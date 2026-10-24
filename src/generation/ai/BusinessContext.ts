/** Pure builder of the compact business context the opt-in `enrich-business` AI task reads as evidence. No vscode, no I/O. */
import { containsCredentialValue, isSecretKey } from '../adapters/secrets';
import type { GenerationModel, JsonSchema, OperationModel } from '../model/TestModel';

/** Hard cap for the whole context; later operations are dropped and counted. */
export const BUSINESS_CONTEXT_MAX_CHARS = 6000;
const OMITTED_RESERVE = 40;
const MAX_TEXT = 240;
const MAX_ENUM_VALUES = 12;
const MAX_EXAMPLE = 200;
const MAX_FIELDS = 8;
const STATE_FIELD = /^(status|state|stage|phase|type|kind|role|visibility|lifecycle)$/i;

const clip = (text: string, max: number): string => {
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length > max ? `${one.slice(0, max - 3)}...` : one;
};

interface EnumField { path: string; values: string[] }

/** Enum-valued properties of a schema (depth 3, sorted by path). */
function enumsOf(schema: JsonSchema | undefined, prefix = '', depth = 0, out: EnumField[] = []): EnumField[] {
    if (!schema || typeof schema !== 'object' || depth > 3) {return out;}
    if (Array.isArray(schema.enum) && prefix) {
        out.push({ path: prefix, values: schema.enum.slice(0, MAX_ENUM_VALUES).map(v => String(v)) });
    }
    for (const key of Object.keys(schema.properties ?? {}).sort()) {
        enumsOf(schema.properties[key], prefix ? `${prefix}.${key}` : key, depth + 1, out);
    }
    if (schema.items) {enumsOf(schema.items, prefix ? `${prefix}[]` : '[]', depth + 1, out);}
    return out;
}

/** Compact JSON of an example with credential-looking keys and values removed. */
function exampleText(value: unknown): string | undefined {
    const scrub = (v: unknown, depth: number): unknown => {
        if (depth > 3) {return '...';}
        if (Array.isArray(v)) {return v.slice(0, 2).map(x => scrub(x, depth + 1));}
        if (v && typeof v === 'object') {
            return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, MAX_FIELDS).map(([k, x]) => [k, isSecretKey(k) ? '[REDACTED]' : scrub(x, depth + 1)]));
        }
        return typeof v === 'string' && containsCredentialValue(v) ? '[REDACTED]' : v;
    };
    if (value === undefined || value === null) {return undefined;}
    return clip(JSON.stringify(scrub(value, 0)) ?? '', MAX_EXAMPLE);
}

const resourceOf = (path: string): string => path.split('/').filter(s => s && !s.startsWith('{'))[0] ?? '';

/** Resources a path or a `...Id` field points to, among the resources the model really has. */
function links(op: OperationModel, resources: Set<string>): string[] {
    const found = new Set<string>();
    const segments = op.path.split('/').filter(s => s && !s.startsWith('{'));
    for (const s of segments.slice(1)) {if (resources.has(s)) {found.add(s);}}
    const fields = new Set<string>();
    const collect = (schema: JsonSchema | undefined, depth: number): void => {
        if (!schema || typeof schema !== 'object' || depth > 2) {return;}
        for (const [k, v] of Object.entries(schema.properties ?? {})) {fields.add(k); collect(v as JsonSchema, depth + 1);}
        if (schema.items) {collect(schema.items, depth + 1);}
    };
    collect(op.body?.schema, 0);
    for (const r of op.responses) {collect(r.schema, 0);}
    for (const f of [...fields].sort()) {
        const m = /^(.+?)_?[iI]d$/.exec(f);
        if (!m) {continue;}
        const stem = m[1].toLowerCase();
        for (const r of resources) {
            if (r.toLowerCase() === stem || r.toLowerCase() === `${stem}s` || r.toLowerCase() === `${stem}es`) {found.add(`${f} -> /${r}`);}
        }
    }
    return [...found].sort();
}

function describe(op: OperationModel, resources: Set<string>): string {
    const lines: string[] = [`${op.method.toUpperCase()} ${op.path}${op.tags.length ? ` [${op.tags.join(', ')}]` : ''}`];
    const text = [op.summary, op.description].filter((t): t is string => Boolean(t && t.trim())).map(t => clip(t, MAX_TEXT));
    if (text.length) {lines.push(`  about: ${[...new Set(text)].join(' | ')}`);}
    const declared = op.responses.map(r => `${r.status}${r.description ? ` ${clip(r.description, 100)}` : ''}`);
    if (declared.length) {lines.push(`  responses: ${declared.join('; ')}`);}
    const enums: EnumField[] = [
        ...op.pathParams, ...op.queryParams, ...op.headerParams
    ].flatMap(p => (Array.isArray(p.schema?.enum) ? [{ path: `param ${p.name}`, values: p.schema.enum.slice(0, MAX_ENUM_VALUES).map((v: unknown) => String(v)) }] : []));
    enums.push(...enumsOf(op.body?.schema).map(e => ({ ...e, path: `request ${e.path}` })));
    for (const r of op.responses.filter(x => /^2/.test(String(x.status)))) {enums.push(...enumsOf(r.schema).map(e => ({ ...e, path: `response ${e.path}` })));}
    const seen = new Set<string>();
    for (const e of enums) {
        const key = `${e.path}=${e.values.join('|')}`;
        if (seen.has(key)) {continue;}
        seen.add(key);
        const leaf = e.path.split(/[ .]/).pop() ?? '';
        lines.push(`  ${STATE_FIELD.test(leaf.replace(/\[\]$/, '')) ? 'state field' : 'enum'} ${e.path}: ${e.values.join(', ')}`);
    }
    const bodyExample = exampleText(op.body?.example);
    if (bodyExample) {lines.push(`  request example: ${bodyExample}`);}
    for (const r of op.responses) {
        const ex = exampleText(r.example);
        if (ex && /^2/.test(String(r.status))) {lines.push(`  response ${r.status} example: ${ex}`);}
    }
    const related = links(op, resources);
    if (related.length) {lines.push(`  links: ${related.join(', ')}`);}
    return lines.join('\n');
}

/**
 * One evidence item describing what the API says about its own business rules: descriptions, enums, examples,
 * state fields, declared error meanings and links between resources. Deterministic (operations sorted by path then
 * method) and capped at `maxChars`; operations that do not fit are replaced by a count. Returns `[]` when the model
 * has no operations.
 */
export function buildBusinessContext(model: GenerationModel, maxChars: number = BUSINESS_CONTEXT_MAX_CHARS): { label: string; text: string }[] {
    const ops = [...model.operations].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    if (!ops.length) {return [];}
    const resources = new Set(ops.map(o => resourceOf(o.path)).filter(Boolean));
    const blocks = ops.map(op => describe(op, resources));
    const header = `Business context for ${clip(model.name, 80)} (descriptions, enums, examples, declared errors, links). Only these facts are justified.`;
    const parts: string[] = [header];
    let used = header.length;
    let kept = 0;
    for (let n = 0; n < blocks.length; n++) {
        // keep a prefix of the sorted operations; leave room for the omitted-count line unless this is the last one
        const need = used + blocks[n].length + 1 + (n === blocks.length - 1 ? 0 : OMITTED_RESERVE);
        if (need > maxChars) {break;}
        parts.push(blocks[n]);
        used += blocks[n].length + 1;
        kept++;
    }
    if (kept < blocks.length) {parts.push(`(${blocks.length - kept} more operation(s) omitted)`);}
    return [{ label: 'business-context', text: parts.join('\n').slice(0, maxChars) }];
}
