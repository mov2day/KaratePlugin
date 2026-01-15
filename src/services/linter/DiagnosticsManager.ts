import * as vscode from 'vscode';

export class DiagnosticsManager {
    private diagnosticCollection: vscode.DiagnosticCollection;

    constructor() {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('karate-linter');
    }

    public updateDiagnostics(document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
        this.diagnosticCollection.set(document.uri, diagnostics);
    }

    public clearDiagnostics(document: vscode.TextDocument) {
        this.diagnosticCollection.delete(document.uri);
    }

    public dispose() {
        this.diagnosticCollection.dispose();
    }
}
