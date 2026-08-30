import * as vscode from 'vscode';
import { AIModelDescriptor, AIProvider, AIProviderId, CompletionOptions } from './AIProvider';
import { CopilotProvider } from './CopilotProvider';
import { ClaudeAPIProvider } from './ClaudeAPIProvider';
import { OllamaProvider } from './OllamaProvider';
import { logger } from '../../utils/logger';
import { KaratePromptComposer } from './KaratePromptComposer';

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
 * AIProviderRegistry — singleton that resolves only the provider selected by
 * the user. Model fallback is delegated to that provider and never crosses a
 * provider boundary.
 *
 * Error handling:
 * - Provider unavailable → offers configuration or a non-AI continuation
 * - Rate limit exceeded → dismissible notification with settings link
 * - Timeout → cancels after 120s, returns un-enhanced content
 */
export class AIProviderRegistry {
    private static instance: AIProviderRegistry;

    private providers = new Map<AIProviderId, AIProvider>();
    private copilotProvider: CopilotProvider;
    private vscodeModelProvider: CopilotProvider;
    private claudeProvider: ClaudeAPIProvider;
    private aiSkippedForSession = false;

    private constructor() {
        this.copilotProvider = new CopilotProvider();
        this.providers.set('copilot', this.copilotProvider);
        this.vscodeModelProvider = new CopilotProvider('other-vscode');
        this.providers.set('vscode-lm', this.vscodeModelProvider);
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
        this.copilotProvider.initialize(context);
        this.vscodeModelProvider.initialize(context);
    }

    /**
     * Get the Claude provider instance (for API key management commands)
     */
    getClaudeProvider(): ClaudeAPIProvider {
        return this.claudeProvider;
    }

    /**
     * Get the active provider based on settings. The legacy "auto" value maps
     * to Copilot and never falls through to Claude or Ollama.
     * Throws AISkippedError if user chooses "Continue without AI".
     */
    async getProvider(): Promise<AIProvider> {
        // If user already chose to skip AI this session, don't prompt again
        if (this.aiSkippedForSession) {
            throw new AISkippedError();
        }

        const configured = this.getConfiguredProviderId();

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
            'Continue without AI',
            'Open Settings'
        );

        if (choice === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'karateDsl.ai.provider');
            throw new AISkippedError();
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
    async complete(prompt: string, opts: CompletionOptions = {}): Promise<string> {
        try {
            const provider = await this.getProvider();
            logger.info(`AI request via selected provider ${provider.name}`);
            const composed = KaratePromptComposer.compose(prompt, opts.task, opts.systemPrompt);
            return await provider.complete(composed.prompt, {
                ...opts,
                systemPrompt: composed.systemPrompt
            });
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

    async isConfiguredProviderAvailable(): Promise<boolean> {
        const configured = this.getConfiguredProviderId();
        return this.providers.get(configured)?.isAvailable() ?? false;
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

    async getModels(providerId?: AIProviderId): Promise<AIModelDescriptor[]> {
        const id = providerId ?? this.getConfiguredProviderId();
        const provider = this.providers.get(id);
        return provider?.listModels ? provider.listModels() : [];
    }

    private getConfiguredProviderId(): AIProviderId {
        const config = vscode.workspace.getConfiguration('karateDsl');
        const value = config.get<string>('ai.provider') || 'copilot';
        if (value === 'auto') {
            logger.info('Legacy AI provider value "auto" resolved to Copilot without cross-provider fallback');
            return 'copilot';
        }
        if (value === 'copilot' || value === 'vscode-lm' || value === 'claude-api' || value === 'ollama') {
            return value;
        }
        return 'copilot';
    }

    private getUnavailableHint(providerId: AIProviderId): string {
        switch (providerId) {
            case 'ollama':
                return 'Is Ollama running? Start it with `ollama serve`.';
            case 'claude-api':
                return 'API key not set. Use "Karate: Set Claude API Key" command.';
            case 'copilot':
                return 'GitHub Copilot not detected. Check your subscription.';
            case 'vscode-lm':
                return 'No non-Copilot VS Code language model provider is currently available.';
            default:
                return '';
        }
    }

    private handleError(error: any): string {
        const message = (error?.message || '').toLowerCase();

        if (message.includes('rate limit') || message.includes('429') || message.includes('quota')) {
            vscode.window.showWarningMessage(
                '⚠️ The selected AI provider has reached its rate limit. Try again later or choose another model from that provider.',
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

}
