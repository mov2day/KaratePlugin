/** Pure scenario matching/editing for spec-diff merges. No vscode, no fs. */

export interface ScenarioRange {
    /** First line of the scenario including its leading tag/comment lines. */
    startLine: number;
    /** Line of the `Scenario:` header. */
    headerLine: number;
    /** Last non-blank line belonging to the scenario. */
    endLine: number;
    matchedBy: 'source' | 'name';
}

const HEADER = /^\s*Scenario(?: Outline)?:/;
const SOURCE = /^\s*#\s*source:\s*([A-Za-z]+)\s+(\S+)/;
const LEADING = (l: string): boolean => /^\s*[@#]/.test(l);
const normPath = (p: string): string => p.replace(/\{[^}]*\}/g, '{}').replace(/\/+$/, '');

/** Start of the block that owns the header at `h`: contiguous tag/comment lines directly above it. */
function blockStart(lines: string[], h: number): number {
    let s = h;
    while (s > 0 && LEADING(lines[s - 1])) {s--;}
    return s;
}

export function findScenarioRanges(lines: string[], method: string, path: string): ScenarioRange[] {
    const headers: number[] = [];
    lines.forEach((l, i) => { if (HEADER.test(l)) {headers.push(i);} });
    const wanted = normPath(path);
    const nameRe = new RegExp(`Scenario(?: Outline)?:.*${method}.*${path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]*\}/g, '.*')}`, 'i');
    const ranges: ScenarioRange[] = [];
    headers.forEach((h, idx) => {
        const next = idx + 1 < headers.length ? blockStart(lines, headers[idx + 1]) : lines.length;
        let end = next - 1;
        while (end > h && lines[end].trim() === '') {end--;}
        let matchedBy: 'source' | 'name' | undefined;
        for (let i = h + 1; i <= end; i++) {
            const m = SOURCE.exec(lines[i]);
            if (m && m[1].toUpperCase() === method.toUpperCase() && normPath(m[2]) === wanted) {matchedBy = 'source'; break;}
        }
        if (!matchedBy && nameRe.test(lines[h])) {matchedBy = 'name';}
        if (matchedBy) {ranges.push({ startLine: blockStart(lines, h), headerLine: h, endLine: end, matchedBy });}
    });
    return ranges;
}

/** Replace every scenario for the operation with `snippet`; append when none match. */
export function replaceScenarios(content: string, method: string, path: string, snippet: string): { content: string; replaced: number } {
    const lines = content.split('\n');
    const ranges = findScenarioRanges(lines, method, path);
    if (ranges.length === 0) {return { content: `${content}\n\n${snippet}`, replaced: 0 };}
    for (let r = ranges.length - 1; r >= 1; r--) {
        const { startLine, endLine } = ranges[r];
        const drop = endLine - startLine + 1 + (lines[endLine + 1]?.trim() === '' && endLine + 1 < lines.length ? 1 : 0);
        lines.splice(startLine, drop);
    }
    lines.splice(ranges[0].startLine, ranges[0].endLine - ranges[0].startLine + 1, snippet);
    return { content: lines.join('\n'), replaced: ranges.length };
}

/** Insert a DEPRECATED comment under each matching scenario header (once). */
export function markScenariosDeprecated(content: string, method: string, path: string, stamp: string): { content: string; marked: number } {
    const lines = content.split('\n');
    const ranges = findScenarioRanges(lines, method, path);
    let marked = 0;
    for (let r = ranges.length - 1; r >= 0; r--) {
        const h = ranges[r].headerLine;
        if (/DEPRECATED:/.test(lines[h + 1] ?? '')) {continue;}
        lines.splice(h + 1, 0, `    # DEPRECATED: Endpoint removed from spec on ${stamp}`);
        marked++;
    }
    return { content: lines.join('\n'), marked };
}
