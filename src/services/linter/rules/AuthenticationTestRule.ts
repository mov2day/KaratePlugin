import * as vscode from 'vscode';
import { LinterRule } from './Rule';

export class AuthenticationTestRule implements LinterRule {
    id = 'S001';
    name = 'Missing Authentication Test';
    severity = vscode.DiagnosticSeverity.Warning;

    check(document: vscode.TextDocument): vscode.Diagnostic[] {
        const diagnostics: vscode.Diagnostic[] = [];
        const text = document.getText();

        // Naive check: Does the file use Authorization headers?
        const hasAuth = /header\s+Authorization/i.test(text) || /Authorization\s*:/i.test(text);

        if (!hasAuth) {
            return diagnostics;
        }

        // Check if there are negative tests
        // Look for status 401 or status 403
        const hasNegativeAuthTest = /status\s+401/.test(text) || /status\s+403/.test(text);

        if (!hasNegativeAuthTest) {
            // Mark the top of the file
            const range = new vscode.Range(0, 0, 0, 0);
            const diagnostic = new vscode.Diagnostic(
                range,
                'Security Risk: File uses Authentication but seems to lack negative tests (status 401/403).',
                this.severity
            );
            diagnostic.code = this.id;
            diagnostic.source = 'Karate Security';
            diagnostics.push(diagnostic);
        }

        return diagnostics;
    }
}
