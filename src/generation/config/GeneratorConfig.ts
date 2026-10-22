import type { KarateStyle } from '../../types';

export type TagCategory = 'positive' | 'negative' | 'edge' | 'boundary' | 'security' | 'exploratory';
export type ScenarioCategory = 'positive' | 'negative' | 'edge' | 'boundary' | 'security';

export interface GeneratorConfig {
    karateVersion: '2';
    layout: { outputRoot: string; strategy: 'domain' | 'flat' | 'method'; classpathRoot: string };
    config: { mode: 'standard' | 'env-json'; urlVariable: string; envs: string[] };
    style: KarateStyle;
    tags: { auto: boolean; taxonomy: Record<TagCategory, string> };
    scenarios: { categories: ScenarioCategory[]; exploratory: boolean; crud: boolean; outlineThreshold: number };
    data: { smart: boolean; externalize: boolean };
    ai: { refine: boolean; maxRetries: 1; chunk: 'feature' | 'scenario' };
    gate: { dryRun: 'auto' | 'off'; failOn: 'error' | 'never' };
}

export const DEFAULT_GENERATOR_CONFIG: GeneratorConfig = {
    karateVersion: '2',
    layout: { outputRoot: 'src/test/karate', strategy: 'domain', classpathRoot: 'src/test/java' },
    config: { mode: 'standard', urlVariable: 'baseUrl', envs: ['dev', 'staging'] },
    style: { indentation: '  ', variableCase: 'camelCase', commentStyle: 'hash', lineSpacing: 1 },
    tags: {
        auto: true,
        taxonomy: {
            positive: '@positive',
            negative: '@negative',
            edge: '@edge',
            boundary: '@boundary',
            security: '@security',
            exploratory: '@exploratory'
        }
    },
    scenarios: {
        categories: ['positive', 'negative', 'edge', 'boundary', 'security'],
        exploratory: false,
        crud: true,
        outlineThreshold: 3
    },
    data: { smart: true, externalize: true },
    ai: { refine: true, maxRetries: 1, chunk: 'feature' },
    gate: { dryRun: 'auto', failOn: 'error' }
};

type Plain = Record<string, unknown>;

const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const ENUMS: Record<string, readonly string[]> = {
    'layout.strategy': ['domain', 'flat', 'method'],
    'config.mode': ['standard', 'env-json'],
    'style.variableCase': ['camelCase', 'snake_case'],
    'style.commentStyle': ['hash', 'doubleSlash'],
    'ai.chunk': ['feature', 'scenario'],
    'gate.dryRun': ['auto', 'off'],
    'gate.failOn': ['error', 'never']
};
const ARRAY_ENUMS: Record<string, readonly string[]> = {
    'scenarios.categories': ['positive', 'negative', 'edge', 'boundary', 'security']
};
const LEGACY_STYLE_KEYS = ['indentation', 'variableCase', 'commentStyle', 'lineSpacing'];

function typeOk(def: unknown, value: unknown): boolean {
    if (Array.isArray(def)) {return Array.isArray(value);}
    return typeof def === typeof value;
}

/** Validate `layer` against the shape of `schema` (defaults). Returns a sanitized copy; problems become warnings. */
function sanitize(layer: Plain, schema: Plain, path: string, origin: string, warnings: string[]): Plain {
    const out: Plain = {};
    for (const [key, value] of Object.entries(layer)) {
        const keyPath = path ? `${path}.${key}` : key;
        if (!Object.prototype.hasOwnProperty.call(schema, key)) {
            warnings.push(`${origin}: unknown config key "${keyPath}" ignored`);
            continue;
        }
        const def = schema[key];
        if (isPlain(def)) {
            if (!isPlain(value)) {
                warnings.push(`${origin}: "${keyPath}" must be an object; using default`);
                continue;
            }
            out[key] = sanitize(value, def, keyPath, origin, warnings);
            continue;
        }
        if (!typeOk(def, value)) {
            warnings.push(`${origin}: "${keyPath}" has the wrong type; using default`);
            continue;
        }
        if (ENUMS[keyPath] && !ENUMS[keyPath].includes(value as string)) {
            warnings.push(`${origin}: invalid value ${JSON.stringify(value)} for "${keyPath}"; using default "${String(def)}"`);
            continue;
        }
        if (ARRAY_ENUMS[keyPath]) {
            const bad = (value as unknown[]).filter(v => !ARRAY_ENUMS[keyPath].includes(v as string));
            if (bad.length) {
                warnings.push(`${origin}: invalid value(s) ${JSON.stringify(bad)} for "${keyPath}"; using default`);
                continue;
            }
        }
        if (key === 'karateVersion' && value !== '2') {
            warnings.push(`${origin}: "karateVersion" must be '2'; using default`);
            continue;
        }
        if (key === 'maxRetries' && value !== 1) {
            warnings.push(`${origin}: "${keyPath}" must be 1; using default`);
            continue;
        }
        out[key] = value;
    }
    return out;
}

function merge(base: Plain, over: Plain): Plain {
    const out: Plain = { ...base };
    for (const [key, value] of Object.entries(over)) {
        out[key] = isPlain(value) && isPlain(out[key]) ? merge(out[key] as Plain, value) : Array.isArray(value) ? [...value] : value;
    }
    return out;
}

/** Accept the legacy `sharedStylePath` shape (style fields at the top level) alongside the new schema. */
function normalizeFile(file: unknown): Plain {
    if (!isPlain(file)) {return {};}
    const legacy: Plain = {};
    const rest: Plain = {};
    for (const [k, v] of Object.entries(file)) {
        if (LEGACY_STYLE_KEYS.includes(k)) {legacy[k] = v;}
        else {Object.defineProperty(rest, k, { value: v, enumerable: true, writable: true, configurable: true });}
    }
    if (Object.keys(legacy).length === 0) {return rest;}
    const style = isPlain(rest.style) ? { ...legacy, ...rest.style } : legacy;
    return { ...rest, style };
}

/** Pure resolver. Precedence: file > settings > defaults. Never throws; problems are reported as warnings. */
export function resolveGeneratorConfig(file: unknown, settings: Partial<GeneratorConfig>): { config: GeneratorConfig; warnings: string[] } {
    const warnings: string[] = [];
    const schema = DEFAULT_GENERATOR_CONFIG as unknown as Plain;
    const settingsLayer = sanitize(isPlain(settings) ? (settings as Plain) : {}, schema, '', 'settings', warnings);
    const fileLayer = sanitize(normalizeFile(file), schema, '', 'config file', warnings);
    const merged = merge(merge(clone(schema), settingsLayer), fileLayer);
    return { config: merged as unknown as GeneratorConfig, warnings };
}
