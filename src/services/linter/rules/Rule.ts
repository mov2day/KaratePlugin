import * as vscode from 'vscode';

export interface LinterRule {
    id: string;
    name: string;
    severity: vscode.DiagnosticSeverity;
    check(document: vscode.TextDocument): vscode.Diagnostic[];
}
