/**
 * AIProvider interface — abstraction over all AI backends.
 * All AI call sites program against this interface.
 */

export interface CompletionOptions {
    maxTokens?: number;
    temperature?: number;
    systemPrompt?: string;
}

export type AIProviderId = 'copilot' | 'claude-api' | 'ollama';

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
}
