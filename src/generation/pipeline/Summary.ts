/** Pure, human-readable summary of a PipelineResult. No vscode, no logger. */
import type { Finding } from '../quality/QualityGate';
import type { PipelineResult } from './GenerationPipeline';

export interface GenerationSummary {
    headline: string;
    details: string[];
    /** 'warning' when gate errors, rejected refinements, side-by-side files or drafts need attention. */
    level: 'info' | 'warning';
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function groupByRule(findings: Finding[]): { ruleId: string; severity: string; count: number }[] {
    const map = new Map<string, { ruleId: string; severity: string; count: number }>();
    for (const f of findings) {
        const e = map.get(f.ruleId) ?? { ruleId: f.ruleId, severity: f.severity, count: 0 };
        e.count++;
        if (f.severity === 'error') {e.severity = 'error';}
        map.set(f.ruleId, e);
    }
    return [...map.values()].sort((a, b) => a.ruleId.localeCompare(b.ruleId));
}

/** Concatenate several pipeline results (batch runs) into one. */
export function mergeResults(results: PipelineResult[]): PipelineResult {
    const merged: PipelineResult = {
        written: { created: [], updated: [], skippedExisting: [], sideBySide: [] },
        features: [], draftScenarios: 0, warnings: [], gate: { errors: 0, warnings: 0 }
    };
    const addUnique = (target: string[], items: string[]): void => {
        for (const x of items) {if (!target.includes(x)) {target.push(x);}}
    };
    for (const r of results) {
        addUnique(merged.written.created, r.written.created);
        addUnique(merged.written.updated, r.written.updated);
        addUnique(merged.written.skippedExisting, r.written.skippedExisting);
        merged.written.sideBySide.push(...r.written.sideBySide);
        merged.features.push(...r.features);
        merged.draftScenarios += r.draftScenarios;
        merged.warnings.push(...r.warnings);
        merged.gate.errors += r.gate.errors;
        merged.gate.warnings += r.gate.warnings;
        if (r.dryRun) {merged.dryRun = r.dryRun;}
    }
    return merged;
}

export interface SummaryOptions {
    /** Features whose draft scenarios are expected (e.g. requirement drafts); they are listed but do not raise the level. */
    expectedDraftFeature?: (featurePath: string) => boolean;
}

export function formatSummary(r: PipelineResult, opts: SummaryOptions = {}): GenerationSummary {
    const w = r.written;
    const rejected = r.features.filter(f => f.refinement?.status === 'rejected');
    const parts: string[] = [];
    const total = w.created.length + w.updated.length;
    const featureCount = r.features.length;

    let head = total === 0 && w.sideBySide.length === 0
        ? 'No files were written'
        : `Generated ${plural(featureCount, 'feature file')}`;
    const counts: string[] = [];
    if (w.created.length) {counts.push(`${w.created.length} created`);}
    if (w.updated.length) {counts.push(`${w.updated.length} updated`);}
    if (counts.length) {head += ` (${counts.join(', ')})`;}
    parts.push(head);
    if (w.sideBySide.length) {parts.push(`${w.sideBySide.length} side-by-side (your edits kept)`);}
    if (r.gate.errors) {parts.push(plural(r.gate.errors, 'gate error'));}
    if (r.draftScenarios) {parts.push(plural(r.draftScenarios, 'draft scenario'));}
    if (rejected.length) {parts.push(`${rejected.length} AI refinement${rejected.length === 1 ? '' : 's'} rejected`);}
    const headline = parts.join(', ');

    const details: string[] = [];
    const list = (title: string, items: string[]): void => {
        if (!items.length) {return;}
        details.push(`${title} (${items.length})`);
        for (const i of items) {details.push(`  ${i}`);}
    };
    list('Created', w.created);
    list('Updated', w.updated);
    list('Kept as is (already exist, not overwritten)', w.skippedExisting);
    list('Side-by-side (you edited the original; review the .generated copy)', w.sideBySide.map(s => `${s.path} -> ${s.generatedPath}`));

    const groups = groupByRule(r.features.flatMap(f => f.findings));
    if (groups.length) {
        details.push('Quality gate findings');
        for (const g of groups) {details.push(`  ${g.ruleId} (${g.severity}) x${g.count}`);}
    }
    const drafts = r.features.filter(f => f.draft);
    if (r.draftScenarios || drafts.length) {
        details.push(`Draft scenarios: ${r.draftScenarios} marked @ignore until completed or fixed`);
        for (const f of drafts) {details.push(`  ${f.path}`);}
    }
    if (rejected.length) {
        details.push('AI refinement rejected (deterministic output kept)');
        for (const f of rejected) {
            const ids = [...new Set((f.refinement?.findings ?? []).map(x => x.ruleId))];
            details.push(`  ${f.path}: ${ids.join(', ') || 'no rule ids'}`);
        }
    }
    if (r.dryRun) {
        details.push(r.dryRun.status === 'skipped' ? `Dry run: skipped (${r.dryRun.message})` : `Dry run: ${r.dryRun.status}`);
        if (r.dryRun.status === 'failed') {
            details.push(`  ${r.dryRun.message}`);
            for (const f of r.dryRun.findings ?? []) {details.push(`  ${f.ruleId} line ${f.line}: ${f.message}`);}
        }
    }
    if (r.warnings.length) {
        details.push('Warnings');
        for (const x of r.warnings) {details.push(`  ${x}`);}
    }

    const unexpectedDrafts = r.features.some(f => f.draft && !(opts.expectedDraftFeature?.(f.path) ?? false));
    const level = r.gate.errors > 0 || rejected.length > 0 || w.sideBySide.length > 0 || unexpectedDrafts ? 'warning' : 'info';
    return { headline, details, level };
}
