import * as vscode from 'vscode';
import { LinterRule } from './Rule';

export class DuplicateScenarioRule implements LinterRule {
    id = 'K002';
    name = 'Duplicate Scenario Name';
    severity = vscode.DiagnosticSeverity.Warning;

    check(document: vscode.TextDocument): vscode.Diagnostic[] {
        const diagnostics: vscode.Diagnostic[] = [];
        const text = document.getText();
        const lines = text.split('\n');

        const scenarioNames = new Map<string, number>(); // Name -> LineIndex

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            const match = line.match(/^\s*(Scenario:|Scenario Outline:)\s+(.*)$/);
            if (match) {
                const name = match[2].trim();
                if (name) {
                    if (scenarioNames.has(name)) {
                        const originalLine = scenarioNames.get(name)!;
                        const range = new vscode.Range(i, line.indexOf(name), i, line.length);
                        const diagnostic = new vscode.Diagnostic(
                            range,
                            `Duplicate Scenario name '${name}'. Used previously at line ${originalLine + 1}.`,
                            this.severity
                        );
                        diagnostic.code = this.id;
                        diagnostic.source = 'Karate Health';
                        diagnostics.push(diagnostic);
                    } else {
                        scenarioNames.set(name, i);
                    }
                }
            }
        }

        return diagnostics;
    }
}
