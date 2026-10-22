// Converts a JSON schema into a Karate match schema (markers such as #string, ##number, #[] #string).
// Pure: no vscode, no I/O.
import type { JsonSchema } from '../model/TestModel';
import { numericBounds } from './dataFactory';

export interface KarateSchemaOptions {
    /** Mark non-required properties as optional (`##marker`). When false they stay strict. */
    optionalAsDoubleHash: boolean;
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const IGNORE = '#ignore';

const isObj = (v: unknown): v is JsonSchema => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `#string` -> `##string`; leaves `##x` and `#ignore` alone. Object (nested) schemas cannot be marked, so they collapse to `##object`. */
function optional(marker: unknown): unknown {
    if (isObj(marker)) {return '##object';}
    if (typeof marker !== 'string') {return marker;}
    if (!marker.startsWith('#') || marker.startsWith('##') || marker === IGNORE) {return marker;}
    return `#${marker}`;
}

const exceedsSafeInteger = (s: JsonSchema): boolean => {
    const candidates: unknown[] = [s.minimum, s.maximum, s.example, s.default, ...(Array.isArray(s.enum) ? s.enum : [])];
    return candidates.some(v => (typeof v === 'number' && Math.abs(v) > MAX_SAFE) || (typeof v === 'string' && /^-?\d{16,}$/.test(v) && BigInt(v) > BigInt(MAX_SAFE)));
};

const jsList = (values: unknown[]): string =>
    `[${values.map(v => (typeof v === 'string' ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : JSON.stringify(v))).join(', ')}]`;

/** OpenAPI `pattern` is an unanchored search; Karate `#regex` matches the whole value. */
function anchored(pattern: string): string {
    return pattern.startsWith('^') && pattern.endsWith('$') && !pattern.endsWith('\\$') ? pattern : `.*(?:${pattern}).*`;
}

function scalar(s: JsonSchema, type: string): string {
    if (type === 'string') {
        if (Array.isArray(s.enum) && s.enum.length > 0) {return `#string? ${jsList(s.enum)}.includes(_)`;}
        if (s.format === 'uuid') {return '#uuid';}
        if (typeof s.pattern === 'string' && s.pattern !== '') {return `#regex ${anchored(s.pattern)}`;}
        const parts: string[] = [];
        if (typeof s.minLength === 'number' && s.minLength > 0) {parts.push(`_.length >= ${s.minLength}`);}
        if (typeof s.maxLength === 'number') {parts.push(`_.length <= ${s.maxLength}`);}
        return parts.length > 0 ? `#string? ${parts.join(' && ')}` : '#string';
    }
    if (type === 'integer' || type === 'number') {
        if (exceedsSafeInteger(s)) {return '#string';}
        if (Array.isArray(s.enum) && s.enum.length > 0) {return `#number? ${jsList(s.enum)}.includes(_)`;}
        const parts: string[] = [];
        const { min, max } = numericBounds(s);
        if (min) {parts.push(`_ ${min.exclusive ? '>' : '>='} ${min.value}`);}
        if (max) {parts.push(`_ ${max.exclusive ? '<' : '<='} ${max.value}`);}
        return parts.length > 0 ? `#number? ${parts.join(' && ')}` : '#number';
    }
    return '#boolean';
}

function convert(s: JsonSchema | undefined, opts: KarateSchemaOptions): unknown {
    if (!isObj(s)) {return IGNORE;}
    let result: unknown;
    const type: string | undefined = typeof s.type === 'string' ? s.type : isObj(s.properties) ? 'object' : s.items ? 'array' : undefined;
    if (s['x-truncated'] === true) {
        result = '#object';
    } else if (type === 'object') {
        const props = isObj(s.properties) ? s.properties : {};
        const required: string[] = Array.isArray(s.required) ? s.required : [];
        const keys = Object.keys(props);
        if (keys.length === 0) {
            result = '#object';
        } else {
            const obj: Record<string, unknown> = {};
            for (const key of keys) {
                let child = convert(props[key], opts);
                const nullable = isObj(props[key]) && props[key].nullable === true;
                if ((!required.includes(key) && opts.optionalAsDoubleHash) || nullable) {child = optional(child);}
                obj[key] = child;
            }
            result = obj;
        }
    } else if (type === 'array') {
        const item = convert(s.items, opts);
        result = typeof item === 'string' ? `#[] ${item}` : '#[] #object';
    } else if (type === 'string' || type === 'integer' || type === 'number' || type === 'boolean') {
        result = scalar(s, type);
    } else {
        result = IGNORE;
    }
    return s.nullable === true ? optional(result) : result;
}

/** Karate match schema for a JSON schema. The returned value is JSON-serialisable (strings and plain objects). */
export function toKarateSchema(schema: JsonSchema, opts: KarateSchemaOptions): unknown {
    return convert(schema, opts);
}
