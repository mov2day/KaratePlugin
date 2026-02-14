import * as vscode from 'vscode';

export class Logger {
    private outputChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Karate DSL Generator');
    }

    info(message: string): void {
        this.outputChannel.appendLine(`[INFO] ${new Date().toISOString()}: ${this.redact(message)}`);
    }

    error(message: string, error?: Error): void {
        this.outputChannel.appendLine(`[ERROR] ${new Date().toISOString()}: ${this.redact(message)}`);
        if (error) {
            this.outputChannel.appendLine(`  ${this.redact(error.message)}`);
            if (error.stack) {
                this.outputChannel.appendLine(`  ${this.redact(error.stack)}`);
            }
        }
    }

    warn(message: string, error?: Error): void {
        this.outputChannel.appendLine(`[WARN] ${new Date().toISOString()}: ${this.redact(message)}`);
        if (error) {
            this.outputChannel.appendLine(`  ${this.redact(error.message)}`);
        }
    }

    show(): void {
        this.outputChannel.show();
    }

    private redact(message: string): string {
        if (!message) return '';

        let redacted = message;
        // Bearer tokens
        redacted = redacted.replace(/(Bearer\s+)[a-zA-Z0-9\-\._~\+\/]+=*/g, '$1[REDACTED]');

        // Basic Email redaction
        redacted = redacted.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL_REDACTED]');

        // API Keys (basic patterns)
        redacted = redacted.replace(/(api[-_]?key|access[-_]?token)[:=]\s*["']?([a-zA-Z0-9_\-\.]{8,})["']?/gi, '$1: [REDACTED]');

        return redacted;
    }
}

export const logger = new Logger();
