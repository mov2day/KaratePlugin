/** Pure core of the Karate v2 CLI lookup (probe/exists injected; no vscode, no child_process). Never downloads. */
import { isJava21, isKarateV2 } from './DryRun';

export type Cli = { command: string; args: string[] };

export interface ResolverDeps {
    /** Runs a command and returns its combined output, or undefined when it could not be spawned. */
    probe: (cmd: string, args: string[]) => Promise<string | undefined>;
    exists: (p: string) => boolean;
    /** The user-configured jar (karateDsl.execution.jarPath); blank means "none" (the bundled jar is Karate v1 and never used). */
    jarPath: string;
}

export async function resolveCli(deps: ResolverDeps): Promise<Cli | undefined> {
    // (1) `karate` on PATH reporting v2+. Probed directly (no which/where). Windows `karate.cmd` shims are not
    // found by execFile without a shell, so such installs fall through to the jar setting.
    const v = await deps.probe('karate', ['--version']);
    if (v && isKarateV2(v)) {return { command: 'karate', args: [] };}
    // (2) the configured jar, only when Java is 21+ and the jar reports v2+
    const jar = deps.jarPath.trim();
    if (jar && deps.exists(jar)) {
        const java = await deps.probe('java', ['-version']);
        if (java && isJava21(java)) {
            const jv = await deps.probe('java', ['-jar', jar, '--version']);
            if (jv && isKarateV2(jv)) {return { command: 'java', args: ['-jar', jar] };}
        }
    }
    return undefined;
}

export const HIT_TTL_MS = 5 * 60 * 1000;
export const MISS_TTL_MS = 30 * 1000;

/** Caches a resolution per key: hits for 5 minutes, misses (undefined) for only 30 seconds. */
export class CliCache {
    private entry: { key: string; at: number; cli: Cli | undefined } | undefined;
    constructor(private readonly now: () => number = Date.now) {}

    async get(key: string, resolve: () => Promise<Cli | undefined>): Promise<Cli | undefined> {
        const e = this.entry;
        if (e && e.key === key && this.now() - e.at < (e.cli ? HIT_TTL_MS : MISS_TTL_MS)) {return e.cli;}
        const cli = await resolve();
        this.entry = { key, at: this.now(), cli };
        return cli;
    }
}

/** Creates a temp dir, runs `fn`, and always removes the dir (best effort), even when `fn` throws. */
export async function withTempDir<T>(make: () => string, remove: (dir: string) => void, fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = make();
    try {
        return await fn(dir);
    } finally {
        try {
            remove(dir);
        } catch { /* best effort */ }
    }
}
