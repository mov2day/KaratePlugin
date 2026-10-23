import * as vscode from 'vscode';
import { LinterRule } from './Rule';
import { gateFindingsForText } from '../gateAdapter';

/** Surfaces quality-gate findings (V2-* ids) as diagnostics. Individual ids can be disabled via karate.linter.enabledRules. */
export class GateFindingsRule implements LinterRule {
    id = 'V2-GATE';
    name = 'Quality gate findings';
    severity = vscode.DiagnosticSeverity.Warning;

    constructor(private readonly isEnabled: (ruleId: string) => boolean = () => true) {}

    check(document: vscode.TextDocument): vscode.Diagnostic[] {
        const lines = document.getText().split('\n');
        return gateFindingsForText(document.getText(), document.fileName)
            .filter(f => this.isEnabled(f.ruleId))
            .map(f => {
                const idx = Math.max(0, Math.min(f.line - 1, lines.length - 1));
                const range = new vscode.Range(idx, 0, idx, (lines[idx] ?? '').length);
                const message = f.fix ? `${f.message}. ${f.fix}` : f.message;
                const d = new vscode.Diagnostic(range, message, f.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
                d.code = f.ruleId;
                d.source = 'Karate Gate';
                return d;
            });
    }
}
