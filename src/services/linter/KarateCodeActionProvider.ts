import * as vscode from 'vscode';

export class KarateCodeActionProvider implements vscode.CodeActionProvider {

    provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];

        for (const diagnostic of context.diagnostics) {
            if (diagnostic.source === 'Karate Health') {
                if (diagnostic.code === 'K008') { // Keyword Spacing
                    const fix = this.createSpacingFix(document, diagnostic);
                    if (fix) actions.push(fix);
                } else if (diagnostic.code === 'K006') { // Indentation
                    const fix = this.createIndentationFix(document, diagnostic);
                    if (fix) actions.push(fix);
                }
            }
        }

        // Add "AI Suggestion" action generically?
        // Only if line has some content
        if (!range.isEmpty) {
            const aiAction = new vscode.CodeAction('Copilot: Suggest Improvement', vscode.CodeActionKind.Refactor);
            // We would need a command to handle this
            aiAction.command = { command: 'karate-dsl.copilotSuggest', title: 'Suggest Improvement', arguments: [document, range] };
            actions.push(aiAction);
        }

        return actions;
    }

    private createSpacingFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction | undefined {
        const line = document.lineAt(diagnostic.range.start.line);
        // Identify missing space
        const keywords = ['Given', 'When', 'Then', 'And', '*'];
        // Find which keyword is mashed
        for (const kw of keywords) {
            const regex = new RegExp(`^\\s*(${kw})([^\\s])`);
            const match = line.text.match(regex);
            if (match) {
                const action = new vscode.CodeAction(`Insert space after ${kw}`, vscode.CodeActionKind.QuickFix);
                action.edit = new vscode.WorkspaceEdit();
                // Calculate position: Indentation + Keyword Length
                const insertPos = line.text.indexOf(match[1]) + match[1].length;
                const position = new vscode.Position(line.lineNumber, insertPos);
                action.edit.insert(document.uri, position, ' ');
                action.diagnostics = [diagnostic];
                return action;
            }
        }
        return undefined;
    }

    private createIndentationFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction | undefined {
        const action = new vscode.CodeAction('Fix indentation (2 spaces)', vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        const line = document.lineAt(diagnostic.range.start.line);
        const currentText = line.text.trimLeft(); // remove all leading space
        const newText = '  ' + currentText; // Add 2 spaces

        action.edit.replace(document.uri, line.range, newText);
        action.diagnostics = [diagnostic];
        return action;
    }
}
