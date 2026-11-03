import { HostResponse, WorkbenchError } from './SessionProtocol';
import { InsertionPoint } from './GherkinSteps';
import { maskDeep } from './Redaction';

/** State shared with the Workbench view, plus the small pure helpers around it. No vscode dependency. */

export interface PanelStep {
    text: string;
    status: 'PASSED' | 'FAILED' | 'SKIPPED';
    durationMs: number;
    error?: string;
}

export interface PanelResponse {
    status: number;
    timeMs: number;
    headers: unknown;
    body: unknown;
    /** False when the response comes from an earlier step. */
    fresh: boolean;
    /** True when assertions can be written for it. */
    assertable: boolean;
}

export interface PanelState {
    title: string;
    env: string;
    envs: string[];
    busy: string;
    notice: string;
    step?: PanelStep;
    response?: PanelResponse;
    variables: Record<string, unknown>;
}

export function emptyState(): PanelState {
    return { title: 'Karate Workbench', env: '', envs: [], busy: '', notice: '', variables: {} };
}

export function maskedResponse(response: HostResponse, fresh: boolean, assertable: boolean): PanelResponse {
    return {
        status: response.status,
        timeMs: response.timeMs,
        headers: maskDeep(response.headers),
        body: maskDeep(response.body),
        fresh,
        assertable
    };
}

export function maskedVariables(variables: Record<string, unknown>): Record<string, unknown> {
    return maskDeep(variables) as Record<string, unknown>;
}

/** Turns host and process errors into text a person can act on. */
export function friendlyError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const version = /class file version (\d+)/.exec(message);
    if (version) {
        const built = Number(version[1]) - 44;
        return `Your build compiled Java classes for Java ${built}, but Workbench is running an older Java. ` +
            `Set karateDsl.workbench.javaPath to a Java ${built}+ executable, or compile the tests for the Java that runs Karate (for example release 21).`;
    }
    if (error instanceof WorkbenchError) {
        if (error.code === 'spawn') {
            return `${message} Set karateDsl.workbench.javaPath if Java is not on your PATH.`;
        }
        return message;
    }
    return message;
}

/** True when the environment name or the configured base URL looks like production. */
export function isProductionContext(env: string, config: Record<string, unknown>, pattern: string): boolean {
    const text = pattern.trim();
    if (!text) {
        return false;
    }
    let expression: RegExp;
    try {
        expression = new RegExp(text, 'i');
    } catch {
        expression = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    if (expression.test(env)) {
        return true;
    }
    const url = ['baseUrl', 'url', 'apiUrl', 'host'].map(key => config[key]).find(value => typeof value === 'string') as string | undefined;
    if (!url) {
        return false;
    }
    try {
        return expression.test(new URL(url).hostname);
    } catch {
        return expression.test(url);
    }
}

export type InsertKind = 'match' | 'def' | 'status';

/** The text to insert after `point.afterLine`, with a leading newline. Multi-line steps keep the indentation. */
export function insertionText(point: InsertionPoint, kind: InsertKind, stepText: string): string {
    const keyword = kind === 'def' ? '*' : (point.hasAssertions ? 'And' : 'Then');
    const lines = stepText.split('\n');
    const first = `${point.indent}${keyword} ${lines[0]}`;
    const rest = lines.slice(1).map(line => `${point.indent}${line}`);
    return '\n' + [first, ...rest].join('\n');
}
