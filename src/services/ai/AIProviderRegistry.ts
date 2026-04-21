import * as vscode from 'vscode';
import { AIProvider, AIProviderId } from './AIProvider';
import { CopilotProvider } from './CopilotProvider';
import { ClaudeAPIProvider } from './ClaudeAPIProvider';
import { OllamaProvider } from './OllamaProvider';
import { logger } from '../../utils/logger';

/**
 * Thrown when user chooses "Continue without AI" — callers should
 * return un-enhanced content instead of showing errors.
 */
export class AISkippedError extends Error {
    constructor() {
        super('AI skipped by user');
        this.name = 'AISkippedError';
    }
}

/**
 * AIProviderRegistry — singleton that resolves the active AI provider
 * based on user settings with automatic fallback.
 *
 * Error handling:
 * - Provider unavailable → falls back to next provider, then degrades with status bar warning
 * - Rate limit exceeded → dismissible notification with settings link
 * - Timeout → cancels after 120s, returns un-enhanced content
 */
export class AIProviderRegistry {
    private static instance: AIProviderRegistry;

    private providers = new Map<AIProviderId, AIProvider>();
    private claudeProvider: ClaudeAPIProvider;
    private statusBarItem: vscode.StatusBarItem | undefined;
    private aiSkippedForSession = false;

    private constructor() {
        this.providers.set('copilot', new CopilotProvider());
        this.claudeProvider = new ClaudeAPIProvider();
        this.providers.set('claude-api', this.claudeProvider);
        this.providers.set('ollama', new OllamaProvider());
    }

    static getInstance(): AIProviderRegistry {
        if (!AIProviderRegistry.instance) {
            AIProviderRegistry.instance = new AIProviderRegistry();
        }
        return AIProviderRegistry.instance;
    }

    /**
     * Reset the session skip flag. Call before explicit user-triggered AI actions
     * so a prior background dismiss doesn't silently block user intent.
     */
    resetSessionSkip(): void {
        this.aiSkippedForSession = false;
    }

    /**
     * Initialize with extension context (needed for SecretStorage)
     */
    initialize(context: vscode.ExtensionContext): void {
        this.claudeProvider.setSecretStorage(context.secrets);
    }

    /**
     * Get the Claude provider instance (for API key management commands)
     */
    getClaudeProvider(): ClaudeAPIProvider {
        return this.claudeProvider;
    }

    /**
     * Get the active provider based on settings, with fallback.
     * When user explicitly selects a provider (not "auto"), failing
     * provider shows a visible warning before falling back.
     * Throws AISkippedError if user chooses "Continue without AI".
     */
    async getProvider(): Promise<AIProvider> {
        // If user already chose to skip AI this session, don't prompt again
        if (this.aiSkippedForSession) {
            throw new AISkippedError();
        }

        const configured = this.getConfiguredProviderId();

        // Auto mode: try copilot first, then claude, then ollama
        if (configured === 'auto') {
            return this.resolveAutoProvider();
        }

        // Specific provider requested
        const provider = this.providers.get(configured);
        if (provider && await provider.isAvailable()) {
            return provider;
        }

        // Configured provider unavailable — warn user visibly
        const providerName = provider?.name || configured;
        logger.warn(`Configured provider '${configured}' unavailable`);

        const choice = await vscode.window.showWarningMessage(
            `⚠️ ${providerName} is not available. ${this.getUnavailableHint(configured)}`,
            'Use Another Provider',
            'Continue without AI',
            'Open Settings'
        );

        if (choice === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'karateDsl.ai.provider');
            throw new AISkippedError();
        }

        if (choice === 'Use Another Provider') {
            logger.info(`User chose fallback from unavailable ${providerName}`);
            try {
                return await this.resolveAutoProvider();
            } catch {
                // All providers down — skip AI
                throw new AISkippedError();
            }
        }

        if (choice === 'Continue without AI') {
            // Explicit skip — remember for rest of session
            logger.info('User explicitly chose to continue without AI for this session');
            this.aiSkippedForSession = true;
            throw new AISkippedError();
        }

        // Dismissed (closed notification) — skip this one call, ask again next time
        logger.info(`Notification dismissed for unavailable ${providerName}, will ask again next call`);
        throw new AISkippedError();
    }

    /**
     * Complete a prompt using the active provider with full error handling.
     */
    async complete(prompt: string, opts?: { maxTokens?: number; temperature?: number; systemPrompt?: string }): Promise<string> {
        try {
            const provider = await this.getProvider();
            const configured = this.getConfiguredProviderId();
            const note = configured !== 'auto' && configured !== provider.id
                ? ` (fallback from ${configured})`
                : '';
            logger.info(`AI request via ${provider.name}${note}`);
            return await provider.complete(prompt, opts);
        } catch (error: any) {
            if (error instanceof AISkippedError) {
                logger.info('AI skipped — returning empty response');
                return '';
            }
            return this.handleError(error);
        }
    }

    /**
     * Check if any AI provider is available
     */
    async isAnyAvailable(): Promise<boolean> {
        for (const provider of this.providers.values()) {
            if (await provider.isAvailable()) {
                return true;
            }
        }
        return false;
    }

    /**
     * Get all registered providers with their availability status
     */
    async getProviderStatus(): Promise<Array<{ id: AIProviderId; name: string; available: boolean }>> {
        const result = [];
        for (const provider of this.providers.values()) {
            result.push({
                id: provider.id,
                name: provider.name,
                available: await provider.isAvailable()
            });
        }
        return result;
    }

    private getConfiguredProviderId(): AIProviderId | 'auto' {
        const config = vscode.workspace.getConfiguration('karateDsl');
        const value = config.get<string>('ai.provider') || 'auto';
        if (value === 'auto' || value === 'copilot' || value === 'claude-api' || value === 'ollama') {
            return value;
        }
        return 'auto';
    }

    private getUnavailableHint(providerId: AIProviderId | 'auto'): string {
        switch (providerId) {
            case 'ollama':
                return 'Is Ollama running? Start it with `ollama serve`.';
            case 'claude-api':
                return 'API key not set. Use "Karate: Set Claude API Key" command.';
            case 'copilot':
                return 'GitHub Copilot not detected. Check your subscription.';
            default:
                return '';
        }
    }

    private async resolveAutoProvider(): Promise<AIProvider> {
        const order: AIProviderId[] = ['copilot', 'claude-api', 'ollama'];

        for (const id of order) {
            const provider = this.providers.get(id);
            if (provider && await provider.isAvailable()) {
                logger.info(`Auto-resolved AI provider: ${provider.name}`);
                return provider;
            }
        }

        // No provider available — show warning
        this.showNoProviderWarning();
        throw new Error('No AI provider available. Configure one in Settings → Karate DSL → AI Provider.');
    }

    private handleError(error: any): string {
        const message = (error?.message || '').toLowerCase();

        if (message.includes('rate limit') || message.includes('429') || message.includes('quota')) {
            vscode.window.showWarningMessage(
                '⚠️ AI provider rate limit exceeded. Try again later or switch providers.',
                'Open Settings'
            ).then(choice => {
                if (choice === 'Open Settings') {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'karateDsl.ai.provider');
                }
            });
            return '';
        }

        if (message.includes('timeout') || message.includes('cancelled')) {
            logger.warn('AI request timed out, returning empty');
            return '';
        }

        logger.error('AI provider error', error as Error);
        vscode.window.showErrorMessage(`AI provider error: ${error?.message || 'Unknown error'}`);
        return '';
    }

    private showNoProviderWarning(): void {
        if (!this.statusBarItem) {
            this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
            this.statusBarItem.text = '$(warning) No AI Provider';
            this.statusBarItem.tooltip = 'No AI provider available. Click to configure.';
            this.statusBarItem.command = 'workbench.action.openSettings';
        }
        this.statusBarItem.show();

        vscode.window.showWarningMessage(
            'No AI provider available. AI features will be disabled.',
            'Configure AI Provider'
        ).then(choice => {
            if (choice === 'Configure AI Provider') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'karateDsl.ai.provider');
            }
        });
    }
}
