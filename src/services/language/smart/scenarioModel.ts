/** A light-weight reading of a Karate feature: steps, variables and the request being built. Pure, no vscode import. */

const STEP = /^(\s*)(\*|Given|When|Then|And|But)\s+(.*?)\s*$/;
const SECTION = /^\s*(Feature|Background|Scenario Outline|Scenario Template|Scenario|Examples|Rule)\s*:/;
const MULTI_WORD = ['form field', 'retry until', 'soap action', 'multipart file', 'multipart field'];
const DEF_KINDS = ['def', 'text', 'yaml', 'csv', 'string', 'json', 'xml', 'xmlstring', 'bytes', 'copy', 'table'];

export interface StepInfo {
    line: number;
    keyword: string;
    kind: string;
    text: string;
    background: boolean;
}

export type VarShape = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'file' | 'response' | 'unknown';

export interface VarInfo {
    name: string;
    shape: VarShape;
    keys: string[];
    /** Top-level key/value pairs of an object literal, with the value text as written. */
    entries?: Array<{ key: string; value: string }>;
    source: string;
}

export interface FeatureModel {
    steps: StepInfo[];
    /** Index ranges of scenarios in `steps` (background steps carry background: true). */
    scenarioStarts: number[];
}

export function stepKind(text: string): string {
    const lower = text.toLowerCase();
    for (const word of MULTI_WORD) { if (lower.startsWith(`${word} `) || lower === word) { return word; } }
    const first = /^([A-Za-z]+)/.exec(text)?.[1]?.toLowerCase();
    return first ?? 'expr';
}

/** Parses `lines`, stopping before `stopLine` (exclusive) when given. Skips doc-string bodies. */
export function parseFeature(lines: string[], stopLine = lines.length): FeatureModel {
    const steps: StepInfo[] = [];
    const scenarioStarts: number[] = [];
    let inBackground = false;
    let inDoc = false;
    for (let i = 0; i < Math.min(lines.length, stopLine); i++) {
        const line = lines[i];
        if (/^\s*"""/.test(line)) { inDoc = !inDoc; continue; }
        if (inDoc) { continue; }
        const section = SECTION.exec(line);
        if (section) {
            if (section[1] === 'Background') { inBackground = true; }
            else if (/^Scenario/.test(section[1])) { inBackground = false; scenarioStarts.push(steps.length); }
            continue;
        }
        const step = STEP.exec(line);
        if (!step) { continue; }
        steps.push({ line: i, keyword: step[2], kind: stepKind(step[3]), text: step[3], background: inBackground });
    }
    return { steps, scenarioStarts };
}

/** Steps that apply at the cursor: the Background plus the current scenario's steps. */
export function currentScenarioSteps(model: FeatureModel): StepInfo[] {
    const start = model.scenarioStarts.length ? model.scenarioStarts[model.scenarioStarts.length - 1] : 0;
    const background = model.steps.filter(step => step.background);
    return [...background, ...model.steps.slice(start).filter(step => !step.background)];
}

function objectKeys(literal: string): string[] {
    const keys = new Set<string>();
    let depth = 0;
    let quote = '';
    // A small scanner keeps nested keys out of the top level.
    for (let i = 0; i < literal.length; i++) {
        const ch = literal[i];
        if (quote) { if (ch === quote && literal[i - 1] !== '\\') { quote = ''; } continue; }
        if (ch === "'" || ch === '"') {
            if (depth === 1) {
                const rest = literal.slice(i);
                const key = /^(['"])((?:[^'"\\]|\\.)*)\1\s*:/.exec(rest);
                if (key) { keys.add(key[2]); i += key[0].length - 1; continue; }
            }
            quote = ch; continue;
        }
        if (ch === '{' || ch === '[') { depth++; continue; }
        if (ch === '}' || ch === ']') { depth--; continue; }
        if (depth === 1) {
            const bare = /^([A-Za-z_$][\w$]*)\s*:/.exec(literal.slice(i));
            if (bare && (i === 0 || /[{,\s]/.test(literal[i - 1]))) { keys.add(bare[1]); i += bare[0].length - 1; }
        }
    }
    return [...keys];
}

/** Splits `{ a: 1, b: { c: 2 } }` into its top-level pairs. Values stay as written. */
export function topLevelEntries(literal: string): Array<{ key: string; value: string }> {
    const out: Array<{ key: string; value: string }> = [];
    const body = literal.trim().replace(/^\{/, '').replace(/\}$/, '');
    let depth = 0;
    let quote = '';
    let start = 0;
    const pieces: string[] = [];
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (quote) { if (ch === quote && body[i - 1] !== '\\') { quote = ''; } continue; }
        if (ch === "'" || ch === '"') { quote = ch; continue; }
        if (ch === '{' || ch === '[' || ch === '(') { depth++; }
        else if (ch === '}' || ch === ']' || ch === ')') { depth--; }
        else if (ch === ',' && depth === 0) { pieces.push(body.slice(start, i)); start = i + 1; }
    }
    pieces.push(body.slice(start));
    for (const piece of pieces) {
        const match = /^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$-]*))\s*:\s*([\s\S]*?)\s*$/.exec(piece);
        if (match) { out.push({ key: match[1] ?? match[2] ?? match[3], value: match[4] }); }
    }
    return out;
}

export function inferVariable(name: string, kind: string, rhs: string): VarInfo {
    const value = rhs.trim();
    if (value.startsWith('{')) { return { name, shape: 'object', keys: objectKeys(value), entries: topLevelEntries(value), source: kind }; }
    if (value.startsWith('[')) { return { name, shape: 'array', keys: [], source: kind }; }
    if (/^read\s*\(/.test(value)) {
        const file = /read\(\s*['"]([^'"]+)['"]/.exec(value)?.[1] ?? '';
        return { name, shape: /\.(json|yaml|yml)$/i.test(file) ? 'object' : 'file', keys: [], source: file };
    }
    if (/^['"]/.test(value)) { return { name, shape: 'string', keys: [], source: kind }; }
    if (/^-?\d/.test(value)) { return { name, shape: 'number', keys: [], source: kind }; }
    if (/^(true|false)$/.test(value)) { return { name, shape: 'boolean', keys: [], source: kind }; }
    if (/^response\b/.test(value)) { return { name, shape: 'response', keys: [], source: kind }; }
    return { name, shape: 'unknown', keys: [], source: kind };
}

export function variablesIn(steps: StepInfo[]): Map<string, VarInfo> {
    const vars = new Map<string, VarInfo>();
    for (const step of steps) {
        if (!DEF_KINDS.includes(step.kind)) { continue; }
        const match = new RegExp(`^${step.kind}\\s+([A-Za-z_]\\w*)\\s*(?:=\\s*)?(.*)$`, 'i').exec(step.text);
        if (match) { vars.set(match[1], inferVariable(match[1], step.kind, match[2])); }
    }
    return vars;
}

/** Keys seen in `match response ... { ... }` literals anywhere in the file: a cheap model of the response shape. */
export function responseKeys(lines: string[]): string[] {
    const keys = new Set<string>();
    for (const line of lines) {
        const match = /^\s*(?:\*|Given|When|Then|And|But)\s+match\s+(?:each\s+)?response(?:\.\w+)*\s*(?:==|!=|contains(?:\s+(?:only|any|deep))?)\s*(\{.*\})\s*$/.exec(line);
        if (match) { for (const key of objectKeys(match[1])) { keys.add(key); } }
    }
    return [...keys];
}

export interface RequestState {
    hasUrl: boolean;
    paths: string[];
    hasRequest: boolean;
    method?: string;
    statusAsserted: boolean;
    matched: boolean;
    last?: StepInfo;
}

/** What has been set up for the request that is being built, counting from the last method call. */
export function requestState(steps: StepInfo[]): RequestState {
    const state: RequestState = { hasUrl: false, paths: [], hasRequest: false, statusAsserted: false, matched: false };
    for (const step of steps) {
        if (step.kind === 'url') { state.hasUrl = true; }
        if (step.kind === 'method') {
            state.method = /^method\s+(\w+)/i.exec(step.text)?.[1]?.toLowerCase();
            state.statusAsserted = false; state.matched = false;
        } else if (step.kind === 'path') { state.paths.push(step.text.replace(/^path\s+/i, '')); }
        else if (step.kind === 'request') { state.hasRequest = true; }
        else if (step.kind === 'status') { state.statusAsserted = true; }
        else if (step.kind === 'match' && /^match\s+response\b/.test(step.text)) { state.matched = true; }
    }
    state.last = steps[steps.length - 1];
    return state;
}
