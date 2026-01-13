import * as vscode from 'vscode';

/**
 * Dedicated logger for Copilot transparency
 * Shows users exactly what data is sent to AI and what responses are received
 */
export class CopilotLogger {
    private static outputChannel: vscode.OutputChannel;
    private static statusBarItem: vscode.StatusBarItem;

    /**
     * Initialize the Copilot logger
     */
    public static initialize(context: vscode.ExtensionContext): void {
        this.outputChannel = vscode.window.createOutputChannel('Karate Copilot Activity');
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = 'karate.showCopilotActivity';
        context.subscriptions.push(this.outputChannel, this.statusBarItem);

        this.log('🤖 Copilot Activity Logger Initialized');
        this.log('All Copilot interactions will be logged here for transparency');
        this.log('---');
    }

    /**
     * Check if logging is enabled
     */
    private static isLoggingEnabled(): boolean {
        const config = vscode.workspace.getConfiguration('karate.copilot.logging');
        return config.get<boolean>('enabled', true);
    }

    /**
     * Check if sensitive data redaction is enabled
     */
    private static shouldRedactSensitiveData(): boolean {
        const config = vscode.workspace.getConfiguration('karate.copilot.logging');
        return config.get<boolean>('redactSensitiveData', true);
    }

    /**
     * Check if token usage should be shown
     */
    private static shouldShowTokenUsage(): boolean {
        const config = vscode.workspace.getConfiguration('karate.copilot.logging');
        return config.get<boolean>('showTokenUsage', true);
    }

    /**
     * Redact sensitive data from text
     */
    private static redactSensitiveData(text: string): string {
        if (!this.shouldRedactSensitiveData()) {
            return text;
        }

        let redacted = text;

        // Redact common API key patterns
        redacted = redacted.replace(/(['"]?api[_-]?key['"]?\s*[:=]\s*)['"][^'"]+['"]/gi, '$1"[REDACTED]"');
        redacted = redacted.replace(/(['"]?token['"]?\s*[:=]\s*)['"][^'"]+['"]/gi, '$1"[REDACTED]"');
        redacted = redacted.replace(/(['"]?password['"]?\s*[:=]\s*)['"][^'"]+['"]/gi, '$1"[REDACTED]"');
        redacted = redacted.replace(/(['"]?secret['"]?\s*[:=]\s*)['"][^'"]+['"]/gi, '$1"[REDACTED]"');

        // Redact Bearer tokens
        redacted = redacted.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, 'Bearer [REDACTED]');

        // Redact basic auth
        redacted = redacted.replace(/Basic\s+[A-Za-z0-9+/]+=*/g, 'Basic [REDACTED]');

        return redacted;
    }

    /**
     * Log a Copilot request
     */
    public static logRequest(operation: string, context: string, prompt: string): void {
        if (!this.isLoggingEnabled()) {
            return;
        }

        const timestamp = new Date().toLocaleString();
        const redactedPrompt = this.redactSensitiveData(prompt);

        this.log('');
        this.log(`[${timestamp}] 🤖 Copilot Request Started`);
        this.log(`Operation: ${operation}`);
        this.log(`Context: ${context}`);
        this.log(`Prompt Length: ${prompt.length.toLocaleString()} characters`);
        this.log('---');
        this.log('Prompt Preview (first 500 chars):');
        this.log(redactedPrompt.substring(0, 500) + (redactedPrompt.length > 500 ? '...' : ''));
        this.log('---');

        // Show activity in status bar
        this.statusBarItem.text = '$(loading~spin) Copilot Processing...';
        this.statusBarItem.show();
    }

    /**
     * Log a Copilot response
     */
    public static logResponse(
        operation: string,
        response: string,
        durationMs: number,
        tokensUsed?: { prompt: number; response: number; total: number }
    ): void {
        if (!this.isLoggingEnabled()) {
            return;
        }

        const timestamp = new Date().toLocaleString();
        const redactedResponse = this.redactSensitiveData(response);

        this.log('');
        this.log(`[${timestamp}] ✅ Copilot Response Received`);
        this.log(`Operation: ${operation}`);
        this.log(`Duration: ${(durationMs / 1000).toFixed(2)} seconds`);

        if (tokensUsed && this.shouldShowTokenUsage()) {
            this.log(`Tokens Used: ${tokensUsed.total.toLocaleString()} (prompt: ${tokensUsed.prompt.toLocaleString()}, response: ${tokensUsed.response.toLocaleString()})`);
        }

        this.log(`Response Length: ${response.length.toLocaleString()} characters`);
        this.log('---');
        this.log('Response Preview (first 500 chars):');
        this.log(redactedResponse.substring(0, 500) + (redactedResponse.length > 500 ? '...' : ''));
        this.log('---');

        // Hide status bar activity
        this.statusBarItem.hide();
    }

    /**
     * Log a Copilot error
     */
    public static logError(operation: string, error: Error, durationMs: number): void {
        if (!this.isLoggingEnabled()) {
            return;
        }

        const timestamp = new Date().toLocaleString();

        this.log('');
        this.log(`[${timestamp}] ❌ Copilot Request Failed`);
        this.log(`Operation: ${operation}`);
        this.log(`Duration: ${(durationMs / 1000).toFixed(2)} seconds`);
        this.log(`Error: ${error.message}`);
        this.log('---');

        // Hide status bar activity
        this.statusBarItem.hide();
    }

    /**
     * Log general message
     */
    private static log(message: string): void {
        this.outputChannel.appendLine(message);
    }

    /**
     * Show the Copilot activity log
     */
    public static show(): void {
        this.outputChannel.show();
    }

    /**
     * Clear the log
     */
    public static clear(): void {
        this.outputChannel.clear();
        this.log('🤖 Copilot Activity Log Cleared');
        this.log('---');
    }
}
