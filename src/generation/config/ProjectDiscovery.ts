/** Pure project discovery: finds an existing karate-config.js and related layout. No vscode, no node fs. */

export interface FsLike {
    exists(p: string): boolean;
    read(p: string): string;
    list(dir: string): string[];
}

export interface ProjectInfo {
    classpathRoot: string;
    baseConfig?: { path: string; urlVariable?: string; variables: string[] };
    envConfigs: string[];
    hasEnvJson: boolean;
    runnerStyle: 'junit6' | 'cli' | 'unknown';
}

const SEARCH_DIRS = ['src/test/java', 'src/test/resources', '.'];
const DEFAULT_CLASSPATH_ROOT = 'src/test/java';
const MAX_JAVA_DEPTH = 8;
const SKIP_DIRS = new Set(['node_modules', 'target', 'build', 'out', '.git']);

const rel = (dir: string, name: string): string => (dir === '.' ? name : `${dir}/${name}`);
const abs = (root: string, relPath: string): string => (relPath === '.' ? root : `${root.replace(/\/+$/, '')}/${relPath}`);

/** Extract the text of the first balanced `{...}` starting at `start` (index of '{'), skipping strings and comments. */
function balancedLiteral(src: string, start: number): string | undefined {
    let depth = 0;
    for (let i = start; i < src.length; i++) {
        const ch = src[i];
        if (ch === '"' || ch === "'" || ch === '`') {
            for (i++; i < src.length && src[i] !== ch; i++) {if (src[i] === '\\') {i++;}}
        } else if (ch === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') {i++;}
        } else if (ch === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            i = end < 0 ? src.length : end + 1;
        } else if (ch === '{') {depth++;}
        else if (ch === '}' && --depth === 0) {return src.slice(start, i + 1);}
    }
    return undefined;
}

/** Top-level keys of an object literal (depth 1 only). */
function topLevelKeys(literal: string): string[] {
    const keys: string[] = [];
    let depth = 0;
    for (let i = 0; i < literal.length; i++) {
        const ch = literal[i];
        if (ch === '"' || ch === "'" || ch === '`') {
            const quote = ch;
            const begin = i + 1;
            for (i++; i < literal.length && literal[i] !== quote; i++) {if (literal[i] === '\\') {i++;}}
            if (depth === 1 && quote !== '`' && /^\s*:/.test(literal.slice(i + 1))) {keys.push(literal.slice(begin, i));}
        } else if (ch === '/' && literal[i + 1] === '/') {
            while (i < literal.length && literal[i] !== '\n') {i++;}
        } else if (ch === '/' && literal[i + 1] === '*') {
            const end = literal.indexOf('*/', i + 2);
            i = end < 0 ? literal.length : end + 1;
        } else if (ch === '{' || ch === '[' || ch === '(') {depth++;}
        else if (ch === '}' || ch === ']' || ch === ')') {depth--;}
        else if (depth === 1 && /[A-Za-z_$]/.test(ch) && !/[\w$]/.test(literal[i - 1] ?? '')) {
            const m = /^[A-Za-z_$][\w$]*/.exec(literal.slice(i));
            if (m) {
                if (/^\s*:/.test(literal.slice(i + m[0].length))) {keys.push(m[0]);}
                i += m[0].length - 1;
            }
        }
    }
    return keys;
}

function analyzeConfig(src: string): { urlVariable?: string; variables: string[] } {
    const m = /\b(?:var|let|const)\s+config\s*=\s*\{|\breturn\s*\{/.exec(src);
    if (!m) {return { variables: [] };}
    const literal = balancedLiteral(src, m.index + m[0].length - 1);
    const variables = literal ? topLevelKeys(literal) : [];
    const urls = variables.filter(k => /^\w*[uU]rl$|^host$/.test(k));
    const urlVariable = urls.includes('baseUrl') ? 'baseUrl' : urls[0];
    return { urlVariable, variables };
}

function safeList(fsApi: FsLike, dir: string): string[] {
    try {
        return fsApi.list(dir);
    } catch {
        return [];
    }
}

function hasJunit6(fsApi: FsLike, dir: string, depth: number): boolean {
    if (depth > MAX_JAVA_DEPTH) {return false;}
    for (const name of safeList(fsApi, dir)) {
        if (SKIP_DIRS.has(name)) {continue;}
        const p = `${dir}/${name}`;
        if (name.endsWith('.java')) {
            try {
                if (fsApi.read(p).includes('io.karatelabs.junit6')) {return true;}
            } catch {
                /* unreadable file: skip */
            }
        } else if (!name.includes('.') && hasJunit6(fsApi, p, depth + 1)) {return true;}
    }
    return false;
}

export function discoverProject(root: string, fsApi: FsLike): ProjectInfo {
    let classpathRoot = DEFAULT_CLASSPATH_ROOT;
    let baseConfig: ProjectInfo['baseConfig'];
    for (const dir of SEARCH_DIRS) {
        const relPath = rel(dir, 'karate-config.js');
        if (!fsApi.exists(abs(root, relPath))) {continue;}
        classpathRoot = dir;
        let analysis: { urlVariable?: string; variables: string[] } = { variables: [] };
        try {
            analysis = analyzeConfig(fsApi.read(abs(root, relPath)));
        } catch {
            /* unreadable config: still adopt it */
        }
        baseConfig = { path: relPath, ...analysis };
        break;
    }

    const cpAbs = abs(root, classpathRoot);
    const envConfigs: string[] = [];
    if (baseConfig) {
        for (const name of safeList(fsApi, cpAbs)) {
            const m = /^karate-config-(.+)\.js$/.exec(name);
            if (m) {envConfigs.push(m[1]);}
        }
    }

    const configDir = `${cpAbs}/config`;
    const hasEnvJson = fsApi.exists(configDir) && safeList(fsApi, configDir).some(n => n.endsWith('.json'));

    let runnerStyle: ProjectInfo['runnerStyle'];
    const javaAbs = abs(root, DEFAULT_CLASSPATH_ROOT);
    if (hasJunit6(fsApi, cpAbs, 0) || (javaAbs !== cpAbs && hasJunit6(fsApi, javaAbs, 0))) {runnerStyle = 'junit6';}
    else if (!fsApi.exists(abs(root, 'pom.xml')) && !fsApi.exists(abs(root, 'build.gradle'))) {runnerStyle = 'cli';}
    else {runnerStyle = 'unknown';}

    return { classpathRoot, baseConfig, envConfigs, hasEnvJson, runnerStyle };
}
