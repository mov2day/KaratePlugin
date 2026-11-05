import * as vscode from 'vscode';
import { AIProviderRegistry } from '../ai/AIProviderRegistry';
import { buildPrompt, cleanCompletion, contextFrom, shouldSuggest } from './inlineSuggestionLogic';

export type Completer = (system: string, user: string, token: vscode.CancellationToken) => Promise<string | undefined>;

const DEBOUNCE_MS = 450;
const MAX_FILE_CHARS = 200_000;

const viaPluginProvider: Completer = (system, user, token) =>
    AIProviderRegistry.getInstance().completeQuiet(user, {
        task: 'general', systemPrompt: system, maxTokens: 120, temperature: 0, modelMode: 'efficient', cancellationToken: token
    });

/**
 * Copilot-style ghost-text suggestions for `karate-dsl`. Opt-in (karateDsl.language.inlineSuggestions.enabled), because
 * the surrounding file text is sent to the AI provider chosen in the extension's own settings. Never calls a model any other way.
 */
export class KarateInlineSuggestionProvider implements vscode.InlineCompletionItemProvider {
    private completer: Completer = viaPluginProvider;
    private readonly cache = new Map<string, string | undefined>();

    /** Test hook: replaces the model call. */
    setCompleter(completer: Completer | undefined): void {
        this.completer = completer ?? viaPluginProvider;
        this.cache.clear();
    }

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | undefined> {
        if (!vscode.workspace.isTrusted || document.languageId !== 'karate-dsl' || document.getText().length > MAX_FILE_CHARS) { return undefined; }
        if (!vscode.workspace.getConfiguration('karateDsl.language.inlineSuggestions', document.uri).get<boolean>('enabled', false)) { return undefined; }

        const lineText = document.lineAt(position.line).text;
        const linePrefix = lineText.slice(0, position.character);
        let previous: string | undefined;
        for (let i = position.line - 1; i >= 0 && i >= position.line - 20; i--) {
            if (document.lineAt(i).text.trim() !== '') { previous = document.lineAt(i).text; break; }
        }
        if (!shouldSuggest(linePrefix, lineText.slice(position.character), previous)) { return undefined; }

        const lines = document.getText().split(/\r?\n/);
        const context = contextFrom(lines, position.line, position.character);
        const key = `${document.uri.toString()}|${document.version}|${position.line}:${position.character}`;
        let completion: string | undefined;
        if (this.cache.has(key)) {
            completion = this.cache.get(key);
        } else {
            await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS));
            if (token.isCancellationRequested) { return undefined; }
            const { system, user } = buildPrompt(context);
            const raw = await this.completer(system, user, token);
            if (token.isCancellationRequested || !raw) { return undefined; }
            completion = cleanCompletion(raw, linePrefix);
            this.cache.set(key, completion);
            if (this.cache.size > 50) { this.cache.delete(this.cache.keys().next().value as string); }
        }
        if (!completion) { return undefined; }
        return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
    }
}
