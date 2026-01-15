import * as vscode from 'vscode';
import { LinterRule } from './Rule';

export class HardcodedSecretRule implements LinterRule {
    id = 'S002';
    name = 'Hardcoded Secret';
    severity = vscode.DiagnosticSeverity.Error;

    check(document: vscode.TextDocument): vscode.Diagnostic[] {
        const diagnostics: vscode.Diagnostic[] = [];
        const text = document.getText();
        const lines = text.split('\n');

        // Regex for common secrets
        // def password = '...'
        // def token = '...'
        // def key = '...'
        const secretRegex = /def\s+(password|passwd|secret|token|apikey|api_key|access_token)\s*=\s*['"]([^'"]+)['"]/;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const match = line.match(secretRegex);

            if (match) {
                // If it looks like a variable reference (e.g. '#(someVar)'), ignore it
                const value = match[2];
                if (value.startsWith('#') || value.startsWith('call')) {
                    continue;
                }

                // If it's short/dummy, maybe ignore? But safer to warn.

                const range = new vscode.Range(i, 0, i, line.length);
                const diagnostic = new vscode.Diagnostic(
                    range,
                    'Security Risk: Hardcoded secret detected. Use karate-config.js or environment variables.',
                    this.severity
                );
                diagnostic.code = this.id;
                diagnostic.source = 'Karate Security';
                diagnostics.push(diagnostic);
            }
        }

        return diagnostics;
    }
}
