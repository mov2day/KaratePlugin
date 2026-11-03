import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Karate Workbench session host. Reads one JSON command per line on stdin and writes one JSON reply per line.
 * Karate is reached through reflection so this class compiles with a plain JDK and fails with a clear reply,
 * not a crash, when the Karate version on the classpath does not offer the expected API.
 * stdout is reserved for the protocol; Karate and logging output is redirected to stderr.
 */
public class KarateWorkbenchHost {
    private static final int MAX_STRING = 100_000;
    private static final int MAX_DEPTH = 12;
    private static final int MAX_NODES = 20_000;
    private static final Set<String> RESPONSE_VARS = Set.of(
        "response", "responseStatus", "responseHeaders", "responseTime", "responseBytes",
        "responseCookies", "responseType", "requestTimeStamp", "responseDelay");

    private static PrintStream proto;
    private static Object runtime;

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
                Map<String, Object> req = asMap(Json.parse(line));
                id = ((Number) req.get("id")).longValue();
                String cmd = String.valueOf(req.get("cmd"));
                switch (cmd) {
                    case "start": reply(id, start(req)); break;
                    case "step": reply(id, step(req)); break;
                    case "vars": reply(id, vars()); break;
                    case "config": reply(id, config()); break;
                    case "stop":
                        reply(id, new LinkedHashMap<>());
                        System.exit(0);
                        return;
                    default: fail(id, "unknown_command", "Unknown command: " + cmd);
                }
            } catch (HostException e) {
                fail(id, e.code, e.getMessage());
            } catch (Throwable t) {
                Throwable root = t instanceof InvocationTargetException && t.getCause() != null ? t.getCause() : t;
                fail(id, "error", root.getClass().getSimpleName() + ": " + String.valueOf(root.getMessage()));
            }
        }
    }

    private static Map<String, Object> start(Map<String, Object> req) throws Exception {
        Class<?> runnerCls, featureCls, featureRuntimeCls, scenarioRuntimeCls;
        try {
            runnerCls = Class.forName("io.karatelabs.core.Runner");
            featureCls = Class.forName("io.karatelabs.gherkin.Feature");
            featureRuntimeCls = Class.forName("io.karatelabs.core.FeatureRuntime");
            scenarioRuntimeCls = Class.forName("io.karatelabs.core.ScenarioRuntime");
            scenarioRuntimeCls.getMethod("evalAsStep", String.class);
        } catch (ClassNotFoundException | NoSuchMethodException e) {
            throw new HostException("unsupported",
                "This Karate version does not offer the session API Workbench needs. Use Karate 2.1 or newer.");
        }
        String feature = str(req, "feature");
        String env = str(req, "env");
        String configDir = str(req, "configDir");
        String workDir = str(req, "workDir");

        Object builder = runnerCls.getMethod("path", String[].class).invoke(null, (Object) new String[] {feature});
        if (!env.isEmpty()) {
            builder = call(builder, "karateEnv", env);
        }
        if (!configDir.isEmpty()) {
            builder = call(builder, "configDir", configDir);
        }
        if (!workDir.isEmpty()) {
            builder = call(builder, "workingDir", workDir);
        }
        builder = call(builder, "outputDir", Files.createTempDirectory("karate-workbench").toString());
        builder = call(builder, "outputHtmlReport", Boolean.FALSE);
        builder = call(builder, "outputConsoleSummary", Boolean.FALSE);
        builder = call(builder, "consoleLevel", "warn");
        Object suite = call(builder, "buildSuite");

        Object parsed = featureCls.getMethod("read", String.class).invoke(null, feature);
        Object scenario = null;
        for (Object section : (List<?>) call(parsed, "getSections")) {
            if (!Boolean.TRUE.equals(call(section, "isOutline"))) {
                scenario = call(section, "getScenario");
                break;
            }
        }
        if (scenario == null) {
            throw new HostException("noscenario", "Add a Scenario (not a Scenario Outline) to this feature to use Workbench.");
        }
        Object featureRuntime = findStatic(featureRuntimeCls, "of", 2, suite, parsed);
        Constructor<?> ctor = null;
        for (Constructor<?> candidate : scenarioRuntimeCls.getConstructors()) {
            Class<?>[] types = candidate.getParameterTypes();
            if (types.length == 2 && types[0].isInstance(featureRuntime) && types[1].isInstance(scenario)) {
                ctor = candidate;
            }
        }
        if (ctor == null) {
            throw new HostException("unsupported", "Could not create a scenario runtime with this Karate version.");
        }
        runtime = ctor.newInstance(featureRuntime, scenario);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("config", serialize(call(runtime, "getConfigVars")));
        out.put("variables", variables());
        return out;
    }

    private static Map<String, Object> step(Map<String, Object> req) throws Exception {
        requireRuntime();
        String text = str(req, "text");
        long begin = System.nanoTime();
        Object result = call(runtime, "evalAsStep", text);
        Map<String, Object> out = new LinkedHashMap<>();
        boolean failed = Boolean.TRUE.equals(call(result, "isFailed"));
        out.put("status", String.valueOf(call(result, "getStatus")));
        if (failed) {
            out.put("error", String.valueOf(call(result, "getErrorMessage")));
        }
        Object millis = call(result, "getDurationMillis");
        out.put("durationMs", millis instanceof Number ? ((Number) millis).doubleValue() : (System.nanoTime() - begin) / 1e6);
        Map<String, Object> response = response();
        if (response != null) {
            out.put("response", response);
        }
        out.put("variables", variables());
        return out;
    }

    private static Map<String, Object> vars() throws Exception {
        requireRuntime();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("variables", variables());
        return out;
    }

    private static Map<String, Object> config() throws Exception {
        requireRuntime();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("config", serialize(call(runtime, "getConfigVars")));
        return out;
    }

    private static Map<String, Object> response() throws Exception {
        Object status = call(runtime, "getVariable", "responseStatus");
        if (status == null) {
            return null;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("status", serialize(status));
        out.put("headers", serialize(call(runtime, "getVariable", "responseHeaders")));
        out.put("body", serialize(call(runtime, "getVariable", "response")));
        out.put("timeMs", serialize(call(runtime, "getVariable", "responseTime")));
        return out;
    }

    private static Object variables() throws Exception {
        Map<String, Object> out = new LinkedHashMap<>();
        Object all = call(runtime, "getAllVariables");
        for (Map.Entry<?, ?> entry : ((Map<?, ?>) all).entrySet()) {
            String name = String.valueOf(entry.getKey());
            if (!RESPONSE_VARS.contains(name) && !name.equals("fn")) {
                out.put(name, serialize(entry.getValue()));
            }
        }
        return out;
    }

    private static void requireRuntime() {
        if (runtime == null) {
            throw new HostException("not_started", "The session has not been started.");
        }
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
        proto.println(Json.write(out));
    }

    private static void fail(long id, String code, String message) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", id);
        out.put("ok", Boolean.FALSE);
        out.put("code", code);
        out.put("error", message);
        proto.println(Json.write(out));
    }

    private static Object call(Object target, String name, Object... args) throws Exception {
        for (Method method : target.getClass().getMethods()) {
            if (method.getName().equals(name) && matches(method.getParameterTypes(), args)) {
                return method.invoke(target, args);
            }
        }
        throw new NoSuchMethodException(target.getClass().getName() + "." + name);
    }

    private static Object findStatic(Class<?> type, String name, int arity, Object... args) throws Exception {
        for (Method method : type.getMethods()) {
            if (method.getName().equals(name) && method.getParameterCount() == arity && matches(method.getParameterTypes(), args)) {
                return method.invoke(null, args);
            }
        }
        throw new NoSuchMethodException(type.getName() + "." + name);
    }

    private static boolean matches(Class<?>[] types, Object[] args) {
        if (types.length != args.length) {
            return false;
        }
        for (int i = 0; i < types.length; i++) {
            Class<?> type = types[i];
            if (type.isPrimitive()) {
                if (args[i] == null || !wrapper(type).isInstance(args[i])) {
                    return false;
                }
            } else if (args[i] != null && !type.isInstance(args[i])) {
                return false;
            }
        }
        return true;
    }

    private static Class<?> wrapper(Class<?> primitive) {
        if (primitive == boolean.class) { return Boolean.class; }
        if (primitive == int.class) { return Integer.class; }
        if (primitive == long.class) { return Long.class; }
        if (primitive == double.class) { return Double.class; }
        return Object.class;
    }

    /** Converts any Karate value to a JSON-safe tree with depth, size and node budgets. */
    private static Object serialize(Object value) {
        return serialize(value, 0, new int[] {0});
    }

    private static Object serialize(Object value, int depth, int[] nodes) {
        if (value == null || value instanceof Boolean) {
            return value;
        }
        if (++nodes[0] > MAX_NODES) {
            return "[truncated: too large]";
        }
        if (value instanceof Number) {
            return value;
        }
        if (value instanceof CharSequence) {
            String s = value.toString();
            return s.length() > MAX_STRING ? s.substring(0, MAX_STRING) + "...[truncated " + (s.length() - MAX_STRING) + " chars]" : s;
        }
        if (value instanceof byte[]) {
            return "[binary " + ((byte[]) value).length + " bytes]";
        }
        String typeName = value.getClass().getName();
        if (typeName.contains("Function") || typeName.contains("Lambda") || typeName.contains("Invokable")) {
            return "[function]";
        }
        if (depth >= MAX_DEPTH) {
            return "[truncated: nested too deeply]";
        }
        if (value instanceof Map) {
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                out.put(String.valueOf(entry.getKey()), serialize(entry.getValue(), depth + 1, nodes));
            }
            return out;
        }
        if (value instanceof Iterable) {
            List<Object> out = new ArrayList<>();
            for (Object item : (Iterable<?>) value) {
                out.add(serialize(item, depth + 1, nodes));
            }
            return out;
        }
        String s = String.valueOf(value);
        return s.length() > 500 ? s.substring(0, 500) + "..." : s;
    }

    private static class HostException extends RuntimeException {
        final String code;

        HostException(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    /** Minimal JSON reader and writer; enough for the line protocol. */
    static final class Json {
        private final String s;
        private int i;

        private Json(String s) {
            this.s = s;
        }

        static Object parse(String text) {
            Json p = new Json(text);
            Object value = p.value();
            p.ws();
            if (p.i != p.s.length()) {
                throw new IllegalArgumentException("Unexpected trailing JSON");
            }
            return value;
        }

        private void ws() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) {
                i++;
            }
        }

        private Object value() {
            ws();
            if (i >= s.length()) {
                throw new IllegalArgumentException("Unexpected end of JSON");
            }
            char c = s.charAt(i);
            if (c == '{') { return object(); }
            if (c == '[') { return array(); }
            if (c == '"') { return string(); }
            if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
            if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
            if (s.startsWith("null", i)) { i += 4; return null; }
            int start = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) {
                i++;
            }
            if (start == i) {
                throw new IllegalArgumentException("Unexpected JSON character at " + i);
            }
            String number = s.substring(start, i);
            return number.matches("-?\\d+") ? (Object) Long.valueOf(number) : (Object) Double.valueOf(number);
        }

        private Map<String, Object> object() {
            Map<String, Object> out = new LinkedHashMap<>();
            i++;
            ws();
            if (s.charAt(i) == '}') {
                i++;
                return out;
            }
            while (true) {
                ws();
                String key = string();
                ws();
                if (s.charAt(i++) != ':') {
                    throw new IllegalArgumentException("Expected ':'");
                }
                out.put(key, value());
                ws();
                char c = s.charAt(i++);
                if (c == '}') {
                    return out;
                }
                if (c != ',') {
                    throw new IllegalArgumentException("Expected ',' or '}'");
                }
            }
        }

        private List<Object> array() {
            List<Object> out = new ArrayList<>();
            i++;
            ws();
            if (s.charAt(i) == ']') {
                i++;
                return out;
            }
            while (true) {
                out.add(value());
                ws();
                char c = s.charAt(i++);
                if (c == ']') {
                    return out;
                }
                if (c != ',') {
                    throw new IllegalArgumentException("Expected ',' or ']'");
                }
            }
        }

        private String string() {
            if (s.charAt(i) != '"') {
                throw new IllegalArgumentException("Expected string at " + i);
            }
            i++;
            StringBuilder out = new StringBuilder();
            while (true) {
                char c = s.charAt(i++);
                if (c == '"') {
                    return out.toString();
                }
                if (c != '\\') {
                    out.append(c);
                    continue;
                }
                char e = s.charAt(i++);
                switch (e) {
                    case 'n': out.append('\n'); break;
                    case 'r': out.append('\r'); break;
                    case 't': out.append('\t'); break;
                    case 'b': out.append('\b'); break;
                    case 'f': out.append('\f'); break;
                    case 'u':
                        out.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                        i += 4;
                        break;
                    default: out.append(e);
                }
            }
        }

        static String write(Object value) {
            StringBuilder out = new StringBuilder();
            write(value, out);
            return out.toString();
        }

        private static void write(Object value, StringBuilder out) {
            if (value == null) {
                out.append("null");
            } else if (value instanceof Boolean) {
                out.append(value);
            } else if (value instanceof Number) {
                writeNumber((Number) value, out);
            } else if (value instanceof Map) {
                out.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                    if (!first) {
                        out.append(',');
                    }
                    first = false;
                    quote(String.valueOf(entry.getKey()), out);
                    out.append(':');
                    write(entry.getValue(), out);
                }
                out.append('}');
            } else if (value instanceof Iterable) {
                out.append('[');
                boolean first = true;
                for (Object item : (Iterable<?>) value) {
                    if (!first) {
                        out.append(',');
                    }
                    first = false;
                    write(item, out);
                }
                out.append(']');
            } else {
                quote(String.valueOf(value), out);
            }
        }

        private static void writeNumber(Number n, StringBuilder out) {
            if (n instanceof Double || n instanceof Float) {
                double d = n.doubleValue();
                if (Double.isNaN(d) || Double.isInfinite(d)) {
                    out.append("null");
                } else if (d == Math.rint(d) && Math.abs(d) < 1e15) {
                    out.append((long) d);
                } else {
                    out.append(d);
                }
            } else {
                out.append(n);
            }
        }

        private static void quote(String text, StringBuilder out) {
            out.append('"');
            for (int k = 0; k < text.length(); k++) {
                char c = text.charAt(k);
                switch (c) {
                    case '"': out.append("\\\""); break;
                    case '\\': out.append("\\\\"); break;
                    case '\n': out.append("\\n"); break;
                    case '\r': out.append("\\r"); break;
                    case '\t': out.append("\\t"); break;
                    default:
                        if (c < 0x20) {
                            out.append(String.format("\\u%04x", (int) c));
                        } else {
                            out.append(c);
                        }
                }
            }
            out.append('"');
        }
    }
}
