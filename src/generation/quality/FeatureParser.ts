export interface Tag { name: string; line: number }
export interface Step { line: number; keyword: string; text: string }
export interface Comment { line: number; text: string }
export interface ParsedScenario {
    name: string;
    tags: Tag[];
    startLine: number;
    endLine: number;
    steps: Step[];
    comments: Comment[];
    isOutline: boolean;
    /** True when the scenario or the Feature carries @ignore. */
    ignored: boolean;
}
export interface ParsedBackground { startLine: number; steps: Step[]; comments: Comment[] }
export interface ParsedFeature {
    lines: string[];
    tags: Tag[];
    featureLine?: number;
    scenarios: ParsedScenario[];
    background?: ParsedBackground;
    /** Steps that appear outside any Background/Scenario. */
    orphanSteps: Step[];
}

const STEP_RE = /^(Given|When|Then|And|But|\*)\s+(.*)$/;
const SCENARIO_RE = /^(Scenario Outline|Scenario Template|Scenario|Example)\s*:\s*(.*)$/;

function parseTags(trimmed: string, line: number): Tag[] {
    const tags: Tag[] = [];
    for (const token of trimmed.split(/\s+/)) {
        if (token.startsWith('#')) break;
        if (token.startsWith('@') && token.length > 1) tags.push({ name: token, line });
    }
    return tags;
}

/** Line-based, CRLF-tolerant Gherkin/Karate structure parser. */
export function parseFeature(text: string): ParsedFeature {
    const lines = text.split(/\r?\n/);
    const parsed: ParsedFeature = { lines, tags: [], scenarios: [], orphanSteps: [] };
    let pendingTags: Tag[] = [];
    let pendingComments: Comment[] = [];
    let current: ParsedScenario | undefined;
    let inBackground = false;
    let inDocString = false;

    const block = (): { steps: Step[]; comments: Comment[] } | undefined =>
        current ?? (inBackground ? parsed.background : undefined);

    for (let i = 0; i < lines.length; i++) {
        const lineNo = i + 1;
        const trimmed = lines[i].trim();
        if (inDocString) {
            if (trimmed.startsWith('"""')) inDocString = false;
            if (current) current.endLine = lineNo;
            continue;
        }
        if (trimmed === '') continue;
        if (trimmed.startsWith('"""')) {
            inDocString = true;
            if (current) current.endLine = lineNo;
            continue;
        }
        if (trimmed.startsWith('#')) {
            pendingComments.push({ line: lineNo, text: trimmed });
            continue;
        }
        if (trimmed.startsWith('@')) {
            pendingTags.push(...parseTags(trimmed, lineNo));
            continue;
        }
        if (/^Feature\s*:/.test(trimmed)) {
            parsed.tags = pendingTags;
            parsed.featureLine = lineNo;
            pendingTags = [];
            pendingComments = [];
            continue;
        }
        if (/^Background\s*:/.test(trimmed)) {
            current = undefined;
            inBackground = true;
            parsed.background = { startLine: lineNo, steps: [], comments: pendingComments };
            pendingTags = [];
            pendingComments = [];
            continue;
        }
        const sc = SCENARIO_RE.exec(trimmed);
        if (sc) {
            inBackground = false;
            const featureIgnored = parsed.tags.some(t => t.name === '@ignore');
            current = {
                name: sc[2].trim(),
                tags: pendingTags,
                startLine: lineNo,
                endLine: lineNo,
                steps: [],
                comments: pendingComments,
                isOutline: sc[1] !== 'Scenario' && sc[1] !== 'Example',
                ignored: featureIgnored || pendingTags.some(t => t.name === '@ignore')
            };
            parsed.scenarios.push(current);
            pendingTags = [];
            pendingComments = [];
            continue;
        }
        if (/^Examples\s*:/.test(trimmed)) {
            pendingTags = []; // tags above Examples belong to the table, not the next scenario
            pendingComments = [];
            if (current) current.endLine = lineNo;
            continue;
        }
        const st = STEP_RE.exec(trimmed);
        if (st) {
            const step: Step = { line: lineNo, keyword: st[1], text: st[2].trim() };
            const target = block();
            if (target) {
                target.comments.push(...pendingComments);
                target.steps.push(step);
                if (current) current.endLine = lineNo;
            } else {
                parsed.orphanSteps.push(step);
            }
            pendingComments = [];
            continue;
        }
        // table rows, multi-line JSON continuation, etc.
        if (current) current.endLine = lineNo;
    }
    return parsed;
}
