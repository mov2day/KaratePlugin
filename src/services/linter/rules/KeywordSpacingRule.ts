import * as vscode from 'vscode';
import { LinterRule } from './Rule';

export class KeywordSpacingRule implements LinterRule {
    id = 'K008';
    name = 'Keyword Spacing';
    severity = vscode.DiagnosticSeverity.Error;

    check(document: vscode.TextDocument): vscode.Diagnostic[] {
        const diagnostics: vscode.Diagnostic[] = [];
        const text = document.getText();
        const lines = text.split('\n');

        const keywords = ['Given', 'When', 'Then', 'And'];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            for (const keyword of keywords) {
                // Check if line starts with Keyword but NO space immediately after
                // e.g. "Givenpath" matches "^Given[^\s]"
                const regex = new RegExp(`^\\s*${keyword}[^\\s]`);
                if (regex.test(line)) {
                    // It's a possible typo if the next char is not a colon (Scenario:)
                    if (!trimmed.startsWith('Scenario') && !trimmed.startsWith('Background')) {
                        const range = new vscode.Range(i, 0, i, line.length);
                        const diagnostic = new vscode.Diagnostic(
                            range,
                            `Missing space after keyword '${keyword}'. Example: '${keyword} path ...'`,
                            this.severity
                        );
                        diagnostic.code = this.id;
                        diagnostic.source = 'Karate Health';
                        diagnostics.push(diagnostic);
                    }
                }
            }
        }

        return diagnostics;
    }
}
