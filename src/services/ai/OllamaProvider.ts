import * as vscode from 'vscode';
import axios from 'axios';
import { AIProvider, CompletionOptions } from './AIProvider';
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
            const endpoint = this.getEndpoint();
            const response = await axios.get(`${endpoint}/api/tags`, { timeout: 5000 });
            return response.status === 200;
        } catch {
            return false;
        }
    }

    async complete(prompt: string, opts?: CompletionOptions): Promise<string> {
        const endpoint = this.getEndpoint();
        const model = this.getModel();

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

    private getModel(): string {
        const config = vscode.workspace.getConfiguration('karateDsl');
        return config.get<string>('ai.ollamaModel') || 'llama3';
    }
}
