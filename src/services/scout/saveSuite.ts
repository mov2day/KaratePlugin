/** Pure Scout suite save: quality gate, demotion, protected write. No vscode. */
import { demoteGateFailures, gateScoutSuite } from '../../generation/adapters/scoutGate';
import type { ScoutGateFinding, ScoutSuiteLike } from '../../generation/adapters/scoutGate';
import type { GenerationSummary } from '../../generation/pipeline/Summary';
import { OutputWriter } from '../../generation/write/OutputWriter';
import type { HashStore, WritableFs, WriteFile, WriteReport } from '../../generation/write/OutputWriter';

const USER_OWNED = new Set(['scout-data.json', 'scout-setup.feature', 'scout-reset.feature']);

export interface ScoutSaveResult<T extends ScoutSuiteLike> {
    suite: T;
    report: WriteReport;
    findings: ScoutGateFinding[];
    demoted: string[];
    errors: number;
    warnings: number;
    summary: GenerationSummary;
}

export function saveScoutSuite<T extends ScoutSuiteLike>(suite: T, folder: string, journeyName: string, fsApi: WritableFs, history: HashStore, generatorVersion: string): ScoutSaveResult<T> {
    const { suite: final, demoted } = demoteGateFailures(suite);
    const findings = gateScoutSuite(final).findings;
    const errors = findings.filter(f => f.finding.severity === 'error').length;
    const warnings = findings.length - errors;
    const files: WriteFile[] = Object.entries(final.files).map(([name, content]) => ({
        path: `${folder.replace(/\/+$/, '')}/${name}`, content,
        owner: USER_OWNED.has(name) ? 'user' : 'generated',
        source: name === 'journey.feature' ? `scout:${journeyName}` : undefined
    }));
    const report = OutputWriter.write(files, fsApi, history, { generatorVersion });
    const details: string[] = [`Quality gate: ${errors} errors / ${warnings} warnings`];
    for (const f of findings) { details.push(`  ${f.finding.severity.toUpperCase()} ${f.file}:${f.finding.line} ${f.finding.ruleId} ${f.finding.message}`); }
    for (const d of demoted) { details.push(`  Demoted to draft: ${d}`); }
    for (const [label, list] of [['Created', report.created], ['Updated', report.updated], ['Kept as is', report.skippedExisting]] as const) {
        if (list.length) { details.push(`${label}: ${list.join(', ')}`); }
    }
    for (const s of report.sideBySide) { details.push(`Edited ${s.path} kept; new version at ${s.generatedPath}`); }
    const headline = `Saved ${final.runnableScenarios} enabled scenario(s). Quality gate: ${errors} errors / ${warnings} warnings.`;
    return { suite: final, report, findings, demoted, errors, warnings, summary: { headline, details, level: errors || demoted.length || report.sideBySide.length ? 'warning' : 'info' } };
}

/** Error shown when verification is attempted on a suite the gate demoted at save time. */
export function demotedMessage(demoted: string[]): string {
    return `Quality gate demoted ${demoted.join('; ')}; fix or remove and re-save before verifying.`;
}
