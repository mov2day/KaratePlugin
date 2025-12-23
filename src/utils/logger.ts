import * as vscode from 'vscode';

export class Logger {
    private outputChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Karate DSL Generator');
    }

    info(message: string): void {
        this.outputChannel.appendLine(`[INFO] ${new Date().toISOString()}: ${message}`);
    }

    error(message: string, error?: Error): void {
        this.outputChannel.appendLine(`[ERROR] ${new Date().toISOString()}: ${message}`);
        if (error) {
            this.outputChannel.appendLine(`  ${error.message}`);
            if (error.stack) {
                this.outputChannel.appendLine(`  ${error.stack}`);
            }
        }
    }

    warn(message: string, error?: Error): void {
        this.outputChannel.appendLine(`[WARN] ${new Date().toISOString()}: ${message}`);
        if (error) {
            this.outputChannel.appendLine(`  ${error.message}`);
        }
    }

    show(): void {
        this.outputChannel.show();
    }
}

export const logger = new Logger();
