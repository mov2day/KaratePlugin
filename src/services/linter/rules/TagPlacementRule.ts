import * as vscode from 'vscode';
import { LinterRule } from './Rule';

export class TagPlacementRule implements LinterRule {
    id = 'K010';
    name = 'Tag Placement';
    severity = vscode.DiagnosticSeverity.Hint;

    check(document: vscode.TextDocument): vscode.Diagnostic[] {
        const diagnostics: vscode.Diagnostic[] = [];
        const text = document.getText();
        const lines = text.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Match Scenario/Feature definitions that HAVE tags on the same line
            // e.g. "Scenario: My test @smoke" or "@smoke Scenario: My test"
            // Wait, usually tags are:
            // @smoke
            // Scenario: ...

            // If we see a line containing "Scenario:" AND "@" on the SAME line, it's a violation?
            // Or if we see "@tag1 @tag2 Scenario:" -> This is valid Gherkin but maybe we prefer separate lines?
            // "Scenario: name @tag" is also supported by some runners but weird.

            // Let's enforce: Tags should be on their own line.
            // If a line has a tag AND (Scenario|Feature|Background), it's a violation.

            if (line.includes('@') && /^\s*(Scenario:|Feature:|Background:|Rule:|Scenario Outline:)/.test(line)) {

                // Exclude tags inside comments
                if (line.trim().startsWith('#')) continue;

                // Simple check: if @ appears before or after the keyword on same line
                const range = new vscode.Range(i, 0, i, line.length);
                const diagnostic = new vscode.Diagnostic(
                    range,
                    'Tags should be placed on a separate line above the element.',
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
