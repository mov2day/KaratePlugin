import * as vscode from 'vscode';

export class ConfigManager {
    /**
     * Get Confluence base URL from configuration
     */
    static getConfluenceBaseUrl(): string {
        const config = vscode.workspace.getConfiguration('karateDsl');
        const baseUrl = config.get<string>('confluence.baseUrl', '');

        if (!baseUrl) {
            throw new Error('Confluence base URL is not configured. Please set it in settings.');
        }

        return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    }

    /**
     * Get Confluence email from configuration
     */
    static getConfluenceEmail(): string {
        const config = vscode.workspace.getConfiguration('karateDsl');
        const email = config.get<string>('confluence.email', '');

        if (!email) {
            throw new Error('Confluence email is not configured. Please set it in settings.');
        }

        return email;
    }

    /**
     * Get or prompt for Confluence API token
     */
    static async getConfluenceApiToken(context: vscode.ExtensionContext): Promise<string> {
        // Try to get from secret storage
        let token = await context.secrets.get('confluence.apiToken');

        if (!token) {
            // Prompt user for token
            token = await vscode.window.showInputBox({
                prompt: 'Enter your Confluence API token',
                password: true,
                placeHolder: 'API token from https://id.atlassian.com/manage-profile/security/api-tokens'
            });

            if (!token) {
                throw new Error('Confluence API token is required');
            }

            // Save to secret storage
            await context.secrets.store('confluence.apiToken', token);
        }

        return token;
    }

    /**
     * Get test template style
     */
    static getTestTemplate(): 'standard' | 'detailed' | 'minimal' {
        const config = vscode.workspace.getConfiguration('karateDsl');
        return config.get<'standard' | 'detailed' | 'minimal'>('testTemplate', 'standard');
    }

    /**
     * Get output path
     */
    static getOutputPath(): string {
        const config = vscode.workspace.getConfiguration('karateDsl');
        return config.get<string>('outputPath', 'src/test/karate');
    }

    /**
     * Check if Copilot enhancement is enabled
     */
    static useCopilot(): boolean {
        const config = vscode.workspace.getConfiguration('karateDsl');
        return config.get<boolean>('useCopilot', false);
    }
}
