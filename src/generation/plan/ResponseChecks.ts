// Response-contract checks shared by every flow: Karate step texts (no keyword) asserted after the status line.
// Pure: no vscode, no I/O. 'basic' mode emits nothing except the optional response-time budget.
import type { HeaderModel, JsonSchema, OperationModel, ResponseModel } from '../model/TestModel';
import { jsLiteral } from './dataFactory';

export interface ResponseCheckOptions {
    mode: 'basic' | 'contract';
    /** Response-time budget in ms; 0 disables it. Applies in both modes. */
    responseTimeMs: number;
    /** Literal values the request step sends for query parameters (name -> value). Only these can bound a list size. */
    requestParams?: Record<string, unknown>;
}

const isObj = (v: unknown): v is JsonSchema => typeof v === 'object' && v !== null && !Array.isArray(v);
const IDENT = /^[A-Za-z_$][\w$]*$/;
const LIMIT_PARAM = /^(?:limit|size|page_?size|per_?page|max_?results|top)$/i;
const NUMERIC_HEADER = /^x-(?:total(?:-count)?|total-pages|page-count|per-page|limit)$/i;
const MAX_EXAMPLE_FIELDS = 8;

const baseType = (contentType: string): string => contentType.split(';')[0].trim().toLowerCase();

function headerCheck(h: HeaderModel, status: string): string | undefined {
    const name = h.name.toLowerCase();
    const target = /^[\w-]+$/.test(h.name) ? h.name : undefined;
    if (!target) {return undefined;}
    // A declared-but-optional header is only type-checked when present (`##`).
    const mark = (marker: string): string => (h.required ? `#${marker}` : `##${marker}`);
    if (name === 'location') {return status === '201' ? `match header ${target} == '#string'` : undefined;}
    if (name === 'etag' || name === 'retry-after' || name === 'link') {return `match header ${target} == '${mark('string')}'`;}
    if (NUMERIC_HEADER.test(name)) {return `match header ${target} == '${mark('regex [0-9]+')}'`;}
    return undefined;
}

/** The property of an object response that holds the list, when it is the only array property and is required. */
function listAccessor(schema: JsonSchema): { accessor: string; items: JsonSchema } | undefined {
    if (schema.type === 'array') {return { accessor: 'response', items: schema };}
    const props = isObj(schema.properties) ? (schema.properties as Record<string, JsonSchema>) : {};
    const required: string[] = Array.isArray(schema.required) ? schema.required : [];
    const arrays = Object.entries(props).filter(([, p]) => isObj(p) && p.type === 'array');
    if (arrays.length !== 1) {return undefined;}
    const [name, items] = arrays[0];
    return IDENT.test(name) && required.includes(name) ? { accessor: `response.${name}`, items } : undefined;
}

function arrayChecks(schema: JsonSchema, opts: ResponseCheckOptions): string[] {
    const out: string[] = [];
    const list = listAccessor(schema);
    if (!list || schema['x-truncated'] === true) {return out;}
    // Nested list properties get their bounds from the schema match; only a top-level array needs explicit steps.
    if (list.accessor === 'response') {
        if (typeof schema.minItems === 'number' && schema.minItems > 0) {out.push(`assert response.length >= ${schema.minItems}`);}
        if (typeof schema.maxItems === 'number') {out.push(`assert response.length <= ${schema.maxItems}`);}
        if (schema.uniqueItems === true) {out.push('assert new Set(response.map(x => JSON.stringify(x))).size == response.length');}
    }
    for (const [name, value] of Object.entries(opts.requestParams ?? {})) {
        if (LIMIT_PARAM.test(name) && typeof value === 'number' && Number.isInteger(value) && value > 0) {
            out.push(`assert ${list.accessor}.length <= ${value}`);
            break;
        }
    }
    return out;
}

/** Identity fields that are `const` / single-value enums in the schema and agree with a small example. */
function exampleChecks(schema: JsonSchema | undefined, example: unknown): string[] {
    if (!isObj(example) || !isObj(schema) || !isObj(schema.properties)) {return [];}
    const keys = Object.keys(example);
    if (keys.length === 0 || keys.length > MAX_EXAMPLE_FIELDS) {return [];}
    if (!keys.every(k => ['string', 'number', 'boolean'].includes(typeof example[k]))) {return [];}
    const out: string[] = [];
    for (const key of keys) {
        const p = (schema.properties as Record<string, JsonSchema>)[key];
        if (!isObj(p) || !IDENT.test(key)) {continue;}
        const fixed = p.const !== undefined ? p.const : Array.isArray(p.enum) && p.enum.length === 1 ? p.enum[0] : undefined;
        if (fixed !== undefined && fixed === example[key]) {out.push(`match response.${key} == ${jsLiteral(fixed)}`);}
    }
    return out;
}

/**
 * Step texts (without keyword) that assert the response contract, in order: Content-Type, declared headers,
 * list bounds, example identity fields, then the response-time budget. Nothing is emitted that the spec or example
 * does not support.
 */
export function responseChecksFor(op: OperationModel, response: ResponseModel, opts: ResponseCheckOptions): string[] {
    const out: string[] = [];
    // HEAD responses carry headers only.
    const hasBody = op.method !== 'HEAD';
    if (opts.mode === 'contract') {
        if (hasBody && response.contentType) {
            out.push(`match header Content-Type contains ${jsLiteral(baseType(response.contentType))}`);
        }
        for (const h of response.headers ?? []) {
            const check = headerCheck(h, response.status);
            if (check) {out.push(check);}
        }
        if (hasBody && /^2\d\d$/.test(response.status) && isObj(response.schema)) {
            out.push(...arrayChecks(response.schema, opts));
            out.push(...exampleChecks(response.schema, response.example));
        }
    }
    if (opts.responseTimeMs > 0) {out.push(`assert responseTime < ${opts.responseTimeMs}`);}
    return out;
}
