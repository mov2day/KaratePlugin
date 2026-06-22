import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LinterRule } from './Rule';

interface TagHit {
    file: string;
    line: number;
}

export class DuplicateZephyrTagRule implements LinterRule {
    id = 'K011';
    name = 'Duplicate Zephyr Tag';
    severity = vscode.DiagnosticSeverity.Warning;

    check(document: vscode.TextDocument): vscode.Diagnostic[] {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            return [];
        }

        // ponytail: sync workspace scan; add an async cache if linting large repos gets slow.
        const hits = this.scanWorkspace(workspaceRoot);
        hits.forEach((tagHits, tag) => hits.set(tag, tagHits.filter(hit => hit.file !== document.fileName)));
        for (const [tag, tagHits] of this.scanText(document.fileName, document.getText())) {
            hits.set(tag, [...(hits.get(tag) || []), ...tagHits]);
        }

        const diagnostics: vscode.Diagnostic[] = [];
        const lines = document.getText().split('\n');

        for (let i = 0; i < lines.length; i++) {
            const tags = lines[i].match(/@zephyr-[A-Z][A-Z_0-9]+-T[0-9]+/ig) || [];
            for (const rawTag of tags) {
                const tag = rawTag.toUpperCase();
                const duplicates = (hits.get(tag) || [])
                    .filter(hit => hit.file !== document.fileName || hit.line !== i);
                if (duplicates.length === 0) {
                    continue;
                }

                const first = duplicates[0];
                const start = lines[i].toUpperCase().indexOf(tag);
                const range = new vscode.Range(i, start, i, start + rawTag.length);
                const diagnostic = new vscode.Diagnostic(
                    range,
                    `Duplicate Zephyr tag ${rawTag}. Also used in ${path.basename(first.file)}:${first.line + 1}.`,
                    this.severity
                );
                diagnostic.code = this.id;
                diagnostic.source = 'Karate Health';
                diagnostics.push(diagnostic);
            }
        }

        return diagnostics;
    }

    private scanWorkspace(root: string): Map<string, TagHit[]> {
        const hits = new Map<string, TagHit[]>();
        for (const file of this.findFeatureFiles(root)) {
            for (const [tag, tagHits] of this.scanText(file, fs.readFileSync(file, 'utf-8'))) {
                hits.set(tag, [...(hits.get(tag) || []), ...tagHits]);
            }
        }
        return hits;
    }

    private scanText(file: string, text: string): Map<string, TagHit[]> {
        const hits = new Map<string, TagHit[]>();
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const tags = lines[i].match(/@zephyr-[A-Z][A-Z_0-9]+-T[0-9]+/ig) || [];
            for (const rawTag of tags) {
                const tag = rawTag.toUpperCase();
                hits.set(tag, [...(hits.get(tag) || []), { file, line: i }]);
            }
        }
        return hits;
    }

    private findFeatureFiles(dir: string): string[] {
        const files: string[] = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'out') {
                continue;
            }

            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                files.push(...this.findFeatureFiles(fullPath));
            } else if (entry.isFile() && entry.name.endsWith('.feature')) {
                files.push(fullPath);
            }
        }
        return files;
    }
}
