import * as vscode from 'vscode';
import { LinterRule } from './Rule';

export class EmptyScenarioRule implements LinterRule {
    id = 'K003';
    name = 'Empty Scenario';
    severity = vscode.DiagnosticSeverity.Information;

    check(document: vscode.TextDocument): vscode.Diagnostic[] {
        const diagnostics: vscode.Diagnostic[] = [];
        const text = document.getText();
        const lines = text.split('\n');

        let currentScenarioLine = -1;
        let hasSteps = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('@')) {
                continue;
            }

            if (trimmed.startsWith('Feature:') || trimmed.startsWith('Background:') || trimmed.startsWith('Rule:')) {
                // If we were inside a scenario, check if it was empty
                if (currentScenarioLine !== -1 && !hasSteps) {
                    this.addDiagnostic(diagnostics, currentScenarioLine, lines[currentScenarioLine]);
                }
                currentScenarioLine = -1;
                hasSteps = false;
                continue;
            }

            if (trimmed.startsWith('Scenario:') || trimmed.startsWith('Scenario Outline:')) {
                if (currentScenarioLine !== -1 && !hasSteps) {
                    this.addDiagnostic(diagnostics, currentScenarioLine, lines[currentScenarioLine]);
                }
                currentScenarioLine = i;
                hasSteps = false;
                continue;
            }

            // Check for steps (Given, When, Then, And, *)
            if (currentScenarioLine !== -1) {
                if (/^\s*(Given|When|Then|And|\*)\s+/.test(line)) {
                    hasSteps = true;
                }
            }
        }

        // Check last scenario
        if (currentScenarioLine !== -1 && !hasSteps) {
            this.addDiagnostic(diagnostics, currentScenarioLine, lines[currentScenarioLine]);
        }

        return diagnostics;
    }

    private addDiagnostic(diagnostics: vscode.Diagnostic[], lineIndex: number, lineText: string) {
        const range = new vscode.Range(lineIndex, 0, lineIndex, lineText.length);
        const diagnostic = new vscode.Diagnostic(
            range,
            'Scenario has no steps.',
            this.severity
        );
        diagnostic.code = this.id;
        diagnostic.source = 'Karate Health';
        diagnostics.push(diagnostic);
    }
}
