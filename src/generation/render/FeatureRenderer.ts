import type { KarateFeature, KarateScenario, KarateStep, KarateStyle } from '../../types';

export interface RenderOptions {
    style: KarateStyle;
    /** Comment lines rendered above `Feature:` (each as `# line`). */
    header?: string[];
    /** Feature-level tags, rendered on one line above `Feature:`. */
    featureTags?: string[];
}

// Depths (in levels of `style.indentation`): Feature 0; Background/Scenario/tags 1; steps 2.
const SCENARIO_DEPTH = 1;
const STEP_DEPTH = 2;

const pad = (style: KarateStyle, depth: number): string => (style.indentation || '  ').repeat(depth);

/**
 * Karate/Gherkin only supports `#` comments. A `commentStyle` of `doubleSlash` would
 * produce invalid feature files, so every style renders `#`.
 */
function comment(style: KarateStyle, depth: number, text: string): string {
    return text
        .split(/\r?\n/)
        .map(line => `${pad(style, depth)}# ${line}`.trimEnd())
        .join('\n');
}

const normalizeTag = (tag: string): string => (tag.startsWith('@') ? tag : `@${tag}`);

function blankLines(style: KarateStyle): string[] {
    return Array.from({ length: Math.max(0, Math.floor(style.lineSpacing || 0)) }, () => '');
}

function tableLines(rows: string[][], style: KarateStyle, depth: number): string[] {
    const widths: number[] = [];
    for (const row of rows) row.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, cell.length); });
    return rows.map(row => `${pad(style, depth)}| ${row.map((cell, i) => cell.padEnd(widths[i])).join(' | ')} |`);
}

export function renderStep(step: KarateStep, style: KarateStyle, depth: number = STEP_DEPTH): string {
    const lines = [`${pad(style, depth)}${step.keyword} ${step.text}`];
    if (step.docString !== undefined && step.docString !== '') {
        lines.push(`${pad(style, depth)}"""`);
        for (const body of step.docString.split('\n')) {
            lines.push(body === '' ? '' : `${pad(style, depth + 1)}${body}`);
        }
        lines.push(`${pad(style, depth)}"""`);
    } else if (step.table && step.table.length > 0) {
        lines.push(...tableLines(step.table, style, depth + 1));
    }
    return lines.join('\n');
}

export function renderScenario(s: KarateScenario, style: KarateStyle): string {
    const d = SCENARIO_DEPTH;
    const lines: string[] = [];

    const base = (s.tags ?? []).map(normalizeTag);
    const tags = [...new Set(s.draftReason !== undefined ? ['@ignore', ...base] : base)];
    if (tags.length > 0) lines.push(`${pad(style, d)}${tags.join(' ')}`);

    lines.push(`${pad(style, d)}${s.examples ? 'Scenario Outline' : 'Scenario'}: ${s.name}`);
    if (s.draftReason !== undefined) lines.push(comment(style, STEP_DEPTH, `Draft: ${s.draftReason}`));
    if (s.description) lines.push(comment(style, STEP_DEPTH, s.description));
    if (s.source) lines.push(comment(style, STEP_DEPTH, `source: ${s.source}`));
    // KarateScenario.comments carries no step index, so they sit under the header, before the first step.
    for (const c of s.comments ?? []) lines.push(comment(style, STEP_DEPTH, c));

    for (const step of s.steps) lines.push(renderStep(step, style, STEP_DEPTH));

    if (s.examples) {
        lines.push('');
        lines.push(`${pad(style, STEP_DEPTH)}Examples:`);
        lines.push(...tableLines([s.examples.columns, ...s.examples.rows], style, STEP_DEPTH + 1));
    }
    return lines.join('\n');
}

export function renderFeature(feature: KarateFeature, opts: RenderOptions): string {
    const { style } = opts;
    const lines: string[] = [];
    const gap = blankLines(style);

    for (const h of opts.header ?? []) lines.push(comment(style, 0, h));
    if (opts.featureTags && opts.featureTags.length > 0) lines.push(opts.featureTags.map(normalizeTag).join(' '));
    lines.push(`Feature: ${feature.name}`);
    for (const d of feature.description ? feature.description.split('\n') : []) {
        lines.push(`${pad(style, 1)}${d}`);
    }

    const blocks: string[][] = [];
    if (feature.background) {
        blocks.push([
            `${pad(style, SCENARIO_DEPTH)}Background:`,
            ...feature.background.steps.map(step => renderStep(step, style, STEP_DEPTH))
        ]);
    }
    for (const s of feature.scenarios) blocks.push([renderScenario(s, style)]);

    for (const block of blocks) {
        lines.push(...gap, ...block);
    }
    return `${lines.join('\n')}\n`;
}
