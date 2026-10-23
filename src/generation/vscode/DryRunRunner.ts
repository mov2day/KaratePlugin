import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { readExecutionSettings } from '../../services/execution/ExecutionSettings';
import { logger } from '../../utils/logger';
import type { GeneratorConfig } from '../config/GeneratorConfig';
import { dryRun, dryRunDecision, isJava21, isKarateV2, NO_CLI_MESSAGE } from '../quality/DryRun';
import type { DryRunOutcome } from '../quality/DryRun';

type Cli = { command: string; args: string[] };

const PROBE_TIMEOUT_MS = 5000;
const CACHE_MS = 5 * 60 * 1000;
const RUN_TIMEOUT_MS = 60_000;
let cache: { key: string; at: number; cli: Cli | undefined } | undefined;

/** Run a command capturing stdout+stderr; never throws. */
export function execCapture(cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number }): Promise<{ code: number; out: string }> {
    return new Promise((resolve, reject) => {
        try {
            execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
                const out = `${stdout ?? ''}${stderr ?? ''}`;
                if (error) {
                    const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
                    if (e.killed) {reject(new Error(`timed out after ${opts.timeoutMs} ms`)); return;}
                    if (typeof e.code === 'string') {reject(new Error(`${e.code}: ${e.message}`)); return;}
                    resolve({ code: typeof e.code === 'number' ? e.code : 1, out });
                    return;
                }
                resolve({ code: 0, out });
            });
        } catch (e) {
            reject(e);
        }
    });
}

async function probe(cmd: string, args: string[]): Promise<string | undefined> {
    try {
        const r = await execCapture(cmd, args, { timeoutMs: PROBE_TIMEOUT_MS });
        return r.out;
    } catch {
        return undefined;
    }
}

async function resolveUncached(workspaceRoot: string): Promise<Cli | undefined> {
    // (1) a `karate` executable on PATH reporting v2+
    const locator = process.platform === 'win32' ? 'where' : 'which';
    if (await probe(locator, ['karate'])) {
        const v = await probe('karate', ['--version']);
        if (v && isKarateV2(v)) {return { command: 'karate', args: [] };}
    }
    // (2) the user-configured jar, only when it is v2 and Java is 21+
    let jar = '';
    try {
        jar = readExecutionSettings(workspaceRoot).jarPath.trim();
    } catch {
        jar = '';
    }
    if (jar && fs.existsSync(jar)) {
        const java = await probe('java', ['-version']);
        if (java && isJava21(java)) {
            const v = await probe('java', ['-jar', jar, '--version']);
            if (v && isKarateV2(v)) {return { command: 'java', args: ['-jar', jar] };}
        }
    }
    // never download, never use the bundled v1 jar
    return undefined;
}

/** Finds an already-installed Karate v2 CLI. Never downloads. Cached for 5 minutes. */
export async function resolveKarateV2Cli(_context: vscode.ExtensionContext, workspaceRoot = ''): Promise<Cli | undefined> {
    let key = workspaceRoot;
    try {
        key += `|${readExecutionSettings(workspaceRoot).jarPath}`;
    } catch { /* settings unavailable */ }
    if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) {return cache.cli;}
    const cli = await resolveUncached(workspaceRoot);
    cache = { key, at: Date.now(), cli };
    return cli;
}

/** The `dryRun` input for `runPipeline`; undefined when the config turns the gate stage off. */
export function makeDryRun(
    context: vscode.ExtensionContext, workspaceRoot: string, config: GeneratorConfig
): ((files: string[]) => Promise<DryRunOutcome>) | undefined {
    if (dryRunDecision(config.gate.dryRun, true) === 'disabled') {return undefined;}
    return async files => {
        let cli: Cli | undefined;
        try {
            cli = await resolveKarateV2Cli(context, workspaceRoot);
        } catch (error) {
            logger.warn('Karate v2 CLI lookup failed', error as Error);
        }
        if (dryRunDecision(config.gate.dryRun, cli !== undefined) !== 'run') {
            return { status: 'skipped', message: NO_CLI_MESSAGE, findings: [] };
        }
        const outDir = path.join(os.tmpdir(), `karate-dryrun-${Math.random().toString(36).slice(2, 10)}`);
        try {
            return await dryRun({
                cli, root: workspaceRoot, files: files.filter(f => f.endsWith('.feature')), outDir,
                exec: (cmd, args, o) => execCapture(cmd, args, o), timeoutMs: RUN_TIMEOUT_MS
            });
        } catch (error) {
            return { status: 'skipped', message: `Dry run skipped: ${error instanceof Error ? error.message : String(error)}`, findings: [] };
        } finally {
            try {
                fs.rmSync(outDir, { recursive: true, force: true });
            } catch { /* best effort */ }
        }
    };
}
