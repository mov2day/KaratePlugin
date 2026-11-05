import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    FUZZY_MARKERS,
    MATCH_OPERATORS,
    STEP_KEYWORDS,
    completionContext
} from './karateCompletionContext';

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

/** Free completion for the `karate-dsl` language only. Never registered for the official `karate` id. */
export class KarateCompletionProvider implements vscode.CompletionItemProvider {
    static readonly triggerCharacters = [' ', '#', "'", '"', '/', ':'];

    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
        const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
        const context = completionContext(linePrefix);
        switch (context.kind) {
            case 'keyword': return this.keywords();
            case 'operator': return MATCH_OPERATORS.map(op => {
                const item = new vscode.CompletionItem(op, vscode.CompletionItemKind.Operator);
                item.detail = 'match operator';
                return item;
            });
            case 'marker': return FUZZY_MARKERS.map(marker => {
                const item = new vscode.CompletionItem(marker, vscode.CompletionItemKind.EnumMember);
                item.detail = 'fuzzy matcher';
                return item;
            });
            case 'path': return this.paths(document, position, context.prefix, context.classpath);
            default: return [];
        }
    }

    private keywords(): vscode.CompletionItem[] {
        const items = STEP_KEYWORDS.map(k => {
            const item = new vscode.CompletionItem(k.label, vscode.CompletionItemKind.Keyword);
            item.detail = k.detail;
            return item;
        });
        const snippet = (label: string, body: string, detail: string): vscode.CompletionItem => {
            const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
            item.insertText = new vscode.SnippetString(body);
            item.detail = detail;
            return item;
        };
        items.push(
            snippet('match response ==', 'match response == ${1}', 'Assert the whole response'),
            snippet('def (variable)', 'def ${1:name} = ${2}', 'Define a variable'),
            snippet("call read('')", "call read('${1}')", 'Call another feature'),
            snippet('configure headers', 'configure headers = ${1}', 'Set default headers')
        );
        return items;
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
