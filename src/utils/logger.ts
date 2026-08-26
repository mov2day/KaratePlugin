import * as vscode from 'vscode';

export class Logger {
    private outputChannel: vscode.OutputChannel;
    private readonly recentLines: string[] = [];
    private static readonly RECENT_LINE_LIMIT = 200;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Karate DSL Generator');
    }

    info(message: string): void {
        this.write(`[INFO] ${new Date().toISOString()}: ${Logger.redact(message)}`);
    }

    error(message: string, error?: Error): void {
        this.write(`[ERROR] ${new Date().toISOString()}: ${Logger.redact(message)}`);
        if (error) {
            this.write(`  ${Logger.redact(error.message)}`);
            if (error.stack) {
                this.write(`  ${Logger.redact(error.stack)}`);
            }
        }
    }

    warn(message: string, error?: Error): void {
        this.write(`[WARN] ${new Date().toISOString()}: ${Logger.redact(message)}`);
        if (error) {
            this.write(`  ${Logger.redact(error.message)}`);
        }
    }

    show(): void {
        this.outputChannel.show();
    }

    getRecentLines(): string[] {
        return [...this.recentLines];
    }

    private write(line: string): void {
        this.outputChannel.appendLine(line);
        this.recentLines.push(line);
        if (this.recentLines.length > Logger.RECENT_LINE_LIMIT) this.recentLines.splice(0, this.recentLines.length - Logger.RECENT_LINE_LIMIT);
    }

    static redact(message: string): string {
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
