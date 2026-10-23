// Pure Postman collection -> GenerationModel + planned features adapter. No vscode, no logger, no I/O.
// Reuses the pure script/body conversion in ./postmanScript (also used by the legacy PostmanToKarateConverter).
import type { KarateScenario, KarateStep } from '../../types';
import type { PostmanAuth, PostmanBody, PostmanCollection, PostmanEnvironment, PostmanItem, PostmanRequest } from '../../services/postmanParser';
import type { GeneratorConfig, ScenarioCategory } from '../config/GeneratorConfig';
import type { GenerationModel, OperationModel, SecurityScheme } from '../model/TestModel';
import { planAuth } from '../plan/AuthSchemes';
import type { PlannedFeature } from '../plan/OpenApiPlanner';
import { slug } from '../plan/slug';
import { camelName, credentialKeys, SECRET_HEADER, SECRET_NAME, upperSnake } from './secrets';
import { analyzePreRequestScript, analyzeTestScript, convertBody } from './postmanScript';
import type { ScriptAnalysis } from './postmanScript';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PostmanModelOptions {
    config: GeneratorConfig;
    collectionName: string;
}

export interface PostmanBuild {
    model: GenerationModel;
    features: PlannedFeature[];
    /** Classpath-relative files (`data/<collection>-variables.json`); the caller prefixes the classpath root. */
    files: { path: string; content: string; owner: 'user' }[];
    unsupported: { sourceRef: string; reason: string }[];
    warnings: string[];
}

const MAX_COMMENT = 120;

const st = (keyword: KarateStep['keyword'], text: string, extra: Partial<KarateStep> = {}): KarateStep => ({ keyword, text, ...extra });
const q = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n')}'`;
const idn = (name: string): string => {
    const s = name.replace(/[^A-Za-z0-9_]/g, '_');
    return /^\d/.test(s) ? `_${s}` : s || '_';
};
const camel = camelName;
const normTag = (t: string): string => (t.startsWith('@') ? t : `@${t}`);
const isNumberLiteral = (s: string): boolean => /^(?:0|[1-9]\d{0,14})(?:\.\d+)?$/.test(s);
const VAR_RE = /\{\{([^}]+)\}\}/g;
const namesIn = (s: string): string[] => [...s.matchAll(VAR_RE)].map(m => m[1].trim());
const safeComment = (s: string): string => s.replace(/\s+/g, ' ').replace(/\bTODO\b/g, 'todo').trim();

interface Entry {
    name: string;
    folders: string[];
    request: PostmanRequest;
    auth?: PostmanAuth;
    pre: string;
    test: string;
    method: string;
    pathLabel: string;
    sourceRef: string;
}

type UrlSplit =
    | { kind: 'var'; name: string; rest: string; query: string }
    | { kind: 'literal'; origin: string; full: string; rest: string; query: string }
    | { kind: 'relative'; rest: string; query: string };

function execText(item: { event?: { listen: string; script?: { exec?: string[] | string } }[] }, listen: 'prerequest' | 'test'): string {
    const parts: string[] = [];
    for (const e of item.event ?? []) {
        if (e.listen !== listen) {continue;}
        const ex = e.script?.exec;
        parts.push(Array.isArray(ex) ? ex.join('\n') : typeof ex === 'string' ? ex : '');
    }
    return parts.join('\n').trim();
}

function rawUrl(request: PostmanRequest): string {
    const u: any = request.url;
    if (typeof u === 'string') {return u;}
    if (u?.raw) {return String(u.raw);}
    const host = Array.isArray(u?.host) ? u.host.join('.') : String(u?.host ?? '');
    const path = Array.isArray(u?.path) ? u.path.join('/') : '';
    return `${u?.protocol ? `${u.protocol}://` : ''}${host}${path ? `/${path}` : ''}`;
}

function splitUrl(raw: string): UrlSplit {
    const cut = raw.search(/[?#]/);
    const noQuery = cut < 0 ? raw : raw.slice(0, cut);
    const query = cut >= 0 && raw[cut] === '?' ? raw.slice(cut + 1).split('#')[0] : '';
    const v = /^\{\{([^}]+)\}\}(.*)$/.exec(noQuery);
    if (v) {return { kind: 'var', name: v[1].trim(), rest: v[2], query };}
    const l = /^(https?:\/\/[^/?#]+)(.*)$/i.exec(noQuery);
    if (l) {return { kind: 'literal', origin: l[1], full: noQuery, rest: l[2], query };}
    return { kind: 'relative', rest: noQuery, query };
}

const authBlock = (auth: PostmanAuth, key: string): string | undefined => {
    const arr = (auth as any)[auth.type] as { key: string; value: unknown }[] | undefined;
    const v = arr?.find(a => a.key === key)?.value;
    return v === undefined || v === null ? undefined : String(v);
};

interface Member {
    entry: Entry;
    pre: ScriptAnalysis | null;
    test: ScriptAnalysis | null;
}

export function buildPostmanModel(collection: PostmanCollection, env?: PostmanEnvironment | null, opts?: PostmanModelOptions): PostmanBuild {
    if (!opts?.config) {throw new Error('buildPostmanModel: "opts.config" is required');}
    const config = opts.config;
    const collectionName = opts.collectionName || collection.info?.name || 'collection';
    const urlVar = config.config.urlVariable;
    const warnings: string[] = [];
    const warned = new Set<string>();
    const warnOnce = (m: string): void => { if (!warned.has(m)) { warned.add(m); warnings.push(m); } };
    const unsupported: { sourceRef: string; reason: string }[] = [];

    // ---- variables (environment current value wins over the collection value)
    const vars = new Map<string, string>();
    for (const v of collection.variable ?? []) {
        if (!v.disabled && v.key) {vars.set(v.key, v.value === undefined || v.value === null ? '' : String(v.value));}
    }
    for (const v of env?.values ?? []) {
        if (v.enabled !== false && v.key) {vars.set(v.key, v.value === undefined || v.value === null ? '' : String(v.value));}
    }

    // ---- walk the collection (order preserved, auth inherited, disabled items skipped)
    const entries: Entry[] = [];
    const scriptNotes = (where: string, item: { event?: any[] }): void => {
        if (execText(item, 'prerequest') || execText(item, 'test')) {
            unsupported.push({ sourceRef: where, reason: `${where}-level pm script is not converted; copy its logic into the scenarios that need it` });
            warnings.push(`${where}-level Postman script was not converted`);
        }
    };
    scriptNotes('collection', collection as any);
    const walk = (items: PostmanItem[], folders: string[], inherited: PostmanAuth | undefined): void => {
        for (const item of items ?? []) {
            if ((item as any).disabled === true) {continue;}
            if (item.item) {
                scriptNotes(`folder "${item.name}"`, item);
                walk(item.item, [...folders, item.name], ((item as any).auth as PostmanAuth | undefined) ?? inherited);
                continue;
            }
            if (!item.request) {continue;}
            const request: PostmanRequest = typeof (item.request as any) === 'string' ? { method: 'GET', url: item.request as unknown as string } : item.request;
            const method = String(request.method || 'GET').toUpperCase();
            const split = splitUrl(rawUrl(request));
            const segs = split.rest.split('/').filter(Boolean);
            const pathLabel = `/${segs.join('/')}`;
            entries.push({
                name: item.name, folders, request, auth: request.auth ?? inherited,
                pre: execText(item, 'prerequest'), test: execText(item, 'test'),
                method, pathLabel, sourceRef: `${method} ${pathLabel}`
            });
        }
    };
    walk(collection.item ?? [], [], collection.auth);

    // ---- secret names: by key, plus any variable referenced from a secret-looking header
    const secret = new Set<string>();
    for (const k of vars.keys()) {if (SECRET_NAME.test(k)) {secret.add(k);}}
    const markSecretRefs = (text: string): void => { for (const n of namesIn(text)) {secret.add(n);} };
    for (const e of entries) {
        for (const h of e.request.header ?? []) {if (!h.disabled && SECRET_HEADER.test(h.key)) {markSecretRefs(h.value ?? '');}}
    }
    const secretDefs = new Map<string, string>(); // karate var -> env var
    const secretVar = (name: string): string => {
        const v = idn(name);
        if (!secretDefs.has(v)) {secretDefs.set(v, upperSnake(name));}
        return v;
    };

    // ---- base URL
    let baseVar: string | undefined;
    let baseOrigin: string | undefined;
    let baseUrl: string | undefined;
    if (entries.length > 0) {
        const first = splitUrl(rawUrl(entries[0].request));
        if (first.kind === 'var') {
            baseVar = first.name;
            baseUrl = vars.get(baseVar) || undefined;
            if (!baseUrl) {warnOnce(`Base URL variable "${baseVar}" has no value; karate-config falls back to its default, set -DbaseUrl or ${upperSnake(baseVar)}`);}
        } else if (first.kind === 'literal') {
            baseOrigin = first.origin;
            baseUrl = first.origin;
            warnOnce('The first request uses a literal host; it was moved into karate-config as the base URL');
        }
    }

    // ---- security schemes
    const schemes: SecurityScheme[] = [];
    const schemeOf = (auth: PostmanAuth | undefined): SecurityScheme | undefined => {
        if (!auth || auth.type === 'noauth') {return undefined;}
        let s: SecurityScheme | undefined;
        if (auth.type === 'bearer') {s = { name: 'bearer', kind: 'bearer' };}
        else if (auth.type === 'basic') {s = { name: 'basic', kind: 'basic' };}
        else if (auth.type === 'apikey') {
            const key = authBlock(auth, 'key') || 'X-API-Key';
            const where = authBlock(auth, 'in') === 'query' ? 'query' : 'header';
            s = { name: `apikey-${slug(key) || 'key'}`, kind: 'apiKey', in: where, paramName: key };
        } else if (auth.type === 'oauth2') {
            const grant = authBlock(auth, 'grant_type') ?? 'authorization_code';
            const flow = /client/.test(grant) ? 'clientCredentials' : /password/.test(grant) ? 'password' : /implicit/.test(grant) ? 'implicit' : 'authorizationCode';
            const rawToken = authBlock(auth, 'accessTokenUrl') ?? '';
            const tokenUrl = rawToken.replace(VAR_RE, (m, n: string) => (vars.has(n.trim()) && !secret.has(n.trim()) ? vars.get(n.trim())! : m));
            s = { name: 'oauth2', kind: 'oauth2', flow, tokenUrl: tokenUrl.includes('{{') ? '' : tokenUrl };
        }
        if (!s) {return undefined;}
        if (!schemes.some(x => x.name === s!.name)) {schemes.push(s);}
        return s;
    };
    for (const e of entries) {schemeOf(e.auth);}
    const authPlan = planAuth(schemes);
    for (const s of authPlan.unsupported) {
        const reason = s.kind === 'oauth2' && s.flow && s.flow !== 'clientCredentials'
            ? `oauth2 ${s.flow} flow cannot be configured automatically; supply a token via API_TOKEN or extend common/auth.feature`
            : 'Karate v2 applies a single auth scheme; configure this one manually';
        unsupported.push({ sourceRef: `auth:${s.name}`, reason });
        warnings.push(`Auth "${s.name}": ${reason}`);
    }

    // ---- variable usage
    const varsOut = new Map<string, string>();

    // ---- script analysis (once per request)
    const analysed = new Map<Entry, Member>();
    let pmTests = 0;
    for (const e of entries) {
        const m: Member = {
            entry: e,
            pre: e.pre ? analyzePreRequestScript(e.pre) : null,
            test: e.test ? analyzeTestScript(e.test) : null
        };
        analysed.set(e, m);
        for (const w of [...(m.pre?.warnings ?? []), ...(m.test?.warnings ?? [])]) {warnOnce(`${e.sourceRef}: ${w}`);}
        pmTests += (e.test.match(/pm\.test\(/g) ?? []).length;
    }
    if (pmTests > 0) {warnOnce(`${pmTests} pm.test block(s) were flattened into plain assertions; test titles are not kept as comments`);}

    const referenced = (e: Entry): Set<string> => {
        const out = new Set<string>();
        const add = (s: string | undefined): void => { for (const n of namesIn(s ?? '')) {out.add(n);} };
        add(rawUrl(e.request));
        for (const h of e.request.header ?? []) {if (!h.disabled) {add(h.value);}}
        for (const p of (e.request.url as any)?.query ?? []) {if (!p.disabled) {add(p.value);}}
        const b = e.request.body;
        if (b) {
            add(b.raw);
            for (const f of b.urlencoded ?? []) {if (!f.disabled) {add(f.value);}}
            for (const f of b.formdata ?? []) {if (!f.disabled) {add(f.value);}}
        }
        return out;
    };

    // ---- feature grouping (folders -> features) and chaining of dependent requests
    const flat = config.layout.strategy !== 'domain';
    // Group by the folder's actual path; slugs are only used for file names (distinct folders can slug alike).
    const groupKey = (e: Entry): string => (flat ? '' : e.folders.join('\u0000'));
    const groups = new Map<string, Entry[]>();
    for (const e of entries) {
        const k = groupKey(e);
        groups.set(k, [...(groups.get(k) ?? []), e]);
    }

    const operations: OperationModel[] = [];
    const features: PlannedFeature[] = [];
    const usedPaths = new Set<string>();
    const collSlug = slug(collectionName) || 'collection';

    for (const [key, groupEntries] of groups) {
        // chain: a request consuming a variable set by an earlier request's script joins that scenario
        const chains: Member[][] = [];
        const producerChain = new Map<string, Member[]>();
        for (const e of groupEntries) {
            const m = analysed.get(e)!;
            const own = new Set([...(m.pre?.setVars ?? [])].map(idn));
            let target: Member[] | undefined;
            for (const n of referenced(e)) {
                const v = idn(n);
                if (own.has(v) || secret.has(n) || n === baseVar || n.startsWith('$')) {continue;}
                const c = producerChain.get(v);
                if (!c) {continue;}
                if (!target) {target = c;}
                else if (c !== target) {
                    warnOnce(`${e.sourceRef} (${e.name}) depends on variables set by more than one earlier request; it was chained to "${target[0].entry.name}" and "${n}" falls back to vars.${v} (set it in the variables file)`);
                }
            }
            const chain = target ?? [];
            if (!target) {chains.push(chain);}
            chain.push(m);
            for (const v of [...(m.pre?.setVars ?? []), ...(m.test?.setVars ?? [])]) {
                producerChain.set(idn(v), chain);
            }
        }

        for (const c of chains) {
            if (c.length > 1) {warnings.push(`Merged into one scenario because later requests consume variables set by earlier ones: ${c.map(x => x.entry.name).join(', ')}`);}
        }

        const leaf = groupEntries[0].folders;
        const featureName = flat ? collectionName : (leaf.length > 0 ? leaf[leaf.length - 1] : collectionName);
        const scenarios: { scenario: KarateScenario; secured: boolean; secretsUsed: Set<string>; varsUsed: Set<string> }[] = [];
        const names = new Set<string>();

        for (const chain of chains) {
            const secretsUsed = new Set<string>();
            const varsUsed = new Set<string>();
            const local = new Set<string>();
            const steps: KarateStep[] = [];
            const comments: string[] = [];
            const reasons: string[] = [];
            const statuses: string[] = [];
            const unsupportedBits: string[] = [];
            let lostAssertion = false;
            let secured = false;

            const ref = (rawName: string): string => {
                const name = rawName.trim();
                if (name.startsWith('$')) {
                    if (/^\$(guid|randomUUID)$/.test(name)) {return 'karate.uuid()';}
                    if (name === '$timestamp') {return 'java.lang.System.currentTimeMillis()';}
                    if (name === '$randomInt') {return 'karate.faker.randomInt()';}
                    warnOnce(`Postman dynamic variable {{${name}}} has no Karate equivalent; its placeholder was left empty`);
                    return "''";
                }
                const id = idn(name);
                if (local.has(id)) {return id;}
                if (name === baseVar) {return urlVar;}
                if (secret.has(name)) {
                    secretsUsed.add(secretVar(name));
                    return id;
                }
                varsUsed.add(id);
                if (!varsOut.has(id)) {
                    const value = vars.get(name);
                    if (value === undefined) {
                        warnOnce(`Variable "${name}" has no value in the collection or environment; add it to data/${collSlug}-variables.json`);
                    }
                    varsOut.set(id, value ?? '');
                }
                return `vars.${id}`;
            };
            const tpl = (text: string): string => {
                const parts: string[] = [];
                let last = 0;
                for (const m of text.matchAll(VAR_RE)) {
                    if (m.index! > last) {parts.push(q(text.slice(last, m.index)));}
                    parts.push(ref(m[1]));
                    last = m.index! + m[0].length;
                }
                if (last < text.length) {parts.push(q(text.slice(last)));}
                return parts.length === 0 ? "''" : parts.join(' + ');
            };
            const valueExpr = (text: string): string => (isNumberLiteral(text) ? text : tpl(text));
            /** Literal secret values never reach a feature: they become a sysenv-backed placeholder variable. */
            const guardSecret = (key: string, value: string): string => {
                if (!SECRET_HEADER.test(key) || value === '' || value.includes('{{')) {return value;}
                const v = camel(key);
                secretDefs.set(v, secretDefs.get(v) ?? upperSnake(key));
                secretsUsed.add(v);
                secret.add(v);
                warnOnce(`A literal value for "${key}" in the collection was replaced with karate.sysenv('${secretDefs.get(v)}')`);
                return `{{${v}}}`;
            };

            chain.forEach((m, idx) => {
                const e = m.entry;
                const r = e.request;
                const bits: string[] = [];
                const emit = (kw: KarateStep['keyword'], text: string, extra: Partial<KarateStep> = {}): void => { steps.push(st(kw, text, extra)); };
                if (idx > 0) {comments.push(`Chained request: ${e.sourceRef} (${e.name}) consumes a variable set by an earlier request in this scenario`);}

                // pre-request script
                for (const l of m.pre?.lines ?? []) {
                    const fixed = l.replace(/^\* def ([^ ]+) =/, (_x, n: string) => `* def ${idn(n)} =`);
                    emit('*', fixed.slice(2));
                    const defName = /^\* def ([^ ]+) =/.exec(l)?.[1];
                    if (defName) {local.add(idn(defName));}
                }
                if (m.pre) {bits.push(...m.pre.unsupported);}

                // url / path / params / headers
                const split = splitUrl(rawUrl(r));
                const req: string[] = [];
                let rest = split.rest;
                if (split.kind === 'var' && split.name !== baseVar) {
                    const val = vars.get(split.name);
                    if (secret.has(split.name)) {
                        reasons.push(`request base URL comes from secret-looking variable ${split.name}`);
                    } else if (!val) {
                        reasons.push(`request base URL variable ${split.name} has no value; it is not the base URL`);
                        unsupported.push({ sourceRef: e.sourceRef, reason: `base URL variable ${split.name} has no value` });
                    } else if (val !== (baseVar ? vars.get(baseVar) : undefined)) {
                        req.push(`url ${ref(split.name)}`);
                    }
                } else if (split.kind === 'literal') {
                    const base = baseUrl ?? baseOrigin;
                    if (base && split.full.startsWith(base)) {rest = split.full.slice(base.length);}
                    else {
                        reasons.push('request targets a different host than the base URL; set it in karate-config');
                        unsupported.push({ sourceRef: e.sourceRef, reason: 'request targets a different host than the base URL (host not written to the feature)' });
                    }
                }
                const pathVars = new Map<string, string>();
                for (const pv of ((r.url as any)?.variable ?? []) as { key: string; value?: string }[]) {if (pv.key) {pathVars.set(pv.key, pv.value ?? '');}}
                const segs = rest.split('/').filter(Boolean).map(seg => {
                    if (seg.startsWith(':')) {
                        const val = pathVars.get(seg.slice(1));
                        if (val) {return tpl(val);}
                        warnOnce(`Path variable "${seg}" has no value; set it in data/${collSlug}-variables.json`);
                        varsUsed.add(idn(seg.slice(1)));
                        if (!varsOut.has(idn(seg.slice(1)))) {varsOut.set(idn(seg.slice(1)), '');}
                        return `vars.${idn(seg.slice(1))}`;
                    }
                    return seg.includes('{{') ? tpl(seg) : q(seg);
                });
                if (segs.length > 0) {req.push(`path ${segs.join(', ')}`);}

                const queryPairs: { key: string; value: string }[] = [];
                const urlQuery = (r.url as any)?.query as { key: string; value: string; disabled?: boolean }[] | undefined;
                if (urlQuery) {
                    for (const p of urlQuery) {if (!p.disabled && p.key) {queryPairs.push({ key: p.key, value: p.value ?? '' });}}
                } else if (split.query) {
                    for (const part of split.query.split('&').filter(Boolean)) {
                        const eq = part.indexOf('=');
                        queryPairs.push({ key: eq < 0 ? part : part.slice(0, eq), value: eq < 0 ? '' : part.slice(eq + 1) });
                    }
                }
                const pname = (k: string): string => (/^\w+$/.test(k) ? k : q(k));
                for (const p of queryPairs) {req.push(`param ${pname(p.key)} = ${valueExpr(guardSecret(p.key, p.value))}`);}
                for (const h of r.header ?? []) {
                    if (h.disabled || !h.key) {continue;}
                    req.push(`header ${/^[\w-]+$/.test(h.key) ? h.key : q(h.key)} = ${valueExpr(guardSecret(h.key, h.value ?? ''))}`);
                }

                // auth
                const sch = schemeOf(e.auth);
                if (idx === 0) {secured = Boolean(sch);}
                if (sch && sch.kind === 'apiKey' && sch.in !== 'header' && authPlan.apiKeyVars.has(sch.name)) {
                    req.push(`param ${pname(sch.paramName ?? 'api_key')} = ${authPlan.apiKeyVars.get(sch.name)!.variable}`);
                }

                // body
                const body: PostmanBody | undefined = r.body;
                let bodyLines: string[] = [];
                let bodyDoc: string | undefined;
                /** Raw bodies: JSON gets `#(expr)` placeholders (typed substitution); anything else is a docstring text body. */
                const rawBody = (raw: string): { lines: string[]; doc?: string } => {
                    const names: string[] = [];
                    let text = '';
                    let inStr = false;
                    let esc = false;
                    for (let i = 0; i < raw.length; i++) {
                        const ch = raw[i];
                        if (raw.startsWith('{{', i)) {
                            const end = raw.indexOf('}}', i);
                            if (end > i) {
                                names.push(raw.slice(i + 2, end).trim());
                                text += inStr ? `__PM_VAR_${names.length - 1}__` : `"__PM_VAR_${names.length - 1}__"`;
                                i = end + 1;
                                continue;
                            }
                        }
                        if (inStr) {
                            if (esc) {esc = false;} else if (ch === '\\') {esc = true;} else if (ch === '"') {inStr = false;}
                        } else if (ch === '"') {inStr = true;}
                        text += ch;
                    }
                    let parsed: any;
                    let isJsonBody = true;
                    try { parsed = JSON.parse(text); } catch { isJsonBody = false; }
                    if (isJsonBody) {
                        const str = (val: string, key: string): string => {
                            const restored = val.replace(/__PM_VAR_(\d+)__/g, (_x, n: string) => `{{${names[Number(n)]}}}`);
                            const guarded = guardSecret(key, restored);
                            if (!guarded.includes('{{')) {return guarded;}
                            return /^\{\{[^}]+\}\}$/.test(guarded) ? `#(${ref(guarded.slice(2, -2))})` : `#(${tpl(guarded)})`;
                        };
                        const walk = (v: any, key: string): any => {
                            if (Array.isArray(v)) {return v.map(x => walk(x, key));}
                            if (v && typeof v === 'object') {return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));}
                            return typeof v === 'string' ? str(v, key) : v;
                        };
                        return { lines: [`And request ${JSON.stringify(walk(parsed, ''), null, 2)}`] };
                    }
                    // Not cleanly parseable JSON (text, XML, form, malformed JSON). Fail safe: never rewrite the text; if it
                    // mentions any credential-like key the whole body is omitted and the scenario is drafted.
                    const keys = credentialKeys(raw);
                    if (keys.length > 0) {
                        reasons.push(`Request body contains credential-like fields (${keys.join(', ')}); provide the body via data/${collSlug}-variables.json or karate.sysenv`);
                        comments.push('Body omitted: contains credential-like fields');
                        return { lines: [] };
                    }
                    return { lines: [], doc: raw.replace(VAR_RE, (_x, n: string) => `#(${ref(n)})`) };
                };
                if (body && (body.mode === 'graphql' || body.mode === 'file')) {
                    reasons.push(`${body.mode} request bodies are not converted`);
                    unsupported.push({ sourceRef: e.sourceRef, reason: `${body.mode} request body is not converted` });
                } else if (body && body.mode === 'raw') {
                    if (body.raw) {
                        const converted = rawBody(body.raw);
                        bodyLines = converted.lines;
                        bodyDoc = converted.doc;
                    }
                } else if (body) {
                    const guarded = guardBody(body, guardSecret);
                    const subst = (text: string): string => text.replace(VAR_RE, (_x, n: string) => `#(${ref(n)})`);
                    bodyLines = convertBody(guarded, subst);
                }

                req.forEach((text, i) => emit(i === 0 ? 'Given' : 'And', text));
                if (bodyDoc !== undefined) {emit(req.length === 0 ? 'Given' : 'And', 'request', { docString: bodyDoc });}
                bodyLines.forEach((line, i) => {
                    const m2 = /^And ([\s\S]*)$/.exec(line);
                    const content = m2 ? m2[1] : line;
                    const nl = content.indexOf('\n');
                    const kw: KarateStep['keyword'] = req.length === 0 && i === 0 ? 'Given' : 'And';
                    if (nl > 0 && content.startsWith('request ')) {emit(kw, 'request', { docString: content.slice('request '.length) });}
                    else {emit(kw, content.replace(/\n/g, ' '));}
                });
                emit(req.length === 0 && bodyLines.length === 0 && bodyDoc === undefined ? 'Given' : 'When', `method ${e.method.toLowerCase()}`);

                // assertions
                const test = m.test;
                const lines = (test?.lines ?? []).filter(l => !l.startsWith('#'));
                const isStatus = (l: string): boolean => /^(?:Then|And) (?:status \d+|assert responseStatus)/.test(l);
                const ordered = [...lines.filter(isStatus), ...lines.filter(l => !isStatus(l))];
                ordered.forEach((l, i) => {
                    const fixed = l.replace(/^\* def ([^ ]+) =/, (_x, n: string) => `* def ${idn(n)} =`);
                    const parsed = /^(Then|And|Given|When|But|\*)\s+([\s\S]*)$/.exec(fixed);
                    if (!parsed) {return;}
                    emit(parsed[1] === '*' ? '*' : i === 0 ? 'Then' : 'And', parsed[2]);
                    const sm = /^status (\d+)$/.exec(parsed[2]);
                    if (sm) {statuses.push(sm[1]);}
                    const def = /^def (\w+) =/.exec(parsed[2]);
                    if (parsed[1] === '*' && def) {local.add(def[1]);}
                });
                if (!ordered.some(isStatus)) {
                    // No status assertion survived (no test script, or a script that only checks bodies/variables):
                    // the status cannot be inferred, so assert only that the call succeeded (below 400) instead of
                    // guessing `status 200`. The scenario stays active; only a LOST assertion drafts it (below).
                    emit(ordered.length === 0 ? 'Then' : 'And', 'assert responseStatus < 400');
                }
                if (test) {
                    bits.push(...test.unsupported.filter(u => !bits.includes(u)));
                    if (test.lostAssertions.length > 0) {lostAssertion = true;}
                }
                unsupportedBits.push(...bits);
                if (bits.length > 0) {
                    unsupported.push({ sourceRef: e.sourceRef, reason: `pm script not converted: ${safeComment(bits.join(' ')).slice(0, MAX_COMMENT)}` });
                }
                for (const v of [...(m.test?.setVars ?? [])]) {local.add(idn(v));}

                // operation
                const opSec: string[] | 'none' = sch ? [sch.name] : 'none';
                operations.push({
                    id: `${e.method.toLowerCase()}-${slug(e.name) || 'request'}`, method: e.method, path: e.pathLabel, summary: e.name,
                    tags: e.folders.map(f => slug(f)).filter(Boolean).slice(-1), pathParams: [], queryParams: [], headerParams: [],
                    responses: statuses.map(s => ({ status: s })), security: opSec, sourceRef: e.sourceRef
                });
            });

            if (unsupportedBits.length > 0) {
                comments.unshift(`UNSUPPORTED (pm script): ${safeComment(unsupportedBits.join(' ')).slice(0, MAX_COMMENT)}`);
            }
            if (lostAssertion) {reasons.push('a Postman test assertion could not be converted');}

            const first = chain[0].entry;
            const category: ScenarioCategory = statuses.some(s => Number(s) >= 400) ? 'negative' : 'positive';
            const tags = config.tags.auto ? [normTag(config.tags.taxonomy[category])] : [];
            let name = flat && first.folders.length > 0 ? `${first.folders.join(' > ')} > ${first.name}` : first.name;
            const base = name;
            for (let n = 2; names.has(name); n++) {name = `${base} (${n})`;}
            names.add(name);
            const scenario: KarateScenario = {
                name, steps, tags, category, source: first.sourceRef,
                domain: first.folders.length > 0 ? slug(first.folders[first.folders.length - 1]) : collSlug,
                ...(comments.length > 0 ? { comments } : {}),
                ...(reasons.length > 0 ? { draftReason: [...new Set(reasons)].join('; ') } : {})
            };
            scenarios.push({ scenario, secured, secretsUsed, varsUsed });
        }

        // assemble the feature(s): authenticated and unauthenticated scenarios never share a callonce Background
        const basePath = flat || key === '' ? collSlug : groupEntries[0].folders.map(f => slug(f) || 'folder').join('/');
        const hasAuth = schemes.length > 0;
        const buckets: { suffix: string; list: typeof scenarios; auth: boolean }[] = [];
        const securedList = scenarios.filter(s => s.secured);
        const openList = scenarios.filter(s => !s.secured);
        if (!hasAuth || securedList.length === 0) {buckets.push({ suffix: '', list: scenarios, auth: false });}
        else {
            buckets.push({ suffix: '', list: securedList, auth: true });
            if (openList.length > 0) {buckets.push({ suffix: '-public', list: openList, auth: false });}
        }
        for (const b of buckets) {
            if (b.list.length === 0) {continue;}
            const bg: KarateStep[] = [st('*', `url ${urlVar}`)];
            if (b.auth) {bg.push(st('*', "callonce read('classpath:common/auth.feature')"));}
            if (b.list.some(s => s.varsUsed.size > 0)) {bg.push(st('*', `def vars = read('classpath:data/${collSlug}-variables.json')`));}
            const used: string[] = [];
            for (const s of b.list) {for (const v of s.secretsUsed) {if (!used.includes(v)) {used.push(v);}}}
            for (const v of used) {bg.push(st('*', `def ${v} = karate.sysenv(${q(secretDefs.get(v) ?? upperSnake(v))}, '')`));}
            const leafSeg = basePath.split('/').pop()!;
            const stem = flat ? `${collSlug}` : `${basePath}/${leafSeg}`;
            let rel = `${stem}${b.suffix}.feature`;
            for (let n = 2; usedPaths.has(rel); n++) {rel = `${stem}-${n}${b.suffix}.feature`;}
            usedPaths.add(rel);
            features.push({
                relativePath: rel,
                feature: {
                    name: `${featureName}${b.suffix === '-public' ? ' - Public' : ''}`,
                    description: `Generated from ${collectionName} (postman)`,
                    background: { steps: bg },
                    scenarios: b.list.map(s => s.scenario)
                }
            });
        }
    }

    const files: PostmanBuild['files'] = [];
    if (varsOut.size > 0) {
        files.push({ path: `data/${collSlug}-variables.json`, content: `${JSON.stringify(Object.fromEntries(varsOut), null, 2)}\n`, owner: 'user' });
    }

    const model: GenerationModel = {
        source: 'postman', name: collectionName, ...(baseUrl ? { baseUrl } : {}), schemes, operations, unsupported
    };
    return { model, features, files, unsupported, warnings };
}

/** Replace literal values of secret-looking keys in form bodies with `{{placeholder}}` variables. */
function guardBody(body: PostmanBody, guard: (key: string, value: string) => string): PostmanBody {
    const out: PostmanBody = { ...body };
    if (body.urlencoded) {out.urlencoded = body.urlencoded.map(f => (f.disabled ? f : { ...f, value: guard(f.key, f.value ?? '') }));}
    if (body.formdata) {out.formdata = body.formdata.map(f => (f.disabled || f.type === 'file' ? f : { ...f, value: guard(f.key, f.value ?? '') }));}
    return out;
}

/** Collection JSON for AI evidence with credential values removed. */
export function redactedCollectionText(collection: PostmanCollection): string {
    const clone = JSON.parse(JSON.stringify(collection));
    const red = (node: any): void => {
        if (Array.isArray(node)) {node.forEach(red); return;}
        if (!node || typeof node !== 'object') {return;}
        if (typeof node.key === 'string' && 'value' in node && SECRET_NAME.test(node.key)) {node.value = '[REDACTED]';}
        if (typeof node.type === 'string' && ['bearer', 'basic', 'apikey', 'oauth2'].includes(node.type)) {
            const arr = node[node.type];
            if (Array.isArray(arr)) {for (const a of arr) {if (a && 'value' in a) {a.value = '[REDACTED]';}}}
        }
        if (typeof node.key === 'string' && 'value' in node && SECRET_HEADER.test(node.key)) {node.value = '[REDACTED]';}
        Object.values(node).forEach(red);
    };
    red(clone);
    return JSON.stringify(clone, null, 2);
}
