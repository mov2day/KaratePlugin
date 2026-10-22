// Deterministic OpenAPI scenario planner. Turns a GenerationModel into Karate v2 features plus data/schema files.
// Pure: no vscode, no logger, no I/O, no randomness.
import type { KarateFeature, KarateScenario, KarateStep, KarateStyle } from '../../types';
import type { GeneratorConfig, ScenarioCategory } from '../config/GeneratorConfig';
import type { GenerationModel, JsonSchema, OperationModel, ResponseModel, SecurityScheme } from '../model/TestModel';
import { jsLiteral, valueFor, violation } from './dataFactory';
import { toKarateSchema } from './schemaMatch';

export interface PlannedFeature {
    /** Relative to `config.layout.outputRoot`. */
    relativePath: string;
    feature: KarateFeature;
}

export interface PlannedFile {
    /** Classpath-relative (`data/<resource>.json`, `schemas/<resource>.json`). */
    path: string;
    content: string;
    owner: 'user';
}

export interface PlanResult {
    features: PlannedFeature[];
    files: PlannedFile[];
    warnings: string[];
}

type Category = ScenarioCategory;
type Kind = 'main' | 'security' | 'crud';

interface Item {
    base: string;
    kind: Kind;
    secured: boolean;
    domain: string;
    scenario: KarateScenario;
}

interface ReqOpts {
    pathExprs?: Record<string, string>;
    /** Query overrides; null omits the parameter. */
    query?: Record<string, string | null>;
    /** Steps applied right after the payload is loaded. */
    mutate?: KarateStep[];
    /** Add scheme-specific query/cookie credentials (header auth comes from common/auth.feature). Default true. */
    auth?: boolean;
    noBody?: boolean;
    payloadVar?: string;
}

interface Chain {
    domain: string;
    create: OperationModel;
    read: OperationModel;
    update: OperationModel;
    del: OperationModel;
    idField: string;
    idParam: string;
}

const EXPLORATORY_NOTE = 'Exploratory: expectation is not declared in the contract';
const SAMPLE_UUID_ZERO = '00000000-0000-0000-0000-000000000000';
const UNIQUE_FIELD = /(name|title|email|username|sku|code)$/i;
const INJECTION = "' OR '1'='1";

const st = (keyword: KarateStep['keyword'], text: string, extra: Partial<KarateStep> = {}): KarateStep => ({ keyword, text, ...extra });
const isObj = (v: unknown): v is JsonSchema => typeof v === 'object' && v !== null && !Array.isArray(v);
const truncated = (s: JsonSchema | undefined): boolean => isObj(s) && s['x-truncated'] === true;

function slug(s: string): string {
    return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
const titleCase = (s: string): string => slug(s).split('-').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
const tagSafe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, '_');
const normTag = (t: string): string => (t.startsWith('@') ? t : `@${t}`);

function varName(name: string, style: KarateStyle): string {
    const words = slug(name).split('-').filter(Boolean);
    if (words.length === 0) {return 'value';}
    const joined = style.variableCase === 'snake_case' ? words.join('_') : words[0] + words.slice(1).map(w => w[0].toUpperCase() + w.slice(1)).join('');
    return /^\d/.test(joined) ? `v${joined[0].toUpperCase()}${joined.slice(1)}` : joined;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function domainOf(op: OperationModel): string {
    const fromTag = op.tags[0] ? slug(op.tags[0]) : '';
    if (fromTag) {return fromTag;}
    const seg = op.path.split('/').filter(s => s !== '' && !s.includes('{'))[0];
    return (seg ? slug(seg) : '') || 'general';
}

const successResponses = (op: OperationModel): ResponseModel[] =>
    op.responses.filter(r => /^2\d\d$/.test(r.status)).sort((a, b) => cmp(a.status, b.status));
const declared = (op: OperationModel, status: string): ResponseModel | undefined => op.responses.find(r => r.status === status);

const bodyProps = (op: OperationModel): Record<string, JsonSchema> => (isObj(op.body?.schema?.properties) ? (op.body!.schema!.properties as Record<string, JsonSchema>) : {});
const bodyRequired = (op: OperationModel): string[] => (Array.isArray(op.body?.schema?.required) ? (op.body!.schema!.required as string[]) : []);

class Planner {
    private readonly files = new Map<string, string>();
    private readonly schemaNames = new Map<string, Map<string, string>>();
    private readonly data = new Map<string, Record<string, unknown>>();
    private readonly warningList: string[] = [];
    private readonly items: Item[] = [];
    private readonly style: KarateStyle;
    private readonly mismatchWarned = new Set<string>();
    private readonly unsupported: Map<string, string>;
    private readonly ops: OperationModel[];

    constructor(private readonly model: GenerationModel, private readonly config: GeneratorConfig) {
        this.style = config.style;
        this.unsupported = new Map(model.unsupported.map(u => [u.sourceRef, u.reason]));
        this.ops = [...model.operations].sort((a, b) => cmp(a.path, b.path) || cmp(a.method, b.method));
    }

    // ---------------------------------------------------------------- plan

    plan(): PlanResult {
        const chains = this.config.scenarios.crud ? this.findChains() : [];
        const chained = new Set(chains.map(c => c.del.id));
        for (const op of this.ops) {this.planOperation(op, chained);}
        for (const chain of chains) {this.planChain(chain);}
        if (this.config.scenarios.exploratory) {this.planPathExploratory();}
        return { features: this.assemble(), files: this.collectFiles(), warnings: this.warningList };
    }

    private warn(message: string): void {
        if (!this.warningList.includes(message)) {this.warningList.push(message);}
    }

    private enabled(category: Category): boolean {
        return this.config.scenarios.categories.includes(category);
    }

    private secured(op: OperationModel): boolean {
        return this.model.schemes.length > 0 && op.security !== 'none';
    }

    private schemeOf(op: OperationModel): SecurityScheme | undefined {
        const names = Array.isArray(op.security) ? op.security : [];
        return this.model.schemes.find(s => names.includes(s.name)) ?? this.model.schemes[0];
    }

    // ---------------------------------------------------------------- layout

    private baseFor(op: OperationModel, kind: Kind): string {
        const d = domainOf(op);
        const root = slug(this.model.name) || 'api';
        const strategy = this.config.layout.strategy;
        if (kind === 'main') {return strategy === 'flat' ? root : strategy === 'method' ? `${op.method.toLowerCase()}/${d}` : `${d}/${d}`;}
        const suffix = kind === 'crud' ? 'crud' : 'security';
        return strategy === 'flat' ? `${root}-${suffix}` : `${d}/${d}-${suffix}`;
    }

    private push(op: OperationModel, kind: Kind, scenario: KarateScenario, secured = this.secured(op)): void {
        if (secured && kind !== 'security' && this.model.schemes.length > 0) {this.warnSchemeMismatch(op);}
        this.items.push({ base: this.baseFor(op, kind), kind, secured: kind === 'security' ? false : secured, domain: domainOf(op), scenario });
    }

    private warnSchemeMismatch(op: OperationModel): void {
        const first = this.model.schemes[0].name;
        if (!Array.isArray(op.security) || op.security.length === 0 || op.security.includes(first)) {return;}
        const message = `${op.sourceRef}: requires ${op.security.join(', ')} but common/auth.feature configures only '${first}'; add credentials for it`;
        if (!this.mismatchWarned.has(message)) {
            this.mismatchWarned.add(message);
            this.warn(message);
        }
    }

    private assemble(): PlannedFeature[] {
        const hasSecuredMain = new Set(this.items.filter(i => i.kind === 'main' && i.secured).map(i => i.base));
        const groups = new Map<string, Item[]>();
        for (const item of this.items) {
            const path = item.kind === 'main' && !item.secured && hasSecuredMain.has(item.base) ? `${item.base}-public` : item.base;
            groups.set(path, [...(groups.get(path) ?? []), item]);
        }
        const features: PlannedFeature[] = [];
        for (const [path, items] of [...groups.entries()].sort((a, b) => cmp(a[0], b[0]))) {
            const first = items[0];
            const needsAuth = this.model.schemes.length > 0 && first.kind !== 'security' && items.some(i => i.secured);
            const steps = [st('*', `url ${this.config.config.urlVariable}`)];
            if (needsAuth) {steps.push(st('*', "callonce read('classpath:common/auth.feature')"));}
            const label = this.config.layout.strategy === 'flat' ? titleCase(this.model.name) : titleCase(first.domain);
            const suffix = first.kind === 'crud' ? ' - CRUD lifecycle' : first.kind === 'security' ? ' - Security' : path.endsWith('-public') ? ' - Public' : '';
            features.push({
                relativePath: `${path}.feature`,
                feature: {
                    name: `${label} API${suffix}`,
                    description: `Generated from ${this.model.name} (${this.model.source})`,
                    background: { steps },
                    scenarios: this.uniqueNames(items.map(i => i.scenario))
                }
            });
        }
        return features;
    }

    private uniqueNames(scenarios: KarateScenario[]): KarateScenario[] {
        const seen = new Set<string>();
        for (const s of scenarios) {
            let name = s.name;
            if (seen.has(name) && s.source) {name = `${s.name} (${s.source})`;}
            for (let n = 2; seen.has(name); n++) {name = `${s.name} (${n})`;}
            seen.add(name);
            s.name = name;
        }
        return scenarios;
    }

    private collectFiles(): PlannedFile[] {
        for (const [resource, entries] of this.data) {
            if (this.config.data.externalize) {this.files.set(`data/${resource}.json`, `${JSON.stringify(entries, null, 2)}\n`);}
        }
        return [...this.files.entries()].sort((a, b) => cmp(a[0], b[0])).map(([path, content]) => ({ path, content, owner: 'user' as const }));
    }

    // ---------------------------------------------------------------- scenarios

    private tags(category: Category | undefined, op: OperationModel, extra: string[] = []): string[] {
        const tags: string[] = [];
        if (category && this.config.tags.auto) {tags.push(normTag(this.config.tags.taxonomy[category]));}
        tags.push(`@op=${tagSafe(op.id)}`, `@domain=${domainOf(op)}`, ...extra);
        return tags;
    }

    private scenario(op: OperationModel, category: Category | undefined, name: string, steps: KarateStep[], extra: Partial<KarateScenario> = {}, tags: string[] = []): KarateScenario {
        const s: KarateScenario = { name, steps, tags: this.tags(category, op, tags), domain: domainOf(op), source: op.sourceRef, ...extra };
        if (category) {s.category = category;}
        return s;
    }

    private label(op: OperationModel): string {
        return op.summary || `${op.method} ${op.path}`;
    }

    private planOperation(op: OperationModel, chained: Set<string>): void {
        const reason = this.unsupported.get(op.sourceRef);
        if (reason !== undefined) {return this.planDraft(op, reason);}
        if (truncated(op.body?.schema)) {return this.planDraft(op, 'Request body schema was truncated (too large to expand); provide the request body manually');}

        const ok = successResponses(op);
        if (ok.length === 0) {
            this.warn(`${op.sourceRef}: no 2xx response declared; positive and boundary scenarios skipped`);
        } else {
            if (this.enabled('positive') && !chained.has(op.id)) {this.planPositive(op, ok);}
            if (this.enabled('edge') || this.enabled('boundary')) {this.planBoundaries(op, ok[0]);}
        }
        if (this.enabled('negative')) {this.planNegative(op);}
        if (this.enabled('security')) {this.planSecurity(op);}
        if (this.config.scenarios.exploratory) {this.planOperationExploratory(op);}
    }

    private planDraft(op: OperationModel, reason: string): void {
        this.warn(`${op.sourceRef}: ${reason}`);
        const ok = successResponses(op)[0];
        const steps = [...this.requestSteps(op, { noBody: true, auth: false }), st('Then', `status ${ok?.status ?? '200'}`)];
        this.push(op, 'main', this.scenario(op, 'positive', this.label(op), steps, { draftReason: reason }));
    }

    // ---- request construction

    private payloadValue(op: OperationModel): unknown {
        if (isObj(op.body?.example) || Array.isArray(op.body?.example)) {return op.body!.example;}
        return valueFor(op.body?.schema ?? {}, '');
    }

    private payloadSteps(op: OperationModel, pv: string): KarateStep[] {
        const domain = domainOf(op);
        const value = this.payloadValue(op);
        const entries = this.data.get(domain) ?? {};
        entries[op.id] = value;
        this.data.set(domain, entries);
        const steps: KarateStep[] = [];
        if (this.config.data.externalize) {
            steps.push(st('*', `def ${pv} = karate.copy(read('classpath:data/${domain}.json')[${jsLiteral(op.id)}])`));
        } else {
            steps.push(st('*', `def ${pv} =`, { docString: JSON.stringify(value, null, 2) }));
        }
        for (const field of this.uniqueFields(op)) {
            const base = String(isObj(value) ? value[field] : field);
            steps.push(st('*', `set ${pv}.${field} = ${jsLiteral(`${base}-`)} + karate.uuid()`));
        }
        return steps;
    }

    private uniqueFields(op: OperationModel): string[] {
        const props = bodyProps(op);
        const value = this.payloadValue(op);
        return bodyRequired(op).filter(f => {
            const p = props[f];
            if (!isObj(p) || p.type !== 'string' || p.enum || p.format || p.pattern || !UNIQUE_FIELD.test(f)) {return false;}
            const base = String(isObj(value) ? value[f] : f);
            return typeof p.maxLength !== 'number' || base.length + 37 <= p.maxLength;
        });
    }

    private segmentExpr(segment: string): string {
        const parts = segment.split(/(\{[^}]+\})/).filter(Boolean);
        return parts.map(p => (/^\{.+\}$/.test(p) ? varName(p.slice(1, -1), this.style) : jsLiteral(p))).join(' + ');
    }

    private requestSteps(op: OperationModel, o: ReqOpts = {}): KarateStep[] {
        const pv = o.payloadVar ?? 'payload';
        const defs: KarateStep[] = [];
        const names = [...new Set([...op.pathParams.map(p => p.name), ...[...op.path.matchAll(/\{([^}]+)\}/g)].map(m => m[1])])];
        for (const name of names) {
            const param = op.pathParams.find(p => p.name === name);
            const v = varName(name, this.style);
            const expr = o.pathExprs?.[name] ?? jsLiteral(param?.example ?? valueFor(param?.schema ?? { type: 'integer' }, name));
            if (expr !== v) {defs.push(st('*', `def ${v} = ${expr}`));}
        }
        const hasBody = !o.noBody && op.body !== undefined;
        const body: KarateStep[] = hasBody ? [...this.payloadSteps(op, pv), ...(o.mutate ?? [])] : [];

        const request: Array<[string]> = [];
        const segments = op.path.split('/').filter(Boolean);
        if (segments.length > 0) {request.push([`path ${segments.map(s => this.segmentExpr(s)).join(', ')}`]);}
        const quote = (n: string): string => (/^[A-Za-z_][\w.-]*$/.test(n) ? n : jsLiteral(n));
        for (const q of op.queryParams) {
            if (o.query && q.name in o.query) {
                if (o.query[q.name] !== null) {request.push([`param ${quote(q.name)} = ${o.query[q.name]}`]);}
            } else if (q.required || q.schema.default !== undefined || q.example !== undefined) {
                request.push([`param ${quote(q.name)} = ${jsLiteral(q.example ?? valueFor(q.schema, q.name))}`]);
            }
        }
        const scheme = this.model.schemes[0];
        const authHeader = (n: string): boolean => n.toLowerCase() === 'authorization' || (scheme?.kind === 'apiKey' && scheme.in !== 'query' && scheme.paramName?.toLowerCase() === n.toLowerCase());
        for (const h of op.headerParams) {
            if (!h.required || authHeader(h.name)) {continue;}
            const generated = h.schema.format === 'uuid' || /request-?id|correlation|trace/i.test(h.name);
            request.push([`header ${h.name} = ${generated ? 'karate.uuid()' : jsLiteral(h.example ?? valueFor(h.schema, h.name))}`]);
        }
        if (o.auth !== false && this.secured(op) && scheme?.kind === 'apiKey' && scheme.in === 'query') {request.push([`param ${quote(scheme.paramName ?? 'api_key')} = apiKey`]);}
        if (o.auth !== false && this.secured(op) && scheme?.kind === 'apiKey' && scheme.in === 'cookie') {request.push([`cookie ${scheme.paramName ?? 'api_key'} = apiKey`]);}
        if (hasBody) {request.push([`request ${pv}`]);}

        const steps = [...defs, ...body];
        request.forEach(([text], i) => steps.push(st(i === 0 ? 'Given' : 'And', text)));
        steps.push(st('When', `method ${op.method.toLowerCase()}`));
        if (request.length === 0) {steps[steps.length - 1] = st('Given', `method ${op.method.toLowerCase()}`);}
        return steps;
    }

    // ---- response assertions

    private schemaFile(domain: string, ks: unknown, hint: string): string {
        const json = JSON.stringify(ks, null, 2);
        const names = this.schemaNames.get(domain) ?? new Map<string, string>();
        this.schemaNames.set(domain, names);
        const existing = names.get(json);
        if (existing) {return existing;}
        let name = names.size === 0 ? `schemas/${domain}.json` : `schemas/${domain}-${slug(hint) || 'schema'}.json`;
        for (let n = 2; this.files.has(name); n++) {name = `schemas/${domain}-${slug(hint) || 'schema'}-${n}.json`;}
        this.files.set(name, `${json}\n`);
        names.set(json, name);
        return name;
    }

    /** Assertion steps for a response. `draft` is set when the schema cannot be used. */
    private responseSteps(op: OperationModel, res: ResponseModel | undefined, hint: string): { steps: KarateStep[]; comments: string[]; draft?: string } {
        if (!res || !isObj(res.schema)) {return { steps: [], comments: ['no response body schema declared'] };}
        if (truncated(res.schema)) {return { steps: [], comments: [], draft: 'Response schema was truncated (too large to expand); add body assertions' };}
        const isArray = res.schema.type === 'array';
        if (isArray && !isObj(res.schema.items)) {return { steps: [st('And', "match response == '#[]'")], comments: [] };}
        const ks = toKarateSchema(isArray ? (res.schema.items as JsonSchema) : res.schema, { optionalAsDoubleHash: true });
        const file = this.schemaFile(domainOf(op), ks, hint);
        return { steps: [st('And', `match ${isArray ? 'each ' : ''}response == read('classpath:${file}')`)], comments: [] };
    }

    // ---- positive

    private planPositive(op: OperationModel, ok: ResponseModel[]): void {
        const lowest = ok[0];
        const resp = this.responseSteps(op, lowest, op.id);
        const steps = [...this.requestSteps(op), st('Then', `status ${lowest.status}`), ...resp.steps];
        const comments: string[] = [];
        if (ok.length > 1) {comments.push(`declared success statuses: ${ok.map(r => r.status).join(', ')}`);}
        comments.push(...resp.comments);
        if (op.pathParams.length > 0) {comments.push('Assumes a resource with this id exists in the target environment');}
        const destructive = op.method === 'DELETE';
        if (destructive) {comments.push('Destructive: removes the resource with this id');}
        const s = this.scenario(op, 'positive', `${this.label(op)} - returns ${lowest.status}`, steps, comments.length ? { comments } : {}, destructive ? [`@lock=${domainOf(op)}`] : []);
        if (resp.draft) {
            s.draftReason = resp.draft;
            this.warn(`${op.sourceRef}: ${resp.draft}`);
        }
        this.push(op, 'main', s);
    }

    // ---- negative

    private planNegative(op: OperationModel): void {
        const statuses = op.responses.map(r => r.status).filter(s => /^4\d\d$/.test(s)).sort();
        for (const status of statuses) {
            if (status === '400' || status === '422') {this.planInvalidRequest(op, status);}
            else if (status === '404') {this.planNotFound(op);}
        }
    }

    private invalidMutation(op: OperationModel): { label: string; opts: ReqOpts } | undefined {
        const props = bodyProps(op);
        if (op.body && !truncated(op.body.schema)) {
            const required = bodyRequired(op);
            if (required.length > 0) {return { label: `missing required field '${required[0]}'`, opts: { mutate: [st('*', `remove payload.${required[0]}`)] } };}
            for (const [field, schema] of Object.entries(props)) {
                const v = violation(schema);
                if (v) {return { label: `invalid '${field}' (${v.label})`, opts: { mutate: [st('*', `set payload.${field} = ${v.expr}`)] } };}
            }
        }
        for (const q of op.queryParams) {
            const v = violation(q.schema);
            if (v) {return { label: `invalid query parameter '${q.name}' (${v.label})`, opts: { query: { [q.name]: v.expr } } };}
        }
        for (const p of op.pathParams) {
            const v = violation(p.schema);
            if (v) {return { label: `invalid path parameter '${p.name}' (${v.label})`, opts: { pathExprs: { [p.name]: v.expr } } };}
        }
        return undefined;
    }

    private planInvalidRequest(op: OperationModel, status: string): void {
        const m = this.invalidMutation(op);
        if (!m) {return;}
        const resp = this.responseSteps(op, declared(op, status), `${op.id}-${status}`);
        const steps = [...this.requestSteps(op, m.opts), st('Then', `status ${status}`), ...(resp.draft ? [] : resp.steps)];
        this.push(op, 'main', this.scenario(op, 'negative', `${this.label(op)} - rejects ${m.label} with ${status}`, steps));
    }

    private planNotFound(op: OperationModel): void {
        if (op.pathParams.length === 0) {return;}
        const pathExprs: Record<string, string> = {};
        for (const p of op.pathParams) {
            pathExprs[p.name] = p.schema.format === 'uuid' ? jsLiteral(SAMPLE_UUID_ZERO) : p.schema.type === 'integer' || p.schema.type === 'number' ? '999999999' : `'does-not-exist-' + karate.uuid()`;
        }
        const resp = this.responseSteps(op, declared(op, '404'), `${op.id}-404`);
        const steps = [...this.requestSteps(op, { pathExprs }), st('Then', 'status 404'), ...(resp.draft ? [] : resp.steps)];
        this.push(op, 'main', this.scenario(op, 'negative', `${this.label(op)} - returns 404 for an unknown id`, steps));
    }

    // ---- security

    private planSecurity(op: OperationModel): void {
        if (!this.secured(op)) {return;}
        const steps = [...this.requestSteps(op, { auth: false }), st('Then', 'status 401')];
        this.push(op, 'security', this.scenario(op, 'security', `${this.label(op)} - rejects an unauthenticated request with 401`, steps));
        if (declared(op, '403')) {
            const scheme = this.schemeOf(op);
            const forbidden = [st('*', "def token = karate.sysenv('API_FORBIDDEN_TOKEN', '')"), ...this.credentialSteps(scheme, 'token')];
            const all = this.requestSteps(op, { auth: false });
            const at = all.findIndex(s => s.keyword === 'Given' || s.keyword === 'When');
            all.splice(at < 0 ? all.length : at, 0, ...forbidden);
            all.push(st('Then', 'status 403'));
            this.push(op, 'security', this.scenario(op, 'security', `${this.label(op)} - rejects a credential without permission with 403`, all, {
                draftReason: 'Requires a credential without permission; provide API_FORBIDDEN_TOKEN'
            }));
        }
    }

    private credentialSteps(scheme: SecurityScheme | undefined, valueExpr: string): KarateStep[] {
        if (scheme?.kind === 'apiKey') {
            const name = scheme.paramName ?? 'X-API-Key';
            if (scheme.in === 'query') {return [st('*', `param ${name} = ${valueExpr}`)];}
            if (scheme.in === 'cookie') {return [st('*', `cookie ${name} = ${valueExpr}`)];}
            return [st('*', `header ${name} = ${valueExpr}`)];
        }
        if (scheme?.kind === 'basic') {return [st('*', `header Authorization = 'Basic ' + ${valueExpr}`)];}
        return [st('*', `header Authorization = 'Bearer ' + ${valueExpr}`)];
    }

    // ---- boundary / edge

    private planBoundaries(op: OperationModel, ok: ResponseModel): void {
        const resp = this.responseSteps(op, ok, op.id);
        const targets: Array<{ kind: 'body' | 'query'; field: string; schema: JsonSchema }> = [];
        if (op.body && !truncated(op.body.schema)) {
            for (const [field, schema] of Object.entries(bodyProps(op))) {targets.push({ kind: 'body', field, schema });}
        }
        for (const q of op.queryParams) {targets.push({ kind: 'query', field: q.name, schema: q.schema });}

        for (const t of targets) {
            const cases = this.boundaryCases(t.schema);
            if (!cases || !this.enabled(cases.category)) {continue;}
            const cells = cases.values;
            if (cells.some(v => /[|\n\r]/.test(v.cell) || v.cell === '')) {continue;}
            const column = `${varName(t.field, this.style)}Value`;
            const apply = (expr: string): ReqOpts => (t.kind === 'body' ? { mutate: [st('*', `set payload.${t.field} = ${expr}`)] } : { query: { [t.field]: expr } });
            const tail = [st('Then', `status ${ok.status}`), ...(resp.draft ? [] : resp.steps)];
            const typed = cases.typed;
            if (cells.length >= this.config.scenarios.outlineThreshold) {
                const s = this.scenario(op, cases.category, `${this.label(op)} - ${cases.phrase(t.field)}`, [...this.requestSteps(op, apply(column)), ...tail], {
                    examples: { columns: [typed ? `${column}!` : column], rows: cells.map(v => [v.cell]) }
                });
                this.push(op, 'main', s);
            } else {
                for (const v of cells) {
                    this.push(op, 'main', this.scenario(op, cases.category, `${this.label(op)} - ${cases.single(t.field, v.desc)}`, [...this.requestSteps(op, apply(typed ? v.cell : jsLiteral(v.cell))), ...tail]));
                }
            }
        }
    }

    private boundaryCases(s: JsonSchema): { category: 'edge' | 'boundary'; typed: boolean; values: Array<{ cell: string; desc: string }>; phrase: (f: string) => string; single: (f: string, d: string) => string } | undefined {
        if (Array.isArray(s.enum) && s.enum.length >= 2) {
            const typed = s.enum.some((v: unknown) => typeof v !== 'string');
            return {
                category: 'edge', typed,
                values: s.enum.map((v: unknown) => ({ cell: typed ? jsLiteral(v) : String(v), desc: String(v) })),
                phrase: f => `accepts every allowed value of '${f}'`,
                single: (f, d) => `accepts '${f}' = ${d}`
            };
        }
        if ((s.type === 'integer' || s.type === 'number') && (typeof s.minimum === 'number' || typeof s.maximum === 'number')) {
            const values: Array<{ cell: string; desc: string }> = [];
            if (typeof s.minimum === 'number') {values.push({ cell: String(s.minimum), desc: `minimum ${s.minimum}` });}
            if (typeof s.maximum === 'number') {values.push({ cell: String(s.maximum), desc: `maximum ${s.maximum}` });}
            return { category: 'boundary', typed: true, values, phrase: f => `accepts the minimum and maximum of '${f}'`, single: (f, d) => `accepts '${f}' at its ${d}` };
        }
        if (s.type === 'string' && !s.format && !s.pattern && !s.enum && ((typeof s.minLength === 'number' && s.minLength >= 1) || (typeof s.maxLength === 'number' && s.maxLength >= 1 && s.maxLength <= 1000))) {
            const values: Array<{ cell: string; desc: string }> = [];
            if (typeof s.minLength === 'number' && s.minLength >= 1) {values.push({ cell: `'a'.repeat(${s.minLength})`, desc: `minimum length ${s.minLength}` });}
            if (typeof s.maxLength === 'number' && s.maxLength <= 1000 && s.maxLength !== s.minLength) {values.push({ cell: `'a'.repeat(${s.maxLength})`, desc: `maximum length ${s.maxLength}` });}
            return { category: 'boundary', typed: true, values, phrase: f => `accepts the shortest and longest '${f}'`, single: (f, d) => `accepts '${f}' at its ${d}` };
        }
        return undefined;
    }

    // ---- CRUD

    private findChains(): Chain[] {
        const chains: Chain[] = [];
        for (const create of this.ops) {
            if (create.method !== 'POST' || create.path.includes('{') || this.unsupported.has(create.sourceRef)) {continue;}
            const item = new RegExp(`^${create.path.replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\{([^}/]+)\\}$`);
            const pick = (...methods: string[]): OperationModel | undefined => {
                for (const m of methods) {
                    const found = this.ops.find(o => o.method === m && item.test(o.path) && !this.unsupported.has(o.sourceRef));
                    if (found) {return found;}
                }
                return undefined;
            };
            const read = pick('GET');
            const update = pick('PUT', 'PATCH');
            const del = pick('DELETE');
            if (!read || !update || !del) {continue;}
            const idParam = item.exec(read.path)![1];
            const res = successResponses(create)[0]?.schema;
            const props = isObj(res?.properties) ? Object.keys(res!.properties) : [];
            const idField = props.includes('id') ? 'id' : props.find(p => /Id$|_id$/i.test(p));
            if (!idField || truncated(create.body?.schema) || truncated(update.body?.schema)) {
                this.warn(`${create.sourceRef}: CRUD chain skipped - cannot determine the id field from the create response`);
                continue;
            }
            chains.push({ domain: domainOf(create), create, read, update, del, idField, idParam });
        }
        return chains;
    }

    private planChain(chain: Chain): void {
        const { create, read, update, del } = chain;
        const idVar = varName(chain.idParam, this.style);
        const okOf = (op: OperationModel): string => successResponses(op)[0]?.status ?? '200';
        const asserts = (op: OperationModel): KarateStep[] => {
            const r = this.responseSteps(op, successResponses(op)[0], op.id);
            return r.draft ? [] : r.steps;
        };
        const field = this.uniqueFields(create).find(f => isObj(successResponses(read)[0]?.schema?.properties) && f in (successResponses(read)[0].schema!.properties as object));
        const updateField = this.uniqueFields(update).find(f => {
            const props = successResponses(update)[0]?.schema?.properties;
            return isObj(props) && f in props;
        });
        const ids = { [chain.idParam]: idVar };

        const steps: KarateStep[] = [
            ...this.requestSteps(create), st('Then', `status ${okOf(create)}`), ...asserts(create),
            st('*', `def ${idVar} = response.${chain.idField}`),
            ...this.requestSteps(read, { pathExprs: ids }), st('Then', `status ${okOf(read)}`), ...asserts(read),
            ...(field ? [st('And', `match response.${field} == payload.${field}`)] : []),
            ...this.requestSteps(update, { pathExprs: ids, payloadVar: 'updatePayload' }), st('Then', `status ${okOf(update)}`), ...asserts(update),
            ...(updateField ? [st('And', `match response.${updateField} == updatePayload.${updateField}`)] : []),
            ...this.requestSteps(del, { pathExprs: ids }), st('Then', `status ${okOf(del)}`)
        ];
        if (declared(read, '404')) {steps.push(...this.requestSteps(read, { pathExprs: ids }), st('Then', 'status 404'));}

        const resource = domainOf(create);
        const s = this.scenario(create, 'positive', `${titleCase(resource)} lifecycle - create, read, update, delete`, steps, {
            comments: [`Covers: ${[read, update, del].map(o => o.sourceRef).join(', ')}`]
        }, ['@crud', `@lock=${resource}`]);
        const secured = [create, read, update, del].some(o => this.secured(o));
        [create, read, update, del].forEach(o => this.secured(o) && this.warnSchemeMismatch(o));
        this.items.push({ base: this.baseFor(create, 'crud'), kind: 'crud', secured, domain: resource, scenario: s });
    }

    // ---- exploratory

    private exploratory(op: OperationModel, name: string, steps: KarateStep[], source = op.sourceRef): KarateScenario {
        const s = this.scenario(op, undefined, name, [...steps, st('Then', 'assert responseStatus < 500')], { comments: [EXPLORATORY_NOTE], source });
        s.tags = [normTag(this.config.tags.taxonomy.exploratory), ...(s.tags ?? [])];
        return s;
    }

    private planOperationExploratory(op: OperationModel): void {
        if (this.unsupported.has(op.sourceRef) || truncated(op.body?.schema)) {return;}
        // Injection string in the first free-text parameter.
        const q = op.queryParams.find(p => p.schema.type === 'string' && !p.schema.enum && !p.schema.format);
        const field = Object.entries(bodyProps(op)).find(([, s]) => s.type === 'string' && !s.enum && !s.format);
        if (q) {
            this.push(op, 'main', this.exploratory(op, `${this.label(op)} - handles an injection string in '${q.name}'`, this.requestSteps(op, { query: { [q.name]: jsLiteral(INJECTION) } })));
        } else if (op.body && field) {
            this.push(op, 'main', this.exploratory(op, `${this.label(op)} - handles an injection string in '${field[0]}'`, this.requestSteps(op, { mutate: [st('*', `set payload.${field[0]} = ${jsLiteral(INJECTION)}`)] })));
        }
        // Empty credentials (runs unauthenticated, so it lives with the security scenarios).
        if (this.secured(op)) {
            const scheme = this.schemeOf(op);
            const steps = this.requestSteps(op, { auth: false });
            const at = steps.findIndex(s => s.keyword === 'Given' || s.keyword === 'When');
            steps.splice(at < 0 ? steps.length : at, 0, ...this.credentialSteps(scheme, "''").map(s => ({ ...s, text: s.text.replace(/ = 'Bearer ' \+ ''$| = 'Basic ' \+ ''$/, " = ''") })));
            this.push(op, 'security', this.exploratory(op, `${this.label(op)} - handles empty credentials`, steps));
        }
    }

    private planPathExploratory(): void {
        const byPath = new Map<string, OperationModel[]>();
        for (const op of this.ops) {byPath.set(op.path, [...(byPath.get(op.path) ?? []), op]);}
        for (const [path, ops] of [...byPath.entries()].sort((a, b) => cmp(a[0], b[0]))) {
            const used = new Set(ops.map(o => o.method));
            const method = ['PATCH', 'DELETE', 'PUT', 'POST'].find(m => !used.has(m));
            const first = ops.find(o => !this.unsupported.has(o.sourceRef));
            if (!method || !first) {continue;}
            const virtual: OperationModel = { ...first, method, body: undefined, queryParams: [], headerParams: [], sourceRef: `${method} ${path}` };
            this.push(first, 'main', this.exploratory(first, `${method} ${path} is not accepted`, this.requestSteps(virtual, { auth: true }), virtual.sourceRef), this.secured(first));
        }
    }
}

export function planOpenApi(model: GenerationModel, config: GeneratorConfig): PlanResult {
    return new Planner(model, config).plan();
}
