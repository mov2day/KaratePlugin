import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Karate step debugger host. Written from scratch against Karate's MIT-licensed public hooks
 * ({@code Runner.Builder.debugSupport}, {@code RunInterceptor}, {@code DebugPointFactory}, {@code RunListener});
 * it does not use or require the Karate IDE jars.
 *
 * Reads one JSON command per line on stdin. Writes one JSON message per line on stdout, either a reply
 * ({@code id}, {@code ok}) or an event ({@code event}). Karate is reached through reflection so this compiles with a
 * plain JDK. Stepping stops before each Gherkin step; JavaScript statements inside steps are not breakpoints.
 */
public class KarateDebugHost {
    private static final Set<String> HIDDEN_VARS = Set.of(
        "fn", "karate", "read", "responseBytes", "responseCookies", "responseType", "requestTimeStamp", "responseDelay");

    private static PrintStream proto;
    private static final Object LOCK = new Object();
    private static final Map<String, Set<Integer>> BREAKPOINTS = new ConcurrentHashMap<>();
    private static final ThreadLocal<Object> CURRENT_RUNTIME = new ThreadLocal<>();

    // Debuggee state, guarded by LOCK.
    private static boolean paused;
    private static boolean resume;
    private static String mode = "entry"; // entry | run | into | over | out
    private static Object pausedRuntime;
    private static Object stepRuntime;
    private static Class<?> stepType;
    private static volatile Thread runThread;

    /** A debug point: the step's line and absolute file, resolved once. */
    static final class Point {
        final int type;
        final int line;
        final Object step;
        final String file;

        Point(int type, int line, Object step, String file) {
            this.type = type;
            this.line = line;
            this.step = step;
            this.file = file;
        }
    }

    public static void main(String[] args) throws Exception {
        proto = new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");
        System.setOut(System.err);
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            if (line.isBlank()) {
                continue;
            }
            long id = -1;
            try {
                Map<String, Object> req = asMap(KarateWorkbenchHost.Json.parse(line));
                id = ((Number) req.get("id")).longValue();
                String cmd = String.valueOf(req.get("cmd"));
                switch (cmd) {
                    case "launch": launch(req); reply(id, new LinkedHashMap<>()); break;
                    case "breakpoints": setBreakpoints(req); reply(id, new LinkedHashMap<>()); break;
                    case "continue": release("run"); reply(id, new LinkedHashMap<>()); break;
                    case "stepIn": release("into"); reply(id, new LinkedHashMap<>()); break;
                    case "stepOver": release("over"); reply(id, new LinkedHashMap<>()); break;
                    case "stepOut": release("out"); reply(id, new LinkedHashMap<>()); break;
                    case "variables": reply(id, variables()); break;
                    case "evaluate": reply(id, evaluate(req)); break;
                    case "disconnect":
                        reply(id, new LinkedHashMap<>());
                        System.exit(0);
                        return;
                    default: fail(id, "unknown_command", "Unknown command: " + cmd);
                }
            } catch (Throwable t) {
                Throwable root = t instanceof InvocationTargetException && t.getCause() != null ? t.getCause() : t;
                fail(id, "error", root.getClass().getSimpleName() + ": " + String.valueOf(root.getMessage()));
            }
        }
        System.exit(0);
    }

    private static void launch(Map<String, Object> req) throws Exception {
        Class<?> runnerCls;
        Class<?> interceptorCls;
        Class<?> factoryCls;
        Class<?> listenerCls;
        try {
            runnerCls = Class.forName("io.karatelabs.core.Runner");
            interceptorCls = Class.forName("io.karatelabs.js.RunInterceptor");
            factoryCls = Class.forName("io.karatelabs.js.DebugPointFactory");
            listenerCls = Class.forName("io.karatelabs.core.RunListener");
            stepType = Class.forName("io.karatelabs.gherkin.Step");
            Class.forName("io.karatelabs.core.ScenarioRuntime").getMethod("getAllVariables");
        } catch (ClassNotFoundException | NoSuchMethodException e) {
            throw new IllegalStateException("This Karate version does not offer the debug hooks. Use Karate 2.1 or newer.");
        }
        String feature = str(req, "feature");
        String env = str(req, "env");
        String configDir = str(req, "configDir");
        String workDir = str(req, "workDir");
        mode = Boolean.TRUE.equals(req.get("stopOnEntry")) ? "entry" : "run";
        setBreakpoints(req);

        Class<?> actionCls = Class.forName("io.karatelabs.js.RunInterceptor$Action");
        Object proceed = enumValue(actionCls, "PROCEED");

        Object interceptor = Proxy.newProxyInstance(interceptorCls.getClassLoader(), new Class<?>[] {interceptorCls}, (proxy, method, a) -> {
            switch (method.getName()) {
                case "beforeExecute":
                    beforeExecute((Point) a[0]);
                    return proceed;
                case "waitForResume":
                    return proceed;
                case "afterExecute":
                    return null;
                default:
                    return objectMethod(proxy, method, a);
            }
        });
        Object factory = Proxy.newProxyInstance(factoryCls.getClassLoader(), new Class<?>[] {factoryCls}, (proxy, method, a) -> {
            if (method.getName().equals("create")) {
                int type = ((Number) a[0]).intValue();
                int line = ((Number) a[1]).intValue();
                return new Point(type, line, a[3], type == 2 ? absoluteFile(a[3]) : "");
            }
            return objectMethod(proxy, method, a);
        });
        // STEP_ENTER fires on the scenario thread right before the interceptor, so it tells us which runtime owns the step.
        Class<?> stepEvent = Class.forName("io.karatelabs.core.StepRunEvent");
        Object listener = Proxy.newProxyInstance(listenerCls.getClassLoader(), new Class<?>[] {listenerCls}, (proxy, method, a) -> {
            if (method.getName().equals("onEvent")) {
                if (stepEvent.isInstance(a[0])) {
                    Object type = call(a[0], "type");
                    if ("STEP_ENTER".equals(String.valueOf(type))) {
                        CURRENT_RUNTIME.set(call(a[0], "scenarioRuntime"));
                    }
                }
                return Boolean.TRUE;
            }
            return objectMethod(proxy, method, a);
        });

        Object builder = runnerCls.getMethod("path", String[].class).invoke(null, (Object) new String[] {feature});
        if (!env.isEmpty()) { builder = call(builder, "karateEnv", env); }
        if (!configDir.isEmpty()) { builder = call(builder, "configDir", configDir); }
        if (!workDir.isEmpty()) { builder = call(builder, "workingDir", workDir); }
        builder = call(builder, "outputDir", Files.createTempDirectory("karate-debug").toString());
        builder = call(builder, "outputHtmlReport", Boolean.FALSE);
        builder = call(builder, "outputConsoleSummary", Boolean.FALSE);
        builder = call(builder, "debugSupport", interceptor, factory);
        builder = call(builder, "listener", listener);
        final Object ready = builder;
        Thread thread = new Thread(() -> {
            Object result = null;
            String failure = null;
            try {
                result = call(ready, "parallel", 1);
            } catch (Throwable t) {
                Throwable root = t instanceof InvocationTargetException && t.getCause() != null ? t.getCause() : t;
                failure = root.getClass().getSimpleName() + ": " + root.getMessage();
            }
            Map<String, Object> done = new LinkedHashMap<>();
            done.put("event", "terminated");
            if (failure != null) {
                done.put("error", failure);
            } else if (result != null) {
                try { done.put("failed", call(result, "getScenarioFailedCount")); } catch (Throwable ignored) { /* optional */ }
                try { done.put("passed", call(result, "getScenarioPassedCount")); } catch (Throwable ignored) { /* optional */ }
            }
            proto.println(KarateWorkbenchHost.Json.write(done));
        }, "karate-debuggee");
        runThread = thread;
        thread.start();
    }

    private static void beforeExecute(Point point) {
        if (point.type != 2) {
            return; // JavaScript statements and expressions are not stop points
        }
        Object runtime = CURRENT_RUNTIME.get();
        String reason = null;
        synchronized (LOCK) {
            Set<Integer> lines = BREAKPOINTS.get(point.file);
            switch (mode) {
                case "entry": reason = "entry"; break;
                case "into": reason = "step"; break;
                case "over": if (runtime == stepRuntime) { reason = "step"; } break;
                case "out": if (runtime != stepRuntime) { reason = "step"; } break;
                default: break;
            }
            if (reason == null && lines != null && lines.contains(point.line)) {
                reason = "breakpoint";
            }
            if (reason == null) {
                return;
            }
            paused = true;
            resume = false;
            pausedRuntime = runtime;
            stepRuntime = runtime;
            Map<String, Object> event = new LinkedHashMap<>();
            event.put("event", "stopped");
            event.put("reason", reason);
            event.put("file", point.file);
            event.put("line", point.line);
            proto.println(KarateWorkbenchHost.Json.write(event));
            while (!resume) {
                try {
                    LOCK.wait();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
            paused = false;
            pausedRuntime = null;
        }
    }

    private static void release(String nextMode) {
        synchronized (LOCK) {
            if (!paused) {
                throw new IllegalStateException("The debuggee is not paused.");
            }
            mode = nextMode;
            resume = true;
            LOCK.notifyAll();
        }
    }

    @SuppressWarnings("unchecked")
    private static void setBreakpoints(Map<String, Object> req) {
        Object bp = req.get("breakpoints");
        if (!(bp instanceof Map)) {
            return;
        }
        for (Map.Entry<String, Object> entry : ((Map<String, Object>) bp).entrySet()) {
            Set<Integer> lines = ConcurrentHashMap.newKeySet();
            for (Object n : (List<Object>) entry.getValue()) {
                lines.add(((Number) n).intValue());
            }
            BREAKPOINTS.put(normalize(entry.getKey()), lines);
        }
    }

    private static String normalize(String path) {
        try {
            return Paths.get(path).toAbsolutePath().normalize().toString();
        } catch (Exception e) {
            return path;
        }
    }

    private static String absoluteFile(Object step) {
        try {
            Object resource = call(call(step, "getFeature"), "getResource");
            Object path = call(resource, "getPath");
            return path == null ? "" : normalize(((Path) path).toString());
        } catch (Throwable t) {
            return "";
        }
    }

    private static Map<String, Object> variables() throws Exception {
        Object runtime;
        synchronized (LOCK) {
            if (!paused) {
                throw new IllegalStateException("The debuggee is not paused.");
            }
            runtime = pausedRuntime;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        Map<String, Object> vars = new LinkedHashMap<>();
        if (runtime != null) {
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) call(runtime, "getAllVariables")).entrySet()) {
                String name = String.valueOf(entry.getKey());
                if (!HIDDEN_VARS.contains(name)) {
                    vars.put(name, describe(entry.getValue()));
                }
            }
        }
        out.put("variables", vars);
        return out;
    }

    private static Map<String, Object> evaluate(Map<String, Object> req) throws Exception {
        Object runtime;
        synchronized (LOCK) {
            if (!paused || pausedRuntime == null) {
                throw new IllegalStateException("The debuggee is not paused.");
            }
            runtime = pausedRuntime;
        }
        Object engine = call(runtime, "getEngine");
        Object value = call(engine, "eval", str(req, "expression"));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("result", describe(value));
        return out;
    }

    /** A compact, JSON-safe description: {value: display string, type, children?: name -> description}. */
    private static Map<String, Object> describe(Object value) {
        return describe(value, 0, new int[] {0});
    }

    private static Map<String, Object> describe(Object value, int depth, int[] nodes) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (value == null) {
            out.put("type", "null");
            out.put("value", "null");
            return out;
        }
        String typeName = value.getClass().getName();
        if (value instanceof CharSequence) {
            String s = value.toString();
            out.put("type", "string");
            out.put("value", s.length() > 2000 ? s.substring(0, 2000) + "..." : s);
        } else if (value instanceof Number) {
            out.put("type", "number");
            out.put("value", String.valueOf(value));
        } else if (value instanceof Boolean) {
            out.put("type", "boolean");
            out.put("value", String.valueOf(value));
        } else if (value instanceof byte[]) {
            out.put("type", "bytes");
            out.put("value", "[binary " + ((byte[]) value).length + " bytes]");
        } else if (typeName.contains("Function") || typeName.contains("Lambda") || typeName.contains("Invokable")) {
            out.put("type", "function");
            out.put("value", "[function]");
        } else if (value instanceof Map && depth < 6 && nodes[0] < 2000) {
            Map<String, Object> children = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                nodes[0]++;
                children.put(String.valueOf(entry.getKey()), describe(entry.getValue(), depth + 1, nodes));
            }
            out.put("type", "object");
            out.put("value", "{" + children.size() + (children.size() == 1 ? " field}" : " fields}"));
            out.put("children", children);
        } else if (value instanceof Iterable && depth < 6 && nodes[0] < 2000) {
            Map<String, Object> children = new LinkedHashMap<>();
            int index = 0;
            for (Object item : (Iterable<?>) value) {
                nodes[0]++;
                children.put(String.valueOf(index++), describe(item, depth + 1, nodes));
            }
            out.put("type", "array");
            out.put("value", "[" + children.size() + (children.size() == 1 ? " item]" : " items]"));
            out.put("children", children);
        } else {
            String s = String.valueOf(value);
            out.put("type", "object");
            out.put("value", s.length() > 500 ? s.substring(0, 500) + "..." : s);
        }
        return out;
    }

    private static Object objectMethod(Object proxy, Method method, Object[] a) {
        switch (method.getName()) {
            case "hashCode": return System.identityHashCode(proxy);
            case "equals": return proxy == a[0];
            case "toString": return "KarateDebugHost proxy";
            default: return null;
        }
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private static Object enumValue(Class<?> type, String name) {
        return Enum.valueOf((Class<Enum>) type, name);
    }

    private static Object call(Object target, String name, Object... args) throws Exception {
        for (Method method : target.getClass().getMethods()) {
            if (method.getName().equals(name) && method.getParameterCount() == args.length && accepts(method.getParameterTypes(), args)) {
                return method.invoke(target, args);
            }
        }
        throw new NoSuchMethodException(target.getClass().getName() + "." + name);
    }

    private static boolean accepts(Class<?>[] types, Object[] args) {
        for (int i = 0; i < types.length; i++) {
            Class<?> type = types[i];
            if (type.isPrimitive()) {
                if (args[i] == null) { return false; }
                if (type == int.class && !(args[i] instanceof Integer)) { return false; }
                if (type == boolean.class && !(args[i] instanceof Boolean)) { return false; }
                if (type == long.class && !(args[i] instanceof Long || args[i] instanceof Integer)) { return false; }
            } else if (args[i] != null && !type.isInstance(args[i])) {
                return false;
            }
        }
        return true;
    }

    private static String str(Map<String, Object> req, String key) {
        Object value = req.get(key);
        return value == null ? "" : String.valueOf(value);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object value) {
        return (Map<String, Object>) value;
    }

    private static void reply(long id, Map<String, Object> body) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", id);
        out.put("ok", Boolean.TRUE);
        out.putAll(body);
        proto.println(KarateWorkbenchHost.Json.write(out));
    }

    private static void fail(long id, String code, String message) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", id);
        out.put("ok", Boolean.FALSE);
        out.put("code", code);
        out.put("error", message);
        proto.println(KarateWorkbenchHost.Json.write(out));
    }
}
