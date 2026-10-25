import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { readExecutionSettings } from '../../services/execution/ExecutionSettings';
import { logger } from '../../utils/logger';
import type { GeneratorConfig } from '../config/GeneratorConfig';
import { CliCache, resolveCli, withTempDir } from '../quality/CliResolver';
import type { Cli } from '../quality/CliResolver';
import { dryRun, dryRunDecision, NO_CLI_MESSAGE } from '../quality/DryRun';
import type { DryRunOutcome } from '../quality/DryRun';

const PROBE_TIMEOUT_MS = 5000;
const RUN_TIMEOUT_MS = 60_000;

/** Run a command capturing stdout+stderr; never throws. */
export function execCapture(cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number }): Promise<{ code: number; out: string }> {
    return new Promise((resolve, reject) => {
        try {
            execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
                const out = `${stdout ?? ''}${stderr ?? ''}`;
                if (error) {
                    const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
                    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {reject(new Error('output exceeded the buffer limit')); return;}
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

const cache = new CliCache();

export interface DryRunStagedFile { path: string; content: string; }
export interface StageFs { mkdir(path: string): void; write(path: string, content: string): void; }

/** Stage generated features beneath `outDir`; paths must be children of `workspaceRoot`. */
export function stageDryRunFiles(outDir: string, files: DryRunStagedFile[], workspaceRoot: string, fsApi: StageFs = {
    mkdir: p => fs.mkdirSync(p, { recursive: true }), write: (p, c) => fs.writeFileSync(p, c, 'utf8')
}): string[] {
    const root = path.resolve(workspaceRoot);
    return files.filter(f => f.path.endsWith('.feature')).map(file => {
        const absolute = path.resolve(file.path);
        const relative = path.relative(root, absolute);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error(`Dry-run path is outside the workspace: ${file.path}`);
        }
        const target = path.join(outDir, relative);
        fsApi.mkdir(path.dirname(target));
        fsApi.write(target, file.content);
        return target;
    });
}

/** Finds an already-installed Karate v2 CLI. Never downloads. Hits cached 5 minutes, misses 30 seconds. */
export async function resolveKarateV2Cli(_context: vscode.ExtensionContext, workspaceRoot = ''): Promise<Cli | undefined> {
    let jarPath = '';
    try {
        jarPath = readExecutionSettings(workspaceRoot).jarPath;
    } catch { /* settings unavailable */ }
    return cache.get(`${workspaceRoot}|${jarPath}`, () => resolveCli({ probe, exists: p => fs.existsSync(p), jarPath }));
}

/** The `dryRun` input for `runPipeline`; undefined when the config turns the gate stage off. */
export function makeDryRun(
    context: vscode.ExtensionContext, workspaceRoot: string, config: GeneratorConfig
): ((files: DryRunStagedFile[]) => Promise<DryRunOutcome>) | undefined {
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
        try {
            return await withTempDir(
                () => fs.mkdtempSync(path.join(os.tmpdir(), 'karate-dryrun-')),
                d => fs.rmSync(d, { recursive: true, force: true }),
                outDir => {
                    const staged = stageDryRunFiles(outDir, files, workspaceRoot);
                    return dryRun({
                    cli, root: workspaceRoot, files: staged, outDir,
                    exec: (cmd, args, o) => execCapture(cmd, args, o), timeoutMs: RUN_TIMEOUT_MS
                    });
                }
            );
        } catch (error) {
            return { status: 'skipped', message: error instanceof Error ? error.message : String(error), findings: [] };
        }
    };
}
