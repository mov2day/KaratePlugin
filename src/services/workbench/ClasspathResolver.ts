import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

/** Resolves the test classpath through the project's build tool, so Java helpers and dependency jars are found. No vscode dependency. */

export type Exec = (file: string, args: string[], options: { cwd: string; timeoutMs: number; shell?: boolean }) => Promise<{ stdout: string; stderr: string }>;

export interface ClasspathRequest {
    projectRoot: string;
    strategy: 'cli' | 'maven' | 'gradle';
    karateJar: string;
    additionalClasspath?: string[];
    buildArgs?: string[];
    timeoutMs?: number;
    exec?: Exec;
}

export interface ClasspathResult {
    strategy: 'cli' | 'maven' | 'gradle';
    entries: string[];
    usedProjectKarate: boolean;
}

const GRADLE_MARKER = 'KARATE_WB_CP=';

const GRADLE_INIT_SCRIPT = `allprojects {
  afterEvaluate { p ->
    if (p.plugins.hasPlugin('java')) {
      p.tasks.register('karateWorkbenchClasspath') {
        dependsOn p.tasks.named('testClasses')
        doLast {
          println '${GRADLE_MARKER}' + p.projectDir.absolutePath + '\\t' + p.sourceSets.test.runtimeClasspath.asPath
        }
      }
    }
  }
}
`;

export const defaultExec: Exec = (file, args, options) => new Promise((resolve, reject) => {
    execFile(file, args, { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024, shell: options.shell === true }, (error, stdout, stderr) => {
        if (error) {
            const detail = (stderr || stdout || error.message).toString().trim().split('\n').slice(-12).join('\n');
            reject(new Error(`${path.basename(file)} failed: ${detail}`));
        } else {
            resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
        }
    });
});

interface Launcher {
    file: string;
    prefix: string[];
    shell: boolean;
}

function launcher(projectRoot: string, wrapper: string, tool: string): Launcher {
    const isWindows = process.platform === 'win32';
    const script = path.join(projectRoot, isWindows ? `${wrapper}.${wrapper === 'gradlew' ? 'bat' : 'cmd'}` : wrapper);
    if (fs.existsSync(script)) {
        return isWindows ? { file: script, prefix: [], shell: true } : { file: 'sh', prefix: [script], shell: false };
    }
    return { file: tool, prefix: [], shell: isWindows };
}

function existing(root: string, relative: string[]): string[] {
    return relative.map(item => path.join(root, item)).filter(item => fs.existsSync(item));
}

export function parseGradleOutput(stdout: string, projectRoot: string): string[] {
    const candidates = stdout.split(/\r?\n/)
        .filter(line => line.startsWith(GRADLE_MARKER))
        .map(line => line.slice(GRADLE_MARKER.length).split('\t'))
        .filter(parts => parts.length === 2);
    if (!candidates.length) {
        throw new Error('Gradle did not report a test classpath. Does the project apply the java plugin?');
    }
    const real = (value: string): string => {
        try { return fs.realpathSync(value); } catch { return value; }
    };
    const own = candidates.find(parts => real(parts[0]) === real(projectRoot)) ?? candidates[0];
    return own[1].split(path.delimiter).filter(Boolean);
}

async function gradleClasspath(request: ClasspathRequest, exec: Exec): Promise<string[]> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karate-workbench-'));
    const script = path.join(dir, 'classpath.init.gradle');
    fs.writeFileSync(script, GRADLE_INIT_SCRIPT);
    try {
        const tool = launcher(request.projectRoot, 'gradlew', 'gradle');
        const args = [...tool.prefix, '-q', '--init-script', script, ...(request.buildArgs ?? []), 'karateWorkbenchClasspath'];
        const { stdout } = await exec(tool.file, args, { cwd: request.projectRoot, timeoutMs: request.timeoutMs ?? 300_000, shell: tool.shell });
        return parseGradleOutput(stdout, request.projectRoot);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function mavenClasspath(request: ClasspathRequest, exec: Exec): Promise<string[]> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karate-workbench-'));
    const output = path.join(dir, 'classpath.txt');
    try {
        const tool = launcher(request.projectRoot, 'mvnw', 'mvn');
        const args = [...tool.prefix, '-q', '-B', ...(request.buildArgs ?? []), 'test-compile', 'dependency:build-classpath', `-Dmdep.outputFile=${output}`, '-Dmdep.includeScope=test'];
        await exec(tool.file, args, { cwd: request.projectRoot, timeoutMs: request.timeoutMs ?? 300_000, shell: tool.shell });
        const dependencies = fs.existsSync(output) ? fs.readFileSync(output, 'utf8').trim().split(path.delimiter).filter(Boolean) : [];
        return [...existing(request.projectRoot, ['target/test-classes', 'target/classes']), ...dependencies];
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function plainClasspath(request: ClasspathRequest): string[] {
    return existing(request.projectRoot, [
        'src/test/resources', 'src/main/resources', 'target/test-classes', 'target/classes',
        'build/classes/java/test', 'build/classes/java/main', 'build/resources/test', 'build/resources/main', 'out/test/classes', 'bin'
    ]);
}

const KARATE_JAR = /^karate(?:-core|-junit5)?-\d[\w.-]*\.jar$/;

export async function resolveClasspath(request: ClasspathRequest): Promise<ClasspathResult> {
    const exec = request.exec ?? defaultExec;
    let resolved: string[];
    if (request.strategy === 'gradle') {
        resolved = await gradleClasspath(request, exec);
    } else if (request.strategy === 'maven') {
        resolved = await mavenClasspath(request, exec);
    } else {
        resolved = plainClasspath(request);
    }
    const additional = (request.additionalClasspath ?? []).map(item => (path.isAbsolute(item) ? item : path.join(request.projectRoot, item)));
    // Source folders first: edits to features, config and data are seen without a rebuild.
    const sources = existing(request.projectRoot, ['src/test/java', 'src/test/resources']);
    const entries = Array.from(new Set([...sources, ...resolved, ...additional]));
    const usedProjectKarate = entries.some(entry => KARATE_JAR.test(path.basename(entry)));
    if (!usedProjectKarate) {
        entries.push(request.karateJar);
    }
    return { strategy: request.strategy, entries, usedProjectKarate };
}
