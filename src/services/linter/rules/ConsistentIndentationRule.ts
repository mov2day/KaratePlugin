import * as vscode from 'vscode';
import { LinterRule } from './Rule';

export class ConsistentIndentationRule implements LinterRule {
    id = 'K006';
    name = 'Consistent Indentation';
    severity = vscode.DiagnosticSeverity.Warning;

    check(document: vscode.TextDocument): vscode.Diagnostic[] {
        const diagnostics: vscode.Diagnostic[] = [];
        const text = document.getText();
        const lines = text.split('\n');

        let insideScenario = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            if (trimmed.length === 0 || trimmed.startsWith('#')) {
                continue;
            }

            if (trimmed.startsWith('Scenario:') || trimmed.startsWith('Scenario Outline:')) {
                insideScenario = true;
                continue;
            } else if (trimmed.startsWith('Background:') || trimmed.startsWith('Feature:') || trimmed.startsWith('Rule:')) {
                insideScenario = false;
                continue;
            }

            if (insideScenario) {
                // Steps should be indented. Let's assume 2 spaces is the standard.
                // Keywords: Given, When, Then, And, *
                const stepMatch = line.match(/^(\s*)(Given|When|Then|And|\*)\s+/);
                if (stepMatch) {
                    const indentation = stepMatch[1];
                    if (indentation.length !== 2 && indentation.length !== 4) { // Allow 2 or 4, but warn if 0 or odd
                        if (indentation.length === 0) {
                            const range = new vscode.Range(i, 0, i, stepMatch[0].length);
                            const diagnostic = new vscode.Diagnostic(
                                range,
                                'Steps should be indented (typically 2 spaces).',
                                this.severity
                            );
                            diagnostic.code = this.id;
                            diagnostic.source = 'Karate Health';
                            diagnostics.push(diagnostic);
                        }
                    }
                }
            }
        }

        return diagnostics;
    }
}
