import * as vscode from 'vscode';
import { LinterRule } from './Rule';
import { dedupeGateFindings, EQUIVALENT_LINTER_RULES, gateFindingsForText } from '../gateAdapter';

/** Surfaces quality-gate findings (V2-* ids) as diagnostics. Individual ids can be disabled via karate.linter.enabledRules. */
export class GateFindingsRule implements LinterRule {
    id = 'V2-GATE';
    name = 'Quality gate findings';
    severity = vscode.DiagnosticSeverity.Warning;

    /**
     * `peers` are the legacy rules (K001, S002) whose findings take precedence: a gate finding that
     * an enabled peer reports on the same line is skipped so the user sees one diagnostic, not two.
     */
    constructor(
        private readonly isEnabled: (ruleId: string) => boolean = () => true,
        private readonly peers: LinterRule[] = []
    ) {}

    private peerLines(document: vscode.TextDocument): Map<string, Set<number>> {
        const out = new Map<string, Set<number>>();
        const wanted = new Set(Object.values(EQUIVALENT_LINTER_RULES));
        for (const peer of this.peers) {
            if (!wanted.has(peer.id) || !this.isEnabled(peer.id)) {continue;}
            try {
                out.set(peer.id, new Set(peer.check(document).map(d => d.range.start.line + 1)));
            } catch {
                // A failing peer must not hide gate findings.
            }
        }
        return out;
    }

    check(document: vscode.TextDocument): vscode.Diagnostic[] {
        const lines = document.getText().split('\n');
        const findings = gateFindingsForText(document.getText(), document.fileName).filter(f => this.isEnabled(f.ruleId));
        return dedupeGateFindings(findings, this.peerLines(document))
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
