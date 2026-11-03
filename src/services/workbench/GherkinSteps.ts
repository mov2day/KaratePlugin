/** Lightweight step locator for Karate feature text. Works on the live editor text, not the saved file. No vscode dependency. */

export interface FeatureStep {
    /** Zero-based first line. */
    line: number;
    /** Zero-based last line (docstrings and tables included). */
    endLine: number;
    keyword: string;
    /** Normalized text sent to Karate, including any docstring or table. */
    text: string;
    indent: string;
}

export interface FeatureScenario {
    name: string;
    line: number;
    endLine: number;
    outline: boolean;
    steps: FeatureStep[];
}

export interface ParsedFeature {
    background: FeatureStep[];
    scenarios: FeatureScenario[];
}

const STEP = /^(Given|When|Then|And|But|\*)\s+(\S.*)$/;
const SCENARIO = /^(Scenario Outline|Scenario Template|Scenario|Example)\s*:\s*(.*)$/;
const BACKGROUND = /^Background\s*:/;
const EXAMPLES = /^(Examples|Scenarios)\s*:/;

export function normalizeStepText(text: string): string {
    return text.replace(/^\s+/, '').replace(/[ \t]+$/gm, '');
}

export function parseFeature(text: string): ParsedFeature {
    const lines = text.split(/\r?\n/);
    const parsed: ParsedFeature = { background: [], scenarios: [] };
    let target: FeatureStep[] | undefined;
    let current: FeatureStep | undefined;
    let scenario: FeatureScenario | undefined;
    let docstring: string | undefined;
    let inExamples = false;

    const finish = (step: FeatureStep | undefined, endLine: number): void => {
        if (step) {
            step.endLine = endLine;
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (docstring !== undefined) {
            if (current) {
                current.text += '\n' + raw;
                current.endLine = i;
            }
            if (trimmed.startsWith(docstring)) {
                docstring = undefined;
            }
            continue;
        }
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }
        if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
            if (current && !inExamples) {
                docstring = trimmed.slice(0, 3);
                current.text += '\n' + raw;
                current.endLine = i;
                if (trimmed.length > 3 && trimmed.slice(3).includes(docstring)) {
                    docstring = undefined;
                }
            }
            continue;
        }
        if (trimmed.startsWith('|')) {
            if (current && !inExamples) {
                current.text += '\n' + raw;
                current.endLine = i;
            }
            continue;
        }
        if (trimmed.startsWith('@')) {
            finish(current, current ? current.endLine : i);
            current = undefined;
            continue;
        }
        const scenarioMatch = SCENARIO.exec(trimmed);
        if (scenarioMatch) {
            current = undefined;
            inExamples = false;
            scenario = {
                name: scenarioMatch[2].trim(),
                line: i,
                endLine: i,
                outline: /Outline|Template/.test(scenarioMatch[1]),
                steps: []
            };
            parsed.scenarios.push(scenario);
            target = scenario.steps;
            continue;
        }
        if (BACKGROUND.test(trimmed)) {
            current = undefined;
            inExamples = false;
            scenario = undefined;
            target = parsed.background;
            continue;
        }
        if (EXAMPLES.test(trimmed)) {
            current = undefined;
            inExamples = true;
            continue;
        }
        const stepMatch = STEP.exec(trimmed);
        if (stepMatch && target && !inExamples) {
            current = {
                line: i,
                endLine: i,
                keyword: stepMatch[1],
                text: trimmed,
                indent: raw.slice(0, raw.length - raw.trimStart().length)
            };
            target.push(current);
            if (scenario) {
                scenario.endLine = i;
            }
            continue;
        }
        if (/^Feature\s*:/.test(trimmed)) {
            current = undefined;
        }
    }
    for (const step of [...parsed.background, ...parsed.scenarios.flatMap(item => item.steps)]) {
        step.text = normalizeStepText(step.text);
    }
    for (const item of parsed.scenarios) {
        const last = item.steps[item.steps.length - 1];
        if (last) {
            item.endLine = last.endLine;
        }
    }
    return parsed;
}

/** The scenario containing the line, or the closest one above it. */
export function scenarioAtLine(parsed: ParsedFeature, line: number): FeatureScenario | undefined {
    let found: FeatureScenario | undefined;
    for (const item of parsed.scenarios) {
        if (item.line <= line) {
            found = item;
        }
    }
    return found ?? parsed.scenarios[0];
}

/** The scenario step containing the line (multi-line steps included). */
export function stepAtLine(scenario: FeatureScenario, line: number): { step: FeatureStep; index: number } | undefined {
    const index = scenario.steps.findIndex(step => line >= step.line && line <= step.endLine);
    return index >= 0 ? { step: scenario.steps[index], index } : undefined;
}

export interface RunPlan {
    /** True when the session state cannot be reused and must start over. */
    restart: boolean;
    toRun: string[];
}

/**
 * Decides which step texts to send. "to" runs everything up to and including the target, reusing the
 * session when the steps it already ran are an unchanged prefix. "this" runs only the target step.
 */
export function planRun(background: string[], steps: string[], targetIndex: number, mode: 'to' | 'this', executed: string[]): RunPlan {
    if (mode === 'this') {
        return { restart: false, toRun: [steps[targetIndex]] };
    }
    const desired = [...background, ...steps.slice(0, targetIndex + 1)];
    const reusable = executed.length < desired.length && executed.every((text, index) => text === desired[index]);
    return reusable ? { restart: false, toRun: desired.slice(executed.length) } : { restart: true, toRun: desired };
}

const METHOD = /^(?:\*|Given|When|Then|And|But)\s+method\s+(\w+)/i;
const ASSERTION = /^(?:\*|Given|When|Then|And|But)\s+(?:status|match|assert)\b/i;
const SAFE_VERBS = new Set(['get', 'head', 'options']);

export function methodVerb(stepText: string): string | undefined {
    return METHOD.exec(stepText.trim())?.[1].toLowerCase();
}

export function isMutatingVerb(verb: string | undefined): boolean {
    return verb !== undefined && !SAFE_VERBS.has(verb);
}

export interface InsertionPoint {
    /** Insert after this zero-based line. */
    afterLine: number;
    indent: string;
    hasAssertions: boolean;
}

/** Where new assertion lines for the response of the method step at `methodIndex` belong. */
export function insertionPoint(steps: FeatureStep[], methodIndex: number): InsertionPoint {
    const method = steps[methodIndex];
    let last = method;
    let hasAssertions = false;
    for (let i = methodIndex + 1; i < steps.length && ASSERTION.test(steps[i].text); i++) {
        last = steps[i];
        hasAssertions = true;
    }
    return { afterLine: last.endLine, indent: method.indent, hasAssertions };
}

/**
 * The index of the last step that has run in the session, for run-to-here sessions. New lines go right after it so the
 * file order always matches the order the steps ran, which lets the next run reuse the session instead of restarting
 * (a restart would send the request again). A single-step session has no such guarantee, so it falls back to the method step.
 */
export function frontierIndex(executedCount: number, backgroundCount: number, methodIndex: number, stepCount: number, singleStep: boolean): number {
    if (singleStep) {
        return methodIndex;
    }
    return Math.min(stepCount - 1, Math.max(methodIndex, executedCount - backgroundCount - 1));
}

/** Insertion point after the step at `frontier`, indented like the method step. */
export function insertionPointAt(steps: FeatureStep[], methodIndex: number, frontier: number): InsertionPoint {
    return { afterLine: steps[frontier].endLine, indent: steps[methodIndex].indent, hasAssertions: frontier > methodIndex };
}

/** The steps that apply to the response of the method step at `methodIndex`: everything after it up to the next method step. */
export function responseScope(steps: FeatureStep[], methodIndex: number): FeatureStep[] {
    const scope: FeatureStep[] = [];
    for (let i = methodIndex + 1; i < steps.length && methodVerb(steps[i].text) === undefined; i++) {
        scope.push(steps[i]);
    }
    return scope;
}

/** Quoted path segments used so far, to name variables ("path 'users'" gives "users"). */
export function pathHints(stepTexts: string[]): string[] {
    const hints: string[] = [];
    for (const text of stepTexts) {
        const match = /^(?:\*|Given|When|Then|And|But)\s+path\s+(.+)$/i.exec(text.split('\n')[0].trim());
        if (!match) {
            continue;
        }
        for (const part of match[1].matchAll(/'([^']+)'|"([^"]+)"/g)) {
            const segment = part[1] ?? part[2];
            if (/[A-Za-z]/.test(segment)) {
                hints.push(segment);
            }
        }
    }
    return hints;
}
