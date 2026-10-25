/** Pure adapter exposing the generation quality gate to the linter. No vscode import. */
import { runGate } from '../../generation/quality/QualityGate';
import type { Finding } from '../../generation/quality/QualityGate';

export interface GateLintFinding extends Finding {
    /** Quick-fix hint, when one can be computed mechanically. */
    quickFix?: { title: string; find: string; replacement: string };
}

const PARALLEL_FALSE = /@parallel\s*=\s*false/i;

/** Lock name derived from the feature file name, restricted to safe tag characters. */
export function lockNameFor(fileName: string): string {
    const base = (fileName.split(/[\\/]/).pop() ?? '').replace(/\.feature$/i, '');
    const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug || 'shared';
}

/** Run the gate on a feature text; findings keep their `V2-<AREA>-<NNN>` ids (lines are 1-based). */
export function gateFindingsForText(text: string, fileName = ''): GateLintFinding[] {
    return runGate(text).findings.map(f => {
        if (f.ruleId !== 'V2-LOCK-001') {return f;}
        const name = lockNameFor(fileName);
        return { ...f, quickFix: { title: `Replace with @lock=${name}`, find: PARALLEL_FALSE.source, replacement: `@lock=${name}` } };
    });
}

/** Apply a finding's quick fix to a single line of text; undefined when it does not apply. */
export function applyQuickFix(f: GateLintFinding, lineText: string): string | undefined {
    if (!f.quickFix) {return undefined;}
    const re = new RegExp(f.quickFix.find, 'i');
    return re.test(lineText) ? lineText.replace(re, f.quickFix.replacement) : undefined;
}

/** Gate rule -> legacy linter rule that reports the same concern on the same line. */
export const EQUIVALENT_LINTER_RULES: Readonly<Record<string, string>> = {
    'V2-CFG-001': 'K001', // hard-coded URL
    'V2-SEC-001': 'S002'  // hard-coded secret
};

/**
 * Drop gate findings already reported by an equivalent legacy rule on the same line.
 * `peerLines` maps a legacy rule id to the 1-based lines it reported.
 */
export function dedupeGateFindings<T extends Finding>(findings: T[], peerLines: ReadonlyMap<string, ReadonlySet<number>>): T[] {
    return findings.filter(f => {
        const peer = EQUIVALENT_LINTER_RULES[f.ruleId];
        return !(peer && peerLines.get(peer)?.has(f.line));
    });
}
