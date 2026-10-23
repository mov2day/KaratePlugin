// Pure GraphQL schema -> GenerationModel + planned features adapter. No vscode, no logger, no I/O.
// Only what the schema evidences is generated: operation text and selection sets come from the declared types,
// variable values from the deterministic data factory, assertions from the declared return types.
import type { KarateScenario, KarateStep } from '../../types';
import { BUILTIN_SCALARS, namedType, parseTypeRef } from '../../services/graphql/GraphQLParser';
import type { GraphQLArg, GraphQLField, GraphQLSchema, GraphQLTypeDef, TypeRef } from '../../services/graphql/GraphQLParser';
import type { GeneratorConfig } from '../config/GeneratorConfig';
import type { GenerationModel, JsonSchema, OperationModel, SecurityScheme } from '../model/TestModel';
import { valueFor } from '../plan/dataFactory';
import type { PlannedFeature } from '../plan/OpenApiPlanner';
import { slug } from '../plan/slug';
import { camelName, isSecretKey, looksLikeCredentialValue, upperSnake } from './secrets';

export interface GraphQLPlanOptions {
    config: GeneratorConfig;
    /** Feature, folder and file name stem. */
    name: string;
    /** Path the GraphQL endpoint is served at, relative to the base URL. Default `graphql`. */
    endpointPath?: string;
    /** Endpoint origin; reduced to scheme://host[:port] (path, query and credentials are never kept). */
    baseUrl?: string;
    /**
     * How the endpoint authenticates. A schema cannot say, so without this hint the generated tests are unauthenticated.
     * With it, every operation is marked secured and the features call `common/auth.feature`.
     */
    auth?: GraphQLAuthHint;
}

export type GraphQLAuthHint = { type: 'bearer' } | { type: 'basic' } | { type: 'apiKey'; /** Header name; default `X-API-Key`. */ header?: string };

export interface GraphQLPlan {
    model: GenerationModel;
    features: PlannedFeature[];
    files: { path: string; content: string; owner: 'user' }[];
    warnings: string[];
    unsupported: { sourceRef: string; reason: string }[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const SIMPLE_KEY = /^[A-Za-z_$][\w$]*$/;
const MAX_FIELDS = 12;
const MAX_INLINE = 100;

/** Karate/JS single-quoted string literal. Every character that could end or break the literal is escaped. */
export function q(s: string): string {
    const body = s
        .replace(/[\\']/g, '\\$&')
        .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
        .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    return `'${body}'`;
}

/** Karate-style relaxed JSON literal. */
function lit(v: unknown, pretty = false, depth = 0): string {
    if (typeof v === 'string') {return q(v);}
    if (Array.isArray(v)) {return `[${v.map(x => lit(x, pretty, depth + 1)).join(', ')}]`;}
    if (isObj(v)) {
        const entries = Object.entries(v).map(([k, x]) => `${SIMPLE_KEY.test(k) ? k : q(k)}: ${lit(x, pretty, depth + 1)}`);
        if (entries.length === 0) {return '{}';}
        if (!pretty) {return `{ ${entries.join(', ')} }`;}
        const pad = '  '.repeat(depth + 1);
        return `{\n${entries.map(e => `${pad}${e}`).join(',\n')}\n${'  '.repeat(depth)}}`;
    }
    return String(v);
}

/**
 * Reduces a user-supplied endpoint URL to its origin and path. Credentials, the query string (often `?token=`) and
 * the fragment are dropped; `strippedQuery` tells the caller to warn.
 */
export function splitEndpointUrl(raw: string): { baseUrl?: string; endpointPath: string; strippedQuery: boolean } {
    try {
        const u = new URL(raw);
        return {
            baseUrl: u.origin === 'null' ? undefined : u.origin,
            endpointPath: u.pathname.replace(/^\/+|\/+$/g, '') || 'graphql',
            strippedQuery: u.search !== '' || u.username !== '' || u.password !== '' || u.hash !== ''
        };
    } catch {
        return { endpointPath: 'graphql', strippedQuery: false };
    }
}

// ---- GraphQL literal -> JS value (variable defaults)
function parseLiteral(text: string): unknown {
    let i = 0;
    const ws = (): void => { while (i < text.length && /[\s,]/.test(text[i])) {i++;} };
    const value = (): unknown => {
        ws();
        const c = text[i];
        if (c === '"') {
            if (text.startsWith('"""', i)) {
                const end = text.indexOf('"""', i + 3);
                if (end < 0) {throw new Error('unterminated');}
                const raw = text.slice(i + 3, end);
                i = end + 3;
                return raw.trim();
            }
            let out = '';
            i++;
            while (i < text.length && text[i] !== '"') {
                if (text[i] === '\\') {
                    const e = text[i + 1];
                    if (e === 'u') {out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)); i += 6; continue;}
                    out += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[e] ?? e;
                    i += 2;
                } else {
                    out += text[i++];
                }
            }
            if (text[i] !== '"') {throw new Error('unterminated');}
            i++;
            return out;
        }
        if (c === '[') {
            i++;
            const out: unknown[] = [];
            for (;;) {
                ws();
                if (text[i] === ']') {i++; return out;}
                if (i >= text.length) {throw new Error('unterminated');}
                out.push(value());
            }
        }
        if (c === '{') {
            i++;
            const out: Obj = {};
            for (;;) {
                ws();
                if (text[i] === '}') {i++; return out;}
                const m = /^[A-Za-z_]\w*/.exec(text.slice(i));
                if (!m) {throw new Error('bad key');}
                i += m[0].length;
                ws();
                if (text[i] !== ':') {throw new Error('bad object');}
                i++;
                out[m[0]] = value();
            }
        }
        const m = /^[^\s,\]}]+/.exec(text.slice(i));
        if (!m) {throw new Error('empty');}
        i += m[0].length;
        const t = m[0];
        if (t === 'true') {return true;}
        if (t === 'false') {return false;}
        if (t === 'null') {return null;}
        if (/^-?\d+$/.test(t)) {
            const n = Number(t);
            if (!Number.isSafeInteger(n)) {throw new Error('unsafe integer');}
            return n;
        }
        if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) {return Number(t);}
        return t; // enum value
    };
    const v = value();
    ws();
    if (i < text.length) {throw new Error('trailing');}
    return v;
}

const CUSTOM_SCALARS: Record<string, JsonSchema> = {
    DateTime: { type: 'string', format: 'date-time' }, Date: { type: 'string', format: 'date' },
    UUID: { type: 'string', format: 'uuid' }, Email: { type: 'string', format: 'email' }, EmailAddress: { type: 'string', format: 'email' },
    URL: { type: 'string', format: 'uri' }, URI: { type: 'string', format: 'uri' },
    JSON: { type: 'object' }, JSONObject: { type: 'object' }
};

interface Gen { unknown: string[]; recursive: string[] }

/** JSON-schema view of a GraphQL input type, so the shared data factory can produce the value. */
function inputSchema(ref: TypeRef, types: Record<string, GraphQLTypeDef>, gen: Gen, seen: string[]): JsonSchema {
    if (ref.list) {return { type: 'array', items: inputSchema(ref.list, types, gen, seen) };}
    const name = ref.name ?? 'Unknown';
    switch (name) {
        case 'String': return { type: 'string' };
        case 'ID': return { type: 'string' };
        case 'Int': return { type: 'integer' };
        case 'Float': return { type: 'number' };
        case 'Boolean': return { type: 'boolean' };
        default: break;
    }
    const def = types[name];
    if (def?.kind === 'enum' && def.enumValues.length > 0) {return { enum: [def.enumValues[0]] };}
    if (def?.kind === 'input' && !seen.includes(name)) {
        const props: Obj = {};
        for (const f of def.fields) {
            const r = parseTypeRef(f.type);
            const nm = namedType(f.type);
            if (r.nonNull && types[nm]?.kind === 'input' && [...seen, name].includes(nm)) {
                gen.recursive.push(`${name}.${f.name}`);
                continue;
            }
            if (r.nonNull) {props[f.name] = inputSchema(r, types, gen, [...seen, name]);}
        }
        return { type: 'object', properties: props };
    }
    if (CUSTOM_SCALARS[name] && (!def || def.kind === 'scalar')) {return CUSTOM_SCALARS[name];}
    gen.unknown.push(name);
    return { type: 'object' };
}

interface Selection { lines: string[]; match: Obj }

export function buildGraphQLPlan(schema: GraphQLSchema, opts: GraphQLPlanOptions): GraphQLPlan {
    if (!opts?.config) {throw new Error('buildGraphQLPlan: "opts.config" is required');}
    const config = opts.config;
    const types = schema.types ?? {};
    const warnings: string[] = [];
    const warned = new Set<string>();
    const warnOnce = (m: string): void => { if (!warned.has(m)) { warned.add(m); warnings.push(m); } };
    const unsupported: { sourceRef: string; reason: string }[] = [];

    const rawName = (opts.name ?? '').replace(/\s+/g, ' ').trim();
    const name = rawName || 'GraphQL API';
    const stem = slug(name) || 'graphql';
    const endpoint = (opts.endpointPath ?? 'graphql').split(/[?#]/)[0].replace(/^\/+|\/+$/g, '') || 'graphql';

    let baseUrl: string | undefined;
    if (opts.baseUrl) {
        const s = splitEndpointUrl(opts.baseUrl);
        baseUrl = s.baseUrl;
        if (s.strippedQuery) {warnOnce('The endpoint URL had a query string or credentials; they were removed and are not written anywhere. Configure authentication in karate-config');}
    }

    const st = (keyword: KarateStep['keyword'], text: string, extra: Partial<KarateStep> = {}): KarateStep => ({ keyword, text, ...extra });
    const normTag = (t: string): string => (t.startsWith('@') ? t : `@${t}`);
    const cat = (c: keyof GeneratorConfig['tags']['taxonomy']): string[] => (config.tags.auto ? [normTag(config.tags.taxonomy[c])] : []);
    const isScalarish = (n: string): boolean => BUILTIN_SCALARS.includes(n) || types[n]?.kind === 'enum' || types[n]?.kind === 'scalar';

    const marker = (n: string, nonNull: boolean): string => {
        const m = n === 'Int' || n === 'Float' ? '#number' : n === 'Boolean' ? '#boolean' : n === 'String' || n === 'ID' || types[n]?.kind === 'enum' ? '#string' : '#present';
        return nonNull ? m : m === '#present' ? '##ignore' : `#${m}`;
    };

    // ---- selection sets (never beyond what the schema declares)
    const selection = (typeName: string, depth: number): Selection => {
        const def = types[typeName];
        const typename: Selection = { lines: ['__typename'], match: { __typename: '#string' } };
        if (!def || def.kind !== 'object' && def.kind !== 'interface') {return typename;}
        const lines: string[] = [];
        const match: Obj = {};
        for (const f of def.fields) {
            if (lines.length >= MAX_FIELDS) {break;}
            if (f.deprecated || f.name.startsWith('__') || f.args.some(a => a.required)) {continue;}
            const ref = parseTypeRef(f.type);
            let inner = ref;
            while (inner.list) {inner = inner.list;}
            const n = inner.name ?? 'Unknown';
            if (isScalarish(n)) {
                lines.push(f.name);
                match[f.name] = ref.list ? `${ref.nonNull ? '#' : '##'}[]${inner.nonNull && !ref.list.list ? ` ${marker(n, true)}` : ''}` : marker(n, ref.nonNull);
            } else if (depth < 1 && (types[n]?.kind === 'object' || types[n]?.kind === 'interface')) {
                const sub = selection(n, depth + 1);
                lines.push(`${f.name} {`, ...sub.lines.map(l => `  ${l}`), '}');
                const p = ref.nonNull ? '#' : '##';
                match[f.name] = ref.list ? (ref.list.list ? `${p}[]` : `${p}[] #object`) : `${p}object`;
            }
        }
        if (lines.length === 0) {return typename;}
        return { lines, match };
    };

    // ---- variables
    const secretDefs = new Map<string, string>(); // variable -> env name (per feature, reset by the caller)
    const useSecret = (key: string): string => {
        const v = camelName(key);
        secretDefs.set(v, upperSnake(key));
        return `#(${v})`;
    };

    const sanitizeValue = (v: unknown, key: string, reasons: string[]): unknown => {
        if (Array.isArray(v)) {return v.map(x => sanitizeValue(x, key, reasons));}
        if (isObj(v)) {return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sanitizeValue(x, k, reasons)]));}
        if (typeof v === 'string' || typeof v === 'number') {
            if (isSecretKey(key) && v !== '') {return useSecret(key);}
            if (typeof v === 'string') {
                if (looksLikeCredentialValue(v)) {return useSecret(key);}
                if (v.startsWith('#')) {reasons.push(`A sample value starts with "#", which Karate would read as a macro (argument "${key}")`);}
            }
        }
        return v;
    };

    interface Built { variables: Obj; declarations: string[]; omitted?: string; reasons: string[] }
    const variablesFor = (field: GraphQLField, omitFirstRequired: boolean): Built => {
        const variables: Obj = {};
        const declarations: string[] = [];
        const reasons: string[] = [];
        let omitted: string | undefined;
        for (const a of field.args as GraphQLArg[]) {
            let value: unknown;
            let have = false;
            if (a.defaultValue !== undefined) {
                try {
                    value = parseLiteral(a.defaultValue);
                    have = true;
                } catch {
                    warnOnce(`Default value of ${field.type} ${field.name}(${a.name}) could not be read and was not used`);
                }
            }
            const mustSend = a.required && !have;
            if (!have && mustSend) {
                const gen: Gen = { unknown: [], recursive: [] };
                value = valueFor(inputSchema(parseTypeRef(a.type), types, gen, []), a.name);
                have = true;
                for (const r of [...new Set(gen.recursive)]) {
                    warnOnce(`${field.type} ${field.name}(${a.name}): recursive required input ${r}; supply a value manually`);
                    reasons.push(`Recursive required input ${r}; supply a value manually`);
                }
                if (gen.unknown.length > 0) {
                    const t = [...new Set(gen.unknown)].join(', ');
                    warnOnce(`${field.type} ${field.name}(${a.name}): no sample value for custom type ${t}; an empty object was used`);
                    reasons.push(`No sample value for custom type ${t} of required argument "${a.name}"; provide one in the variables`);
                }
            }
            if (!have) {continue;}
            declarations.push(`$${a.name}: ${a.type}${a.required ? '!' : ''}`);
            if (omitFirstRequired && mustSend && omitted === undefined) {omitted = a.name; continue;}
            variables[a.name] = sanitizeValue(value, a.name, reasons);
        }
        // declared variables must match the ones sent (an omitted one stays declared on purpose)
        return { variables, declarations, omitted, reasons };
    };
    // ---- scenarios
    const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
    const operationText = (field: GraphQLField, built: Built, sel: Selection | undefined): string => {
        const kw = field.type === 'Query' ? 'query' : 'mutation';
        const decl = built.declarations.length > 0 ? `(${built.declarations.join(', ')})` : '';
        const call = field.args.length > 0 && built.declarations.length > 0
            ? `(${field.args.filter(a => built.declarations.some(d => d.startsWith(`$${a.name}:`))).map(a => `${a.name}: $${a.name}`).join(', ')})`
            : '';
        const body = sel ? ` {\n${sel.lines.map(l => `    ${l}`).join('\n')}\n  }` : '';
        return `${kw} ${capital(field.name)}${decl} {\n  ${field.name}${call}${body}\n}`;
    };

    const requestSteps = (text: string, variables: Obj | undefined): KarateStep[] => {
        const steps: KarateStep[] = [st('Given', `path ${q(endpoint)}`), st('And', 'text query =', { docString: text })];
        if (variables && Object.keys(variables).length > 0) {
            const one = lit(variables);
            steps.push(one.length <= MAX_INLINE ? st('And', `def variables = ${one}`) : st('And', 'def variables =', { docString: JSON.stringify(variables, null, 2) }));
            steps.push(st('And', "request { query: '#(query)', variables: '#(variables)' }"));
        } else {
            steps.push(st('And', "request { query: '#(query)' }"));
        }
        steps.push(st('When', 'method post'));
        return steps;
    };
    const matchStep = (target: string, value: unknown): KarateStep => {
        const one = lit(value);
        return one.length <= MAX_INLINE ? st('And', `match ${target} == ${one}`) : st('And', `match ${target} ==`, { docString: lit(value, true) });
    };

    const operations: OperationModel[] = [];
    const scheme: SecurityScheme | undefined = opts.auth?.type === 'bearer' ? { name: 'bearer', kind: 'bearer' }
        : opts.auth?.type === 'basic' ? { name: 'basic', kind: 'basic' }
        : opts.auth?.type === 'apiKey' ? { name: 'apiKey', kind: 'apiKey', in: 'header', paramName: opts.auth.header?.trim() || 'X-API-Key' }
        : undefined;
    let deprecated = 0;
    const buildFor = (fields: GraphQLField[], kind: 'Query' | 'Mutation'): { scenarios: KarateScenario[]; secrets: Map<string, string> } => {
        secretDefs.clear();
        const scenarios: KarateScenario[] = [];
        const wantPositive = config.scenarios.categories.includes('positive');
        const wantNegative = config.scenarios.categories.includes('negative');
        for (const field of fields) {
            if (field.deprecated) {deprecated++; continue;}
            const ref = parseTypeRef(field.returnType);
            let inner = ref;
            while (inner.list) {inner = inner.list;}
            const n = inner.name ?? 'Unknown';
            const sel = isScalarish(n) ? undefined : selection(n, 0);
            const tagsOf = (c: 'positive' | 'negative'): string[] => [...cat(c), ...(config.tags.auto ? [`@op=${field.name}`] : [])];
            const base = `${kind} ${field.name}`;
            const opId = `${kind.toLowerCase()}-${field.name}`;
            operations.push({
                id: opId, method: 'POST', path: `/${endpoint}`, summary: base, tags: [], pathParams: [], queryParams: [], headerParams: [],
                responses: [{ status: '200' }], security: scheme ? [scheme.name] : 'none', sourceRef: base
            });

            const pos = variablesFor(field, false);
            const posText = operationText(field, pos, sel);
            if (posText.includes('"""')) {continue;}
            const draft = (r: string[]): string | undefined => (r.length > 0 ? [...new Set(r)].join('; ') : undefined);

            if (wantPositive) {
                const steps = requestSteps(posText, pos.variables);
                steps.push(st('Then', 'status 200'), st('And', "match response.errors == '#notpresent'"));
                const target = `response.data.${field.name}`;
                if (isScalarish(n) && !ref.list) {
                    steps.push(st('And', `match ${target} == ${q(marker(n, ref.nonNull))}`));
                } else if (ref.list) {
                    const itemMarker = sel ? '#object' : marker(n, true);
                    const arr = inner.nonNull && !ref.list.list ? `[] ${itemMarker}` : '[]';
                    steps.push(st('And', `match ${target} == ${q(`${ref.nonNull ? '#' : '##'}${arr}`)}`));
                    if (sel && inner.nonNull && ref.nonNull && !ref.list.list) {steps.push(matchStep(`each ${target}`, sel.match));}
                } else if (ref.nonNull && sel) {
                    steps.push(matchStep(target, sel.match));
                } else {
                    steps.push(st('And', `match ${target} == '#present'`));
                }
                const reason = draft(pos.reasons);
                scenarios.push({
                    name: `${base} - success`, steps, tags: tagsOf('positive'), category: 'positive', source: base,
                    ...(reason ? { draftReason: reason } : {})
                });
            }

            const required = (field.args as GraphQLArg[]).filter(a => a.required && a.defaultValue === undefined);
            if (wantNegative && required.length > 0) {
                const neg = variablesFor(field, true);
                const steps = requestSteps(operationText(field, neg, sel), neg.variables);
                steps.push(
                    st('Then', 'assert responseStatus == 200 || responseStatus == 400', { comment: 'GraphQL over HTTP: request errors arrive as 200 or 400 depending on the server' }),
                    st('And', "match response.errors == '#[_ > 0]'")
                );
                const reason = draft(neg.reasons);
                scenarios.push({
                    name: `${base} - missing required variable ${neg.omitted ?? required[0].name}`, steps, tags: tagsOf('negative'), category: 'negative', source: base,
                    ...(reason ? { draftReason: reason } : {})
                });
            }
        }
        return { scenarios, secrets: new Map(secretDefs) };
    };

    const queries = buildFor(schema.queries, 'Query');
    const mutations = buildFor(schema.mutations, 'Mutation');

    // ---- exploratory (opt-in): the server must not crash on unusual but well-formed requests
    if (config.scenarios.exploratory) {
        const probe = (title: string, text: string): KarateScenario => ({
            name: `Exploratory - ${title}`,
            steps: [...requestSteps(text, undefined), st('Then', 'assert responseStatus < 500')],
            tags: [...cat('exploratory'), ...(config.tags.auto ? ['@op=introspection'] : [])], source: 'Introspection'
        });
        const target = queries.scenarios.length > 0 || mutations.scenarios.length === 0 ? queries : mutations;
        target.scenarios.push(
            probe('introspection query', '{\n  __schema {\n    queryType {\n      name\n    }\n  }\n}'),
            probe('deeply nested introspection query', '{\n  __schema {\n    types {\n      fields {\n        type {\n          ofType {\n            ofType {\n              ofType {\n                name\n              }\n            }\n          }\n        }\n      }\n    }\n  }\n}')
        );
    }

    for (const s of schema.subscriptions ?? []) {
        unsupported.push({ sourceRef: `Subscription ${s.name}`, reason: 'subscriptions are not supported (they need a WebSocket, not a single HTTP request)' });
    }
    if ((schema.subscriptions ?? []).length > 0) {
        warnOnce(`${schema.subscriptions!.length} subscription field(s) were skipped: Karate generation covers queries and mutations over HTTP`);
    }
    if (deprecated > 0) {warnOnce(`${deprecated} deprecated field(s) were skipped`);}
    if (schema.queries.length + schema.mutations.length === 0) {warnOnce('The schema has no Query or Mutation fields');}
    for (const f of [...schema.queries, ...schema.mutations]) {
        if (!f.deprecated && !isScalarish(namedType(f.returnType)) && !types[namedType(f.returnType)]) {
            warnOnce(`Return type ${namedType(f.returnType)} of ${f.type} ${f.name} is not defined in the schema; only __typename is selected`);
        }
    }

    // ---- features
    const flat = config.layout.strategy === 'flat';
    const make = (kind: 'queries' | 'mutations', built: { scenarios: KarateScenario[]; secrets: Map<string, string> }): PlannedFeature[] => {
        if (built.scenarios.length === 0) {return [];}
        const bg: KarateStep[] = [st('*', `url ${config.config.urlVariable}`)];
        if (scheme) {bg.push(st('*', "call read('classpath:common/auth.feature')"));}
        for (const [v, env] of built.secrets) {bg.push(st('*', `def ${v} = karate.sysenv(${q(env)}, '')`));}
        if (built.secrets.size > 0) {
            warnOnce(`Credential-like arguments use karate.sysenv(...); set ${[...built.secrets.values()].join(', ')} in the environment before running`);
        }
        const file = `${stem}-${kind}.feature`;
        return [{
            relativePath: flat ? file : `${stem}/${file}`,
            feature: {
                name: `${name} ${kind}`,
                description: scheme
                    ? 'Generated from a GraphQL schema. Authentication comes from common/auth.feature.'
                    : 'Generated from a GraphQL schema. Authentication is not part of a schema: configure it in karate-config or a common auth feature.',
                background: { steps: bg },
                scenarios: built.scenarios
            }
        }];
    };
    const features = [...make('queries', queries), ...make('mutations', mutations)];

    const model: GenerationModel = { source: 'graphql', name, baseUrl, schemes: scheme ? [scheme] : [], operations, unsupported };
    return { model, features, files: [], warnings, unsupported };
}

/**
 * Removes an endpoint URL's secrets from text that is shown or logged: the whole URL, credentials, query values,
 * the host, and path segments that look like embedded keys (20+ characters of [A-Za-z0-9_-] mixing letters and digits).
 */
export function redactEndpoint(text: string, url: string | undefined): string {
    if (!url) {return text;}
    let out = text.split(url).join('[endpoint]');
    try {
        const u = new URL(url);
        const parts = [u.password, u.username, ...[...u.searchParams.values()], u.search.replace(/^\?/, ''), u.host, u.hostname];
        for (const seg of u.pathname.split('/')) {
            if (/^[A-Za-z0-9_-]{20,}$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg)) {parts.push(seg);}
        }
        for (const part of parts.filter(x => x).sort((a, b) => b.length - a.length)) {out = out.split(part).join('[redacted]');}
    } catch { /* keep text */ }
    return out;
}
