import { DEFAULT_STATUS } from './karateKnowledge';
import { FeatureModel, RequestState, StepInfo, VarInfo, currentScenarioSteps, parseFeature, requestState, variablesIn } from './scenarioModel';

/**
 * Predicts the next Karate step without any model. It combines patterns learned from this file and the rest of the
 * project (strongest when the same request, e.g. `path 'pet'` + `post`, has been written before) with workflow rules.
 */

export interface Prediction {
    /** Step text without its keyword, e.g. `status 200`. */
    text: string;
    source: 'learned' | 'rule';
    reason: string;
    /** Rule backed by what this very scenario did; it outranks general patterns learned from elsewhere. */
    strong?: boolean;
}

/** context key -> next step text -> weight. Keys are `start`, `u:<kind>`, `b:<kind>><kind>` and `s:<path signature>|<kind>`. */
export type Learned = Map<string, Map<string, number>>;

const FILE_WEIGHT = 2;
const THRESHOLD = { start: 4, u: 4, b: 4, s: 2 };

const SETUP_KINDS = new Set(['path', 'param', 'params', 'header', 'headers', 'cookie', 'cookies', 'request', 'form field', 'multipart file', 'multipart field', 'url', 'def', 'configure', 'set', 'text', 'json', 'copy']);

/** A coarse key for "what a step was", so repeated patterns transfer to new places. */
export function transitionKey(step: StepInfo): string {
    if (step.kind === 'method') { return `method:${/^method\s+(\w+)/i.exec(step.text)?.[1]?.toLowerCase() ?? ''}`; }
    return step.kind;
}

export function stripKeyword(text: string): string {
    return text.replace(/^(?:\*|Given|When|Then|And|But)\s+/, '');
}

/** `path 'pet', idPath, 'uploadImage'` -> `pet/*\/uploadImage`: literals kept, variables and numbers become `*`. */
export function pathSignature(pathStepText: string): string {
    const args = pathStepText.replace(/^path\s+/i, '');
    const parts: string[] = [];
    let current = '';
    let quote = '';
    for (const ch of args) {
        if (quote) { current += ch; if (ch === quote) { quote = ''; } continue; }
        if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
        if (ch === ',') { parts.push(current.trim()); current = ''; continue; }
        current += ch;
    }
    if (current.trim()) { parts.push(current.trim()); }
    return parts.map(part => /^(['"])(.*)\1$/.exec(part)?.[2] ?? '*').join('/');
}

function add(learned: Learned, key: string, text: string, weight: number): void {
    const counts = learned.get(key) ?? new Map<string, number>();
    counts.set(text, (counts.get(text) ?? 0) + weight);
    learned.set(key, counts);
}

function lastPathSignature(steps: StepInfo[]): string {
    for (let i = steps.length - 1; i >= 0; i--) { if (steps[i].kind === 'path') { return pathSignature(steps[i].text); } }
    return '';
}

/** Adds the transitions of every scenario in `model` to `into`. Transitions into or out of `skipLine` (a step being typed) are ignored. */
export function learnFrom(model: FeatureModel, weight: number, into: Learned, skipLine = -1): void {
    const bounds = [...model.scenarioStarts, model.steps.length];
    for (let s = 0; s < model.scenarioStarts.length; s++) {
        const steps = model.steps.slice(bounds[s], bounds[s + 1]).filter(step => !step.background);
        if (steps.length && steps[0].line !== skipLine) { add(into, 'start', steps[0].text, weight); }
        for (let i = 0; i + 1 < steps.length; i++) {
            if (steps[i].line === skipLine || steps[i + 1].line === skipLine) { continue; }
            const next = steps[i + 1].text;
            add(into, `u:${transitionKey(steps[i])}`, next, weight);
            if (i >= 1) { add(into, `b:${transitionKey(steps[i - 1])}>${transitionKey(steps[i])}`, next, weight); }
            const sig = lastPathSignature(steps.slice(0, i + 1));
            if (sig) { add(into, `s:${sig}|${transitionKey(steps[i])}`, next, weight); }
        }
    }
}

export function learnFromLines(lines: string[], weight: number, into: Learned = new Map()): Learned {
    learnFrom(parseFeature(lines), weight, into);
    return into;
}

/** The keyword this file uses most for a kind of step (`path` -> Given, `method` -> When), when it is clear. */
export function dominantKeyword(model: FeatureModel, kind: string): string | undefined {
    const counts = new Map<string, number>();
    for (const step of model.steps) { if (step.kind === kind) { counts.set(step.keyword, (counts.get(step.keyword) ?? 0) + 1); } }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (!ranked.length) { return undefined; }
    const total = ranked.reduce((sum, [, n]) => sum + n, 0);
    return ranked[0][1] >= 2 && ranked[0][1] / total >= 0.6 ? ranked[0][0] : undefined;
}

/** The keyword to put before `text`, matching the file's own style. */
export function keywordFor(text: string, previous: StepInfo | undefined, model?: FeatureModel): string {
    const kind = text.split(/\s+/)[0];
    const all = model?.steps ?? [];
    const starCount = all.filter(step => step.keyword === '*').length;
    if (all.length >= 3 && starCount / all.length >= 0.7) { return '*'; }
    if (!previous) { return all.length && starCount === all.length ? '*' : (SETUP_KINDS.has(kind) ? 'Given' : '*'); }
    const learnedKind = model ? dominantKeyword(model, kind === 'form' || kind === 'multipart' ? text.split(/\s+/).slice(0, 2).join(' ') : kind) : undefined;
    if (learnedKind) { return learnedKind; }
    if (previous.keyword === '*' && all.length === 0) { return '*'; }
    if (kind === 'method') { return 'When'; }
    if (kind === 'status') { return previous.kind === 'status' || previous.kind === 'match' ? 'And' : 'Then'; }
    if (kind === 'match' || kind === 'print' || kind === 'assert') { return previous.kind === 'status' || previous.kind === 'match' ? 'And' : 'Then'; }
    if (SETUP_KINDS.has(kind)) { return SETUP_KINDS.has(previous.kind) && previous.kind !== 'def' && previous.kind !== 'set' ? 'And' : 'Given'; }
    return 'And';
}

/** A variable fits a path when it is named like the resource: `pet` for `pet` or `pet/*`, not for `pet/findByStatus`. */
function similarity(variable: string, pathSignatureValue: string): number {
    const name = variable.toLowerCase();
    const words = pathSignatureValue.toLowerCase().split('/').filter(w => w && w !== '*');
    if (words.length !== 1) { return 0; }
    const word = words[0];
    return name === word || name.startsWith(word) || word.startsWith(name) ? 1 : 0;
}

/** After changing a variable that was sent as a request body, the usual next step is to send it again to the same path. */
function resendPath(steps: StepInfo[], last: StepInfo): Prediction | undefined {
    const target = /^(?:set|def|copy)\s+([A-Za-z_]\w*)/.exec(last.text)?.[1];
    if (!target) { return undefined; }
    for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i].kind === 'request' && new RegExp(`^request\\s+${target}\\b`).test(steps[i].text)) {
            for (let j = i - 1; j >= 0; j--) {
                if (steps[j].kind === 'path') { return { text: steps[j].text, source: 'rule', strong: true, reason: `${target} was sent here before; send the change` }; }
                if (steps[j].kind === 'method') { break; }
            }
        }
    }
    return undefined;
}

function ruleBased(steps: StepInfo[], state: RequestState, vars: Map<string, VarInfo>): Prediction[] {
    const out: Prediction[] = [];
    const last = state.last;
    const sig = lastPathSignature(steps);
    if (!last) {
        if (vars.has('baseUrl')) { out.push({ text: 'url baseUrl', source: 'rule', reason: 'baseUrl is defined and no url is set' }); }
        return out;
    }
    if (!state.hasUrl && ['def', 'configure'].includes(last.kind) && vars.has('baseUrl')) {
        out.push({ text: 'url baseUrl', source: 'rule', reason: 'baseUrl is defined and no url is set' });
    }
    switch (last.kind) {
        case 'url':
            out.push({ text: "path '/'", source: 'rule', reason: 'a url is usually followed by a path' });
            break;
        case 'set':
        case 'def':
        case 'copy': {
            const resend = state.method ? resendPath(steps, last) : undefined;
            if (resend) { out.push(resend); }
            break;
        }
        case 'path':
        case 'param':
        case 'params':
        case 'header':
        case 'headers':
        case 'form field':
        case 'multipart file':
        case 'multipart field': {
            if (state.hasRequest || state.method) { break; }
            if (last.kind === 'form field' || last.kind === 'multipart file' || last.kind === 'multipart field') {
                out.push({ text: 'method post', source: 'rule', reason: 'form and multipart data is posted' });
                break;
            }
            const lastArg = steps.filter(s => s.kind === 'path').pop()?.text ?? '';
            const byId = /,\s*[A-Za-z_]\w*\s*$|,\s*\d+\s*$/.test(lastArg);
            const candidates = [...vars.values()].filter(v => v.shape === 'object' && !/^(config|credentials|headers)$/i.test(v.name));
            const named = candidates.find(v => similarity(v.name, sig));
            if (last.kind === 'path' && named) {
                out.push({ text: `request ${named.name}`, source: 'rule', reason: `${named.name} looks like the body for ${sig}` });
            }
            out.push({ text: `method get`, source: 'rule', reason: 'the request is ready to send' });
            break;
        }
        case 'request': {
            const body = /^request\s+([A-Za-z_]\w*)\s*$/.exec(last.text)?.[1];
            // Posted earlier in this scenario and changed since: sending it again is an update.
            const postedAt = body ? steps.findIndex(step => step.kind === 'request' && step.text === `request ${body}`) : -1;
            const changed = body ? steps.some((step, i) => i > postedAt && postedAt >= 0 && step.kind === 'set' && step.text.startsWith(`set ${body}.`)) : false;
            if (changed) { out.push({ text: 'method put', source: 'rule', strong: true, reason: `${body} was created earlier and changed since` }); break; }
            const lastArg = steps.filter(s => s.kind === 'path').pop()?.text ?? '';
            const byId = /,\s*[A-Za-z_]\w*\s*$|,\s*\d+\s*$/.test(lastArg);
            out.push({ text: `method ${byId ? 'put' : 'post'}`, source: 'rule', reason: byId ? 'a body sent to a resource id is usually an update' : 'a request body is usually posted' });
            break;
        }
        case 'method': {
            const verb = state.method ?? 'get';
            out.push({ text: `status ${DEFAULT_STATUS[verb] ?? 200}`, source: 'rule', reason: `the usual status for ${verb.toUpperCase()}` });
            break;
        }
        case 'status': {
            const verb = state.method ?? 'get';
            if (verb === 'delete' || verb === 'head') { break; }
            const lastArg = steps.filter(s => s.kind === 'path').pop()?.text ?? '';
            const byId = /,\s*[A-Za-z_]\w*\s*$|,\s*\d+\s*$/.test(lastArg);
            const failure = /^status\s+[45]\d\d/.test(last.text);
            if (failure) { break; }
            const requestStep = [...steps].reverse().find(step => step.kind === 'request');
            const bodyVar = requestStep ? vars.get(/^request\s+([A-Za-z_]\w*)/.exec(requestStep.text)?.[1] ?? '') : undefined;
            const scalars = (bodyVar?.entries ?? []).filter(entry => !/^[\[{]/.test(entry.value)).slice(0, 3);
            if ((verb === 'post' || verb === 'put' || verb === 'patch') && scalars.length) {
                out.push({ text: `match response contains { ${scalars.map(entry => `${entry.key}: ${entry.value}`).join(', ')} }`, source: 'rule', reason: `the response usually echoes what ${bodyVar!.name} sent` });
            }
            out.push({ text: verb === 'get' && !byId ? "match response == '#array'" : "match response == '#object'", source: 'rule', reason: 'assert the response shape after the status' });
            break;
        }
        default:
            break;
    }
    return out;
}

function ranked(learned: Learned[], key: string, threshold: number, taken: Set<string>): Array<[string, number]> {
    const merged = new Map<string, number>();
    for (const source of learned) {
        for (const [text, weight] of source.get(key) ?? []) { merged.set(text, (merged.get(text) ?? 0) + weight); }
    }
    return [...merged.entries()].filter(([text, weight]) => weight >= threshold && !taken.has(text)).sort((a, b) => b[1] - a[1]);
}

/** Ranked predictions for the step at `cursorLine`. The line itself is ignored, so a half-typed step never teaches the engine. */
export function predictCandidates(lines: string[], cursorLine: number, workspace?: Learned): Prediction[] {
    const before = parseFeature(lines, cursorLine);
    const steps = currentScenarioSteps(before);
    const scenarioSteps = steps.filter(step => !step.background);
    const state = requestState(steps);
    const vars = variablesIn(steps);
    // A step is only "already there" within the request being built: the same status or match is fine for the next request.
    const lastMethod = scenarioSteps.map(step => step.kind).lastIndexOf('method');
    const taken = new Set(scenarioSteps.slice(Math.max(0, lastMethod)).map(step => step.text));
    const learnedHere: Learned = new Map();
    learnFrom(parseFeature(lines), FILE_WEIGHT, learnedHere, cursorLine);
    const sources = workspace ? [learnedHere, workspace] : [learnedHere];

    const out: Prediction[] = [];
    const push = (prediction: Prediction): void => {
        if (!out.some(existing => existing.text === prediction.text) && !taken.has(prediction.text)) { out.push(prediction); }
    };
    const last = scenarioSteps[scenarioSteps.length - 1];
    const rules = ruleBased(steps, state, vars);
    for (const rule of rules.filter(r => r.strong)) { push(rule); }
    if (!last) {
        for (const [text, weight] of ranked(sources, 'start', THRESHOLD.start, taken).slice(0, 2)) {
            push({ text, source: 'learned', reason: `scenarios in this project often start with this (${Math.round(weight / FILE_WEIGHT)}+ times)` });
        }
    } else {
        const sig = lastPathSignature(scenarioSteps);
        const second = scenarioSteps[scenarioSteps.length - 2];
        const tiers: Array<[string, number, string]> = [];
        if (sig) { tiers.push([`s:${sig}|${transitionKey(last)}`, THRESHOLD.s, `the same request (${sig}) was written this way before`]); }
        if (second) { tiers.push([`b:${transitionKey(second)}>${transitionKey(last)}`, THRESHOLD.b, 'the same two steps were followed by this before']); }
        tiers.push([`u:${transitionKey(last)}`, THRESHOLD.u, 'usually follows this kind of step in this project']);
        for (const [key, threshold, reason] of tiers) {
            for (const [text] of ranked(sources, key, threshold, taken).slice(0, 2)) { push({ text, source: 'learned', reason }); }
        }
    }
    for (const rule of rules) { push(rule); }
    return out;
}

export function predictNextStep(lines: string[], cursorLine: number, workspace?: Learned): Prediction | undefined {
    return predictCandidates(lines, cursorLine, workspace)[0];
}
