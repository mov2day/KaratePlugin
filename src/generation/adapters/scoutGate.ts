/** Pure quality-gate integration for Karate Scout suites. No vscode. */
import { parseFeature, runGate } from '../quality/QualityGate';
import type { Finding } from '../quality/QualityGate';

export interface ScoutSuiteLike {
    files: Record<string, string>;
    runnableScenarios: number;
    draftReasons: string[];
}

export interface ScoutGateFinding { file: string; finding: Finding }
export interface ScoutGateResult { findings: ScoutGateFinding[]; ok: boolean }

/** Rules Scout deliberately does not enforce. */
const SCOUT_IGNORED_RULES = new Set(['V2-ASSERT-002']);

export function gateScoutSuite(suite: Pick<ScoutSuiteLike, 'files'>): ScoutGateResult {
    const findings: ScoutGateFinding[] = [];
    try {
        const knownFiles = new Set(Object.keys(suite.files));
        for (const [file, text] of Object.entries(suite.files)) {
            if (!file.endsWith('.feature')) { continue; }
            for (const finding of runGate(text, { knownFiles }).findings) {
                if (!SCOUT_IGNORED_RULES.has(finding.ruleId)) { findings.push({ file, finding }); }
            }
        }
    } catch (error) {
        findings.push({ file: 'journey.feature', finding: { ruleId: 'SCOUT-GATE-FAIL', severity: 'error', line: 1, message: `Quality gate failed to run: ${error instanceof Error ? error.message : String(error)}` } });
    }
    return { findings, ok: !findings.some(f => f.finding.severity === 'error') };
}

const SCENARIO_RE = /^\s*Scenario(?: Outline)?:/;

/**
 * Demote scenarios of journey.feature that carry gate errors to `@ignore` drafts.
 * Errors that cannot be attributed to a scenario mark the whole Feature `@ignore`.
 * Never throws; returns the input untouched when nothing needs demoting.
 */
export function demoteGateFailures<T extends ScoutSuiteLike>(suite: T): { suite: T; demoted: string[] } {
    const demoted: string[] = [];
    try {
        let files = { ...suite.files };
        for (let pass = 0; pass < 20; pass++) {
            const errors = gateScoutSuite({ files }).findings.filter(f => f.finding.severity === 'error' && f.file === 'journey.feature');
            if (!errors.length) { break; }
            const lines = files['journey.feature'].split('\n');
            const scenarioStarts = lines.map((l, i) => SCENARIO_RE.test(l) ? i : -1).filter(i => i >= 0);
            const first = errors[0].finding;
            const parsed = parseFeature(files['journey.feature']);
            if (parsed.tags.some(t => t.name === '@ignore')) { break; }
            const startIndex = [...scenarioStarts].reverse().find(i => i + 1 <= first.line);
            const owner = startIndex === undefined ? undefined : parsed.scenarios.find(sc => sc.startLine === startIndex + 1);
            if (owner?.ignored) { break; }
            if (startIndex === undefined) {
                lines.unshift('@ignore', `# Draft: Quality gate: ${first.ruleId}`);
                demoted.push(`Feature: ${first.ruleId}`);
            } else {
                const indent = /^\s*/.exec(lines[startIndex])![0];
                lines.splice(startIndex, 0, `${indent}@ignore`, `${indent}# Draft: Quality gate: ${first.ruleId}`);
                demoted.push(`${lines[startIndex + 2].trim()} (${first.ruleId})`);
            }
            files = { ...files, 'journey.feature': lines.join('\n') };
        }
        if (!demoted.length) { return { suite, demoted }; }
        const runnable = parseFeature(files['journey.feature']).scenarios.filter(sc => !sc.ignored).length;
        const reasons = [...suite.draftReasons, ...demoted.map(d => `Quality gate demoted ${d}`)];
        return { suite: { ...suite, files, runnableScenarios: Math.min(suite.runnableScenarios, runnable), draftReasons: reasons }, demoted };
    } catch {
        return { suite, demoted: [] };
    }
}
