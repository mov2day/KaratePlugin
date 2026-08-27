import * as vscode from 'vscode';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Logger } from '../../utils/logger';

export type TelemetryEventName =
    | 'activation' | 'activation_error' | 'migration_started' | 'migration_completed'
    | 'migration_failed' | 'webview_shell_error' | 'command_error' | 'history_lock_conflict'
    | 'ai_guardrail_triggered' | 'user_reported_bug';

export class TelemetryService {
    private readonly sessionId = randomUUID();

    constructor(private readonly context: vscode.ExtensionContext) { }

    send(name: TelemetryEventName, fields: Record<string, unknown> = {}): void {
        const config = vscode.workspace.getConfiguration('karateDsl');
        const enabled = config.get<boolean>('telemetry.enabled', false);
        const endpoint = config.get<string>('telemetry.endpoint', '').trim();
        if (!enabled || !vscode.env.isTelemetryEnabled || !endpoint) return;

        const payload = this.sanitize({
            event: name,
            version: this.context.extension.packageJSON.version,
            vscodeVersion: vscode.version,
            platform: process.platform,
            sessionId: this.sessionId,
            ...fields
        });
        void this.deliver(endpoint, payload);
    }

    private async deliver(endpoint: string, payload: Record<string, unknown>): Promise<void> {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 1500);
            await fetch(endpoint, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload), signal: controller.signal
            });
            clearTimeout(timeout);
        } catch {
            // Telemetry is deliberately invisible and must never change extension behavior.
        }
    }

    private sanitize(value: Record<string, unknown>): Record<string, unknown> {
        return this.sanitizeValue(value) as Record<string, unknown>;
    }

    private sanitizeValue(value: unknown): unknown {
        if (typeof value === 'string') {
            const redacted = Logger.redact(value);
            return redacted.replace(/(?:[A-Za-z]:)?[/\\][^\s:]+(?:[/\\][^\s:]+)*/g, match =>
                match.includes('\\') ? path.win32.basename(match) : path.basename(match));
        }
        if (Array.isArray(value)) return value.map(item => this.sanitizeValue(item));
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.sanitizeValue(item)]));
        }
        return value;
    }
}
