import * as vscode from 'vscode';
import axios from 'axios';
import { AIModelDescriptor, AIProvider, CompletionOptions } from './AIProvider';
import { logger } from '../../utils/logger';

/**
 * OllamaProvider — local inference via Ollama.
 * No API key needed. Requires Ollama running locally.
 */
export class OllamaProvider implements AIProvider {
    readonly id = 'ollama' as const;
    readonly name = 'Ollama (Local)';

    async isAvailable(): Promise<boolean> {
        try {
            return (await this.listModels()).length > 0;
        } catch {
            return false;
        }
    }

    async listModels(): Promise<AIModelDescriptor[]> {
        const response = await axios.get(`${this.getEndpoint()}/api/tags`, { timeout: 5000 });
        const models = Array.isArray(response.data?.models) ? response.data.models : [];
        return models.map((model: any) => ({
            id: String(model.model || model.name),
            name: String(model.name || model.model),
            family: model.details?.family
        })).filter((model: AIModelDescriptor) => model.id.length > 0);
    }

    async complete(prompt: string, opts?: CompletionOptions): Promise<string> {
        const endpoint = this.getEndpoint();
        const model = await this.getModel();

        const body: Record<string, unknown> = {
            model,
            prompt: opts?.systemPrompt ? `${opts.systemPrompt}\n\n${prompt}` : prompt,
            stream: false
        };

        if (opts?.temperature !== undefined) {
            body.options = { temperature: opts.temperature };
        }

        try {
            const response = await axios.post(`${endpoint}/api/generate`, body, {
                timeout: 120_000,
                headers: { 'Content-Type': 'application/json' }
            });

            return response.data?.response || '';
        } catch (error: any) {
            if (error.code === 'ECONNREFUSED') {
                logger.warn('OllamaProvider: Ollama not running');
                throw new Error('Cannot connect to Ollama. Make sure Ollama is running locally.');
            }
            logger.error('OllamaProvider: request failed', error as Error);
            throw error;
        }
    }

    private getEndpoint(): string {
        const config = vscode.workspace.getConfiguration('karateDsl');
        return config.get<string>('ai.ollamaEndpoint') || 'http://localhost:11434';
    }

    private async getModel(): Promise<string> {
        const config = vscode.workspace.getConfiguration('karateDsl');
        const configured = config.get<string>('ai.ollamaModel', '').trim();
        const models = await this.listModels();
        if (configured && models.some(model => model.id === configured || model.name === configured)) {
            return configured;
        }
        if (models.length === 0) {
            throw new Error('Ollama is running but has no installed models. Pull a model before using AI enhancement.');
        }
        return models[0].id;
    }
}
