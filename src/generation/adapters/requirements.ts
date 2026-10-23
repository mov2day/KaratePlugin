// Pure requirements (Jira acceptance criteria / Confluence test cases) -> planned features adapter.
// No vscode, no logger, no I/O. Policy: a generator never invents a live step. Without a linked contract every
// criterion is an `@ignore` draft that restates the criterion; with an OpenAPI model a criterion becomes a runnable
// scenario only when exactly one operation matches clearly and the asserted status is declared by that operation.
import type { KarateScenario, KarateStep } from '../../types';
import type { GeneratorConfig, ScenarioCategory } from '../config/GeneratorConfig';
import type { GenerationModel, OperationModel } from '../model/TestModel';
import { createOperationPlanner } from '../plan/OpenApiPlanner';
import type { PlannedFeature, PlannedFile } from '../plan/OpenApiPlanner';
import { slug } from '../plan/slug';
import { redactCredentialText } from './secrets';

export const NO_CONTRACT_REASON = 'No API contract linked; select an OpenAPI spec or enable AI refinement';

export interface RequirementCriterion {
    /** The criterion or test case name; names the scenario. */
    text: string;
    /** Confluence test case steps (rendered as `# Step n:` comments, never as live steps). */
    steps?: string[];
    expected?: string;
}

export interface RequirementItem {
    /** Jira issue key or Confluence page id; becomes `@req=<id>` and `# source:`. */
    id: string;
    title: string;
    criteria: (string | RequirementCriterion)[];
    /** Optional origin label for `# source:`; any host is removed. Defaults to the id. */
    link?: string;
}

export interface RequirementOptions {
    model?: GenerationModel;
    config: GeneratorConfig;
    /** Names the feature file: `<name>/<name>-requirements.feature`. */
    name: string;
}

export interface RequirementBuild {
    features: PlannedFeature[];
    /** Data files the matched scenarios read (classpath-relative; namespaced under `data/requirements/`). */
    files: PlannedFile[];
    warnings: string[];
    /** `<id>: <criterion>` for every criterion that stayed a draft because no operation matched clearly. */
    unmatched: string[];
}

// ---------------------------------------------------------------- redaction

const HOST = /\bhttps?:\/\/[^\s/'"<>)]+/gi;

/** Credential-looking content becomes `[redacted]` (shared secrets helper); literal hosts become `[host]`. `redacted` reports credentials only. */
export function redactRequirementText(text: string): { text: string; redacted: boolean; truncated: boolean } {
    const r = redactCredentialText(String(text ?? ''));
    return { text: r.text.replace(HOST, '[host]').replace(/\[redacted\]@[\w.-]+/g, '[redacted]@[host]'), redacted: r.hits.some(h => h !== 'truncated'), truncated: r.hits.includes('truncated') };
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const reqTag = (id: string): string => `@req=${id.replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown'}`;
const MAX_NAME = 100;
function scenarioName(text: string, fallback: string): string {
    const t = oneLine(text);
    if (t === '') {return fallback;}
    if (t.length <= MAX_NAME) {return t;}
    const cut = t.slice(0, MAX_NAME);
    const space = cut.lastIndexOf(' ');
    return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[\s.,;:-]+$/, '')}...`;
}

// ---------------------------------------------------------------- matching

const STOP = new Set(['a', 'an', 'the', 'is', 'are', 'be', 'to', 'of', 'and', 'or', 'for', 'by', 'in', 'on', 'at', 'as', 'it', 'its', 'with', 'that', 'this', 'then', 'when', 'given',
    'should', 'must', 'can', 'will', 'shall', 'return', 'response', 'status', 'code', 'http', 'api', 'user', 'request', 'respond', 'no', 'not', 'from', 'all', 'any', 'unknown', 'valid', 'invalid']);
const VERB_METHODS: Record<string, string[]> = {
    create: ['POST'], add: ['POST'], post: ['POST'], register: ['POST'], submit: ['POST'], place: ['POST'], upload: ['POST'],
    get: ['GET'], read: ['GET'], list: ['GET'], view: ['GET'], fetch: ['GET'], retrieve: ['GET'], request: ['GET'], show: ['GET'], find: ['GET'], search: ['GET'], lookup: ['GET'],
    update: ['PUT', 'PATCH'], edit: ['PUT', 'PATCH'], modify: ['PUT', 'PATCH'], change: ['PUT', 'PATCH'], replace: ['PUT', 'PATCH'],
    delete: ['DELETE'], remove: ['DELETE'], cancel: ['DELETE']
};

function stem(word: string): string {
    let w = word.toLowerCase();
    if (w.length > 4 && w.endsWith('ies')) {w = `${w.slice(0, -3)}y`;}
    else if (w.length > 5 && w.endsWith('ing')) {w = w.slice(0, -3);}
    else if (w.length > 4 && w.endsWith('ed')) {w = w.slice(0, -2);}
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) {w = w.slice(0, -1);}
    if (w.length > 3 && w.endsWith('e')) {w = w.slice(0, -1);}
    return w;
}
const VERB_STEMS = new Map(Object.entries(VERB_METHODS).map(([v, m]) => [stem(v), m]));
const rawWords = (s: string): string[] => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const GROUP_OF = (w: string): string => (w === stem('upload') ? 'UPLOAD' : VERB_STEMS.get(w)![0]);
/** HTTP verb groups named in the text (POST, GET, PUT for put/patch, DELETE). `request` is too weak to count (also a noun). */
const verbGroups = (text: string): Set<string> => new Set(rawWords(text).map(stem).filter(w => w !== 'request' && VERB_STEMS.has(w)).map(w => GROUP_OF(w)));
const allVerbGroups = (text: string): Set<string> => new Set(rawWords(text).map(stem).filter(w => VERB_STEMS.has(w)).map(w => GROUP_OF(w)));

function nouns(text: string): Set<string> {
    const out = new Set<string>();
    const invalidBody = /\binvalid\b/i.test(text) && /\b(body|request|input|payload)\b/i.test(text);
    for (const w of rawWords(text)) {
        if (/^\d+$/.test(w) || (STOP.has(w) && !(invalidBody && w === 'invalid'))) {continue;}
        const s = stem(w);
        if (s.length < 2 || VERB_STEMS.has(s) || STOP.has(s)) {continue;}
        out.add(s);
    }
    return out;
}

function verbMethods(text: string): Set<string> {
    const out = new Set<string>();
    // `request` is also a noun ("a bad request"): it only counts when no stronger verb is present.
    const strong = verbGroups(text).size > 0;
    for (const w of rawWords(text)) {
        const st = stem(w);
        if (strong && st === 'request') {continue;}
        for (const m of VERB_STEMS.get(st) ?? []) {out.add(m);}
    }
    return out;
}

const STATUS_AFTER = /(?:status(?:\s+code)?|returns?|responds?(?:\s+with)?|response|http|code|with|gets?|receives?|is|be|are|=|:)\s*(?:an?\s+)?([1-5]\d\d)\b/i;
const STATUS_PHRASES: [RegExp, string][] = [
    [/\bnot found\b/i, '404'], [/\bunauthori[sz]ed\b|\bunauthenticated\b/i, '401'], [/\bforbidden\b/i, '403'], [/\bbad request\b/i, '400'], [/\binvalid\b/i, '400']
];
/** The status a criterion asks for: an explicit code first, else a status phrase. */
export function statusHint(...texts: (string | undefined)[]): string | undefined {
    for (const t of texts) {
        const m = t ? STATUS_AFTER.exec(t) : null;
        if (m) {return m[1];}
    }
    for (const t of texts) {
        if (!t) {continue;}
        for (const [re, status] of STATUS_PHRASES) {if (re.test(t)) {return status;}}
    }
    return undefined;
}

const categoryOf = (status: string | undefined): ScenarioCategory =>
    status === '400' || status === '404' || status === '422' ? 'negative' : status === '401' || status === '403' ? 'security' : 'positive';

const normPath = (p: string): string => p.toLowerCase().replace(/\/+$/, '').replace(/\{[^}]*\}|:[a-z_]\w*/g, '{}');
const EXPLICIT = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s,;)"'`]*)/g;

interface Scored {
    op: OperationModel;
    score: number;
}

const lastStatic = (op: OperationModel): string => op.path.split('/').filter(s => s !== '' && !s.startsWith('{')).pop()?.toLowerCase() ?? '';
const endsWithParam = (op: OperationModel): boolean => /\{[^}]*\}$/.test(op.path);

type Match =
    | { kind: 'op'; op: OperationModel }
    | { kind: 'none'; reason: string }
    | { kind: 'multi'; reason: string }
    | { kind: 'ambiguous'; reason: string; first?: OperationModel };

const label = (op: OperationModel): string => `${op.method.toUpperCase()} ${op.path}`;

const FRAGMENT_SPLIT = /\s*(?:[,;]|\b(?:and then|then|as well as|plus|and|afterwards|followed by|after that|before)\b)\s*/i;

function matchOperation(ops: OperationModel[], matchText: string, status: string | undefined): Match {
    // Score each verb-bearing fragment on its own: different best operations (even in one verb group) mean several operations.
    const bests: OperationModel[] = [];
    let verbFragments = 0;
    for (const f of matchText.split(FRAGMENT_SPLIT).map(x => x.trim()).filter(Boolean)) {
        if (verbGroups(f).size === 0) {continue;}
        verbFragments++;
        const m = matchSingle(ops, f, status, true);
        if (m.kind === 'op' && !bests.includes(m.op)) {bests.push(m.op);}
    }
    if (verbFragments >= 2 && bests.length >= 2) {
        return { kind: 'multi', reason: `Criterion spans several operations (${bests.map(label).join(', ')}); split it into one criterion per operation or enable AI refinement` };
    }
    const groups = verbGroups(matchText);
    if (groups.size >= 2) {
        const picks = [...groups].map(g => bestFor(ops, matchText, status, g)).filter((o): o is OperationModel => o !== undefined);
        return { kind: 'multi', reason: `Criterion spans several operations (${picks.map(label).join(', ') || [...groups].sort().join(', ')}); split it into one criterion per operation or enable AI refinement` };
    }
    return matchSingle(ops, matchText, status);
}

function bestFor(ops: OperationModel[], matchText: string, status: string | undefined, group: string): OperationModel | undefined {
    const inGroup = ops.filter(o => (group === 'PUT' ? ['PUT', 'PATCH'] : group === 'UPLOAD' ? ['POST'] : [group]).includes(o.method.toUpperCase()));
    const m = matchSingle(inGroup, matchText, status, true);
    return m.kind === 'op' ? m.op : m.kind === 'ambiguous' ? m.first : undefined;
}

function matchSingle(ops: OperationModel[], matchText: string, status: string | undefined, forceFirst = false): Match & { first?: OperationModel } {
    const explicit = [...matchText.matchAll(EXPLICIT)].map(m => ({ method: m[1], path: normPath(m[2].replace(/[.!?]+$/, '')) }));
    const wantNouns = nouns(matchText);
    const verbs = verbMethods(matchText);
    const wantGroups = verbGroups(matchText).size > 0 ? verbGroups(matchText) : allVerbGroups(matchText);
    const words = new Set(rawWords(matchText));
    const scored: Scored[] = [];
    for (const op of ops) {
        let score = 0;
        const hit = explicit.some(e => e.method === op.method.toUpperCase() && e.path === normPath(op.path));
        if (hit) {score += 10;}
        const opNouns = nouns(`${op.id} ${op.summary ?? ''} ${op.path.replace(/[{}/]/g, ' ')}`);
        let overlap = 0;
        for (const n of wantNouns) {if (opNouns.has(n)) {overlap++;}}
        if (overlap === 0 && !hit) {continue;}
        score += overlap;
        if (verbs.has(op.method.toUpperCase())) {score += 1;}
        if ([...allVerbGroups(`${op.id} ${op.summary ?? ''}`)].some(g => wantGroups.has(g))) {score += 1;}
        if (status && op.responses.some(r => r.status === status)) {score += 1;}
        const seg = lastStatic(op);
        if (seg && !endsWithParam(op) && words.has(seg)) {score += 0.5;}
        if (seg && endsWithParam(op) && (words.has('id') || words.has('unknown') || words.has('existing') || words.has(stem(seg)))) {score += 0.5;}
        scored.push({ op, score });
    }
    if (scored.length === 0) {
        if (explicit.length > 0) {return { kind: 'none', reason: `${explicit[0].method} ${explicit[0].path} is not in the linked contract` };}
        return { kind: 'none', reason: 'No operation in the linked contract matches this criterion' };
    }
    scored.sort((a, b) => b.score - a.score);
    const [first, second] = scored;
    if (second && !forceFirst && (first.score - second.score) / first.score <= 0.1) {
        const near = scored.filter(s => (first.score - s.score) / first.score <= 0.1).slice(0, 3).map(s => label(s.op));
        return { kind: 'ambiguous', reason: `Ambiguous match; candidates: ${near.join(', ')}`, first: first.op };
    }
    return { kind: 'op', op: first.op };
}

// ---------------------------------------------------------------- build

const st = (keyword: KarateStep['keyword'], text: string): KarateStep => ({ keyword, text });
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function buildRequirementScenarios(items: RequirementItem[], opts: RequirementOptions): RequirementBuild {
    if (!opts?.config) {throw new Error('buildRequirementScenarios: "opts.config" is required');}
    const config = opts.config;
    const model = opts.model && opts.model.operations.length > 0 ? opts.model : undefined;
    const warnings: string[] = [];
    const unmatched: string[] = [];
    const planner = model ? createOperationPlanner(model, config, { filePrefix: 'requirements', inlineSchemas: true }) : undefined;
    const ops = model ? [...model.operations].sort((a, b) => cmp(a.path, b.path) || cmp(a.method, b.method)) : [];
    if (opts.model && !model) {warnings.push('The linked API contract has no operations; requirements were drafted without it');}

    const scenarios: KarateScenario[] = [];
    const seen = new Set<string>();
    let needsAuth = false;
    const tagFor = (category: ScenarioCategory): string[] => (config.tags.auto ? [config.tags.taxonomy[category].startsWith('@') ? config.tags.taxonomy[category] : `@${config.tags.taxonomy[category]}`] : []);

    const str = (x: unknown): string => String(x ?? '');
    const safeItems: RequirementItem[] = (Array.isArray(items) ? items : []).filter(i => i !== null && typeof i === 'object').map(i => ({
        id: str(i.id), title: str(i.title), link: i.link === undefined ? undefined : str(i.link), criteria: Array.isArray(i.criteria) ? i.criteria : []
    }));
    for (const item of safeItems) {
        const id = redactRequirementText(item.id).text;
        const source = oneLine(redactRequirementText(item.link ?? '').text) || id;
        let truncatedAny = false;
        let redactedAny = redactRequirementText(item.id).redacted || redactRequirementText(item.title).redacted;
        if (item.criteria.length === 0) {warnings.push(`${id}: no acceptance criteria or test cases found`);}
        item.criteria.forEach((raw, index) => {
            const c: RequirementCriterion = raw !== null && typeof raw === 'object' ? { text: str(raw.text), steps: Array.isArray(raw.steps) ? raw.steps.map(str) : [], expected: raw.expected === undefined ? undefined : str(raw.expected) } : { text: str(raw) };
            const clean = (t: string): string => {
                const r = redactRequirementText(t);
                redactedAny = redactedAny || r.redacted;
                truncatedAny = truncatedAny || r.truncated;
                return oneLine(r.text);
            };
            const text = clean(c.text);
            const steps = (c.steps ?? []).map(clean).filter(Boolean);
            const expected = c.expected ? clean(c.expected) : '';
            const fallback = `Requirement ${index + 1}`;
            let name = scenarioName(text, fallback);
            for (let n = 2; seen.has(name); n++) {name = `${scenarioName(text, fallback)} (${n})`;}
            seen.add(name);

            const matchText = [text, ...steps, expected].join(' ');
            const status = statusHint(expected, text, ...steps);
            const base: Pick<KarateScenario, 'name' | 'source'> = { name, source };
            const comments = [
                `Criterion: ${text || name}`,
                ...steps.map((s, n) => `Step ${n + 1}: ${s}`),
                ...(expected ? [`Expected: ${expected}`] : [])
            ];
            const draft = (reason: string, category: ScenarioCategory): void => {
                scenarios.push({ ...base, tags: [...tagFor(category), reqTag(id)], category, comments, steps: [], draftReason: reason });
            };

            if (!planner) {return draft(NO_CONTRACT_REASON, categoryOf(status));}
            const match = matchOperation(ops, matchText, status);
            if (match.kind !== 'op') {
                unmatched.push(`${id}: ${text || name}`);
                return draft(match.reason, categoryOf(status));
            }
            const built = planner.scenarioFor(match.op, status);
            if (!built.scenario) {
                return draft(`Matched ${label(match.op)}: ${built.reason ?? 'no scenario could be built'}`, categoryOf(status));
            }
            const s = built.scenario;
            const category = s.category ?? 'positive';
            const planned = (s.comments ?? []).filter(x => !comments.includes(x));
            const extra = (s.tags ?? []).filter(t => !tagFor(category).includes(t));
            if (built.secured) {needsAuth = true;}
            scenarios.push({
                ...s, ...base, tags: [...tagFor(category), reqTag(id), ...extra], category,
                comments: [...comments, `Operation: ${label(match.op)}`, ...planned]
            });
        });
        if (truncatedAny) {warnings.push(`${id}: text longer than 50000 characters was truncated`);}
        if (redactedAny) {warnings.push(`${id}: credential-looking content in the requirements was replaced with [redacted]`);}
    }

    const root = slug(opts.name) || 'requirements';
    const ids = [...new Set(safeItems.map(i => redactRequirementText(i.id).text))];
    const background: KarateStep[] = [st('*', `url ${config.config.urlVariable}`)];
    if (model && needsAuth && model.schemes.length > 0) {background.push(st('*', "callonce read('classpath:common/auth.feature')"));}
    const features: PlannedFeature[] = scenarios.length === 0 ? [] : [{
        relativePath: `${root}/${root}-requirements.feature`,
        feature: {
            name: `${oneLine(redactRequirementText(opts.name).text) || 'Requirements'} - requirements`,
            description: `Requirements ${ids.join(', ')}`,
            background: { steps: background },
            scenarios
        }
    }];
    if (planner) {for (const w of planner.warnings()) {if (!warnings.includes(w)) {warnings.push(w);}}}
    return { features, files: planner ? planner.files() : [], warnings, unmatched };
}

// ---------------------------------------------------------------- source mappings

/** Jira issues (parsed) -> items. The caller sanitises the text first; the issue key is the id. */
export function jiraRequirementItems(contents: { issueKey: string; summary: string; acceptanceCriteria: string[] }[]): RequirementItem[] {
    return contents.map(c => ({ id: c.issueKey, title: c.summary, criteria: c.acceptanceCriteria.filter(a => a.trim() !== '') }));
}

/** A Confluence page (parsed) -> one item: test cases, else flow steps, else listed requirements. */
export function confluenceRequirementItems(
    page: { id: string; title: string },
    data: { requirements?: string[]; testCases: { name: string; description?: string; steps: string[]; expectedResult?: string }[]; flowSteps?: string[] }
): RequirementItem[] {
    let criteria: (string | RequirementCriterion)[] = data.testCases.map(t => ({ text: t.name || t.description || '', steps: t.steps, expected: t.expectedResult }));
    if (criteria.length === 0 && (data.flowSteps ?? []).length > 0) {criteria = [{ text: 'Flow from Confluence', steps: data.flowSteps }];}
    if (criteria.length === 0) {criteria = (data.requirements ?? []).filter(r => r.trim() !== '');}
    return [{ id: page.id, title: page.title, criteria }];
}
