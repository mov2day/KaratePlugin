import { FUZZY_MARKERS, MATCH_OPERATORS, STEP_KEYWORDS } from '../karateCompletionContext';
import {
    BUILTIN_TAGS, BUILTIN_VARIABLES, CONFIGURE_KEYS, CONTENT_TYPES, DEFAULT_STATUS, HEADER_NAMES, HTTP_METHODS, KARATE_API, STATUS_CODES
} from './karateKnowledge';
import { Learned, keywordFor, predictCandidates, stripKeyword } from './predictor';
import { currentScenarioSteps, parseFeature, requestState, responseKeys, variablesIn } from './scenarioModel';
import { SmartContext } from './smartContext';

/** The built-in suggestion engine: turns a context plus what it knows about the file into ranked items. Pure, no vscode import. */

export type SmartItemKind = 'keyword' | 'snippet' | 'operator' | 'marker' | 'variable' | 'function' | 'property' | 'value' | 'tag';

export interface SmartItem {
    label: string;
    kind: SmartItemKind;
    detail?: string;
    insertText?: string;
    snippet?: boolean;
    sortText?: string;
    /** How many typed characters before the cursor the insertion replaces (for dotted member access). */
    replaceTyped?: number;
}

/** Facts gathered outside the open file (other features, karate-config.js). */
export interface WorkspaceFacts {
    configVariables: string[];
    paths: string[];
    tags: string[];
    /** Step patterns learned from the project's other features. */
    learned?: Learned;
}

export const EMPTY_FACTS: WorkspaceFacts = { configVariables: [], paths: [], tags: [] };

const LIKELY_NEXT: Record<string, string[]> = {
    url: ['path', 'header', 'param'],
    path: ['param', 'header', 'request', 'method'],
    param: ['param', 'header', 'request', 'method'],
    header: ['header', 'request', 'method'],
    headers: ['request', 'method'],
    request: ['method', 'header'],
    method: ['status', 'match', 'def'],
    status: ['match', 'def', 'print'],
    match: ['match', 'def', 'call'],
    def: ['def', 'url', 'path', 'match', 'call'],
    configure: ['url', 'def']
};

function rank(index: number): string {
    return String(index).padStart(3, '0');
}

function keywordItems(lines: string[], line: number, facts: WorkspaceFacts): SmartItem[] {
    const model = parseFeature(lines, line);
    const steps = currentScenarioSteps(model);
    const state = requestState(steps);
    const order = state.last ? (LIKELY_NEXT[state.last.kind] ?? []) : ['url', 'def', 'configure', 'call'];
    const items: SmartItem[] = [];
    predictCandidates(lines, line, facts.learned).slice(0, 3).forEach((prediction, i) => {
        items.push({ label: prediction.text, kind: 'snippet', detail: `Suggested next step: ${prediction.reason}`, insertText: prediction.text, sortText: `00${i}` });
    });
    for (const keyword of STEP_KEYWORDS) {
        const position = order.indexOf(keyword.label);
        items.push({ label: keyword.label, kind: 'keyword', detail: keyword.detail, sortText: position >= 0 ? `1${rank(position)}` : `5${keyword.label}` });
    }
    const snippets: Array<[string, string, string]> = [
        ['match response ==', 'match response == ${1}', 'Assert the whole response'],
        ['def (variable)', 'def ${1:name} = ${2}', 'Define a variable'],
        ["call read('')", "call read('${1}')", 'Call another feature'],
        ['configure headers', 'configure headers = ${1}', 'Set default headers']
    ];
    for (const [label, body, detail] of snippets) { items.push({ label, kind: 'snippet', detail, insertText: body, snippet: true, sortText: `6${label}` }); }
    return items;
}

function variableItems(lines: string[], line: number, facts: WorkspaceFacts): SmartItem[] {
    const vars = variablesIn(currentScenarioSteps(parseFeature(lines, line)));
    const items: SmartItem[] = [];
    let index = 0;
    for (const v of [...vars.values()].reverse()) {
        items.push({ label: v.name, kind: 'variable', detail: `${v.shape}${v.keys.length ? ` {${v.keys.slice(0, 4).join(', ')}${v.keys.length > 4 ? ', …' : ''}}` : ''}`, sortText: `0${rank(index++)}` });
    }
    for (const name of facts.configVariables) {
        if (!vars.has(name)) { items.push({ label: name, kind: 'variable', detail: 'from karate-config.js', sortText: `1${rank(index++)}` }); }
    }
    for (const column of outlineColumns(lines, line)) { items.push({ label: `<${column}>`, kind: 'variable', detail: 'Examples column', sortText: `0${rank(index++)}` }); }
    for (const name of BUILTIN_VARIABLES) { items.push({ label: name, kind: 'variable', detail: 'built-in', sortText: `2${name}` }); }
    return items;
}

/** Column names of the Examples table that belongs to the scenario outline around `line`. */
function outlineColumns(lines: string[], line: number): string[] {
    let outline = -1;
    for (let i = Math.min(line, lines.length - 1); i >= 0; i--) {
        if (/^\s*Scenario\s+(?:Outline|Template)\s*:/.test(lines[i])) { outline = i; break; }
        if (/^\s*Scenario\s*:/.test(lines[i])) { return []; }
    }
    if (outline < 0) { return []; }
    for (let i = line; i < Math.min(lines.length, line + 200); i++) {
        if (/^\s*Scenario\b/.test(lines[i]) && i > outline) { return []; }
        if (/^\s*Examples\s*:/.test(lines[i])) {
            for (let j = i + 1; j < lines.length; j++) {
                if (lines[j].trim().startsWith('|')) { return lines[j].split('|').map(cell => cell.trim()).filter(Boolean); }
                if (lines[j].trim() !== '' && !lines[j].trim().startsWith('@')) { break; }
            }
        }
    }
    return [];
}

function memberItems(object: string, lines: string[], line: number): SmartItem[] {
    const vars = variablesIn(currentScenarioSteps(parseFeature(lines, line)));
    const known = vars.get(object);
    const keys = object === 'response' || known?.shape === 'response' ? responseKeys(lines) : known?.keys ?? [];
    const items: SmartItem[] = keys.map((key, i) => ({ label: key, kind: 'property' as const, detail: 'seen in this file', sortText: rank(i) }));
    if (known?.shape === 'array' || known?.shape === 'string') { items.push({ label: 'length', kind: 'property', detail: 'size', sortText: '900' }); }
    return items;
}

function methodItems(lines: string[], line: number): SmartItem[] {
    const state = requestState(currentScenarioSteps(parseFeature(lines, line)));
    const preferred = state.hasRequest ? ['post', 'put', 'patch'] : ['get', 'post'];
    return HTTP_METHODS.map(method => {
        const position = preferred.indexOf(method);
        return { label: method, kind: 'value' as const, detail: method.toUpperCase(), sortText: position >= 0 ? `0${rank(position)}` : `5${method}` };
    });
}

function statusItems(lines: string[], line: number): SmartItem[] {
    const state = requestState(currentScenarioSteps(parseFeature(lines, line)));
    const likely = DEFAULT_STATUS[state.method ?? 'get'];
    return STATUS_CODES.map(({ code, detail }) => ({
        label: String(code), kind: 'value' as const, detail, sortText: code === likely ? '000' : `5${code}`
    }));
}

function headerValueItems(header: string, lines: string[], line: number): SmartItem[] {
    const lower = header.toLowerCase();
    if (lower === 'content-type' || lower === 'accept') {
        return CONTENT_TYPES.map((type, i) => ({ label: `'${type}'`, kind: 'value' as const, sortText: rank(i) }));
    }
    if (lower === 'authorization') {
        const vars = [...variablesIn(currentScenarioSteps(parseFeature(lines, line))).keys()];
        const token = vars.find(name => /token|jwt|bearer/i.test(name));
        return [{ label: token ? `'Bearer ' + ${token}` : "'Bearer '", kind: 'value', detail: 'bearer token', sortText: '000' }];
    }
    return [];
}

function uniqueSorted(values: string[]): string[] {
    return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function smartItems(context: SmartContext, lines: string[], line: number, facts: WorkspaceFacts = EMPTY_FACTS): SmartItem[] {
    switch (context.kind) {
        case 'keyword': return keywordItems(lines, line, facts);
        case 'operator': return MATCH_OPERATORS.map((op, i) => ({ label: op, kind: 'operator' as const, detail: 'match operator', sortText: rank(i) }));
        case 'marker': return FUZZY_MARKERS.map(marker => ({ label: marker, kind: 'marker' as const, detail: 'fuzzy matcher' }));
        case 'karate-member':
            return KARATE_API.map(member => {
                const isFunction = member.signature.includes('(');
                return {
                    label: member.name, kind: isFunction ? 'function' as const : 'property' as const, detail: member.signature,
                    insertText: isFunction ? `${member.name}($1)` : member.name, snippet: isFunction, replaceTyped: context.typed.length
                };
            });
        case 'member': return memberItems(context.object, lines, line).map(item => ({ ...item, replaceTyped: context.typed.length }));
        case 'method': return methodItems(lines, line);
        case 'status': return statusItems(lines, line);
        case 'header-name': return HEADER_NAMES.map((name, i) => ({ label: name, kind: 'value' as const, insertText: `${name} = `, sortText: rank(i) }));
        case 'header-value': return headerValueItems(context.header, lines, line);
        case 'configure-key': return CONFIGURE_KEYS.map((entry, i) => ({ label: entry.key, kind: 'property' as const, detail: entry.detail, insertText: `${entry.key} = `, sortText: rank(i) }));
        case 'url-path': {
            const own = lines.flatMap(l => [...l.matchAll(/^\s*(?:\*|Given|When|Then|And|But)\s+path\s+['"]([^'"]+)['"]/g)].map(m => m[1]));
            return uniqueSorted([...own, ...facts.paths]).map(path => ({ label: path, kind: 'value' as const, detail: 'used in this project', replaceTyped: context.typed.length }));
        }
        case 'tag': return [
            ...BUILTIN_TAGS.map(t => ({ label: t.tag.slice(1), kind: 'tag' as const, detail: t.detail, sortText: `1${t.tag}` })),
            ...uniqueSorted(facts.tags.filter(tag => !BUILTIN_TAGS.some(b => b.tag === `@${tag}`))).map(tag => ({ label: tag, kind: 'tag' as const, detail: 'used in this project', sortText: `0${tag}` }))
        ];
        case 'expression': return variableItems(lines, line, facts);
        default: return [];
    }
}

/** Ghost text for the end of the line at `character`, or undefined. Insert it directly after the cursor. */
export function inlineSuggestion(lines: string[], line: number, character: number, facts: WorkspaceFacts = EMPTY_FACTS): string | undefined {
    const current = lines[line] ?? '';
    if (current.slice(character).trim() !== '' || current.length !== character) { return undefined; }
    const prefix = current.slice(0, character);
    if (/^\s*#/.test(prefix) || /^\s*(?:Feature|Background|Scenario|Examples|Rule)\b/.test(prefix)) { return undefined; }
    const candidates = predictCandidates(lines, line, facts.learned);
    if (!candidates.length) { return undefined; }
    const model = parseFeature(lines, line);
    const steps = currentScenarioSteps(model).filter(step => !step.background);
    const previous = steps[steps.length - 1];

    const keywordOnly = /^\s*(?:\*|Given|When|Then|And|But)\s*$/.exec(prefix);
    if (keywordOnly) { return `${/\s$/.test(prefix) ? '' : ' '}${candidates[0].text}`; }
    const partial = /^\s*(?:\*|Given|When|Then|And|But)\s+(\S.*)$/.exec(prefix);
    if (partial) {
        const typed = partial[1];
        const match = candidates.find(c => c.text.startsWith(typed) && c.text.length > typed.length);
        return match ? match.text.slice(typed.length) : undefined;
    }
    if (prefix.trim() === '' && prefix.length > 0) {
        // Only right after a step, not after a section header or a blank gap.
        if (line === 0 || lines[line - 1].trim() === '' || /^\s*(?:Feature|Background|Scenario|Examples|Rule)\b/.test(lines[line - 1])) { return undefined; }
        const full = parseFeature(lines);
        return `${keywordFor(candidates[0].text, previous, full)} ${candidates[0].text}`;
    }
    return undefined;
}

export { stripKeyword };
