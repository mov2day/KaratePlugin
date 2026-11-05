import * as vscode from 'vscode';
import * as fs from 'fs';
import { EMPTY_FACTS, WorkspaceFacts } from './smartCompletions';

const MAX_FILES = 300;
const MAX_BYTES = 200_000;

/** Collects project-wide facts for suggestions (paths and tags used in other features, karate-config.js variables). Local only. */
export class WorkspaceFactsService implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private cached: Promise<WorkspaceFacts> | undefined;

    constructor() {
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.{feature,js}');
        const reset = (): void => { this.cached = undefined; };
        this.disposables.push(watcher, watcher.onDidChange(reset), watcher.onDidCreate(reset), watcher.onDidDelete(reset));
    }

    facts(): Promise<WorkspaceFacts> {
        if (!this.cached) { this.cached = this.collect().catch(() => EMPTY_FACTS); }
        return this.cached;
    }

    private async collect(): Promise<WorkspaceFacts> {
        const paths = new Set<string>();
        const tags = new Set<string>();
        const features = await vscode.workspace.findFiles('**/*.feature', '**/{node_modules,target,build,out}/**', MAX_FILES);
        for (const uri of features) {
            let text: string;
            try {
                if (fs.statSync(uri.fsPath).size > MAX_BYTES) { continue; }
                text = fs.readFileSync(uri.fsPath, 'utf8');
            } catch { continue; }
            for (const m of text.matchAll(/^\s*(?:\*|Given|When|Then|And|But)\s+path\s+['"]([^'"]+)['"]/gm)) { paths.add(m[1]); }
            for (const m of text.matchAll(/^\s*@([\w.-]+)/gm)) { tags.add(m[1]); }
        }
        const configVariables = new Set<string>();
        const configs = await vscode.workspace.findFiles('**/karate-config*.js', '**/node_modules/**', 5);
        for (const uri of configs) {
            try {
                const text = fs.readFileSync(uri.fsPath, 'utf8');
                for (const m of text.matchAll(/\bconfig\.([A-Za-z_]\w*)\s*=/g)) { configVariables.add(m[1]); }
                for (const m of text.matchAll(/\bconfig\s*=\s*\{([^}]*)\}/g)) {
                    for (const key of m[1].matchAll(/([A-Za-z_]\w*)\s*:/g)) { configVariables.add(key[1]); }
                }
            } catch { /* optional */ }
        }
        return { configVariables: [...configVariables], paths: [...paths], tags: [...tags] };
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }
}
