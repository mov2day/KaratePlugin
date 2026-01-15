import * as vscode from 'vscode';
import { LinterRule } from './Rule';

export class HardcodedUrlRule implements LinterRule {
    id = 'K001';
    name = 'Hardcoded URL';
    severity = vscode.DiagnosticSeverity.Warning;

    check(document: vscode.TextDocument): vscode.Diagnostic[] {
        const diagnostics: vscode.Diagnostic[] = [];
        const text = document.getText();
        const lines = text.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Regex to find 'Given url' followed by a string containing http/https
            // Example: Given url 'https://api.example.com'
            const match = line.match(/^\s*(Given\s+url\s+)(['"])(https?:\/\/[^'"]+)(['"])/);

            if (match) {
                const startPos = line.indexOf(match[3]);
                const endPos = startPos + match[3].length;
                const range = new vscode.Range(i, startPos, i, endPos);

                const diagnostic = new vscode.Diagnostic(
                    range,
                    'Avoid hardcoded URLs. Use configuration variables (e.g. karate-config.js) instead.',
                    this.severity
                );
                diagnostic.code = this.id;
                diagnostic.source = 'Karate Health';
                diagnostics.push(diagnostic);
            }
        }

        return diagnostics;
    }
}
