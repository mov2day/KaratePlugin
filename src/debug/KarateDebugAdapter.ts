import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

/**
 * Debug Adapter Protocol implementation for Karate features. No vscode dependency.
 * It drives KarateDebugHost (a Java process using Karate's MIT-licensed debug hooks) over a line-JSON protocol.
 * It stops before Gherkin steps only; JavaScript statements inside a step are not stop points.
 */

export interface DebugLaunch {
    javaPath: string;
    hostDir: string;
    classpath: string[];
    feature: string;
    env: string;
    configDir: string;
    workDir: string;
}

export interface DapMessage {
    seq?: number;
    type: string;
    command?: string;
    request_seq?: number;
    success?: boolean;
    message?: string;
    event?: string;
    arguments?: Record<string, unknown>;
    body?: unknown;
    [key: string]: unknown;
}

interface HostReply {
    id?: number;
    ok?: boolean;
    error?: string;
    event?: string;
    [key: string]: unknown;
}

interface VariableNode {
    type: string;
    value: string;
    children?: Record<string, VariableNode>;
}

const THREAD_ID = 1;
const FRAME_ID = 1;
const SCOPE_REF = 1;

export class KarateDebugAdapter {
    private seq = 1;
    private child: ChildProcess | undefined;
    private nextId = 1;
    private readonly pending = new Map<number, (reply: HostReply) => void>();
    private readonly breakpoints = new Map<string, number[]>();
    private launchArgs: { feature: string; stopOnEntry: boolean; noDebug: boolean } | undefined;
    private stopped: { file: string; line: number } | undefined;
    private childRefs = new Map<number, Record<string, VariableNode>>();
    private nextRef = 100;
    private ended = false;

    constructor(
        private readonly send: (message: DapMessage) => void,
        private readonly prepare: (feature: string) => Promise<DebugLaunch>
    ) {}

    handleMessage(message: DapMessage): void {
        if (message.type !== 'request' || !message.command) { return; }
        this.handle(message).catch(error => this.respond(message, false, undefined, (error as Error).message));
    }

    dispose(): void {
        this.end();
    }

    private async handle(request: DapMessage): Promise<void> {
        const args = (request.arguments ?? {}) as Record<string, unknown>;
        switch (request.command) {
            case 'initialize':
                this.respond(request, true, {
                    supportsConfigurationDoneRequest: true,
                    supportsEvaluateForHovers: true,
                    supportsTerminateRequest: true
                });
                this.event('initialized');
                return;
            case 'launch': {
                const feature = String(args.feature ?? '');
                if (!feature || !fs.existsSync(feature)) {
                    throw new Error(`Feature file not found: ${feature || '(none)'}`);
                }
                this.launchArgs = { feature, stopOnEntry: args.stopOnEntry === true, noDebug: args.noDebug === true };
                this.respond(request, true);
                return;
            }
            case 'setBreakpoints': {
                const source = (args.source ?? {}) as { path?: string };
                const lines = ((args.breakpoints ?? []) as Array<{ line: number }>).map(b => b.line);
                if (source.path) {
                    this.breakpoints.set(path.resolve(source.path), lines);
                    if (this.child && !this.launchArgs?.noDebug) {
                        await this.host('breakpoints', { breakpoints: { [path.resolve(source.path)]: lines } });
                    }
                }
                this.respond(request, true, { breakpoints: lines.map(line => ({ verified: true, line })) });
                return;
            }
            case 'setExceptionBreakpoints':
                this.respond(request, true, {});
                return;
            case 'configurationDone':
                this.respond(request, true);
                await this.start();
                return;
            case 'threads':
                this.respond(request, true, { threads: [{ id: THREAD_ID, name: 'Karate' }] });
                return;
            case 'stackTrace': {
                const frames = this.stopped ? [{
                    id: FRAME_ID,
                    name: this.stepText(this.stopped.file, this.stopped.line),
                    source: { name: path.basename(this.stopped.file), path: this.stopped.file },
                    line: this.stopped.line,
                    column: 1
                }] : [];
                this.respond(request, true, { stackFrames: frames, totalFrames: frames.length });
                return;
            }
            case 'scopes':
                this.respond(request, true, { scopes: [{ name: 'Variables', variablesReference: SCOPE_REF, expensive: false }] });
                return;
            case 'variables': {
                const reference = Number(args.variablesReference);
                let nodes: Record<string, VariableNode> | undefined;
                if (reference === SCOPE_REF) {
                    this.childRefs = new Map();
                    nodes = ((await this.host('variables')).variables ?? {}) as Record<string, VariableNode>;
                } else {
                    nodes = this.childRefs.get(reference);
                }
                this.respond(request, true, { variables: Object.entries(nodes ?? {}).map(([name, node]) => this.toVariable(name, node)) });
                return;
            }
            case 'evaluate': {
                if (!this.stopped) { throw new Error('Not paused.'); }
                const reply = await this.host('evaluate', { expression: String(args.expression ?? '') });
                const node = reply.result as VariableNode;
                const variable = this.toVariable('', node);
                this.respond(request, true, { result: variable.value, type: node.type, variablesReference: variable.variablesReference });
                return;
            }
            case 'continue':
                await this.resume('continue');
                this.respond(request, true, { allThreadsContinued: true });
                return;
            case 'next':
                await this.resume('stepOver');
                this.respond(request, true);
                return;
            case 'stepIn':
                await this.resume('stepIn');
                this.respond(request, true);
                return;
            case 'stepOut':
                await this.resume('stepOut');
                this.respond(request, true);
                return;
            case 'pause':
                // Stops before the next step; a step that is already running finishes first.
                await this.host('pause');
                this.respond(request, true);
                return;
            case 'terminate':
            case 'disconnect':
                this.respond(request, true);
                this.end();
                return;
            default:
                throw new Error(`Unsupported request: ${request.command}`);
        }
    }

    private async start(): Promise<void> {
        const launch = this.launchArgs;
        if (!launch) { throw new Error('Launch was not requested.'); }
        let prepared: DebugLaunch;
        try {
            prepared = await this.prepare(launch.feature);
        } catch (error) {
            this.output(`${(error as Error).message}\n`, 'stderr');
            this.finish();
            return;
        }
        const child = spawn(prepared.javaPath, ['-Dfile.encoding=UTF-8', '-cp', [prepared.hostDir, ...prepared.classpath].join(path.delimiter), 'KarateDebugHost'], {
            cwd: prepared.workDir || undefined, shell: false, windowsHide: true
        });
        this.child = child;
        readline.createInterface({ input: child.stdout! }).on('line', line => this.onHostLine(line));
        child.stderr!.on('data', chunk => this.output(chunk.toString(), 'console'));
        child.on('error', error => { this.output(`Could not start Java: ${error.message}\n`, 'stderr'); this.finish(); });
        child.on('exit', () => this.finish());
        const breakpoints: Record<string, number[]> = {};
        if (!launch.noDebug) {
            for (const [file, lines] of this.breakpoints) { breakpoints[file] = lines; }
        }
        const reply = await this.host('launch', {
            feature: prepared.feature, env: prepared.env, configDir: prepared.configDir, workDir: prepared.workDir,
            stopOnEntry: launch.stopOnEntry && !launch.noDebug, breakpoints
        });
        if (!reply.ok) {
            this.output(`${reply.error}\n`, 'stderr');
            this.finish();
        }
    }

    private onHostLine(line: string): void {
        let message: HostReply;
        try { message = JSON.parse(line) as HostReply; } catch { this.output(`${line}\n`, 'console'); return; }
        if (message.event === 'stopped') {
            this.stopped = { file: String(message.file), line: Number(message.line) };
            this.event('stopped', { reason: message.reason === 'breakpoint' ? 'breakpoint' : message.reason === 'entry' ? 'entry' : message.reason === 'pause' ? 'pause' : 'step', threadId: THREAD_ID, allThreadsStopped: true });
        } else if (message.event === 'terminated') {
            if (message.error) { this.output(`${message.error}\n`, 'stderr'); }
            else if (typeof message.failed === 'number' && message.failed > 0) { this.output(`${message.failed} scenario(s) failed\n`, 'stderr'); }
            else { this.output('Run finished\n', 'console'); }
            this.finish();
        } else if (typeof message.id === 'number') {
            this.pending.get(message.id)?.(message);
            this.pending.delete(message.id);
        }
    }

    private host(cmd: string, args: Record<string, unknown> = {}): Promise<HostReply> {
        const child = this.child;
        if (!child || !child.stdin?.writable) { return Promise.reject(new Error('The Karate debug session is not running.')); }
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, reply => reply.ok === false ? reject(new Error(String(reply.error))) : resolve(reply));
            child.stdin!.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
        });
    }

    private async resume(cmd: string): Promise<void> {
        this.stopped = undefined;
        this.childRefs = new Map();
        await this.host(cmd);
        this.event('continued', { threadId: THREAD_ID, allThreadsContinued: true });
    }

    private toVariable(name: string, node: VariableNode): { name: string; value: string; type: string; variablesReference: number } {
        let reference = 0;
        if (node.children && Object.keys(node.children).length > 0) {
            reference = this.nextRef++;
            this.childRefs.set(reference, node.children);
        }
        return { name, value: node.value, type: node.type, variablesReference: reference };
    }

    private stepText(file: string, line: number): string {
        try {
            const text = fs.readFileSync(file, 'utf8').split(/\r?\n/)[line - 1] ?? '';
            return text.trim() || `line ${line}`;
        } catch {
            return `line ${line}`;
        }
    }

    private finish(): void {
        if (this.ended) { return; }
        this.ended = true;
        this.event('terminated');
        this.end();
    }

    private end(): void {
        const child = this.child;
        this.child = undefined;
        for (const resolve of this.pending.values()) { resolve({ ok: false, error: 'Session ended.' }); }
        this.pending.clear();
        if (child && !child.killed) {
            try { child.stdin?.write(`${JSON.stringify({ id: 0, cmd: 'disconnect' })}\n`); } catch { /* already closed */ }
            setTimeout(() => child.kill(), 500).unref();
        }
    }

    private output(text: string, category: 'console' | 'stdout' | 'stderr'): void {
        this.event('output', { category, output: text });
    }

    private event(event: string, body?: unknown): void {
        this.send({ seq: this.seq++, type: 'event', event, body });
    }

    private respond(request: DapMessage, success: boolean, body?: unknown, message?: string): void {
        this.send({ seq: this.seq++, type: 'response', request_seq: request.seq, command: request.command, success, message, body });
    }
}
