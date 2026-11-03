import { jsPath, literal, PathSegment, quoteString, suggestMode, typeMarker } from './AssertionBuilder';
import { isSecretKey, isSecretValue } from './Redaction';

/**
 * Advanced assertion options for any field of a response, by data type. Every option produces ordinary Karate
 * (fuzzy markers, `contains`, `assert`, `match header`). Pure functions, no vscode dependency.
 */

export type ValueKind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

export interface OptionParam {
    prompt: string;
    /** A default that makes the generated assertion pass against the response it came from. */
    value: string;
}

export interface AdvancedOption {
    id: string;
    group: string;
    label: string;
    detail: string;
    param?: OptionParam;
}

export interface AdvancedContext {
    /** True when the value looks secret: only options that do not copy the value are offered. */
    secret: boolean;
    /** Response time in ms, used for the default of the response-time option. */
    timeMs?: number;
    status?: number;
}

export function kindOf(value: unknown): ValueKind {
    if (value === null) {
        return 'null';
    }
    if (Array.isArray(value)) {
        return 'array';
    }
    switch (typeof value) {
        case 'number': return 'number';
        case 'boolean': return 'boolean';
        case 'string': return 'string';
        default: return 'object';
    }
}

/**
 * A regular expression that matches the shape of the text: letter runs, digit runs, spaces, and escaped punctuation.
 * With `tolerant`, every run of letters or digits becomes `[A-Za-z0-9]+`, for generated values such as ids and tokens
 * whose letters and digits change from one response to the next.
 */
export function patternFor(text: string, tolerant = false): string {
    let out = '';
    for (const token of text.matchAll(/([A-Za-z0-9]+)|(\s+)|([\s\S])/g)) {
        if (token[1]) {
            const run = token[1];
            out += tolerant ? '[A-Za-z0-9]+' : /^\d+$/.test(run) ? '\\d+' : /^[A-Za-z]+$/.test(run) ? '[A-Za-z]+' : '[A-Za-z0-9]+';
        } else if (token[2]) {
            out += '\\s+';
        } else {
            out += token[3].replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
        }
    }
    return out;
}

function round(value: number): number {
    return Math.round(value * 1e6) / 1e6;
}

function parseNumber(text: string, label: string): number {
    const value = Number(text.trim());
    if (text.trim() === '' || !Number.isFinite(value)) {
        throw new Error(`${label} must be a number.`);
    }
    return value;
}

function parseInteger(text: string, label: string): number {
    const value = parseNumber(text, label);
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${label} must be a whole number of 0 or more.`);
    }
    return value;
}

function parsePair(text: string, label: string): [number, number] {
    const parts = text.split(',');
    if (parts.length !== 2) {
        throw new Error(`${label} must be two numbers separated by a comma.`);
    }
    return [parseNumber(parts[0], label), parseNumber(parts[1], label)];
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function parseJsonArray(text: string, label: string): unknown[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`${label} must be a JSON array, for example ["a","b"].`);
    }
    if (!Array.isArray(parsed)) {
        throw new Error(`${label} must be a JSON array, for example ["a","b"].`);
    }
    return parsed;
}

/** A Karate fuzzy-marker string, quoted for a step. */
function marker(text: string): string {
    return quoteString(text);
}

function jsString(text: string): string {
    return JSON.stringify(text);
}

/** JSON for a match: one line when short, a docstring otherwise (Karate's form for multi-line JSON in a step). */
function jsonMatch(prefix: string, value: unknown): string {
    const compact = JSON.stringify(value);
    if (compact.length <= 100) {
        return `${prefix} ${compact}`;
    }
    return `${prefix}\n"""\n${JSON.stringify(value, null, 2)}\n"""`;
}

/** The exact value with secrets and changing fields (ids, dates, tokens) replaced by the "#ignore" marker. */
export function exactWithIgnores(value: unknown, key?: PathSegment, depth = 0): unknown {
    if (depth > 12) {
        return '#ignore';
    }
    if (isSecretValue(value) || (typeof key === 'string' && isSecretKey(key)) || (typeof value !== 'object' && suggestMode(key, value) === 'type')) {
        return '#ignore';
    }
    if (Array.isArray(value)) {
        return value.map(item => exactWithIgnores(item, undefined, depth + 1));
    }
    if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
            out[name] = exactWithIgnores(child, name, depth + 1);
        }
        return out;
    }
    return value;
}

const ANY = 'Any value';
const TEXT = 'Text';
const NUMBER = 'Number';
const ARRAY = 'Array';
const OBJECT = 'Object';
const RESPONSE = 'Response';

/** The options that fit this value. `parentIsArray` adds "the array contains this value". */
export function advancedOptions(path: PathSegment[], value: unknown, context: AdvancedContext, parentIsArray = false): AdvancedOption[] {
    const kind = kindOf(value);
    // Ids, dates and tokens change on every response, so options that copy the value would break on the next run.
    const volatile = (kind === 'string' || kind === 'number') && suggestMode(path[path.length - 1], value) === 'type';
    const options: AdvancedOption[] = [];
    const add = (group: string, id: string, label: string, detail: string, param?: OptionParam): void => {
        options.push({ id, group, label, detail, param });
    };

    add(ANY, 'present', 'Is present', "match == '#present' (the field exists, even if null)");
    if (kind !== 'null') {
        add(ANY, 'notNull', 'Is not null', "match == '#notnull'");
        add(ANY, 'optional', 'Optional, with this type', `match == '##${typeMarker(value).slice(1)}' (absent or ${kind})`);
    }

    if (!context.secret) {
        if (kind === 'boolean' || kind === 'number' || (kind === 'string' && !volatile)) {
            const other = volatile ? (kind === 'number' ? '0' : '') : kind === 'string' ? `${String(value)}-other` : kind === 'number' ? String((value as number) + 1) : String(!(value as boolean));
            add(ANY, 'notEqual', 'Is not equal to...', 'match !=', { prompt: 'The value it must not equal', value: other });
        }
        if (kind === 'null') {
            add(ANY, 'isNull', 'Is null', 'match == null');
        }
    }

    if (kind === 'string') {
        add(TEXT, 'notEmpty', 'Is not empty', "match == '#string? _.length > 0'");
        if (!context.secret && volatile) {
            add(TEXT, 'regex', 'Matches a regular expression...', "match == '#regex ...' (the whole text must match)", { prompt: 'Regular expression', value: patternFor(value as string, true) });
        } else if (!context.secret) {
            const text = value as string;
            add(TEXT, 'contains', 'Contains text...', 'match contains', { prompt: 'Text it must contain', value: text.slice(0, 30) });
            add(TEXT, 'startsWith', 'Starts with...', 'a fuzzy expression using startsWith', { prompt: 'Text it must start with', value: text.slice(0, Math.min(3, text.length)) });
            add(TEXT, 'endsWith', 'Ends with...', 'a fuzzy expression using endsWith', { prompt: 'Text it must end with', value: text.slice(Math.max(0, text.length - 3)) });
            add(TEXT, 'regex', 'Matches a regular expression...', "match == '#regex ...' (the whole text must match)", { prompt: 'Regular expression', value: patternFor(text) });
            add(TEXT, 'length', 'Has length...', 'a fuzzy expression on _.length', { prompt: 'Exact length', value: String(text.length) });
            add(TEXT, 'lengthBetween', 'Has length between...', 'a fuzzy expression on _.length', { prompt: 'Minimum,maximum length', value: `${Math.max(0, text.length - 1)},${text.length + 1}` });
            add(TEXT, 'ignoreCase', 'Equals, ignoring case...', 'compares in lower case', { prompt: 'Text it must equal, any case', value: text });
            add(TEXT, 'oneOf', 'Is one of...', 'a fuzzy expression with indexOf', { prompt: 'Allowed values, separated by commas', value: text });
        }
    } else if (kind === 'number' && !context.secret) {
        const n = value as number;
        add(NUMBER, 'positive', 'Is positive', "match == '#number? _ > 0'");
        add(NUMBER, 'nonNegative', 'Is zero or more', "match == '#number? _ >= 0'");
        if (Number.isInteger(n)) {
            add(NUMBER, 'integer', 'Is a whole number', "match == '#number? _ % 1 == 0'");
        }
        if (volatile) {
            add(NUMBER, 'greaterThan', 'Is greater than...', 'a fuzzy number expression', { prompt: 'Greater than', value: '0' });
        } else {
            add(NUMBER, 'greaterThan', 'Is greater than...', 'a fuzzy number expression', { prompt: 'Greater than', value: String(round(n - 1)) });
            add(NUMBER, 'atLeast', 'Is at least...', 'a fuzzy number expression', { prompt: 'At least', value: String(n) });
            add(NUMBER, 'lessThan', 'Is less than...', 'a fuzzy number expression', { prompt: 'Less than', value: String(round(n + 1)) });
            add(NUMBER, 'atMost', 'Is at most...', 'a fuzzy number expression', { prompt: 'At most', value: String(n) });
            add(NUMBER, 'between', 'Is between...', 'a fuzzy number expression', { prompt: 'Minimum,maximum', value: `${Math.floor(n - Math.abs(n) * 0.5 - 1)},${Math.ceil(n + Math.abs(n) * 0.5 + 1)}` });
            add(NUMBER, 'closeTo', 'Is close to...', 'within a tolerance', { prompt: 'Target,tolerance', value: `${n},${Number.isInteger(n) ? 0 : 0.01}` });
        }
    } else if (kind === 'array') {
        const items = value as unknown[];
        add(ARRAY, 'nonEmpty', 'Is not empty', "match == '#[_ > 0]'");
        if (!context.secret) {
            add(ARRAY, 'size', 'Has exactly N items...', "match == '#[N]'", { prompt: 'Number of items', value: String(items.length) });
            add(ARRAY, 'minSize', 'Has at least N items...', "match == '#[_ >= N]'", { prompt: 'Minimum number of items', value: String(items.length) });
            add(ARRAY, 'maxSize', 'Has at most N items...', "match == '#[_ <= N]'", { prompt: 'Maximum number of items', value: String(items.length) });
            const primitive = items.length > 0 && items.every(item => item !== null && typeof item !== 'object' && typeof item === typeof items[0]);
            if (primitive) {
                add(ARRAY, 'eachType', `Every item is a ${typeof items[0]}`, 'match each');
            }
            add(ARRAY, 'contains', 'Contains this item...', 'match contains', { prompt: 'An item it must contain (JSON or text)', value: items.length ? JSON.stringify(items[0]) : '""' });
            add(ARRAY, 'containsOnly', 'Contains only these items, in any order...', 'match contains only', { prompt: 'JSON array', value: JSON.stringify(exactWithIgnores(items)) });
            add(ARRAY, 'containsAny', 'Contains at least one of...', 'match contains any', { prompt: 'JSON array', value: JSON.stringify(items.slice(0, 2)) });
            add(ARRAY, 'notContains', 'Does not contain...', 'match !contains', { prompt: 'An item it must not contain (JSON or text)', value: '"not-in-the-list"' });
        }
    } else if (kind === 'object') {
        const keys = Object.keys(value as Record<string, unknown>);
        if (keys.length) {
            add(OBJECT, 'notEmptyObject', 'Is not empty', 'match != {}');
            add(OBJECT, 'hasKeys', 'Has these fields (any values)', "match contains { key: '#present', ... }");
            add(OBJECT, 'onlyKeys', 'Has exactly these fields', 'match karate.keysOf(...) contains only [...]');
            if (!context.secret) {
                add(OBJECT, 'exact', 'Equals this, ignoring changing fields', "match == { ... } with '#ignore' for ids, dates and secrets");
            }
        }
    }

    if (parentIsArray && !context.secret && kind !== 'null') {
        add(ARRAY, 'parentContains', 'The array contains this value', 'match <array> contains <value>');
    }
    if (path.length === 0) {
        add(RESPONSE, 'responseTime', 'Responds within...', 'assert responseTime <', { prompt: 'Maximum response time in ms', value: String(Math.max(100, Math.ceil(((context.timeMs ?? 100) * 4) / 100) * 100)) });
        add(RESPONSE, 'statusClass', 'Status is in a class...', 'assert on responseStatus', { prompt: 'Status class (1 to 5, for example 2 for 2xx)', value: String(Math.floor((context.status ?? 200) / 100)) });
    }
    return options;
}

/** The step text (without keyword) for an option. Throws an Error with a readable message when a parameter is invalid. */
export function advancedStep(id: string, path: PathSegment[], value: unknown, param = '', context: AdvancedContext = { secret: false }): string {
    const target = jsPath('response', path);
    const guarded = (needsValue: boolean): void => {
        if (needsValue && context.secret) {
            throw new Error('This value looks like a secret, so options that copy it are not available.');
        }
    };
    switch (id) {
        case 'present': return `match ${target} == '#present'`;
        case 'notNull': return `match ${target} == '#notnull'`;
        case 'optional': return `match ${target} == '##${typeMarker(value).slice(1)}'`;
        case 'isNull': return `match ${target} == null`;
        case 'notEqual': {
            guarded(true);
            const expected: unknown = kindOf(value) === 'number' ? parseNumber(param, 'The value') : kindOf(value) === 'boolean' ? param.trim() === 'true' : param;
            return `match ${target} != ${literal(expected)}`;
        }
        case 'notEmpty': return `match ${target} == '#string? _.length > 0'`;
        case 'contains': guarded(true); return `match ${target} contains ${quoteString(param)}`;
        case 'startsWith': guarded(true); return `match ${target} == ${marker(`#? _.startsWith(${jsString(param)})`)}`;
        case 'endsWith': guarded(true); return `match ${target} == ${marker(`#? _.endsWith(${jsString(param)})`)}`;
        case 'regex': {
            guarded(true);
            try {
                new RegExp(param);
            } catch {
                throw new Error('That is not a valid regular expression.');
            }
            return `match ${target} == ${marker(`#regex ${param}`)}`;
        }
        case 'length': guarded(true); return `match ${target} == ${marker(`#? _.length == ${parseInteger(param, 'The length')}`)}`;
        case 'lengthBetween': {
            guarded(true);
            const [low, high] = parsePair(param, 'The range');
            return `match ${target} == ${marker(`#? _.length >= ${low} && _.length <= ${high}`)}`;
        }
        case 'ignoreCase': guarded(true); return `match ${target} == ${marker(`#? _.toLowerCase() == ${jsString(param.toLowerCase())}`)}`;
        case 'oneOf': {
            guarded(true);
            const allowed = param.split(',').map(item => item.trim()).filter(item => item.length > 0);
            if (!allowed.length) {
                throw new Error('List at least one allowed value.');
            }
            return `match ${target} == ${marker(`#? ${JSON.stringify(allowed)}.indexOf(_) >= 0`)}`;
        }
        case 'positive': return `match ${target} == '#number? _ > 0'`;
        case 'nonNegative': return `match ${target} == '#number? _ >= 0'`;
        case 'integer': return `match ${target} == '#number? _ % 1 == 0'`;
        case 'greaterThan': return `match ${target} == '#number? _ > ${parseNumber(param, 'The limit')}'`;
        case 'atLeast': return `match ${target} == '#number? _ >= ${parseNumber(param, 'The limit')}'`;
        case 'lessThan': return `match ${target} == '#number? _ < ${parseNumber(param, 'The limit')}'`;
        case 'atMost': return `match ${target} == '#number? _ <= ${parseNumber(param, 'The limit')}'`;
        case 'between': {
            const [low, high] = parsePair(param, 'The range');
            return `match ${target} == '#number? _ >= ${low} && _ <= ${high}'`;
        }
        case 'closeTo': {
            const [expected, tolerance] = parsePair(param, 'The target and tolerance');
            if (tolerance < 0) {
                throw new Error('The tolerance cannot be negative.');
            }
            return `match ${target} == '#number? Math.abs(_ - ${expected}) <= ${tolerance}'`;
        }
        case 'nonEmpty': return `match ${target} == '#[_ > 0]'`;
        case 'size': return `match ${target} == '#[${parseInteger(param, 'The size')}]'`;
        case 'minSize': return `match ${target} == '#[_ >= ${parseInteger(param, 'The size')}]'`;
        case 'maxSize': return `match ${target} == '#[_ <= ${parseInteger(param, 'The size')}]'`;
        case 'eachType': {
            const first = (value as unknown[])[0];
            return `match each ${target} == '${typeMarker(first)}'`;
        }
        case 'containsOnly': return `match ${target} contains only ${JSON.stringify(parseJsonArray(param, 'The items'))}`;
        case 'containsAny': return `match ${target} contains any ${JSON.stringify(parseJsonArray(param, 'The items'))}`;
        case 'notContains': return `match ${target} !contains ${literal(parseJson(param))}`;
        case 'parentContains': {
            guarded(true);
            return `match ${jsPath('response', path.slice(0, -1))} contains ${literal(value)}`;
        }
        case 'notEmptyObject': return `match ${target} != {}`;
        case 'hasKeys': {
            const keys = Object.keys(value as Record<string, unknown>).slice(0, 50);
            return jsonMatch(`match ${target} contains`, Object.fromEntries(keys.map(key => [key, '#present'])));
        }
        case 'onlyKeys': return `match karate.keysOf(${target}) contains only ${JSON.stringify(Object.keys(value as Record<string, unknown>))}`;
        case 'exact': guarded(true); return jsonMatch(`match ${target} ==`, exactWithIgnores(value, path[path.length - 1]));
        case 'responseTime': return `assert responseTime < ${parseInteger(param, 'The time')}`;
        case 'statusClass': {
            const cls = parseInteger(param, 'The class');
            if (cls < 1 || cls > 5) {
                throw new Error('The status class must be 1 to 5.');
            }
            return `assert responseStatus >= ${cls * 100} && responseStatus < ${cls * 100 + 100}`;
        }
        default: throw new Error(`Unknown assertion option: ${id}`);
    }
}

/** "contains" is both a text option and an array option; arrays take JSON. */
export function advancedStepFor(id: string, path: PathSegment[], value: unknown, param: string, context: AdvancedContext): string {
    if (id === 'contains' && Array.isArray(value)) {
        const target = jsPath('response', path);
        return `match ${target} contains ${literal(parseJson(param))}`;
    }
    return advancedStep(id, path, value, param, context);
}

export type HeaderOption = 'headerEquals' | 'headerContains' | 'headerPresent';

/** `match header Name ...` steps for a response header. The value is the first value of the header. */
export function headerStep(option: HeaderOption, name: string, value: string): string {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
        throw new Error('That header name cannot be written as a Karate step.');
    }
    if (option === 'headerPresent') {
        return `match responseHeaders contains { '${name}': '#present' }`;
    }
    if (option === 'headerContains') {
        return `match header ${name} contains ${quoteString(value.split(';')[0].trim())}`;
    }
    return `match header ${name} == ${quoteString(value)}`;
}
