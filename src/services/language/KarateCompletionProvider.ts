import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { smartContext } from './smart/smartContext';
import { SmartItem, inlineSuggestion, smartItems } from './smart/smartCompletions';
import { WorkspaceFactsService } from './smart/WorkspaceFacts';
import { foldingRanges } from './smart/folding';

const FILE_EXTENSIONS = new Set(['.feature', '.json', '.js', '.csv', '.yaml', '.yml', '.xml', '.txt', '.graphql']);
const IGNORED_DIRS = new Set(['node_modules', 'target', 'build', 'out', '.git']);
const MAX_ITEMS = 200;
const FALLBACK_ROOTS = ['src/test/java', 'src/test/resources'];

function listFiles(root: string, budget: number): string[] {
    const found: string[] = [];
    const walk = (dir: string): void => {
        if (found.length >= budget) { return; }
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (found.length >= budget) { return; }
            if (entry.isDirectory()) {
                if (!IGNORED_DIRS.has(entry.name)) { walk(path.join(dir, entry.name)); }
            } else if (FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                found.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'));
            }
        }
    };
    walk(root);
    return found;
}

function classpathRoots(workspaceRoot: string): string[] {
    const roots: string[] = [];
    try {
        const raw = fs.readFileSync(path.join(workspaceRoot, '.karate-generator.json'), 'utf8');
        const configured = (JSON.parse(raw) as { layout?: { classpathRoot?: unknown } }).layout?.classpathRoot;
        if (typeof configured === 'string' && configured.trim()) { roots.push(configured); }
    } catch { /* optional file */ }
    roots.push(...FALLBACK_ROOTS);
    return roots.map(r => path.resolve(workspaceRoot, r)).filter(r => fs.existsSync(r));
}

const KIND: Record<SmartItem['kind'], vscode.CompletionItemKind> = {
    keyword: vscode.CompletionItemKind.Keyword,
    snippet: vscode.CompletionItemKind.Snippet,
    operator: vscode.CompletionItemKind.Operator,
    marker: vscode.CompletionItemKind.EnumMember,
    variable: vscode.CompletionItemKind.Variable,
    function: vscode.CompletionItemKind.Function,
    property: vscode.CompletionItemKind.Property,
    value: vscode.CompletionItemKind.Value,
    tag: vscode.CompletionItemKind.Reference
};

/**
 * Built-in smart completion for the `karate-dsl` language only (never the official `karate` id).
 * Everything runs locally from the open file, the project's other features and karate-config.js; no model and no network.
 */
export class KarateCompletionProvider implements vscode.CompletionItemProvider {
    static readonly triggerCharacters = [' ', '#', "'", '"', '/', ':', '.', '@', '('];

    constructor(private readonly facts?: WorkspaceFactsService) {}

    async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
        const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
        const context = smartContext(linePrefix);
        if (context.kind === 'path') {
            return this.paths(document, position, context.prefix, context.classpath);
        }
        if (context.kind === 'none') { return []; }
        const lines = document.getText().split(/\r?\n/);
        const facts = this.facts ? await this.facts.facts() : undefined;
        return smartItems(context, lines, position.line, facts).map(item => {
            const completion = new vscode.CompletionItem(item.label, KIND[item.kind]);
            completion.detail = item.detail;
            completion.sortText = item.sortText;
            if (item.snippet) {
                completion.insertText = new vscode.SnippetString(item.insertText ?? item.label);
            } else if (item.insertText !== undefined) {
                completion.insertText = item.insertText;
            }
            if (item.replaceTyped !== undefined) {
                completion.range = new vscode.Range(position.line, position.character - item.replaceTyped, position.line, position.character);
            }
            return completion;
        });
    }

    private paths(document: vscode.TextDocument, position: vscode.Position, prefix: string, classpath: boolean): vscode.CompletionItem[] {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        const roots = classpath
            ? (folder ? classpathRoots(folder.uri.fsPath) : [])
            : [path.dirname(document.uri.fsPath)];
        const seen = new Set<string>();
        const items: vscode.CompletionItem[] = [];
        for (const root of roots) {
            for (const rel of listFiles(root, MAX_ITEMS)) {
                if (seen.has(rel) || items.length >= MAX_ITEMS) { continue; }
                seen.add(rel);
                const item = new vscode.CompletionItem(rel, vscode.CompletionItemKind.File);
                // Replace what has been typed after the opening quote (and the classpath: prefix).
                item.range = new vscode.Range(position.line, position.character - prefix.length, position.line, position.character);
                items.push(item);
            }
        }
        return items;
    }
}

/** Ghost-text prediction of the next step from workflow rules and patterns in the same file. No model, nothing leaves the machine. */
export class KarateSmartInlineProvider implements vscode.InlineCompletionItemProvider {
    constructor(private readonly facts?: WorkspaceFactsService) {}

    async provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.InlineCompletionItem[] | undefined> {
        if (document.languageId !== 'karate-dsl') { return undefined; }
        if (!vscode.workspace.getConfiguration('karateDsl.language', document.uri).get<boolean>('smartSuggestions', true)) { return undefined; }
        const text = inlineSuggestion(document.getText().split(/\r?\n/), position.line, position.character, this.facts ? await this.facts.facts() : undefined);
        return text ? [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))] : undefined;
    }
}

/** Folds Feature, Rule, Background, Scenario, Scenario Outline, Examples and doc-strings. */
export class KarateFoldingProvider implements vscode.FoldingRangeProvider {
    provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
        return foldingRanges(document.getText().split(/\r?\n/)).map(range => new vscode.FoldingRange(range.start, range.end, vscode.FoldingRangeKind.Region));
    }
}
