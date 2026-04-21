import * as vscode from 'vscode';
import { AIProvider, CompletionOptions } from './AIProvider';
import { logger } from '../../utils/logger';

/**
 * CopilotProvider — wraps existing CopilotService as an AIProvider.
 * Zero behaviour change for existing Copilot users.
 */
export class CopilotProvider implements AIProvider {
    readonly id = 'copilot' as const;
    readonly name = 'GitHub Copilot';

    private cachedModel: vscode.LanguageModelChat | undefined;

    async isAvailable(): Promise<boolean> {
        try {
            const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            return models.length > 0;
        } catch {
            return false;
        }
    }

    async complete(prompt: string, opts?: CompletionOptions): Promise<string> {
        const model = await this.getModel();
        if (!model) {
            throw new Error('GitHub Copilot is not available');
        }

        const messages: vscode.LanguageModelChatMessage[] = [];

        if (opts?.systemPrompt) {
            messages.push(vscode.LanguageModelChatMessage.User(opts.systemPrompt));
        }
        messages.push(vscode.LanguageModelChatMessage.User(prompt));

        const timeoutMs = 120_000;
        const cts = new vscode.CancellationTokenSource();
        const timer = setTimeout(() => cts.cancel(), timeoutMs);

        try {
            const response = await model.sendRequest(messages, {}, cts.token);

            let result = '';
            for await (const fragment of response.text) {
                result += fragment;
            }
            return result;
        } catch (error) {
            if (error instanceof vscode.CancellationError) {
                logger.warn('CopilotProvider: request timed out');
                return '';
            }
            throw error;
        } finally {
            clearTimeout(timer);
            cts.dispose();
        }
    }

    private async getModel(): Promise<vscode.LanguageModelChat | undefined> {
        if (this.cachedModel) {
            return this.cachedModel;
        }

        try {
            const { ConfigManager } = await import('../../utils/configManager');
            const family = ConfigManager.getCopilotModel();

            const models = await vscode.lm.selectChatModels({
                vendor: 'copilot',
                family
            });

            if (models.length > 0) {
                this.cachedModel = models[0];
                return this.cachedModel;
            }

            // Fallback: any copilot model
            const allModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            if (allModels.length > 0) {
                this.cachedModel = allModels[0];
                return this.cachedModel;
            }
        } catch (error) {
            logger.error('CopilotProvider: failed to get model', error as Error);
        }

        return undefined;
    }
}
