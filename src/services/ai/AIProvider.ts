/**
 * AIProvider interface — abstraction over all AI backends.
 * All AI call sites program against this interface.
 */

export interface CompletionOptions {
    maxTokens?: number;
    temperature?: number;
    systemPrompt?: string;
    task?: AITask;
    modelMode?: AIModelMode;
    cancellationToken?: import('vscode').CancellationToken;
}

export type AIProviderId = 'copilot' | 'vscode-lm' | 'claude-api' | 'ollama';

export type AIModelMode = 'efficient' | 'balanced' | 'highest-quality';

export type AITask =
    | 'general'
    | 'generate-openapi'
    | 'generate-postman'
    | 'generate-har'
    | 'generate-requirements'
    | 'enhance-feature'
    | 'repair-scenario'
    | 'analyze-coverage'
    | 'generate-missing-test'
    | 'analyze-flakiness'
    | 'suggest-reusability';

export interface AIModelDescriptor {
    id: string;
    name: string;
    family?: string;
    version?: string;
    maxInputTokens?: number;
    vendor?: string;
}

export interface AIProvider {
    readonly id: AIProviderId;
    readonly name: string;

    /**
     * Check whether this provider is currently available
     * (API key set, service reachable, etc.)
     */
    isAvailable(): Promise<boolean>;

    /**
     * Send a prompt and return the completion text.
     */
    complete(prompt: string, opts?: CompletionOptions): Promise<string>;

    /** Discover models from the selected provider. Never return fabricated IDs. */
    listModels?(): Promise<AIModelDescriptor[]>;
}
