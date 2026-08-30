import * as vscode from 'vscode';
import axios from 'axios';
import { AIModelDescriptor, AIProvider, CompletionOptions } from './AIProvider';
import { logger } from '../../utils/logger';
import { classifyModel, orderModelCandidates } from './ModelSelection';
import { isUnsupportedModelRejection } from './ModelErrors';

/**
 * ClaudeAPIProvider — direct Anthropic API calls.
 * API key stored in VS Code SecretStorage.
 */
export class ClaudeAPIProvider implements AIProvider {
    readonly id = 'claude-api' as const;
    readonly name = 'Claude API (Anthropic)';

    private static readonly API_URL = 'https://api.anthropic.com/v1/messages';
    private static readonly MODELS_URL = 'https://api.anthropic.com/v1/models';
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

    async listModels(): Promise<AIModelDescriptor[]> {
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            return [];
        }
        try {
            const response = await axios.get(ClaudeAPIProvider.MODELS_URL, {
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': ClaudeAPIProvider.API_VERSION
                },
                timeout: 10_000
            });
            const models = Array.isArray(response.data?.data) ? response.data.data : [];
            return models.map((model: any) => ({
                id: String(model.id),
                name: String(model.display_name || model.id)
            })).filter((model: AIModelDescriptor) => model.id.length > 0);
        } catch (error) {
            logger.warn('ClaudeAPIProvider: unable to discover models', error as Error);
            return [];
        }
    }

    async complete(prompt: string, opts?: CompletionOptions): Promise<string> {
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            throw new Error('Claude API key not configured. Use the command palette to set your Anthropic API key.');
        }

        let model = await this.getModel(opts);
        const maxTokens = opts?.maxTokens ?? 4096;

        const messages: Array<{ role: string; content: string }> = [];

        messages.push({ role: 'user', content: prompt });

        try {
            try {
                return await this.sendRequest(apiKey, model, messages, maxTokens, opts);
            } catch (error) {
                if (!isUnsupportedModelRejection(error)) throw error;
                const fallback = await this.getModel(opts, model);
                if (fallback === model) throw error;
                logger.warn(`Claude rejected model '${model}'; retrying with '${fallback}' from the selected Claude provider`);
                model = fallback;
                return await this.sendRequest(apiKey, model, messages, maxTokens, opts);
            }
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

    private async sendRequest(
        apiKey: string,
        model: string,
        messages: Array<{ role: string; content: string }>,
        maxTokens: number,
        opts?: CompletionOptions
    ): Promise<string> {
        const body: Record<string, unknown> = {
            model,
            max_tokens: maxTokens,
            messages
        };
        if (opts?.systemPrompt) body.system = opts.systemPrompt;
        if (opts?.temperature !== undefined) body.temperature = opts.temperature;

        const response = await axios.post(ClaudeAPIProvider.API_URL, body, {
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': ClaudeAPIProvider.API_VERSION
            },
            timeout: 120_000
        });
        const content = response.data?.content;
        return Array.isArray(content)
            ? content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('')
            : '';
    }

    private async getModel(opts?: CompletionOptions, excludedModelId?: string): Promise<string> {
        const config = vscode.workspace.getConfiguration('karateDsl');
        const configured = config.get<string>('ai.claudeApiModel') || 'claude-sonnet-4-6';
        const models = (await this.listModels()).filter(model => model.id !== excludedModelId);
        if (models.length === 0) {
            return configured;
        }
        if (configured !== excludedModelId && models.some(model => model.id === configured)) return configured;

        const configuredProfile = classifyModel({ id: configured, name: configured, maxInputTokens: 1 });
        const profiled = models.map(model => ({
            model,
            profile: classifyModel({ id: model.id, name: model.name, family: model.family, maxInputTokens: 1 })
        }));
        const sameFamily = configuredProfile
            ? profiled.filter(item => item.profile?.family === configuredProfile.family)
            : [];
        const sameCapability = configuredProfile
            ? profiled.filter(item => item.profile?.capability === configuredProfile.capability && item.profile.cost === configuredProfile.cost)
            : [];

        let fallback = this.newestModel(sameFamily.map(item => item.model))
            || this.newestModel(sameCapability.map(item => item.model));

        if (!fallback) {
            const candidates = models.map(model => ({ ...model, maxInputTokens: Number.MAX_SAFE_INTEGER }));
            const counts = new Map(candidates.map(model => [model.id, 0]));
            const mode = opts?.modelMode ?? config.get<'efficient' | 'balanced' | 'highest-quality'>('ai.modelMode', 'efficient');
            fallback = orderModelCandidates(candidates, counts, mode, undefined, opts?.task)[0] || models[0];
        }

        logger.warn(`Claude model '${configured}' is unavailable; using '${fallback.id}' from the selected Claude provider`);
        return fallback.id;
    }

    private newestModel(models: AIModelDescriptor[]): AIModelDescriptor | undefined {
        return [...models].sort((left, right) => right.id.localeCompare(left.id, undefined, { numeric: true }))[0];
    }
}
