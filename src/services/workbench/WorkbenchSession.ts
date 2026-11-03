import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { parseHostLine, StartResult, StepResult, toStartResult, toStepResult, WorkbenchError, HostReply } from './SessionProtocol';

/** One Karate session: a Java host process that keeps variables between steps. No vscode dependency. */

export interface SessionOptions {
    javaPath?: string;
    hostDir: string;
    classpath: string[];
    feature: string;
    env?: string;
    configDir?: string;
    workDir: string;
    requestTimeoutMs?: number;
    onLog?: (text: string) => void;
}

interface Pending {
    resolve: (reply: HostReply) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

export async function getJavaMajor(javaPath = 'java'): Promise<number | undefined> {
    return new Promise(resolve => {
        let output = '';
        const child = spawn(javaPath, ['-version'], { shell: false, windowsHide: true });
        child.stdout?.on('data', data => { output += data.toString(); });
        child.stderr?.on('data', data => { output += data.toString(); });
        child.on('close', () => {
            const match = output.match(/version "(\d+)(?:\.(\d+))?/);
            resolve(match ? (Number(match[1]) === 1 ? Number(match[2]) : Number(match[1])) : undefined);
        });
        child.on('error', () => resolve(undefined));
    });
}

export class WorkbenchSession {
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    private buffer = '';
    private exited = false;
    private readonly timeoutMs: number;
    private exitHandlers: Array<() => void> = [];

    private constructor(private readonly child: ChildProcess, private readonly options: SessionOptions) {
        this.timeoutMs = options.requestTimeoutMs ?? 120_000;
        child.stdout?.on('data', data => this.onStdout(data.toString()));
        child.stderr?.on('data', data => options.onLog?.(data.toString()));
        child.stdin?.on('error', () => undefined);
        child.on('error', error => this.onExit(new WorkbenchError(`Could not start Java: ${error.message}`, 'spawn')));
        child.on('close', () => this.onExit(new WorkbenchError('The Karate session ended.', 'exited')));
    }

    static async start(options: SessionOptions): Promise<{ session: WorkbenchSession; result: StartResult }> {
        const classpath = [options.hostDir, ...options.classpath].join(path.delimiter);
        const child = spawn(options.javaPath ?? 'java', ['-Dfile.encoding=UTF-8', '-cp', classpath, 'KarateWorkbenchHost'], {
            cwd: options.workDir,
            shell: false,
            windowsHide: true,
            detached: process.platform !== 'win32',
            stdio: ['pipe', 'pipe', 'pipe']
        });
        const session = new WorkbenchSession(child, options);
        try {
            const reply = await session.request({
                cmd: 'start',
                feature: options.feature,
                env: options.env ?? '',
                configDir: options.configDir ?? '',
                workDir: options.workDir
            });
            return { session, result: toStartResult(reply) };
        } catch (error) {
            session.kill();
            throw error;
        }
    }

    get alive(): boolean {
        return !this.exited;
    }

    onDidExit(handler: () => void): void {
        this.exitHandlers.push(handler);
    }

    async step(text: string): Promise<StepResult> {
        return toStepResult(await this.request({ cmd: 'step', text }));
    }

    async variables(): Promise<Record<string, unknown>> {
        return toStartResult(await this.request({ cmd: 'vars' })).variables;
    }

    async config(): Promise<Record<string, unknown>> {
        return toStartResult(await this.request({ cmd: 'config' })).config;
    }

    /** Ends the session. A request in flight cannot be interrupted safely, so cancelling kills the host. */
    cancel(): void {
        this.kill(new WorkbenchError('Cancelled.', 'cancelled'));
    }

    async stop(): Promise<void> {
        if (this.exited) {
            return;
        }
        try {
            await Promise.race([this.request({ cmd: 'stop' }), new Promise(resolve => setTimeout(resolve, 1500))]);
        } catch {
            // The host may close before replying.
        }
        this.kill();
    }

    kill(reason?: Error): void {
        if (!this.exited) {
            this.terminate();
        }
        this.onExit(reason ?? new WorkbenchError('The Karate session ended.', 'exited'));
    }

    private terminate(): void {
        const pid = this.child.pid;
        try {
            if (process.platform !== 'win32' && pid) {
                process.kill(-pid, 'SIGTERM');
                setTimeout(() => {
                    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
                }, 2000).unref();
            } else {
                this.child.kill();
            }
        } catch {
            this.child.kill();
        }
    }

    private request(payload: Record<string, unknown>): Promise<HostReply> {
        if (this.exited) {
            return Promise.reject(new WorkbenchError('The Karate session is not running.', 'exited'));
        }
        const id = this.nextId++;
        return new Promise<HostReply>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                this.kill(new WorkbenchError(`No reply from Karate within ${Math.round(this.timeoutMs / 1000)} seconds. The session was stopped.`, 'timeout'));
                reject(new WorkbenchError(`No reply from Karate within ${Math.round(this.timeoutMs / 1000)} seconds. The session was stopped.`, 'timeout'));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.child.stdin?.write(JSON.stringify({ id, ...payload }) + '\n', error => {
                if (error) {
                    clearTimeout(timer);
                    this.pending.delete(id);
                    reject(new WorkbenchError('Could not talk to the Karate session.', 'exited'));
                }
            });
        });
    }

    private onStdout(chunk: string): void {
        this.buffer += chunk;
        let index: number;
        while ((index = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, index);
            this.buffer = this.buffer.slice(index + 1);
            const reply = parseHostLine(line);
            if (!reply) {
                continue;
            }
            const waiting = this.pending.get(reply.id);
            if (waiting) {
                clearTimeout(waiting.timer);
                this.pending.delete(reply.id);
                waiting.resolve(reply);
            }
        }
    }

    private onExit(reason: Error): void {
        if (this.exited) {
            return;
        }
        this.exited = true;
        for (const [id, waiting] of this.pending) {
            clearTimeout(waiting.timer);
            waiting.reject(reason);
            this.pending.delete(id);
        }
        for (const handler of this.exitHandlers) {
            handler();
        }
    }
}
