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
    shape: 'V2-AI-004',
    docstring: 'V2-AI-005',
    undrafted: 'V2-AI-006'
} as const;

const err = (ruleId: string, line: number, message: string): Finding => ({ ruleId, severity: 'error', line, message });

/**
 * New docstring state after `line`. A trimmed line starting with `"""` toggles; outside a docstring a step line that
 * ends with a single `"""` (Karate's inline opener, `* text x = """`) opens one.
 */
function docToggle(line: string, inDoc: boolean): boolean {
    const t = line.trim();
    if (t.startsWith('"""')) {return !inDoc;}
    if (!inDoc && t.endsWith('"""') && t.split('"""').length === 2) {return true;}
    return inDoc;
}

/** Line (1-based) of a docstring opener that is never closed, if any. */
export function unterminatedDocstring(text: string): number | undefined {
    let inDoc = false;
    let opener = 0;
    text.split(/\r?\n/).forEach((line, idx) => {
        const next = docToggle(line, inDoc);
        if (next && !inDoc) {opener = idx + 1;}
        inDoc = next;
    });
    return inDoc ? opener : undefined;
}

const FEATURE_LINE = /^\s*Feature\s*:/;
const FENCE_ONLY = /^\s*```\s*$/;
const KEYWORD_LINE = /^\s*(?:(?:Given|When|Then|And|But)\b|\*|Feature\s*:|Background\s*:|Scenario(?: Outline| Template)?\s*:|Example\s*:|Examples\s*:|Rule\s*:)/;

/** Prose = a non-blank line that starts with a letter and is not a Gherkin/Karate construct. */
const isProse = (line: string): boolean => /^\s*[A-Za-z]/.test(line) && !KEYWORD_LINE.test(line);

/**
 * Extract the feature from a model reply: the first fenced block (fences inside `"""` docstrings are content),
 * text from the first Feature line (keeping tags/comments directly above it), and without trailing prose.
 */
export function cleanOutput(raw: string): string {
    const all = raw.replace(/\r\n/g, '\n').split('\n');
    // 1. fenced block: opener before the Feature line, closer outside any docstring
    let start = 0;
    let end = all.length;
    let inDoc = false;
    let featureSeen = false;
    let opened = false;
    for (let n = 0; n < all.length; n++) {
        const line = all[n];
        if (!featureSeen && !inDoc && FEATURE_LINE.test(line)) {featureSeen = true;}
        if (featureSeen || opened) {
            const next = docToggle(line, inDoc);
            if (next !== inDoc) {inDoc = next;}
            else if (!inDoc && FENCE_ONLY.test(line)) { end = n; break; }
            continue;
        }
        if (/^\s*```/.test(line)) { opened = true; start = n + 1; }
    }
    const lines = all.slice(start, end);
    const first = lines.findIndex(l => FEATURE_LINE.test(l));
    if (first < 0) {return lines.filter(l => !/^\s*```/.test(l)).join('\n').trim();}
    let from = first;
    while (from > 0 && /^\s*(@|#)/.test(lines[from - 1])) {from--;}
    // 2. drop trailing prose after the last construct line
    let docOpen = false;
    let last = first;
    for (let n = first; n < lines.length; n++) {
        const t = lines[n].trim();
        const nextDoc = docToggle(lines[n], docOpen);
        if (nextDoc !== docOpen) { docOpen = nextDoc; last = n; continue; }
        if (docOpen || t === '' || !isProse(lines[n])) {last = n;}
    }
    return lines.slice(from, last + 1).join('\n').trim();
}

const sourceOf = (s: { comments: { text: string }[] }): string | undefined => {
    for (const c of s.comments) {
        const m = /^#\s*source:\s*(.+?)\s*$/i.exec(c.text);
        if (m) {return m[1];}
    }
    return undefined;
};

function missingScenarios(input: ParsedFeature, output: ParsedFeature): Finding[] {
    const pool = output.scenarios.map(s => ({ name: s.name, src: sourceOf(s), used: false }));
    const missing: Finding[] = [];
    for (const s of input.scenarios) {
        const src = sourceOf(s);
        const hit = pool.find(o => !o.used && (o.name === s.name || (src !== undefined && o.src === src)));
        if (hit) {hit.used = true;}
        else {missing.push(err(AI_RULES.dropped, s.startLine, `Scenario "${s.name}" from the input is missing from the output`));}
    }
    return missing;
}

/** An AI must not turn a deliberately ignored feature or scenario back into a runnable test. */
function ignoredFindings(input: ParsedFeature, output: ParsedFeature): Finding[] {
    const out: Finding[] = [];
    if (input.tags.some(t => t.name === '@ignore') && !output.tags.some(t => t.name === '@ignore')) {
        out.push(err(AI_RULES.undrafted, input.featureLine ?? 1, 'Feature was @ignore in the input but is runnable in the output'));
    }
    for (const source of input.scenarios.filter(s => s.ignored)) {
        const sourceRef = sourceOf(source);
        const target = output.scenarios.find(s => s.name === source.name || (sourceRef !== undefined && sourceOf(s) === sourceRef));
        if (!target || !target.ignored) {out.push(err(AI_RULES.undrafted, source.startLine, `Scenario "${source.name}" was @ignore in the input but is runnable or missing in the output`));}
    }
    return out;
}


const PATH_STEP = /^path\s+(.+)$/;
const WORDLIKE = /^[A-Za-z][A-Za-z_-]{2,}$/;
/** Modes whose evidence is an API contract; prose modes (jira, confluence) never get the path check. */
const CONTRACT_MODES: ReadonlySet<SourceKind> = new Set<SourceKind>(['openapi', 'postman', 'har', 'graphql', 'combined', 'session']);

/** First path segment of the first string literal in a `path` step argument. */
function firstSegment(arg: string): string | undefined {
    const m = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/.exec(arg);
    return m ? (m[1] ?? m[2]).split('/').filter(Boolean)[0] : undefined;
}

function seen(haystack: string, seg: string): boolean {
    const s = seg.toLowerCase();
    const stems = [s, s.replace(/s$/, ''), s.replace(/es$/, '')];
    return stems.some(stem => stem.length >= 2 && haystack.includes(stem));
}

function inventedFindings(mode: SourceKind, output: ParsedFeature, outputText: string, known: string, knownFiles: Set<string>, haveEvidence: boolean): Finding[] {
    const findings: Finding[] = [];
    const haystack = known.toLowerCase();
    if (haveEvidence && CONTRACT_MODES.has(mode)) {
        const steps = [...(output.background?.steps ?? []), ...output.scenarios.flatMap(s => s.steps)];
        for (const step of steps) {
            const m = PATH_STEP.exec(step.text);
            const seg = m ? firstSegment(m[1]) : undefined;
            if (seg && WORDLIKE.test(seg) && !seen(haystack, seg)) {findings.push(err(AI_RULES.invented, step.line, `Path segment "${seg}" is not in the evidence or the input feature`));}
        }
    }
    outputText.split('\n').forEach((text, idx) => {
        for (const m of text.matchAll(/read\(\s*(['"])classpath:([^'"]+)\1/g)) {
            const target = m[2];
            if (!known.includes(target) && !knownFiles.has(target)) {
                findings.push(err(AI_RULES.invented, idx + 1, `classpath target "${target}" is not in the evidence, the input feature or the known files`));
            }
        }
    });
    return findings;
}

const keyOf = (f: Finding): string => `${f.ruleId}|${f.message.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ')}`;

/** Gate errors of `text` that the input did not already have (pre-existing errors pass through). */
function newGateErrors(text: string, i: RefineInput, baseline: Map<string, number>): { errors: Finding[]; warnings: Finding[] } {
    const gate = runGate(text, { knownFiles: i.knownFiles.size ? i.knownFiles : undefined, config: i.config });
    const budget = new Map(baseline);
    const errors: Finding[] = [];
    for (const f of gate.findings.filter(x => x.severity === 'error')) {
        const k = keyOf(f);
        const left = budget.get(k) ?? 0;
        if (left > 0) {budget.set(k, left - 1);}
        else {errors.push(f);}
    }
    return { errors, warnings: gate.findings.filter(f => f.severity !== 'error') };
}

function baselineOf(i: RefineInput): Map<string, number> {
    const map = new Map<string, number>();
    for (const f of runGate(i.feature, { knownFiles: i.knownFiles.size ? i.knownFiles : undefined, config: i.config }).findings) {
        if (f.severity !== 'error') {continue;}
        map.set(keyOf(f), (map.get(keyOf(f)) ?? 0) + 1);
    }
    return map;
}

interface Attempt { text: string; problems: Finding[]; warnings: Finding[]; empty: boolean }

function check(raw: string, i: RefineInput, inputParsed: ParsedFeature, known: string, baseline: Map<string, number>): Attempt {
    const text = cleanOutput(raw);
    if (!text) {return { text, problems: [err(AI_RULES.empty, 1, 'AI returned no usable output')], warnings: [], empty: true };}
    const parsed = parseFeature(text);
    if (parsed.featureLine === undefined) {
        return { text, problems: [err(AI_RULES.shape, 1, 'Output has no Feature: line')], warnings: [], empty: false };
    }
    const unterminated = unterminatedDocstring(text);
    if (unterminated !== undefined) {
        return { text, problems: [err(AI_RULES.docstring, unterminated, 'AI output has an unterminated docstring')], warnings: [], empty: false };
    }
    const gate = newGateErrors(text, i, baseline);
    const problems = [
        ...missingScenarios(inputParsed, parsed),
        ...ignoredFindings(inputParsed, parsed),
        ...inventedFindings(i.mode, parsed, text, known, i.knownFiles, i.evidence.length > 0),
        ...gate.errors
    ];
    return { text, problems, warnings: gate.warnings, empty: false };
}

const normalise = (t: string): string => t.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').trim();

async function refineWhole(i: RefineInput): Promise<RefineResult> {
    const skills = i.skills.select({ mode: i.mode, task: i.task }).text;
    const inputParsed = parseFeature(i.feature);
    const baseline = baselineOf(i);
    const known = [i.feature, ...i.evidence.map(e => e.text)].join('\n');
    const base = { task: i.task, mode: i.mode, skills, evidence: i.evidence, request: i.request, feature: i.feature };

    const first = check(await i.ai(buildPrompt(base)), i, inputParsed, known, baseline);
    if (first.empty) {return { text: i.feature, status: 'rejected', findings: first.problems, attempts: 1 };}
    let last = first;
    let attempts = 1;
    if (first.problems.length) {
        attempts = 2;
        last = check(await i.ai(buildPrompt({ ...base, findings: first.problems, previousOutput: first.text })), i, inputParsed, known, baseline);
    }
    if (last.problems.length) {return { text: i.feature, status: 'rejected', findings: last.problems, attempts };}
    const unchanged = normalise(last.text) === normalise(i.feature);
    return { text: unchanged ? i.feature : last.text, status: unchanged ? 'unchanged' : 'refined', findings: last.warnings, attempts };
}

/** Line index where a scenario's tags/comments begin (contiguous lines directly above the Scenario line). */
function blockStart(lines: string[], scenarioLine: number): number {
    let from = scenarioLine - 1;
    while (from > 0 && /^\s*(@|#)/.test(lines[from - 1])) {from--;}
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
        if (r.status === 'rejected') {return { text: i.feature, status: 'rejected', findings, attempts };}
        if (r.status === 'refined') {changed = true;}
        if (c === 0) { pieces.push(r.text.trim()); continue; }
        // later chunks repeat the header; keep only their scenarios
        const out = parseFeature(r.text);
        const cut = out.scenarios.length ? blockStart(out.lines, out.scenarios[0].startLine) : 0;
        pieces.push(out.lines.slice(cut).join('\n').trim());
    }
    if (!changed) {return { text: i.feature, status: 'unchanged', findings, attempts };}
    const joined = pieces.join('\n\n');
    const gate = newGateErrors(joined, i, baselineOf(i));
    if (gate.errors.length) {return { text: i.feature, status: 'rejected', findings: gate.errors, attempts };}
    return { text: joined, status: 'refined', findings: [...findings, ...gate.warnings], attempts };
}

/** Ask the model to improve `feature`; the result is never worse: failures return the original feature as 'rejected'. */
export async function refine(i: RefineInput): Promise<RefineResult> {
    const parsed = parseFeature(i.feature);
    if (i.config.ai.chunk === 'scenario' && parsed.scenarios.length > CHUNK_THRESHOLD) {return refineChunked(i, parsed);}
    return refineWhole(i);
}
