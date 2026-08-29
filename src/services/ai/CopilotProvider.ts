import * as vscode from 'vscode';
import { AIModelDescriptor, AIModelMode, AIProvider, CompletionOptions } from './AIProvider';
import { orderModelCandidates } from './ModelSelection';
import { logger } from '../../utils/logger';

class StaleLanguageModelError extends Error {}

/** GitHub Copilot adapter backed exclusively by live VS Code model discovery. */
export class CopilotProvider implements AIProvider {
    readonly id: 'copilot' | 'vscode-lm';
    readonly name: string;

    private models: vscode.LanguageModelChat[] | undefined;
    private lastSuccessfulModelId: string | undefined;
    private accessInformation: vscode.LanguageModelAccessInformation | undefined;

    constructor(private readonly vendor: 'copilot' | 'other-vscode' = 'copilot') {
        this.id = vendor === 'copilot' ? 'copilot' : 'vscode-lm';
        this.name = vendor === 'copilot' ? 'GitHub Copilot' : 'VS Code Language Model';
    }

    initialize(context: vscode.ExtensionContext): void {
        this.accessInformation = context.languageModelAccessInformation;
        context.subscriptions.push(vscode.lm.onDidChangeChatModels(() => {
            this.models = undefined;
            logger.info(`${this.name} availability changed; live model cache cleared`);
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
        const models = this.vendor === 'other-vscode'
            ? (await vscode.lm.selectChatModels()).filter(model => model.vendor !== 'copilot')
            : await this.discoverModels();
        return models.map(model => ({
            id: model.id,
            name: model.name,
            family: model.family,
            version: model.version,
            maxInputTokens: model.maxInputTokens,
            vendor: model.vendor
        }));
    }

    async complete(prompt: string, opts: CompletionOptions = {}): Promise<string> {
        const messages = this.createMessages(prompt, opts.systemPrompt);
        const discovered = await this.discoverModels(true);
        if (discovered.length === 0) {
            throw new Error(`${this.name} has no models available. Check provider sign-in, configuration, and policy access.`);
        }

        const config = vscode.workspace.getConfiguration('karateDsl');
        const mode = opts.modelMode ?? config.get<AIModelMode>('ai.modelMode', 'efficient');
        const configuredModelId = config.get<string>(this.vendor === 'copilot' ? 'ai.copilotModelId' : 'ai.vscodeModelId', '').trim();
        const legacyFamily = this.vendor === 'copilot' ? this.getExplicitLegacyFamily(config) : undefined;
        const exactModelId = configuredModelId || this.findLegacyModelId(discovered, legacyFamily);
        let ordered = await this.orderModels(discovered, messages, opts, mode, exactModelId);
        if (ordered.length === 0) {
            throw new Error('The AI request exceeds the context capacity of every available Copilot model. Reduce the selected source scope.');
        }

        if (!exactModelId && this.lastSuccessfulModelId) {
            const successful = ordered.findIndex(model => model.id === this.lastSuccessfulModelId);
            if (successful > 0) {
                ordered.unshift(...ordered.splice(successful, 1));
            }
        }

        let model = ordered[0];
        try {
            const result = await this.send(model, messages, opts);
            this.lastSuccessfulModelId = model.id;
            logger.info(`AI request completed via ${this.name} model ${model.name} (${model.id}, ${mode})`);
            return result;
        } catch (error) {
            if (!(error instanceof StaleLanguageModelError)) {
                throw error;
            }
            const refreshed = (await this.discoverModels(true)).filter(candidate =>
                candidate.id !== model.id
                && (mode === 'highest-quality' || candidate.maxInputTokens <= model.maxInputTokens * 2)
            );
            ordered = await this.orderModels(refreshed, messages, opts, mode);
            if (ordered.length === 0) {
                throw new Error('The selected language model disappeared and no comparable live model can fit this request.');
            }
            model = ordered[0];
            logger.warn(`Language model changed during the request; retrying once with ${model.name} (${model.id})`);
            const result = await this.send(model, messages, opts);
            this.lastSuccessfulModelId = model.id;
            return result;
        }
    }

    private async discoverModels(force = false): Promise<vscode.LanguageModelChat[]> {
        if (!force && this.models) {
            return this.models;
        }
        const allModels = await vscode.lm.selectChatModels(this.vendor === 'copilot' ? { vendor: 'copilot' } : undefined);
        if (this.vendor === 'copilot') {
            this.models = allModels;
        } else {
            const configuredVendor = vscode.workspace.getConfiguration('karateDsl').get<string>('ai.vscodeVendor', '').trim();
            this.models = allModels.filter(model => model.vendor !== 'copilot' && (!configuredVendor || model.vendor === configuredVendor));
        }
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

    private async orderModels(
        models: vscode.LanguageModelChat[],
        messages: vscode.LanguageModelChatMessage[],
        opts: CompletionOptions,
        mode: AIModelMode,
        exactModelId?: string
    ): Promise<vscode.LanguageModelChat[]> {
        const tokenCounts = new Map<string, number>();
        await Promise.all(models.map(async model => {
            try {
                let total = 0;
                for (const message of messages) {
                    total += await model.countTokens(message, opts.cancellationToken);
                }
                tokenCounts.set(model.id, total);
            } catch (error) {
                logger.warn(`Unable to count tokens for language model ${model.id}`, error as Error);
            }
        }));
        let ordered = orderModelCandidates(models, tokenCounts, mode, exactModelId);
        if (ordered.length === 0 && exactModelId) {
            logger.warn(`Configured language model '${exactModelId}' is unavailable or cannot fit the request; using ${mode} live selection`);
            ordered = orderModelCandidates(models, tokenCounts, mode);
        }
        return ordered;
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
                    throw new StaleLanguageModelError('The selected language model is no longer available.');
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
