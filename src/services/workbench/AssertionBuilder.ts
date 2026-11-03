/** Turns a clicked response field into Karate assertion text. Pure functions, no vscode dependency. */

export type PathSegment = string | number;
export type MatchMode = 'type' | 'value' | 'present';

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const VOLATILE_KEY = /^(?:id|uuid|guid)$|Id$|_id$|created|updated|modified|timestamp|date|time$|token|expires|etag|nonce/i;
const RESERVED = new Set(['response', 'request', 'karate', 'responseStatus', 'responseHeaders', 'responseTime', 'read', 'call', 'url', 'path', 'baseUrl']);

export function jsPath(root: string, path: PathSegment[]): string {
    let out = root;
    for (const segment of path) {
        if (typeof segment === 'number') {
            out += `[${segment}]`;
        } else if (IDENTIFIER.test(segment)) {
            out += `.${segment}`;
        } else {
            out += `['${segment.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;
        }
    }
    return out;
}

export function typeMarker(value: unknown): string {
    if (value === null) {
        return '#null';
    }
    if (Array.isArray(value)) {
        return '#array';
    }
    switch (typeof value) {
        case 'number': return '#number';
        case 'boolean': return '#boolean';
        case 'string': return UUID.test(value) ? '#uuid' : '#string';
        default: return '#object';
    }
}

function quoteString(text: string): string {
    return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n')}'`;
}

/** A Karate literal for the value. */
export function literal(value: unknown): string {
    if (typeof value === 'string') {
        return quoteString(value);
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    return JSON.stringify(value);
}

export function suggestMode(key: PathSegment | undefined, value: unknown): MatchMode {
    if (typeof key === 'string' && VOLATILE_KEY.test(key)) {
        return 'type';
    }
    if (typeof value === 'string' && (UUID.test(value) || ISO_DATE.test(value))) {
        return 'type';
    }
    if (typeof value === 'number' && Math.abs(value) > 1e9) {
        return 'type';
    }
    return 'value';
}

/** The assertion step text, without keyword. */
export function matchStep(path: PathSegment[], value: unknown, mode: MatchMode): string {
    const target = jsPath('response', path);
    if (mode === 'present') {
        return `match ${target} == '#present'`;
    }
    if (mode === 'type') {
        return `match ${target} == '${typeMarker(value)}'`;
    }
    return `match ${target} == ${literal(value)}`;
}

function schemaValue(value: unknown, pad: string, compact: boolean): string {
    if (value === null) {
        return "'#present'";
    }
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return "'#array'";
        }
        const kinds = new Set(value.map(item => (item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item)));
        if (kinds.size === 1) {
            const first = value[0];
            if (typeof first === 'object' && first !== null) {
                return Array.isArray(first) ? "'#[] #array'" : "'#[] #object'";
            }
            return `'#[] ${typeMarker(first)}'`;
        }
        return "'#array'";
    }
    if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length === 0) {
            return "'#object'";
        }
        const name = (key: string): string => (IDENTIFIER.test(key) ? key : quoteString(key));
        if (compact) {
            return `{ ${entries.map(([key, child]) => `${name(key)}: ${schemaValue(child, pad, true)}`).join(', ')} }`;
        }
        const inner = pad + '  ';
        const body = entries.map(([key, child]) => `${inner}${name(key)}: ${schemaValue(child, inner, false)}`).join(',\n');
        return `{\n${body}\n${pad}}`;
    }
    return `'${typeMarker(value)}'`;
}

/**
 * A whole-body schema match. Arrays of objects use "match each". Short schemas stay on one line; longer ones
 * use a docstring, which is how Karate accepts multi-line JSON in a step.
 */
export function schemaStep(path: PathSegment[], value: unknown): string {
    const target = jsPath('response', path);
    const each = Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'object' && item !== null && !Array.isArray(item));
    const subject = each ? (value as unknown[])[0] : value;
    const prefix = each ? `match each ${target} ==` : `match ${target} ==`;
    const compact = schemaValue(subject, '', true);
    if (compact.length <= 100) {
        return `${prefix} ${compact}`;
    }
    return `${prefix}\n"""\n${schemaValue(subject, '', false)}\n"""`;
}

function singular(word: string): string {
    if (/ies$/i.test(word)) {
        return word.replace(/ies$/i, 'y');
    }
    if (/(?:ss|us)$/i.test(word)) {
        return word;
    }
    return word.replace(/s$/i, '');
}

function camel(text: string): string {
    const words = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (!words.length) {
        return 'value';
    }
    const joined = words.map((word, index) => (index === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1))).join('');
    return /^[A-Za-z_$]/.test(joined) ? joined : `v${joined}`;
}

/** A readable, unused variable name for the clicked field. */
export function variableName(path: PathSegment[], existing: Iterable<string>, hints: string[]): string {
    const taken = new Set(existing);
    const last = path[path.length - 1];
    const parent = path.length > 1 ? path[path.length - 2] : undefined;
    let base: string;
    if (typeof last === 'number') {
        base = typeof parent === 'string' ? `${camel(singular(parent))}Item` : 'item';
    } else if (/^id$/i.test(last ?? '') && typeof parent === 'string') {
        base = `${camel(singular(parent))}Id`;
    } else if (/^id$/i.test(last ?? '') && hints.length) {
        base = `${camel(singular(hints[hints.length - 1]))}Id`;
    } else {
        base = camel(String(last ?? 'value'));
    }
    if (RESERVED.has(base)) {
        base = `my${base.charAt(0).toUpperCase()}${base.slice(1)}`;
    }
    let name = base;
    for (let n = 2; taken.has(name); n++) {
        name = `${base}${n}`;
    }
    return name;
}

export function defStep(path: PathSegment[], name: string): string {
    return `def ${name} = ${jsPath('response', path)}`;
}

/** Reads a value out of a parsed body by path; undefined when the path is not present. */
export function valueAtPath(root: unknown, path: PathSegment[]): unknown {
    let value: unknown = root;
    for (const segment of path) {
        if (value === null || typeof value !== 'object') {
            return undefined;
        }
        value = (value as Record<string | number, unknown>)[segment];
    }
    return value;
}
