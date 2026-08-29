import * as vscode from 'vscode';
import { AIModelDescriptor, AIModelMode, AIProvider, CompletionOptions } from './AIProvider';
import { orderModelCandidates } from './ModelSelection';
import { logger } from '../../utils/logger';

/** GitHub Copilot adapter backed exclusively by live VS Code model discovery. */
export class CopilotProvider implements AIProvider {
    readonly id = 'copilot' as const;
    readonly name = 'GitHub Copilot';

    private models: vscode.LanguageModelChat[] | undefined;
    private lastSuccessfulModelId: string | undefined;
    private accessInformation: vscode.LanguageModelAccessInformation | undefined;

    initialize(context: vscode.ExtensionContext): void {
        this.accessInformation = context.languageModelAccessInformation;
        context.subscriptions.push(vscode.lm.onDidChangeChatModels(() => {
            this.models = undefined;
            logger.info('Copilot model availability changed; live model cache cleared');
        }));
    }

    async isAvailable(): Promise<boolean> {
        try {
            return (await this.discoverModels()).length > 0;
        } catch {
            return false;
        }
    }

    async listModels(): Promise<AIModelDescriptor[]> {
        return (await this.discoverModels()).map(model => ({
            id: model.id,
            name: model.name,
            family: model.family,
            version: model.version,
            maxInputTokens: model.maxInputTokens
        }));
    }

    async complete(prompt: string, opts: CompletionOptions = {}): Promise<string> {
        const messages = this.createMessages(prompt, opts.systemPrompt);
        const discovered = await this.discoverModels(true);
        if (discovered.length === 0) {
            throw new Error('GitHub Copilot has no models available. Check Copilot sign-in and policy access.');
        }

        const config = vscode.workspace.getConfiguration('karateDsl');
        const mode = opts.modelMode ?? config.get<AIModelMode>('ai.modelMode', 'efficient');
        const configuredModelId = config.get<string>('ai.copilotModelId', '').trim();
        const legacyFamily = this.getExplicitLegacyFamily(config);
        const exactModelId = configuredModelId || this.findLegacyModelId(discovered, legacyFamily);
        const tokenCounts = new Map<string, number>();

        await Promise.all(discovered.map(async model => {
            try {
                let total = 0;
                for (const message of messages) {
                    total += await model.countTokens(message, opts.cancellationToken);
                }
                tokenCounts.set(model.id, total);
            } catch (error) {
                logger.warn(`Unable to count tokens for Copilot model ${model.id}`, error as Error);
            }
        }));

        let ordered = orderModelCandidates(discovered, tokenCounts, mode, exactModelId);
        if (ordered.length === 0 && exactModelId) {
            logger.warn(`Configured Copilot model '${exactModelId}' is unavailable or cannot fit the request; using ${mode} live selection`);
            ordered = orderModelCandidates(discovered, tokenCounts, mode);
        }
        if (ordered.length === 0) {
            throw new Error('The AI request exceeds the context capacity of every available Copilot model. Reduce the selected source scope.');
        }

        if (!exactModelId && this.lastSuccessfulModelId) {
            const successful = ordered.findIndex(model => model.id === this.lastSuccessfulModelId);
            if (successful > 0) {
                ordered.unshift(...ordered.splice(successful, 1));
            }
        }

        const model = ordered[0];
        const result = await this.send(model, messages, opts);
        this.lastSuccessfulModelId = model.id;
        logger.info(`AI request completed via Copilot model ${model.name} (${model.id}, ${mode})`);
        return result;
    }

    private async discoverModels(force = false): Promise<vscode.LanguageModelChat[]> {
        if (!force && this.models) {
            return this.models;
        }
        this.models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        return this.models;
    }

    private createMessages(prompt: string, systemPrompt?: string): vscode.LanguageModelChatMessage[] {
        const messages: vscode.LanguageModelChatMessage[] = [];
        if (systemPrompt) {
            messages.push(vscode.LanguageModelChatMessage.User(systemPrompt));
        }
        messages.push(vscode.LanguageModelChatMessage.User(prompt));
        return messages;
    }

    private getExplicitLegacyFamily(config: vscode.WorkspaceConfiguration): string | undefined {
        const inspected = config.inspect<string>('copilot.model');
        const explicitlyConfigured = inspected?.workspaceFolderValue
            ?? inspected?.workspaceValue
            ?? inspected?.globalValue;
        return typeof explicitlyConfigured === 'string' && explicitlyConfigured.trim()
            ? explicitlyConfigured.trim()
            : undefined;
    }

    private findLegacyModelId(models: vscode.LanguageModelChat[], family?: string): string | undefined {
        if (!family) {
            return undefined;
        }
        return models.find(model => model.id === family || model.family === family)?.id;
    }

    private async send(
        model: vscode.LanguageModelChat,
        messages: vscode.LanguageModelChatMessage[],
        opts: CompletionOptions
    ): Promise<string> {
        const timeoutSource = new vscode.CancellationTokenSource();
        const timer = setTimeout(() => timeoutSource.cancel(), 120_000);
        const parentSubscription = opts.cancellationToken?.onCancellationRequested(() => timeoutSource.cancel());

        try {
            const access = this.accessInformation?.canSendRequest(model);
            if (access === false) {
                throw vscode.LanguageModelError.NoPermissions('Karate Test Management does not have permission to use this Copilot model.');
            }

            const response = await model.sendRequest(messages, {
                justification: 'Generate, analyze, or repair Karate API tests requested by the user.'
            }, timeoutSource.token);

            let result = '';
            for await (const fragment of response.text) {
                result += fragment;
            }
            return result;
        } catch (error) {
            if (error instanceof vscode.CancellationError || timeoutSource.token.isCancellationRequested) {
                throw new Error('AI request cancelled or timed out.');
            }
            if (error instanceof vscode.LanguageModelError) {
                if (error.code === vscode.LanguageModelError.NotFound().code) {
                    this.models = undefined;
                    throw new Error('The selected Copilot model is no longer available. Retry to use the refreshed model list.');
                }
                if (error.code === vscode.LanguageModelError.Blocked().code) {
                    throw new Error('Copilot blocked the request because of quota or policy. No higher-cost model was tried.');
                }
                if (error.code === vscode.LanguageModelError.NoPermissions().code) {
                    throw new Error('Copilot permission is required before this AI action can run.');
                }
            }
            throw error;
        } finally {
            clearTimeout(timer);
            parentSubscription?.dispose();
            timeoutSource.dispose();
        }
    }
}
