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
