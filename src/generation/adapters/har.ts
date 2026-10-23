// Pure HAR / recorded-session -> GenerationModel + planned features adapter. No vscode, no logger, no I/O.
// The capture is the only evidence: only requests that were observed (with a response) are converted, in the observed
// order, as ONE scenario per recorded flow (later requests depend on earlier ones).
import type { KarateScenario, KarateStep } from '../../types';
import type { CapturedRequest } from '../../services/session/CapturedRequest';
import type { GeneratorConfig } from '../config/GeneratorConfig';
import type { GenerationModel, OperationModel, SecurityScheme } from '../model/TestModel';
import { planAuth, requiredSecrets } from '../plan/AuthSchemes';
import type { PlannedFeature } from '../plan/OpenApiPlanner';
import { slug } from '../plan/slug';
import { camelName, containsCredentialValue, credentialKeys, isSecretKey, looksLikeCredentialValue, upperSnake } from './secrets';

export interface HarModelOptions {
    config: GeneratorConfig;
    /** Feature, scenario and file name stem (the HAR file name or the session label). */
    name: string;
    mode: 'har' | 'session';
    /** When non-empty, only requests to these hosts (`host` or `host:port`) are kept. */
    allowedHosts?: string[];
    sourceRef: string;
}

export interface HarBuild {
    model: GenerationModel;
    features: PlannedFeature[];
    /** Classpath-relative files (`data/<name>-<n>.json`); the caller prefixes the classpath root. */
    files: { path: string; content: string; owner: 'user' }[];
    unsupported: { sourceRef: string; reason: string }[];
    warnings: string[];
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const STATIC_EXT = /\.(?:m?js|css|map|png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp[34]|webm|ogg|wav|wasm|pdf|zip|gz|html?)$/i;
const STATIC_TYPE = /^(?:image|font|audio|video)\/|^text\/css|javascript|^text\/html|application\/(?:font|wasm|octet-stream|pdf|zip)/i;
/** Per-request noise that must not be replayed (trace ids, proxy hops). */
const VOLATILE_X = /^x-(?:request-id|correlation-id|trace-id|b3-.*|forwarded-.*|amzn-.*|datadog-.*|cloud-trace-context|real-ip|client-data|envoy-.*)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BIG = '\u0000BIG:';
const MAX_DEPTH = 4;
const MAX_PROPS = 40;
const MAX_ASSERTED_IDS = 5;
const MAX_STEPS_WARN = 60;

const st = (keyword: KarateStep['keyword'], text: string, extra: Partial<KarateStep> = {}): KarateStep => ({ keyword, text, ...extra });
const q = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n')}'`;
const normTag = (t: string): string => (t.startsWith('@') ? t : `@${t}`);
const safeComment = (s: string): string => s.replace(/\s+/g, ' ').replace(/\bTODO\b/g, 'todo').trim();
const SIMPLE_KEY = /^[A-Za-z_$][\w$]*$/;
const accessor = (key: string): string => (SIMPLE_KEY.test(key) ? `.${key}` : `[${q(key)}]`);
const header = (h: Record<string, string> | undefined, name: string): string | undefined => {
    for (const [k, v] of Object.entries(h ?? {})) {if (k.toLowerCase() === name) {return v;}}
    return undefined;
};
const singular = (w: string): string => (/ies$/i.test(w) ? `${w.slice(0, -3)}y` : /(ss|us|is)$/i.test(w) ? w : /s$/i.test(w) ? w.slice(0, -1) : w);
const decode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };

// ---- JSON helpers (integers beyond 2^53 are kept exact as strings; V2-NUM-001)
function quoteBigInts(text: string): string {
    let out = '';
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"') {j += text[j] === '\\' ? 2 : 1;}
            out += text.slice(i, j + 1);
            i = j + 1;
        } else if (ch === '-' || (ch >= '0' && ch <= '9')) {
            let j = i + 1;
            while (j < text.length && /[0-9.eE+-]/.test(text[j])) {j++;}
            const tok = text.slice(i, j);
            out += /^-?\d{16,}$/.test(tok) && Math.abs(Number(tok)) > Number.MAX_SAFE_INTEGER ? `"\\u0000BIG:${tok}"` : tok;
            i = j;
        } else {
            out += ch;
            i++;
        }
    }
    return out;
}
function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
    try { return { ok: true, value: JSON.parse(quoteBigInts(text)) }; } catch { return { ok: false }; }
}
const isBig = (v: unknown): v is string => typeof v === 'string' && v.startsWith(BIG);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Karate-style relaxed JSON literal (unquoted simple keys, single-quoted strings); `pretty` indents for docstrings. */
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

// ---- response schema (types only, never recorded values)
type Kind = '#string' | '#uuid' | '#number' | '#boolean' | 'object' | 'other';
function kindOf(v: unknown): Kind {
    if (typeof v === 'string') {return isBig(v) ? '#number' : UUID.test(v) ? '#uuid' : '#string';}
    if (typeof v === 'number') {return '#number';}
    if (typeof v === 'boolean') {return '#boolean';}
    return isObj(v) ? 'object' : 'other';
}
interface SchemaCtx { each: { expr: string; schema: unknown }[]; sawNull?: boolean }
function schemaOf(v: unknown, depth: number, expr: string, ctx: SchemaCtx): unknown {
    // A recorded null says nothing about the type: optional and untyped (`##ignore`).
    if (v === null) {ctx.sawNull = true; return '##ignore';}
    if (Array.isArray(v)) {
        if (v.length === 0 || depth > MAX_DEPTH) {return '#array';}
        let kinds = new Set<Kind>(v.map(kindOf));
        if (kinds.size === 2 && kinds.has('#string') && kinds.has('#uuid')) {kinds = new Set<Kind>(['#string']);}
        if (kinds.size !== 1) {return '#array';}
        const kind = [...kinds][0];
        if (kind === 'other') {return '#array';}
        if (kind !== 'object') {return `#[] ${kind}`;}
        const sig = (o: unknown): string => Object.keys(o as Record<string, unknown>).sort().join('\u0000');
        if (depth <= 2 && ctx.each.length < 3 && v.length <= 50 && v.every(x => sig(x) === sig(v[0]))) {
            ctx.each.push({ expr, schema: undefined });
            const slot = ctx.each[ctx.each.length - 1];
            slot.schema = schemaOf(v[0], depth + 1, `${expr}[0]`, ctx);
        }
        return '#[] #object';
    }
    if (isObj(v)) {
        const keys = Object.keys(v);
        if (depth > MAX_DEPTH || keys.length > MAX_PROPS) {return '#object';}
        if (keys.length === 0) {return '#object';}
        return Object.fromEntries(keys.map(k => [k, schemaOf(v[k], depth + 1, `${expr}${accessor(k)}`, ctx)]));
    }
    return kindOf(v);
}

// ---- id discovery
interface IdLeaf { expr: string; key: string; value: string | number }
const isIdKey = (k: string): boolean => /^(?:id|_id|uuid|guid)$/i.test(k) || /(?:Id|ID|Uuid|UUID|Guid)$/.test(k) || /_id$/i.test(k);
function eligibleId(v: unknown): v is string | number {
    if (typeof v === 'number') {return Number.isSafeInteger(v) && v > 0;}
    return typeof v === 'string' && v.length > 0 && v.length <= 100 && !isBig(v) && !/\s/.test(v) && !looksLikeCredentialValue(v) && !containsCredentialValue(v);
}
function idLeaves(root: unknown): IdLeaf[] {
    const out: IdLeaf[] = [];
    const walk = (v: unknown, expr: string, key: string, depth: number): void => {
        if (depth > MAX_DEPTH + 1 || out.length >= 200) {return;}
        if (Array.isArray(v)) {
            v.slice(0, 5).forEach((x, i) => walk(x, `${expr}[${i}]`, key, depth + 1));
        } else if (isObj(v)) {
            for (const k of Object.keys(v).slice(0, MAX_PROPS)) {walk(v[k], `${expr}${accessor(k)}`, k, depth + 1);}
        } else if (key !== '' && isIdKey(key) && !isSecretKey(key) && eligibleId(v)) {
            out.push({ expr, key, value: v });
        }
    };
    walk(root, 'response', '', 0);
    return out;
}

interface Call {
    req: CapturedRequest;
    url: URL;
    method: string;
    status: number;
    origin: string;
}
interface Candidate {
    value: string | number;
    key: string;
    expr: string;
    callIdx: number;
    resource: string;
    name?: string;
    used: boolean;
}

export function buildHarModel(entries: CapturedRequest[], opts: HarModelOptions): HarBuild {
    if (!opts?.config) {throw new Error('buildHarModel: "opts.config" is required');}
    const config = opts.config;
    const urlVar = config.config.urlVariable;
    const name = safeComment(opts.name ?? '') || 'Recorded flow';
    const nameSlug = slug(name) || (opts.mode === 'har' ? 'har-import' : 'recorded-session');
    const warnings: string[] = [];
    const warned = new Set<string>();
    const warnOnce = (m: string): void => { if (!warned.has(m)) { warned.add(m); warnings.push(m); } };
    const unsupported: { sourceRef: string; reason: string }[] = [];
    warnOnce(`${opts.mode === 'har' ? 'HAR imports' : 'Recorded sessions'} are inferred API sequences: recorded values are not contract-verified. Review the assertions and data files before relying on them.`);

    // ---- select evidenced requests (order preserved)
    const allowed = new Set((opts.allowedHosts ?? []).map(h => h.trim().toLowerCase()).filter(Boolean));
    const dropped = { static: 0, preflight: 0, redirect: 0, host: 0, method: 0, duplicate: 0 };
    const notCaptured: string[] = [];
    const calls: Call[] = [];
    const seen = new Map<string, number>(); // identical GET key -> index in `calls` of its last kept occurrence
    let lastMutation = -1;
    for (const req of entries) {
        let url: URL;
        try { url = new URL(req.url); } catch { continue; }
        const method = String(req.method || '').toUpperCase();
        const ctype = header(req.response?.headers, 'content-type') ?? '';
        if (allowed.size > 0 && !allowed.has(url.host.toLowerCase()) && !allowed.has(url.hostname.toLowerCase())) {dropped.host++; continue;}
        if (STATIC_EXT.test(url.pathname) || (req.response && STATIC_TYPE.test(ctype))) {dropped.static++; continue;}
        if (method === 'OPTIONS') {dropped.preflight++; continue;}
        if (!METHODS.has(method)) {dropped.method++; continue;}
        if (!req.response || !Number.isInteger(req.response.status) || req.response.status < 100) {
            notCaptured.push(`${method} ${url.pathname}`);
            continue;
        }
        const status = req.response.status;
        if (status >= 300 && status < 400) {dropped.redirect++; continue;}
        if (method === 'GET' || method === 'HEAD') {
            const key = `${method} ${url.href} ${req.body ?? ''}`;
            const prev = seen.get(key);
            // Collapse only when nothing was written since; a re-read after any write verifies that write and is kept.
            if (prev !== undefined && lastMutation < prev) {dropped.duplicate++; continue;}
            seen.set(key, calls.length);
        } else {
            lastMutation = calls.length;
        }
        calls.push({ req, url, method, status, origin: url.origin });
    }
    const dropNote = (n: number, what: string): void => { if (n > 0) {warnOnce(`Dropped ${n} ${what}`);} };
    dropNote(dropped.static, 'static asset / non-API request(s) (scripts, styles, images, fonts, HTML pages)');
    dropNote(dropped.preflight, 'preflight OPTIONS request(s)');
    dropNote(dropped.redirect, 'redirect or not-modified response(s) (Karate follows redirects itself)');
    dropNote(dropped.host, 'request(s) to hosts that were not selected');
    dropNote(dropped.method, 'request(s) with an unsupported HTTP method');
    dropNote(dropped.duplicate, 'repeated identical GET request(s) with no write in between; the first one was kept');
    if (notCaptured.length > 0) {warnOnce(`Skipped ${notCaptured.length} request(s) without a recorded response (NOT CAPTURED)`);}

    const noModel = (): HarBuild => ({
        model: { source: opts.mode, name, schemes: [], operations: [], unsupported },
        features: [], files: [], unsupported, warnings
    });
    if (calls.length === 0) {
        warnOnce('No API requests were found in the capture; static assets, preflight and uncaptured requests are not converted');
        return noModel();
    }
    if (calls.length > MAX_STEPS_WARN) {warnOnce(`The capture has ${calls.length} API requests; consider recording a shorter journey so the scenario stays reviewable`);}

    // ---- base URL, auth schemes
    const baseOrigin = calls[0].origin;
    const mainCalls = calls.filter(c => c.origin === baseOrigin);
    const otherCalls = calls.filter(c => c.origin !== baseOrigin);
    warnOnce('The first request\'s origin was moved into karate-config as the base URL');

    const schemes: SecurityScheme[] = [];
    const authOf = (c: Call): { kind: 'bearer' | 'basic' | 'unknown' } | undefined => {
        const v = header(c.req.headers, 'authorization');
        if (v === undefined || v.trim() === '') {return undefined;}
        return /^bearer\s/i.test(v) ? { kind: 'bearer' } : /^basic\s/i.test(v) ? { kind: 'basic' } : { kind: 'unknown' };
    };
    let cookieSeen = false;
    for (const c of calls) {
        const a = authOf(c);
        if (a && a.kind !== 'unknown' && !schemes.some(s => s.kind === a.kind)) {schemes.push({ name: a.kind, kind: a.kind });}
        if (header(c.req.headers, 'cookie') !== undefined) {cookieSeen = true;}
    }
    const authPlan = planAuth(schemes);
    for (const s of authPlan.unsupported) {
        const reason = 'Karate v2 applies a single auth scheme; configure this one manually';
        unsupported.push({ sourceRef: `auth:${s.name}`, reason });
        warnOnce(`Auth "${s.name}": ${reason}`);
    }
    if (schemes.length > 0) {
        const env = requiredSecrets(authPlan);
        warnOnce(`Authorization headers were not copied; common/auth.feature applies the scheme${env.length > 0 ? ` (set ${env.join(', ')})` : ''}`);
    }
    if (cookieSeen) {warnOnce('Cookie headers were not written: session cookies are runtime state. Authenticate through common/auth.feature or a login step instead');}

    // ---- shared builders
    const usedNames = new Set<string>(['response', 'request', 'karate', 'read', urlVar, 'baseUrl']);
    const secretDefs = new Map<string, string>(); // karate var -> env var
    const secretVar = (key: string, byValue = false): string => {
        let v = camelName(key || 'credential') + (byValue ? 'Credential' : '');
        const env = upperSnake(key || 'credential') + (byValue ? '_CREDENTIAL' : '');
        if (usedNames.has(v) && !secretDefs.has(v)) {v += 'Secret';}
        usedNames.add(v);
        secretDefs.set(v, env);
        return v;
    };
    const uniqueName = (base: string): string => {
        let n = base;
        for (let i = 2; usedNames.has(n); i++) {n = `${base}${i}`;}
        usedNames.add(n);
        return n;
    };
    const files: HarBuild['files'] = [];
    const operations: OperationModel[] = [];
    const opIds = new Set<string>();
    const callIndex = new Map<Call, number>();
    calls.forEach((c, i) => callIndex.set(c, i + 1));

    interface Group { steps: KarateStep[]; defs: Candidate[]; label: string }

    /** Builds one scenario from `list`; later requests reuse ids captured from earlier responses of the same list. */
    const buildScenario = (list: Call[], scenarioName: string, isMain: boolean, preReason?: string): KarateScenario => {
        const reasons: string[] = preReason ? [preReason] : [];
        const comments: string[] = [];
        const byValue = new Map<string, Candidate>();
        const groups: Group[] = [];

        list.forEach((call, idx) => {
            const n = callIndex.get(call)!;
            const useCand = (c: Candidate): string => {
                if (!c.name) {
                    c.name = uniqueName(/^(?:id|_id|uuid|guid)$/i.test(c.key) ? `${camelName(singular(c.resource))}Id` : camelName(c.key));
                }
                c.used = true;
                return c.name;
            };
            const candFor = (value: string | number, kindMatters: boolean, segName?: string): Candidate | undefined => {
                const c = byValue.get(String(value));
                if (!c) {return undefined;}
                if (typeof c.value === 'number' && String(c.value).length < 2 && !(segName !== undefined && singular(c.resource).toLowerCase() === singular(segName).toLowerCase())) {return undefined;}
                return kindMatters && typeof c.value !== typeof value ? undefined : c;
            };
            const pre: KarateStep[] = [];
            const req: KarateStep[] = [];
            const segs = call.url.pathname.split('/').filter(Boolean).map(decode);
            const labelSegs: string[] = [];

            // path
            const pathExprs = segs.map((seg, si) => {
                const c = candFor(seg, false, segs[si - 1]);
                if (c) {const nm = useCand(c); labelSegs.push(`{${nm}}`); return nm;}
                if (looksLikeCredentialValue(seg) || containsCredentialValue(seg)) {labelSegs.push('{credential}'); return secretVar('path', true);}
                labelSegs.push(seg);
                return q(seg);
            });
            const label = safeComment(`${call.method} /${labelSegs.join('/')}`);
            if (pathExprs.length > 0) {req.push(st('And', `path ${pathExprs.join(', ')}`));}

            // query
            const grouped = new Map<string, string[]>();
            for (const [k, v] of call.url.searchParams.entries()) {grouped.set(k, [...(grouped.get(k) ?? []), v]);}
            const valueExpr = (key: string, value: string): string => {
                if (isSecretKey(key)) {return value === '' ? q('') : secretVar(key);}
                if (looksLikeCredentialValue(value) || containsCredentialValue(value)) {return secretVar(key, true);}
                const c = candFor(value, false);
                return c && (isIdKey(key) || (typeof c.value === 'string' && value.length >= 4)) ? useCand(c) : q(value);
            };
            for (const [k, vs] of grouped) {
                const exprs = vs.map(v => valueExpr(k, v));
                req.push(st('And', `param ${/^\w+$/.test(k) ? k : q(k)} = ${exprs.length === 1 ? exprs[0] : `[${exprs.join(', ')}]`}`));
            }

            // headers (allowlist: Content-Type, a specific Accept, custom X-* and credential-named headers via sysenv)
            const ctype = (header(call.req.headers, 'content-type') ?? '').split(';')[0].trim().toLowerCase();
            const hdrs: KarateStep[] = [];
            for (const [hName, hValueRaw] of Object.entries(call.req.headers ?? {})) {
                const l = hName.toLowerCase();
                const hValue = String(hValueRaw ?? '');
                if (hName.startsWith(':') || l === 'authorization' || l === 'cookie' || l === 'content-type' || l === 'content-length') {continue;}
                const hn = /^[\w-]+$/.test(hName) ? hName : q(hName);
                if (isSecretKey(hName) || (l.startsWith('x-') && (looksLikeCredentialValue(hValue) || containsCredentialValue(hValue)))) {
                    hdrs.push(st('And', `header ${hn} = ${hValue === '' ? q('') : secretVar(hName)}`));
                } else if (l === 'accept') {
                    if (hValue !== '' && !hValue.includes('*/*')) {hdrs.push(st('And', `header Accept = ${q(hValue)}`));}
                } else if (l.startsWith('x-') && !VOLATILE_X.test(l)) {
                    hdrs.push(st('And', `header ${hn} = ${q(hValue)}`));
                }
            }
            const auth = authOf(call);
            if (auth?.kind === 'unknown') {
                reasons.push('an Authorization header with an unrecognised scheme was not copied; configure authentication manually');
                unsupported.push({ sourceRef: label, reason: 'Authorization scheme is not Bearer or Basic and was not written' });
            }
            const headerKinds = new Set<string>();

            // body
            const body = call.req.body;
            const bodyText = typeof body === 'string' ? body : '';
            let bodyDoc: string | undefined;
            const bodySteps: KarateStep[] = [];
            const sets: KarateStep[] = [];
            if (bodyText.trim() !== '') {
                const asJson = /json/.test(ctype) || (ctype === '' && /^\s*[{[]/.test(bodyText));
                const parsed = asJson ? parseJson(bodyText) : { ok: false as const };
                if (asJson && parsed.ok) {
                    if (ctype !== '' && ctype !== 'application/json') {headerKinds.add(`Content-Type = ${q(ctype)}`);}
                    const bodyVar = `body${n}`;
                    const externalize = config.data.externalize;
                    const subs: { acc: string; expr: string }[] = [];
                    let simple = true;
                    const walk = (v: unknown, key: string, acc: string): unknown => {
                        if (Array.isArray(v)) {return v.map((x, i) => walk(x, key, `${acc}[${i}]`));}
                        if (isObj(v)) {return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k, `${acc}${accessor(k)}`)]));}
                        const replace = (expr: string): unknown => {
                            if (acc === '' || !SIMPLE_ACC.test(acc)) {simple = false;}
                            subs.push({ acc, expr });
                            return externalize ? null : `#(${expr})`;
                        };
                        if (isBig(v)) {return v.slice(BIG.length);}
                        if (typeof v === 'string' || typeof v === 'number') {
                            if (isSecretKey(key) && v !== '') {return replace(secretVar(key));}
                            if (typeof v === 'string' && (looksLikeCredentialValue(v) || containsCredentialValue(v))) {return replace(secretVar(key, true));}
                            if (isIdKey(key) && !isSecretKey(key)) {
                                const c = candFor(v, true);
                                if (c) {return replace(useCand(c));}
                            }
                        }
                        return v;
                    };
                    const converted = walk(parsed.value, '', '');
                    if (!externalize || !simple) {
                        // Inline bodies keep `#(expr)` placeholders; a body that `set` cannot address is rewritten inline too.
                        const value = externalize ? walkInline(parsed.value, subs) : converted;
                        const one = lit(value);
                        if (one.length > 100) {bodyDoc = lit(value, true);} else {bodySteps.push(st('And', `request ${one}`));}
                    } else {
                        const file = `data/${nameSlug}-${n}.json`;
                        files.push({ path: file, content: `${JSON.stringify(converted, null, 2)}\n`, owner: 'user' });
                        pre.push(st('*', `def ${bodyVar} = karate.copy(read('classpath:${file}'))`));
                        for (const s of subs) {sets.push(st('*', `set ${bodyVar}${s.acc} = ${s.expr}`));}
                        bodySteps.push(st('And', `request ${bodyVar}`));
                    }
                } else if (ctype === 'application/x-www-form-urlencoded') {
                    for (const [k, v] of new URLSearchParams(bodyText).entries()) {
                        bodySteps.push(st('And', `form field ${/^\w+$/.test(k) ? k : q(k)} = ${valueExpr(k, v)}`));
                    }
                } else if (/multipart\/|octet-stream|^image\/|^audio\/|^video\//.test(ctype)) {
                    reasons.push(`a ${ctype} request body cannot be converted from a capture`);
                    unsupported.push({ sourceRef: label, reason: `${ctype} request body is not converted` });
                } else {
                    // Not cleanly parseable JSON (text, XML, malformed JSON). Fail safe: never rewrite the text; if it
                    // mentions a credential-like key or value the whole body is omitted and the scenario is drafted.
                    const keys = credentialKeys(bodyText);
                    if (keys.length > 0 || containsCredentialValue(bodyText)) {
                        reasons.push(`Request body of ${label} contains credential-like fields${keys.length > 0 ? ` (${keys.join(', ')})` : ''}; provide the body through a data file or karate.sysenv`);
                        comments.push(`Body omitted for ${label}: contains credential-like fields`);
                        unsupported.push({ sourceRef: label, reason: 'request body omitted: contains credential-like fields' });
                    } else {
                        if (ctype !== '') {headerKinds.add(`Content-Type = ${q(ctype)}`);}
                        bodyDoc = bodyText;
                    }
                }
            }
            for (const h of headerKinds) {hdrs.unshift(st('And', `header ${h}`));}
            req.push(...hdrs, ...bodySteps);

            const steps: KarateStep[] = [...pre, ...sets];
            const reqSteps: KarateStep[] = [...req];
            if (bodyDoc !== undefined) {reqSteps.push(st('And', 'request', { docString: bodyDoc }));}
            reqSteps.forEach((s, i) => steps.push(i === 0 ? { ...s, keyword: 'Given' } : s));
            steps.push(st(reqSteps.length === 0 ? 'Given' : 'When', `method ${call.method.toLowerCase()}`));

            // assertions: recorded status, then a types-only schema, then ids tied to earlier responses
            const afterIds: Candidate[] = [];
            steps.push(st('Then', `status ${call.status}`));
            const respText = call.req.response?.body;
            const rctype = (header(call.req.response?.headers, 'content-type') ?? '').toLowerCase();
            const parsedResp = call.method !== 'HEAD' && typeof respText === 'string' && respText.trim() !== ''
                && (/json/.test(rctype) || /^\s*[{[]/.test(respText)) ? parseJson(respText) : { ok: false as const };
            if (parsedResp.ok && (isObj(parsedResp.value) || Array.isArray(parsedResp.value))) {
                const ctx: SchemaCtx = { each: [] };
                const schema = schemaOf(parsedResp.value, 0, 'response', ctx);
                if (ctx.sawNull) {warnOnce("Recorded nulls were rendered as optional '##ignore'; tighten after reviewing the contract");}
                const matchStep = (target: string, value: unknown): KarateStep => {
                    const one = lit(value);
                    return one.length <= 100 ? st('And', `${target} == ${one}`) : st('And', `${target} ==`, { docString: lit(value, true) });
                };
                steps.push(matchStep('match response', schema));
                for (const e of ctx.each) {steps.push(matchStep(`match each ${e.expr}`, e.schema));}
                let asserted = 0;
                const resource = [...segs].reverse().find(s => /^[A-Za-z][A-Za-z_-]*$/.test(s) && !/^(?:api|v\d+)$/i.test(s)) ?? 'resource';
                for (const leaf of idLeaves(parsedResp.value)) {
                    const existing = byValue.get(String(leaf.value));
                    if (existing && existing.callIdx < idx && typeof existing.value === typeof leaf.value && !(typeof leaf.value === 'number' && String(leaf.value).length < 2)) {
                        if (asserted < MAX_ASSERTED_IDS) {
                            steps.push(st('And', `match ${leaf.expr} == ${useCand(existing)}`));
                            asserted++;
                        }
                    } else if (!existing) {
                        const cand: Candidate = { value: leaf.value, key: leaf.key, expr: leaf.expr, callIdx: idx, resource, used: false };
                        byValue.set(String(leaf.value), cand);
                        afterIds.push(cand);
                    }
                }
            }
            groups.push({ steps, defs: afterIds, label });

            // operation
            let opId = `${call.method.toLowerCase()}-${slug(labelSegs.join('/').replace(/[{}]/g, '')) || 'root'}`;
            for (let i = 2; opIds.has(opId); i++) {opId = `${call.method.toLowerCase()}-${slug(labelSegs.join('/').replace(/[{}]/g, '')) || 'root'}-${i}`;}
            opIds.add(opId);
            const a = authOf(call);
            operations.push({
                id: opId, method: call.method, path: `/${labelSegs.join('/')}`, summary: label, tags: [], pathParams: [], queryParams: [], headerParams: [],
                responses: [{ status: String(call.status) }], security: a && a.kind !== 'unknown' ? [a.kind] : 'none', sourceRef: label
            });
        });

        // assemble: a captured id becomes a `def` right after its producing request, only when something reuses it
        const steps: KarateStep[] = [];
        groups.forEach((g, i) => {
            const group = g.steps.map((s, j) => (j === 0 && i > 0 ? { ...s, comment: `source: ${g.label}` } : s));
            steps.push(...group);
            for (const c of g.defs) {if (c.used && c.name) {steps.push(st('*', `def ${c.name} = ${c.expr}`));}}
        });
        for (const c of notCaptured.slice(0, 10)) {if (isMain) {comments.push(`NOT CAPTURED: ${c} (no response was recorded)`);}}
        const tags = config.tags.auto ? [normTag(config.tags.taxonomy.positive)] : [];
        return {
            name: scenarioName, steps, tags, category: 'positive', source: groups[0].label, domain: nameSlug,
            ...(comments.length > 0 ? { comments } : {}),
            ...(reasons.length > 0 ? { draftReason: [...new Set(reasons)].join('; ') } : {})
        };
    };

    const scenarios: KarateScenario[] = [buildScenario(mainCalls, name, true)];
    if (otherCalls.length > 0) {
        for (const c of otherCalls) {
            unsupported.push({ sourceRef: `${c.method} ${c.url.pathname}`, reason: 'request targets a different origin than the base URL (origin not written to the feature)' });
        }
        warnOnce(`${otherCalls.length} request(s) target a different origin than the base URL; they are in a drafted scenario without the host. Configure that origin in karate-config, or re-import with the domain filter to keep only your API host`);
        scenarios.push(buildScenario(otherCalls, `${name} (other origins)`, false, 'requests target a different origin than the base URL; set that origin in karate-config before enabling'));
    }
    if (secretDefs.size > 0) {
        warnOnce(`Credential values were replaced with karate.sysenv(...); set ${[...secretDefs.values()].join(', ')} in the environment before running`);
    }

    // ---- feature
    const bg: KarateStep[] = [st('*', `url ${urlVar}`)];
    if (schemes.length > 0) {bg.push(st('*', "callonce read('classpath:common/auth.feature')"));}
    for (const [v, env] of secretDefs) {bg.push(st('*', `def ${v} = karate.sysenv(${q(env)}, '')`));}
    const flat = config.layout.strategy !== 'domain';
    const features: PlannedFeature[] = [{
        relativePath: flat ? `${nameSlug}.feature` : `${nameSlug}/${nameSlug}.feature`,
        feature: { name, description: `Generated from ${opts.sourceRef} (${opts.mode})`, background: { steps: bg }, scenarios }
    }];

    const model: GenerationModel = { source: opts.mode, name, baseUrl: baseOrigin, schemes, operations, unsupported };
    return { model, features, files, unsupported, warnings };
}

const SIMPLE_ACC = /^(?:\.[A-Za-z_$][\w$]*|\[\d+\])*$/;

/** Rewrites a parsed JSON body inline: substituted leaves become `#(expr)`, large integers become exact strings. */
function walkInline(value: unknown, subs: { acc: string; expr: string }[]): unknown {
    const byAcc = new Map(subs.map(s => [s.acc, s.expr]));
    const go = (v: unknown, acc: string): unknown => {
        if (Array.isArray(v)) {return v.map((x, i) => go(x, `${acc}[${i}]`));}
        if (isObj(v)) {return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, go(x, `${acc}${accessor(k)}`)]));}
        if (isBig(v)) {return v.slice(BIG.length);}
        const e = byAcc.get(acc);
        return e !== undefined ? `#(${e})` : v;
    };
    return go(value, '');
}

const REDACTED = '[REDACTED]';
/** Request/response bodies for AI evidence with credential values removed; headers are never included. */
function redactedBody(text: string | undefined, limit: number): string {
    if (typeof text !== 'string' || text.trim() === '') {return '';}
    const parsed = parseJson(text);
    if (parsed.ok) {
        const go = (v: unknown, key: string): unknown => {
            if (Array.isArray(v)) {return v.slice(0, 5).map(x => go(x, key));}
            if (isObj(v)) {return Object.fromEntries(Object.entries(v).slice(0, MAX_PROPS).map(([k, x]) => [k, go(x, k)]));}
            if (isBig(v)) {return v.slice(BIG.length);}
            if ((typeof v === 'string' || typeof v === 'number') && (isSecretKey(key) || (typeof v === 'string' && (looksLikeCredentialValue(v) || containsCredentialValue(v))))) {return REDACTED;}
            return v;
        };
        return JSON.stringify(go(parsed.value, '')).slice(0, limit);
    }
    return credentialKeys(text).length > 0 || containsCredentialValue(text) ? '[REDACTED BODY]' : text.slice(0, limit);
}

/** A compact, credential-free description of the capture for the optional AI refiner. */
export function redactedCaptureText(entries: CapturedRequest[], maxEntries = 40): string {
    const lines: string[] = [];
    for (const e of entries.slice(0, maxEntries)) {
        let path = e.path;
        try { const u = new URL(e.url); path = u.pathname + (u.search ? `?${redactQuery(u.searchParams)}` : ''); } catch { /* keep the recorded path */ }
        lines.push(`${String(e.method).toUpperCase()} ${path} -> ${e.response?.status ?? 'no response'}`);
        const rq = redactedBody(e.body, 300);
        if (rq) {lines.push(`  request: ${rq}`);}
        const rs = redactedBody(e.response?.body, 500);
        if (rs) {lines.push(`  response: ${rs}`);}
    }
    return lines.join('\n');
}
function redactQuery(params: URLSearchParams): string {
    return [...params.entries()].map(([k, v]) => `${k}=${isSecretKey(k) || looksLikeCredentialValue(v) ? REDACTED : v}`).join('&');
}
