/** JSON-line protocol between the extension and the Workbench session host. No vscode dependency. */

export type StepStatus = 'PASSED' | 'FAILED' | 'SKIPPED';

export interface HostResponse {
    status: number;
    headers: Record<string, unknown>;
    body: unknown;
    timeMs: number;
}

export interface HostReply {
    id: number;
    ok: boolean;
    code?: string;
    error?: string;
    [key: string]: unknown;
}

export interface StartResult {
    config: Record<string, unknown>;
    variables: Record<string, unknown>;
}

export interface StepResult {
    status: StepStatus;
    error?: string;
    durationMs: number;
    response?: HostResponse;
    variables: Record<string, unknown>;
}

export class WorkbenchError extends Error {
    constructor(message: string, readonly code: string) {
        super(message);
        this.name = 'WorkbenchError';
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses one host stdout line; returns undefined for anything that is not a protocol reply. */
export function parseHostLine(line: string): HostReply | undefined {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
        return undefined;
    }
    try {
        const value: unknown = JSON.parse(trimmed);
        if (isRecord(value) && typeof value.id === 'number' && typeof value.ok === 'boolean') {
            return value as HostReply;
        }
    } catch {
        // Not JSON; ignore stray output.
    }
    return undefined;
}

export function assertOk(reply: HostReply): HostReply {
    if (!reply.ok) {
        throw new WorkbenchError(typeof reply.error === 'string' ? reply.error : 'The Workbench host reported an error.',
            typeof reply.code === 'string' ? reply.code : 'error');
    }
    return reply;
}

export function toStartResult(reply: HostReply): StartResult {
    assertOk(reply);
    return {
        config: isRecord(reply.config) ? reply.config : {},
        variables: isRecord(reply.variables) ? reply.variables : {}
    };
}

export function toStepResult(reply: HostReply): StepResult {
    assertOk(reply);
    const status = reply.status;
    if (status !== 'PASSED' && status !== 'FAILED' && status !== 'SKIPPED') {
        throw new WorkbenchError(`Unexpected step status from the host: ${String(status)}`, 'protocol');
    }
    const result: StepResult = {
        status,
        durationMs: typeof reply.durationMs === 'number' ? reply.durationMs : 0,
        variables: isRecord(reply.variables) ? reply.variables : {}
    };
    if (typeof reply.error === 'string') {
        result.error = reply.error;
    }
    if (isRecord(reply.response)) {
        const response = reply.response;
        result.response = {
            status: typeof response.status === 'number' ? response.status : 0,
            headers: isRecord(response.headers) ? response.headers : {},
            body: response.body,
            timeMs: typeof response.timeMs === 'number' ? response.timeMs : 0
        };
    }
    return result;
}
