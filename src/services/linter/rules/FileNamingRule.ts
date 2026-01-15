import * as vscode from 'vscode';
import path from 'path';
import { LinterRule } from './Rule';

export class FileNamingRule implements LinterRule {
    id = 'K009';
    name = 'File Naming';
    severity = vscode.DiagnosticSeverity.Information;

    check(document: vscode.TextDocument): vscode.Diagnostic[] {
        const diagnostics: vscode.Diagnostic[] = [];

        const fileName = path.basename(document.fileName);
        if (!fileName.endsWith('.feature')) {
            return diagnostics;
        }

        const nameWithoutExt = fileName.replace('.feature', '');

        // Check for kebab-case: lowercase letters, numbers, and hyphens only.
        // Must start with letter/number.
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(nameWithoutExt)) {
            // Mark the first line of the file since we can't mark the file itself comfortably in editor diagnostics
            const range = new vscode.Range(0, 0, 0, 0);
            const diagnostic = new vscode.Diagnostic(
                range,
                `Feature file '${fileName}' should be kebab-case (e.g. 'user-profile.feature').`,
                this.severity
            );
            diagnostic.code = this.id;
            diagnostic.source = 'Karate Health';
            // This applies to the file, but we show it at top of file
            diagnostics.push(diagnostic);
        }

        return diagnostics;
    }
}
