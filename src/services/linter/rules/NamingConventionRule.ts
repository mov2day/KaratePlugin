import * as vscode from 'vscode';
import { LinterRule } from './Rule';

export class NamingConventionRule implements LinterRule {
    id = 'K007';
    name = 'Naming Convention';
    severity = vscode.DiagnosticSeverity.Information;

    check(document: vscode.TextDocument): vscode.Diagnostic[] {
        const diagnostics: vscode.Diagnostic[] = [];
        const text = document.getText();
        const lines = text.split('\n');

        // Regex: * def variableName = ...
        // Capture group 2 is the variable name
        const defRegex = /^\s*(\*|Given|When|Then|And)?\s*def\s+([a-zA-Z0-9_-]+)\s*=/;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const match = line.match(defRegex);

            if (match) {
                const varName = match[2];
                // Check if snake_case (contains underscore) or PascalCase (starts with Upper)
                // camelCase: ^[a-z][a-zA-Z0-9]*$

                // Allow some special vars commonly used in Karate or strict JSON keys? 
                // But normally 'def' vars are internal.

                if (!/^[a-z][a-zA-Z0-9]*$/.test(varName)) {
                    const startPos = line.indexOf(varName);
                    const range = new vscode.Range(i, startPos, i, startPos + varName.length);
                    const diagnostic = new vscode.Diagnostic(
                        range,
                        `Variable '${varName}' should be in camelCase (e.g. 'myVariable').`,
                        this.severity
                    );
                    diagnostic.code = this.id;
                    diagnostic.source = 'Karate Health';
                    diagnostics.push(diagnostic);
                }
            }
        }

        return diagnostics;
    }
}
