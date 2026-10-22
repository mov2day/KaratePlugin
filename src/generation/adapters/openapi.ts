// Pure OpenAPI (2.0 / 3.x) to GenerationModel adapter. No vscode, no I/O.
// Accepts raw parsed documents (local $refs resolved here) as well as
// already-dereferenced ones (which may contain real object cycles).

import {
    BodyModel,
    GenerationModel,
    JsonSchema,
    OperationModel,
    ParamModel,
    ResponseModel,
    SecurityScheme
} from '../model/TestModel';

/* eslint-disable @typescript-eslint/no-explicit-any */

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];
const MAX_DEPTH = 5;
const MAX_REF_HOPS = 10;

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const isJsonType = (ct: string): boolean => {
    const base = ct.split(';')[0].trim().toLowerCase();
    return base === 'application/json' || base.endsWith('+json');
};
// eslint-disable-next-line @typescript-eslint/naming-convention
const truncated = (): JsonSchema => ({ type: 'object', 'x-truncated': true });
const MAX_NODES = 2000;

const firstExample = (node: any): unknown => {
    if (!isObject(node)) {
        return undefined;
    }
    if (node.example !== undefined) {
        return node.example;
    }
    if (isObject(node.examples)) {
        const first: any = Object.values(node.examples)[0];
        return isObject(first) ? first.value : undefined;
    }
    return undefined;
};

interface Ctx {
    root: any;
    nodes: number;
    memo: Map<object, { schema: JsonSchema; size: number }>;
}

function lookupRef(ref: string, ctx: Ctx): any {
    if (!ref.startsWith('#/')) {
        return undefined;
    }
    let cur: any = ctx.root;
    for (const raw of ref.slice(2).split('/')) {
        let key: string;
        try {
            key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
        } catch {
            return undefined;
        }
        if (!isObject(cur) && !Array.isArray(cur)) {
            return undefined;
        }
        cur = (cur as any)[key];
    }
    return cur;
}

/** Follow a $ref chain on a non-schema object (parameter, response, requestBody). */
function follow(node: any, ctx: Ctx): any {
    let cur = node;
    for (let i = 0; i < MAX_REF_HOPS && isObject(cur) && typeof cur.$ref === 'string'; i++) {
        cur = lookupRef(cur.$ref, ctx);
    }
    return isObject(cur) && typeof cur.$ref === 'string' ? undefined : cur;
}

function resolveSchema(node: any, ctx: Ctx, refStack: string[], objStack: any[], depth: number): JsonSchema {
    if (!isObject(node)) {
        return {};
    }
    if (depth > MAX_DEPTH + 5) {
        return truncated();
    }
    if (typeof node.$ref === 'string') {
        const ref = node.$ref;
        if (refStack.includes(ref) || refStack.length >= MAX_DEPTH) {
            return truncated();
        }
        const target = lookupRef(ref, ctx);
        if (!isObject(target)) {
            return truncated();
        }
        return resolveSchema(target, ctx, [...refStack, ref], objStack, depth);
    }
    if (objStack.includes(node)) {
        return truncated();
    }
    // The budget counts the EXPANDED size, so a shared child reused many times still counts every time.
    const cached = ctx.memo.get(node);
    if (cached) {
        ctx.nodes += cached.size;
        return ctx.nodes > MAX_NODES ? truncated() : cached.schema;
    }
    const start = ctx.nodes;
    if (++ctx.nodes > MAX_NODES) {
        return truncated();
    }
    const result = resolveNode(node, ctx, refStack, objStack, depth);
    ctx.memo.set(node, { schema: result, size: ctx.nodes - start });
    return result;
}

function resolveNode(node: any, ctx: Ctx, refStack: string[], objStack: any[], depth: number): JsonSchema {
    const stack = [...objStack, node];
    const sub = (s: any) => resolveSchema(s, ctx, refStack, stack, depth + 1);

    const { allOf, oneOf, anyOf, ...rest } = node;
    let result: JsonSchema = {};
    for (const [key, value] of Object.entries(rest)) {
        if (key === 'properties' && isObject(value)) {
            result.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sub(v)]));
        } else if (key === 'patternProperties' && isObject(value)) {
            result.patternProperties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sub(v)]));
        } else if ((key === 'items' || key === 'not') && isObject(value)) {
            result[key] = sub(value);
        } else if (key === 'additionalProperties' && isObject(value)) {
            result[key] = sub(value);
        } else {
            result[key] = value;
        }
    }

    if (Array.isArray(result.type)) {
        const types: string[] = result.type;
        const nonNull = types.find(t => t !== 'null');
        if (types.includes('null')) {
            result.nullable = true;
        }
        if (nonNull) {
            result.type = nonNull;
        } else {
            delete result.type;
        }
    }
    if (Array.isArray(allOf) && allOf.length > 0) {
        result = mergeAllOf([...allOf.map(sub), result]);
    }
    const choice = Array.isArray(oneOf) && oneOf.length ? 'oneOf' : Array.isArray(anyOf) && anyOf.length ? 'anyOf' : undefined;
    if (choice) {
        const first = sub((choice === 'oneOf' ? oneOf : anyOf)[0]);
        result = mergeAllOf([first, result]);
        result['x-note'] = `${choice}: first branch used`;
    }
    return result;
}

function resolveTop(node: any, ctx: Ctx): JsonSchema {
    ctx.nodes = 0;
    return resolveSchema(node, ctx, [], [], 0);
}

function mergeAllOf(parts: JsonSchema[]): JsonSchema {
    const merged: JsonSchema = {};
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const part of parts) {
        for (const [key, value] of Object.entries(part)) {
            if (key === 'properties' && isObject(value)) {
                Object.assign(properties, value);
            } else if (key === 'required' && Array.isArray(value)) {
                for (const r of value) {
                    if (!required.includes(r)) {
                        required.push(r);
                    }
                }
            } else if (!(key in merged)) {
                merged[key] = value;
            }
        }
    }
    if (Object.keys(properties).length > 0) {
        merged.properties = properties;
        merged.type = merged.type ?? 'object';
    }
    if (required.length > 0) {
        merged.required = required;
    }
    return merged;
}

function paramSchema(param: any, ctx: Ctx): JsonSchema {
    if (isObject(param.schema)) {
        return resolveTop(param.schema, ctx);
    }
    // OAS2 inline parameter typing
    const inline: JsonSchema = {};
    for (const key of ['type', 'format', 'enum', 'default', 'items', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'example']) {
        if (param[key] !== undefined) {
            inline[key] = key === 'items' ? resolveSchema(param[key], ctx, [], [], 1) : param[key];
        }
    }
    return inline;
}

function buildSchemes(api: any): SecurityScheme[] {
    const defs: Record<string, any> = api.components?.securitySchemes ?? api.securityDefinitions ?? {};
    const schemes: SecurityScheme[] = [];
    for (const [name, raw] of Object.entries(defs)) {
        const def = isObject(raw) ? raw : {};
        const type = String(def.type ?? '').toLowerCase();
        if (type === 'basic' || (type === 'http' && String(def.scheme).toLowerCase() === 'basic')) {
            schemes.push({ name, kind: 'basic' });
        } else if (type === 'http' && String(def.scheme).toLowerCase() === 'bearer') {
            schemes.push({ name, kind: 'bearer' });
        } else if (type === 'apikey') {
            const where = ['header', 'query', 'cookie'].includes(def.in) ? def.in : undefined;
            schemes.push({ name, kind: 'apiKey', ...(where ? { in: where } : {}), ...(def.name ? { paramName: def.name } : {}) });
        } else if (type === 'oauth2') {
            const flows = def.flows ?? {};
            const tokenUrl = def.tokenUrl ?? flows.clientCredentials?.tokenUrl ?? flows.password?.tokenUrl ?? flows.authorizationCode?.tokenUrl;
            schemes.push({ name, kind: 'oauth2', ...(tokenUrl ? { tokenUrl } : {}) });
        } else if (type === 'openidconnect') {
            schemes.push({ name, kind: 'openIdConnect' });
        }
    }
    return schemes;
}

function buildBaseUrl(api: any): string | undefined {
    const server = Array.isArray(api.servers) ? api.servers.find((s: any) => s?.url) : undefined;
    if (server) {
        return String(server.url).replace(/\{([^}]+)\}/g, (_m, name: string) => server.variables?.[name]?.default ?? `{${name}}`);
    }
    if (api.swagger && api.host) {
        const scheme = Array.isArray(api.schemes) && api.schemes.length ? api.schemes[0] : 'https';
        return `${scheme}://${api.host}${api.basePath && api.basePath !== '/' ? api.basePath : ''}`;
    }
    return undefined;
}

function securityNames(sec: any): string[] {
    const names: string[] = [];
    for (const req of Array.isArray(sec) ? sec : []) {
        for (const name of Object.keys(isObject(req) ? req : {})) {
            if (!names.includes(name)) {
                names.push(name);
            }
        }
    }
    return names;
}

function slug(method: string, path: string): string {
    const s = path.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return `${method}_${s}`;
}

function buildResponses(operation: any, api: any, ctx: Ctx): ResponseModel[] {
    const out: ResponseModel[] = [];
    const produces: string[] = operation.produces ?? api.produces ?? [];
    for (const [status, rawResp] of Object.entries(operation.responses ?? {})) {
        if (status.startsWith('x-')) {
            continue;
        }
        const resp = follow(rawResp, ctx);
        const model: ResponseModel = { status };
        if (isObject(resp)) {
            if (isObject(resp.content)) {
                const ct = Object.keys(resp.content).find(isJsonType);
                if (ct) {
                    model.contentType = ct;
                    const rex = firstExample(resp.content[ct]);
                    if (rex !== undefined) {
                        model.example = rex;
                    }
                    if (isObject(resp.content[ct]?.schema)) {
                        model.schema = resolveTop(resp.content[ct].schema, ctx);
                    }
                }
            } else if (isObject(resp.schema)) {
                model.contentType = produces.find(isJsonType) ?? 'application/json';
                model.schema = resolveTop(resp.schema, ctx);
                if (isObject(resp.examples) && resp.examples[model.contentType] !== undefined) {
                    model.example = resp.examples[model.contentType];
                }
            }
        }
        out.push(model);
    }
    return out;
}

function unsupportedBody(types: string[]): string {
    const note = types.some(t => /multipart/i.test(t))
        ? 'multipart form data is not generated'
        : 'only JSON request bodies are generated';
    return `Unsupported request body content type: ${types.join(', ')} (${note})`;
}

export function buildOpenApiModel(api: any, sourceName: string): GenerationModel {
    const doc = isObject(api) ? api : {};
    const ctx: Ctx = { root: doc, nodes: 0, memo: new Map() };
    const model: GenerationModel = {
        source: 'openapi',
        name: sourceName,
        schemes: buildSchemes(doc),
        operations: [],
        unsupported: []
    };
    const baseUrl = buildBaseUrl(doc);
    if (baseUrl) {
        model.baseUrl = baseUrl;
    }
    const globalSecurity = Array.isArray(doc.security) ? securityNames(doc.security) : undefined;

    const usedIds = new Set<string>();
    for (const [path, rawItem] of Object.entries(doc.paths ?? {})) {
        const item = follow(rawItem, ctx);
        if (!isObject(item)) {
            continue;
        }
        for (const method of METHODS) {
            const operation = item[method];
            if (!isObject(operation)) {
                continue;
            }
            const sourceRef = `${method.toUpperCase()} ${path}`;

            // Parameters: operation overrides path-item by name+in.
            const merged = new Map<string, any>();
            let oas2Body: any;
            const oas2Form: any[] = [];
            for (const raw of [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])]) {
                const p = follow(raw, ctx);
                if (!isObject(p) || !p.name || !p.in) {
                    continue;
                }
                merged.set(`${p.in}:${p.name}`, p);
            }
            const pathParams: ParamModel[] = [];
            const queryParams: ParamModel[] = [];
            const headerParams: ParamModel[] = [];
            for (const p of merged.values()) {
                if (p.in === 'body') {
                    oas2Body = p;
                    continue;
                }
                if (p.in === 'formData') {
                    oas2Form.push(p);
                    continue;
                }
                const pm: ParamModel = { name: p.name, required: p.in === 'path' ? true : p.required === true, schema: paramSchema(p, ctx) };
                const pex = firstExample(p);
                if (pex !== undefined) {
                    pm.example = pex;
                }
                if (p.in === 'path') {
                    pathParams.push(pm);
                } else if (p.in === 'query') {
                    queryParams.push(pm);
                } else if (p.in === 'header') {
                    headerParams.push(pm);
                }
            }

            // Request body
            let body: BodyModel | undefined;
            const rb = follow(operation.requestBody, ctx);
            if (isObject(rb) && isObject(rb.content)) {
                const types = Object.keys(rb.content);
                const ct = types.find(isJsonType);
                if (ct) {
                    const media = rb.content[ct] ?? {};
                    body = { contentType: ct };
                    if (isObject(media.schema)) {
                        body.schema = resolveTop(media.schema, ctx);
                    }
                    const example = media.example ?? (isObject(media.examples) ? (Object.values(media.examples)[0] as any)?.value : undefined);
                    if (example !== undefined) {
                        body.example = example;
                    }
                } else if (types.length > 0) {
                    model.unsupported.push({ sourceRef, reason: unsupportedBody(types) });
                }
            } else if (oas2Body) {
                const consumes: string[] = operation.consumes ?? doc.consumes ?? [];
                const ct = consumes.find(isJsonType) ?? (consumes.length === 0 ? 'application/json' : undefined);
                if (ct) {
                    body = { contentType: ct };
                    if (isObject(oas2Body.schema)) {
                        body.schema = resolveTop(oas2Body.schema, ctx);
                    }
                    if (oas2Body['x-example'] !== undefined) {
                        body.example = oas2Body['x-example'];
                    }
                } else {
                    model.unsupported.push({ sourceRef, reason: unsupportedBody(consumes) });
                }
            } else if (oas2Form.length > 0) {
                const consumes: string[] = operation.consumes ?? doc.consumes ?? [];
                const types = consumes.length ? consumes : [oas2Form.some(p => p.type === 'file') ? 'multipart/form-data' : 'application/x-www-form-urlencoded'];
                model.unsupported.push({ sourceRef, reason: unsupportedBody(types) });
            }

            let security: OperationModel['security'];
            if (Array.isArray(operation.security)) {
                // Optional auth ({} alongside named schemes) keeps the names; only an all-empty list means 'none'.
                const names = securityNames(operation.security);
                security = names.length === 0 ? 'none' : names;
            } else if (globalSecurity !== undefined) {
                security = globalSecurity.length === 0 ? 'none' : globalSecurity;
            } else {
                security = 'inherit';
            }

            const baseId: string = operation.operationId || slug(method, path);
            let id = baseId;
            for (let n = 2; usedIds.has(id); n++) {
                id = `${baseId}_${n}`;
            }
            usedIds.add(id);

            const op: OperationModel = {
                id,
                method: method.toUpperCase(),
                path,
                tags: Array.isArray(operation.tags) ? operation.tags : [],
                pathParams,
                queryParams,
                headerParams,
                responses: buildResponses(operation, doc, ctx),
                security,
                sourceRef
            };
            if (operation.summary) {
                op.summary = operation.summary;
            }
            if (body) {
                op.body = body;
            }
            model.operations.push(op);
        }
    }
    return model;
}
