import { DEFAULT_STATUS } from './karateKnowledge';
import { FeatureModel, RequestState, StepInfo, VarInfo, currentScenarioSteps, parseFeature, requestState, variablesIn } from './scenarioModel';

/** Predicts the next Karate step without any model: workflow rules plus patterns learned from the same file. */

export interface Prediction {
    /** Step text without its keyword, e.g. `status 200`. */
    text: string;
    source: 'learned' | 'rule';
    reason: string;
}

/** A coarse key for "what the previous step was", so repeated patterns in a file transfer to new places. */
export function transitionKey(step: StepInfo): string {
    if (step.kind === 'method') { return `method:${/^method\s+(\w+)/i.exec(step.text)?.[1]?.toLowerCase() ?? ''}`; }
    return step.kind;
}

export function stripKeyword(text: string): string {
    return text.replace(/^(?:\*|Given|When|Then|And|But)\s+/, '');
}

/** key -> next step text -> count, over consecutive steps in the same scenario. `skipLine` excludes the step being typed. */
export function learnTransitions(model: FeatureModel, skipLine = -1): Map<string, Map<string, number>> {
    const learned = new Map<string, Map<string, number>>();
    const bounds = [...model.scenarioStarts, model.steps.length];
    const ranges: Array<[number, number]> = [];
    for (let i = 0; i < model.scenarioStarts.length; i++) { ranges.push([model.scenarioStarts[i], bounds[i + 1]]); }
    for (const [from, to] of ranges) {
        const steps = model.steps.slice(from, to).filter(step => !step.background);
        for (let i = 0; i + 1 < steps.length; i++) {
            if (steps[i + 1].line === skipLine) { continue; }
            const key = transitionKey(steps[i]);
            const next = steps[i + 1].text;
            const counts = learned.get(key) ?? new Map<string, number>();
            counts.set(next, (counts.get(next) ?? 0) + 1);
            learned.set(key, counts);
        }
    }
    return learned;
}

function alreadyInScenario(steps: StepInfo[], text: string): boolean {
    return steps.some(step => step.text === text);
}

function ruleBased(steps: StepInfo[], state: RequestState, vars: Map<string, VarInfo>): Prediction | undefined {
    const last = state.last;
    if (!last) {
        const base = vars.has('baseUrl') ? 'baseUrl' : undefined;
        return base ? { text: `url ${base}`, source: 'rule', reason: 'baseUrl is defined and no url is set' } : undefined;
    }
    if (!state.hasUrl && ['def', 'configure'].includes(last.kind) && vars.has('baseUrl')) {
        return { text: 'url baseUrl', source: 'rule', reason: 'baseUrl is defined and no url is set' };
    }
    switch (last.kind) {
        case 'url':
            return { text: "path '/'", source: 'rule', reason: 'a url is usually followed by a path' };
        case 'path':
        case 'param':
        case 'params':
        case 'header':
        case 'headers': {
            if (state.hasRequest || state.method) { break; }
            const body = [...vars.values()].reverse().find(v => v.shape === 'object' && !/^(config|user|credentials)$/.test(v.name));
            if (!state.hasRequest && body && last.kind === 'path') { return { text: `request ${body.name}`, source: 'rule', reason: `${body.name} is an object that can be the body` }; }
            return { text: `method ${state.hasRequest ? 'post' : 'get'}`, source: 'rule', reason: 'the request is ready to send' };
        }
        case 'request':
            return { text: 'method post', source: 'rule', reason: 'a request body is set' };
        case 'method': {
            const verb = state.method ?? 'get';
            return { text: `status ${DEFAULT_STATUS[verb] ?? 200}`, source: 'rule', reason: `the usual status for ${verb.toUpperCase()}` };
        }
        case 'status': {
            const verb = state.method ?? 'get';
            const listLike = verb === 'get' && state.paths.length > 0 && !/,|\+|\$\{|#\(/.test(state.paths[state.paths.length - 1]);
            if (verb === 'delete' || verb === 'head') { return undefined; }
            return { text: listLike ? "match response == '#array'" : "match response == '#object'", source: 'rule', reason: 'assert the response shape after the status' };
        }
        default:
            return undefined;
    }
    return undefined;
}

export function predictNextStep(lines: string[], cursorLine: number): Prediction | undefined {
    const stopped = parseFeature(lines, cursorLine);
    const steps = currentScenarioSteps(stopped);
    const state = requestState(steps);
    const vars = variablesIn(steps);
    const last = state.last;

    // 1. Repeat what this file already does after the same kind of step.
    if (last) {
        const full = parseFeature(lines);
        const counts = learnTransitions(full, -1).get(transitionKey(last));
        if (counts) {
            const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
            const [text, count] = ranked[0];
            if (count >= 2 && !alreadyInScenario(steps, text)) { return { text, source: 'learned', reason: `used ${count} times after this kind of step in this file` }; }
        }
    }
    // 2. Workflow rules.
    const rule = ruleBased(steps, state, vars);
    if (rule && !alreadyInScenario(steps, rule.text)) { return rule; }
    return undefined;
}

/** Picks a keyword that matches the file's style. */
export function keywordFor(text: string, previous: StepInfo | undefined): string {
    if (!previous || previous.keyword === '*') { return '*'; }
    const kind = text.split(/\s+/)[0];
    if (kind === 'method') { return 'When'; }
    if (kind === 'status' || kind === 'match') { return previous.kind === 'status' || previous.kind === 'match' ? 'And' : 'Then'; }
    return previous.keyword === 'Given' || previous.keyword === 'And' ? 'And' : 'Given';
}
