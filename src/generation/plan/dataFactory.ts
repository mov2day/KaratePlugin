// Deterministic sample values and schema violations for generated requests. Pure: no vscode, no logger, no randomness.
import type { JsonSchema } from '../model/TestModel';

const isObj = (v: unknown): v is JsonSchema => typeof v === 'object' && v !== null && !Array.isArray(v);
const MAX_DEPTH = 6;

/** JS/Karate literal for a value (strings single-quoted). */
export function jsLiteral(v: unknown): string {
    if (typeof v === 'string') {return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;}
    return JSON.stringify(v) ?? 'null';
}

const clamp = (n: number, min?: number, max?: number): number => {
    let v = n;
    if (typeof min === 'number' && v < min) {v = min;}
    if (typeof max === 'number' && v > max) {v = max;}
    return v;
};

function stringFor(s: JsonSchema, name: string): string {
    const n = name.toLowerCase();
    let v: string;
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
            return Math.trunc(clamp(base, s.minimum, s.maximum));
        }
        case 'number': {
            const base = /price|amount|cost|total/.test(n) ? 9.99 : 1.5;
            return clamp(base, s.minimum, s.maximum);
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
        if (typeof s.minimum === 'number') {return { expr: String(s.minimum - 1), label: `below minimum ${s.minimum}` };}
        if (typeof s.maximum === 'number') {return { expr: String(s.maximum + 1), label: `above maximum ${s.maximum}` };}
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
