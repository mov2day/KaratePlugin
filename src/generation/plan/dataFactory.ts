// Deterministic sample values and schema violations for generated requests. Pure: no vscode, no logger, no randomness.
import type { JsonSchema } from '../model/TestModel';

const isObj = (v: unknown): v is JsonSchema => typeof v === 'object' && v !== null && !Array.isArray(v);
const MAX_DEPTH = 6;

/** JS/Karate literal for a value (strings single-quoted). */
export function jsLiteral(v: unknown): string {
    if (typeof v === 'string') {return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;}
    return JSON.stringify(v) ?? 'null';
}

export interface Bound {
    value: number;
    exclusive: boolean;
}

/** Numeric bounds, normalising OAS3.0 boolean and OAS3.1/JSON-Schema numeric exclusive forms. */
export function numericBounds(s: JsonSchema): { min?: Bound; max?: Bound } {
    const out: { min?: Bound; max?: Bound } = {};
    if (typeof s.minimum === 'number') {out.min = { value: s.minimum, exclusive: s.exclusiveMinimum === true };}
    if (typeof s.exclusiveMinimum === 'number' && (!out.min || s.exclusiveMinimum >= out.min.value)) {out.min = { value: s.exclusiveMinimum, exclusive: true };}
    if (typeof s.maximum === 'number') {out.max = { value: s.maximum, exclusive: s.exclusiveMaximum === true };}
    if (typeof s.exclusiveMaximum === 'number' && (!out.max || s.exclusiveMaximum <= out.max.value)) {out.max = { value: s.exclusiveMaximum, exclusive: true };}
    return out;
}

/** Smallest/largest valid value for a bound (undefined when a non-integer exclusive bound has no tidy extreme). */
export function validExtreme(b: Bound, integer: boolean, dir: 1 | -1): number | undefined {
    if (!b.exclusive) {return b.value;}
    return integer ? b.value + dir : undefined;
}

const clamp = (n: number, s: JsonSchema, integer: boolean): number => {
    const { min, max } = numericBounds(s);
    let v = n;
    if (min && (v < min.value || (min.exclusive && v === min.value))) {v = min.exclusive ? (integer ? min.value + 1 : min.value + 0.5) : min.value;}
    if (max && (v > max.value || (max.exclusive && v === max.value))) {v = max.exclusive ? (integer ? max.value - 1 : max.value - 0.5) : max.value;}
    return v;
};

/** Drops properties flagged (readOnly / writeOnly) from an object schema, deeply. Returns a copy. */
export function withoutFlagged(schema: JsonSchema | undefined, flag: 'readOnly' | 'writeOnly'): JsonSchema | undefined {
    if (!isObj(schema)) {return schema;}
    const out: JsonSchema = { ...schema };
    if (isObj(schema.properties)) {
        const props: JsonSchema = {};
        for (const [k, v] of Object.entries(schema.properties)) {
            if (isObj(v) && v[flag] === true) {continue;}
            props[k] = withoutFlagged(v as JsonSchema, flag);
        }
        out.properties = props;
        if (Array.isArray(schema.required)) {out.required = schema.required.filter((r: string) => r in props);}
    }
    if (isObj(schema.items)) {out.items = withoutFlagged(schema.items, flag);}
    return out;
}

type Tok = { set: string[]; min: number; max: number };

/** Tiny generator for trivially simple patterns (literals, \d \w, [classes], {n,m}, one group/alternation). */
export function fromPattern(pattern: string): string | undefined {
    let p = pattern;
    if (p.startsWith('^')) {p = p.slice(1);}
    if (p.endsWith('$') && !p.endsWith('\\$')) {p = p.slice(0, -1);}
    const strip = /^\((?:\?:)?(.*)\)$/.exec(p);
    if (strip && !/[()]/.test(strip[1])) {p = strip[1];}
    if (/[()]/.test(p)) {return undefined;}
    p = p.split('|')[0];
    const toks: Tok[] = [];
    let i = 0;
    const cls = (c: string): string[] | undefined => (c === 'd' ? ['0'] : c === 'w' ? ['a'] : c === 's' ? undefined : [c]);
    while (i < p.length) {
        let set: string[] | undefined;
        const c = p[i];
        if (c === '\\') {
            set = cls(p[i + 1] ?? '');
            i += 2;
        } else if (c === '[') {
            const end = p.indexOf(']', i);
            if (end < 0) {return undefined;}
            const body = p.slice(i + 1, end);
            if (body.startsWith('^')) {return undefined;}
            set = [body[0] === '\\' ? (cls(body[1])?.[0] ?? '') : body[0]];
            i = end + 1;
        } else if (/[.*+?{}$^]/.test(c)) {
            return undefined;
        } else {
            set = [c];
            i++;
        }
        if (!set || set[0] === '') {return undefined;}
        let min = 1;
        let max = 1;
        const q = p[i];
        if (q === '?') { min = 0; max = 1; i++; }
        else if (q === '+') { min = 1; max = 1; i++; }
        else if (q === '*') { min = 0; max = 0; i++; }
        else if (q === '{') {
            const m = /^\{(\d+)(?:,(\d*))?\}/.exec(p.slice(i));
            if (!m) {return undefined;}
            min = Number(m[1]);
            max = min;
            i += m[0].length;
        }
        toks.push({ set, min, max });
    }
    const value = toks.map(t => t.set[0].repeat(t.min)).join('');
    try {
        return new RegExp(pattern).test(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

function stringFor(s: JsonSchema, name: string): string {
    const n = name.toLowerCase();
    let v: string;
    const fromPat = typeof s.pattern === 'string' && !s.format ? fromPattern(s.pattern) : undefined;
    if (fromPat !== undefined) {return fromPat;}
    switch (s.format) {
        case 'uuid': v = '7c9e6679-7425-40de-944b-e07fc1f90ae7'; break;
        case 'email': v = 'test.user@example.com'; break;
        case 'date': v = '2024-01-15'; break;
        case 'date-time': v = '2024-01-15T10:30:00Z'; break;
        case 'uri': case 'url': v = 'https://example.com/resource'; break;
        case 'hostname': v = 'example.com'; break;
        case 'ipv4': v = '192.0.2.1'; break;
        case 'password': v = 'Sample-Passw0rd'; break;
        default:
            if (/e-?mail/.test(n)) {v = 'test.user@example.com';}
            else if (/phone|mobile|tel/.test(n)) {v = '+15555550100';}
            else if (/(^|_)url$|uri$|link$|website/.test(n)) {v = 'https://example.com/resource';}
            else if (/first.?name/.test(n)) {v = 'Alex';}
            else if (/last.?name|surname/.test(n)) {v = 'Rivera';}
            else if (/user.?name|login/.test(n)) {v = 'test-user';}
            else if (/name|title/.test(n)) {v = 'Sample name';}
            else if (/desc|comment|note|message/.test(n)) {v = 'Sample description';}
            else if (/status/.test(n)) {v = 'active';}
            else if (/country/.test(n)) {v = 'US';}
            else if (/city/.test(n)) {v = 'Springfield';}
            else if (/zip|postal/.test(n)) {v = '12345';}
            else {v = 'sample';}
    }
    if (typeof s.minLength === 'number' && v.length < s.minLength) {v = v.padEnd(s.minLength, 'x');}
    if (typeof s.maxLength === 'number' && v.length > s.maxLength) {v = v.slice(0, s.maxLength);}
    return v;
}

/** A valid sample value for `schema`. Priority: example, default, const, first enum value, then type/name/format heuristics. */
export function valueFor(schema: JsonSchema | undefined, name = '', depth = 0): unknown {
    const s: JsonSchema = isObj(schema) ? schema : {};
    if (s.example !== undefined) {return s.example;}
    if (s.default !== undefined) {return s.default;}
    if (s.const !== undefined) {return s.const;}
    if (Array.isArray(s.enum) && s.enum.length > 0) {return s.enum[0];}
    if (s['x-truncated'] === true) {return {};}
    const type: string | undefined = typeof s.type === 'string' ? s.type : isObj(s.properties) ? 'object' : s.items ? 'array' : undefined;
    const n = name.toLowerCase();
    switch (type) {
        case 'integer': {
            const base = /(^|_)id$|id$/.test(n) ? 1 : /age/.test(n) ? 30 : /year/.test(n) ? 2024 : 1;
            return Math.trunc(clamp(base, s, true));
        }
        case 'number': {
            const base = /price|amount|cost|total/.test(n) ? 9.99 : 1.5;
            return clamp(base, s, false);
        }
        case 'boolean': return true;
        case 'array': {
            if (depth >= MAX_DEPTH) {return [];}
            const count = Math.max(1, typeof s.minItems === 'number' ? s.minItems : 1);
            return Array.from({ length: Math.min(count, 5) }, () => valueFor(s.items, name, depth + 1));
        }
        case 'object': {
            if (depth >= MAX_DEPTH || !isObj(s.properties)) {return {};}
            return Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, valueFor(v as JsonSchema, k, depth + 1)]));
        }
        case 'string': return stringFor(s, name);
        default: return s.format ? stringFor(s, name) : 'sample';
    }
}

export interface Violation {
    /** JS expression for the invalid value. */
    expr: string;
    label: string;
}

/** First deterministic way to violate `schema`, or undefined when nothing can be derived from it. */
export function violation(schema: JsonSchema | undefined): Violation | undefined {
    const s: JsonSchema = isObj(schema) ? schema : {};
    const type: string | undefined = typeof s.type === 'string' ? s.type : undefined;
    if (Array.isArray(s.enum) && s.enum.length > 0) {
        const nums = s.enum.filter((v: unknown): v is number => typeof v === 'number');
        if (nums.length === s.enum.length) {return { expr: String(Math.max(...nums) + 1), label: 'value not in enum' };}
        let candidate = 'invalid-value';
        while (s.enum.includes(candidate)) {candidate += '-x';}
        return { expr: jsLiteral(candidate), label: 'value not in enum' };
    }
    if (type === 'integer' || type === 'number') {
        const { min, max } = numericBounds(s);
        if (min) {return { expr: String(min.exclusive ? min.value : min.value - 1), label: `${min.exclusive ? 'at or below exclusive' : 'below'} minimum ${min.value}` };}
        if (max) {return { expr: String(max.exclusive ? max.value : max.value + 1), label: `${max.exclusive ? 'at or above exclusive' : 'above'} maximum ${max.value}` };}
        return { expr: "'not-a-number'", label: 'wrong type' };
    }
    if (type === 'string') {
        if (typeof s.minLength === 'number' && s.minLength >= 1) {
            return { expr: s.minLength === 1 ? "''" : `'a'.repeat(${s.minLength - 1})`, label: `shorter than minLength ${s.minLength}` };
        }
        if (typeof s.maxLength === 'number' && s.maxLength <= 1000) {return { expr: `'a'.repeat(${s.maxLength + 1})`, label: `longer than maxLength ${s.maxLength}` };}
        if (s.format === 'uuid') {return { expr: "'not-a-uuid'", label: 'not a uuid' };}
        if (s.format === 'email') {return { expr: "'not-an-email'", label: 'not an email' };}
        if (s.format === 'date' || s.format === 'date-time') {return { expr: "'not-a-date'", label: `not a ${s.format}` };}
    }
    if (type === 'boolean') {return { expr: "'not-a-boolean'", label: 'wrong type' };}
    return undefined;
}

/** A pattern the generator cannot satisfy (no example/default/enum/const to fall back on), or undefined. */
export function unsatisfiablePattern(schema: JsonSchema | undefined): string | undefined {
    const s = isObj(schema) ? schema : {};
    if (typeof s.pattern !== 'string' || s.format) {return undefined;}
    if (s.example !== undefined || s.default !== undefined || s.const !== undefined || (Array.isArray(s.enum) && s.enum.length > 0)) {return undefined;}
    return fromPattern(s.pattern) === undefined ? s.pattern : undefined;
}
