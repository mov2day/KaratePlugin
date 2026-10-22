import type { AITask } from '../../services/ai/AIProvider';
import type { GeneratorConfig } from '../config/GeneratorConfig';
import type { SourceKind } from '../model/TestModel';
import { parseFeature, runGate } from '../quality/QualityGate';
import type { Finding, ParsedFeature } from '../quality/QualityGate';
import { buildPrompt } from './PromptBuilder';
import type { SkillQuery, SkillSelection } from './SkillPack';

export type AiCall = (p: { system: string; user: string }) => Promise<string>;

/** Anything that can select skill text; SkillPack satisfies this. */
export interface SkillSource {
    select(q: SkillQuery): Pick<SkillSelection, 'text'>;
}

export interface RefineInput {
    feature: string;
    mode: SourceKind;
    task: AITask;
    evidence: { label: string; text: string }[];
    skills: SkillSource;
    ai: AiCall;
    /** Classpath files that exist; an empty set means unknown and disables the missing-file rule. */
    knownFiles: Set<string>;
    config: GeneratorConfig;
    request?: string;
}

export interface RefineResult {
    text: string;
    status: 'refined' | 'unchanged' | 'rejected';
    findings: Finding[];
    attempts: number;
}

/** Features with more scenarios than this are chunked when `config.ai.chunk === 'scenario'`. */
export const CHUNK_THRESHOLD = 40;
export const CHUNK_SIZE = 20;

const AI_RULES = {
    empty: 'V2-AI-001',
    dropped: 'V2-AI-002',
    invented: 'V2-AI-003',
    shape: 'V2-AI-004'
} as const;

const err = (ruleId: string, line: number, message: string): Finding => ({ ruleId, severity: 'error', line, message });

/** Remove markdown fences and any prose around the feature (from the first Feature line, keeping tags/comments above it). */
export function cleanOutput(raw: string): string {
    const lines = raw.replace(/\r\n/g, '\n').split('\n').filter(l => !/^\s*```/.test(l));
    const start = lines.findIndex(l => /^\s*Feature\s*:/.test(l));
    if (start < 0) return lines.join('\n').trim();
    let from = start;
    while (from > 0 && /^\s*(@|#)/.test(lines[from - 1])) from--;
    return lines.slice(from).join('\n').trim();
}

const sourceOf = (s: { comments: { text: string }[] }): string | undefined => {
    for (const c of s.comments) {
        const m = /^#\s*source:\s*(.+?)\s*$/i.exec(c.text);
        if (m) return m[1];
    }
    return undefined;
};

function missingScenarios(input: ParsedFeature, output: ParsedFeature): Finding[] {
    const keys = new Set<string>();
    for (const s of output.scenarios) {
        keys.add(s.name);
        const src = sourceOf(s);
        if (src) keys.add(src);
    }
    return input.scenarios
        .filter(s => {
            const src = sourceOf(s);
            return !keys.has(s.name) && !(src && keys.has(src));
        })
        .map(s => err(AI_RULES.dropped, s.startLine, `Scenario "${s.name}" from the input is missing from the output`));
}

const PATH_STEP = /^path\s+(.+)$/;
const WORDLIKE = /^[A-Za-z][A-Za-z_-]{2,}$/;

function pathSegments(arg: string): string[] {
    const out: string[] = [];
    for (const m of arg.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)) {
        const lit = m[1] ?? m[2];
        out.push(...lit.split('/').filter(Boolean));
    }
    return out;
}

function inventedFindings(output: ParsedFeature, outputText: string, known: string, knownFiles: Set<string>, haveEvidence: boolean): Finding[] {
    const findings: Finding[] = [];
    const haystack = known.toLowerCase();
    const steps = [...(output.background?.steps ?? []), ...output.scenarios.flatMap(s => s.steps)];
    if (haveEvidence) {
        for (const step of steps) {
            const m = PATH_STEP.exec(step.text);
            if (!m) continue;
            const bad = pathSegments(m[1]).find(seg => WORDLIKE.test(seg) && !haystack.includes(seg.toLowerCase()));
            if (bad) findings.push(err(AI_RULES.invented, step.line, `Path segment "${bad}" is not in the evidence or the input feature`));
        }
    }
    const lines = outputText.split('\n');
    lines.forEach((text, idx) => {
        for (const m of text.matchAll(/read\(\s*(['"])classpath:([^'"]+)\1/g)) {
            const target = m[2];
            if (!known.includes(target) && !knownFiles.has(target)) {
                findings.push(err(AI_RULES.invented, idx + 1, `classpath target "${target}" is not in the evidence, the input feature or the known files`));
            }
        }
    });
    return findings;
}

interface Attempt { text: string; problems: Finding[]; warnings: Finding[]; empty: boolean }

function check(raw: string, i: RefineInput, inputParsed: ParsedFeature, known: string): Attempt {
    const text = cleanOutput(raw);
    if (!text) return { text, problems: [err(AI_RULES.empty, 1, 'AI returned no usable output')], warnings: [], empty: true };
    const parsed = parseFeature(text);
    const problems: Finding[] = [];
    if (parsed.featureLine === undefined) {
        problems.push(err(AI_RULES.shape, 1, 'Output has no Feature: line'));
        return { text, problems, warnings: [], empty: false };
    }
    problems.push(...missingScenarios(inputParsed, parsed));
    problems.push(...inventedFindings(parsed, text, known, i.knownFiles, i.evidence.length > 0));
    const gate = runGate(text, { knownFiles: i.knownFiles.size ? i.knownFiles : undefined, config: i.config });
    problems.push(...gate.findings.filter(f => f.severity === 'error'));
    return { text, problems, warnings: gate.findings.filter(f => f.severity !== 'error'), empty: false };
}

async function refineWhole(i: RefineInput): Promise<RefineResult> {
    const skills = i.skills.select({ mode: i.mode, task: i.task }).text;
    const inputParsed = parseFeature(i.feature);
    const known = [i.feature, ...i.evidence.map(e => e.text)].join('\n');
    const base = { task: i.task, mode: i.mode, skills, evidence: i.evidence, request: i.request };

    const first = check(await i.ai(buildPrompt({ ...base, feature: i.feature })), i, inputParsed, known);
    if (first.empty) return { text: i.feature, status: 'rejected', findings: first.problems, attempts: 1 };
    let last = first;
    let attempts = 1;
    if (first.problems.length) {
        attempts = 2;
        last = check(await i.ai(buildPrompt({ ...base, feature: first.text, findings: first.problems })), i, inputParsed, known);
    }
    if (last.problems.length) return { text: i.feature, status: 'rejected', findings: last.problems, attempts };
    const unchanged = last.text.trim() === i.feature.trim();
    return { text: unchanged ? i.feature : last.text, status: unchanged ? 'unchanged' : 'refined', findings: last.warnings, attempts };
}

/** Line index where a scenario's tags/comments begin (contiguous lines directly above the Scenario line). */
function blockStart(lines: string[], scenarioLine: number): number {
    let from = scenarioLine - 1;
    while (from > 0 && /^\s*(@|#)/.test(lines[from - 1])) from--;
    return from;
}

async function refineChunked(i: RefineInput, parsed: ParsedFeature): Promise<RefineResult> {
    const lines = parsed.lines;
    const starts = parsed.scenarios.map(s => blockStart(lines, s.startLine));
    const header = lines.slice(0, starts[0]);
    const chunks: string[] = [];
    for (let g = 0; g < starts.length; g += CHUNK_SIZE) {
        const end = starts[g + CHUNK_SIZE] ?? lines.length;
        chunks.push([...header, ...lines.slice(starts[g], end)].join('\n'));
    }
    const pieces: string[] = [];
    const findings: Finding[] = [];
    let attempts = 0;
    let changed = false;
    for (let c = 0; c < chunks.length; c++) {
        const r = await refineWhole({ ...i, feature: chunks[c] });
        attempts += r.attempts;
        findings.push(...r.findings);
        if (r.status === 'rejected') return { text: i.feature, status: 'rejected', findings, attempts };
        if (r.status === 'refined') changed = true;
        if (c === 0) { pieces.push(r.text); continue; }
        // later chunks repeat the header; keep only their scenarios
        const out = parseFeature(r.text);
        const cut = out.scenarios.length ? blockStart(out.lines, out.scenarios[0].startLine) : 0;
        pieces.push(out.lines.slice(cut).join('\n'));
    }
    if (!changed) return { text: i.feature, status: 'unchanged', findings, attempts };
    return { text: pieces.join('\n'), status: 'refined', findings, attempts };
}

/** Ask the model to improve `feature`; the result is never worse: failures return the original feature as 'rejected'. */
export async function refine(i: RefineInput): Promise<RefineResult> {
    const parsed = parseFeature(i.feature);
    if (i.config.ai.chunk === 'scenario' && parsed.scenarios.length > CHUNK_THRESHOLD) return refineChunked(i, parsed);
    return refineWhole(i);
}
