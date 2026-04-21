import * as vscode from 'vscode';
import axios from 'axios';
import { AIProvider, CompletionOptions } from './AIProvider';
import { logger } from '../../utils/logger';

/**
 * ClaudeAPIProvider — direct Anthropic API calls.
 * API key stored in VS Code SecretStorage.
 */
export class ClaudeAPIProvider implements AIProvider {
    readonly id = 'claude-api' as const;
    readonly name = 'Claude API (Anthropic)';

    private static readonly API_URL = 'https://api.anthropic.com/v1/messages';
    private static readonly SECRET_KEY = 'karateDsl.claude.apiKey';
    private static readonly API_VERSION = '2023-06-01';

    private secretStorage: vscode.SecretStorage | undefined;

    /**
     * Initialize with extension context's secret storage
     */
    setSecretStorage(storage: vscode.SecretStorage): void {
        this.secretStorage = storage;
    }

    async isAvailable(): Promise<boolean> {
        const apiKey = await this.getApiKey();
        return !!apiKey;
    }

    async complete(prompt: string, opts?: CompletionOptions): Promise<string> {
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            throw new Error('Claude API key not configured. Use the command palette to set your Anthropic API key.');
        }

        const model = this.getModel();
        const maxTokens = opts?.maxTokens ?? 4096;

        const messages: Array<{ role: string; content: string }> = [];

        messages.push({ role: 'user', content: prompt });

        const body: Record<string, unknown> = {
            model,
            max_tokens: maxTokens,
            messages
        };

        if (opts?.systemPrompt) {
            body.system = opts.systemPrompt;
        }

        if (opts?.temperature !== undefined) {
            body.temperature = opts.temperature;
        }

        try {
            const response = await axios.post(ClaudeAPIProvider.API_URL, body, {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': ClaudeAPIProvider.API_VERSION
                },
                timeout: 120_000
            });

            const content = response.data?.content;
            if (Array.isArray(content)) {
                return content
                    .filter((block: any) => block.type === 'text')
                    .map((block: any) => block.text)
                    .join('');
            }

            return '';
        } catch (error: any) {
            if (error.response?.status === 429) {
                logger.warn('ClaudeAPIProvider: rate limit exceeded');
                throw new Error('Claude API rate limit exceeded. Please try again later.');
            }
            if (error.response?.status === 401) {
                logger.warn('ClaudeAPIProvider: invalid API key');
                throw new Error('Claude API key is invalid. Please update your API key.');
            }
            logger.error('ClaudeAPIProvider: request failed', error as Error);
            throw error;
        }
    }

    /**
     * Store API key in VS Code SecretStorage
     */
    async setApiKey(key: string): Promise<void> {
        if (!this.secretStorage) {
            throw new Error('SecretStorage not initialized');
        }
        await this.secretStorage.store(ClaudeAPIProvider.SECRET_KEY, key);
        logger.info('Claude API key stored successfully');
    }

    /**
     * Remove stored API key
     */
    async clearApiKey(): Promise<void> {
        if (!this.secretStorage) {
            return;
        }
        await this.secretStorage.delete(ClaudeAPIProvider.SECRET_KEY);
        logger.info('Claude API key cleared');
    }

    private async getApiKey(): Promise<string | undefined> {
        if (!this.secretStorage) {
            return undefined;
        }
        return this.secretStorage.get(ClaudeAPIProvider.SECRET_KEY);
    }

    private getModel(): string {
        const config = vscode.workspace.getConfiguration('karateDsl');
        return config.get<string>('ai.claudeApiModel') || 'claude-sonnet-4-6';
    }
}
