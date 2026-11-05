/** Folding ranges for Karate features. Pure, no vscode import. Lines are zero-based; `end` is the last line that folds away. */

export interface FoldRange { start: number; end: number; kind: 'section' | 'docstring' }

const HEADER = /^\s*(Feature|Rule|Background|Scenario Outline|Scenario Template|Scenario|Examples)\s*:/;
const LEVEL: Record<string, number> = { Feature: 0, Rule: 1, Background: 2, Scenario: 2, 'Scenario Outline': 2, 'Scenario Template': 2, Examples: 3 };

export function foldingRanges(lines: string[]): FoldRange[] {
    const ranges: FoldRange[] = [];
    const headers: Array<{ line: number; level: number }> = [];
    let docStart = -1;
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*"""/.test(lines[i])) {
            if (docStart < 0) { docStart = i; } else { if (i > docStart) { ranges.push({ start: docStart, end: i, kind: 'docstring' }); } docStart = -1; }
            continue;
        }
        if (docStart >= 0) { continue; }
        const match = HEADER.exec(lines[i]);
        if (match) { headers.push({ line: i, level: LEVEL[match[1]] }); }
    }
    for (let h = 0; h < headers.length; h++) {
        const { line, level } = headers[h];
        const next = headers.slice(h + 1).find(candidate => candidate.level <= level);
        let end = (next ? next.line : lines.length) - 1;
        // Tags and comments that sit directly above the next header belong to it, and blank lines are not worth folding.
        while (end > line && (lines[end].trim() === '' || /^\s*@/.test(lines[end]) || /^\s*#/.test(lines[end]))) { end--; }
        if (end > line) { ranges.push({ start: line, end, kind: 'section' }); }
    }
    return ranges;
}
