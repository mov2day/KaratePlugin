import * as path from 'path';
import { containsCredentialValue, isSecretKey, isSecretName } from '../generation/adapters/secrets';

type PatternType = 'auth' | 'setup' | 'headers' | 'data' | 'cleanup';

/**
 * Result of the reusability analysis.
 */
export interface ReusabilityResult {
    commonFiles: Array<{
        path: string;             // "common/auth.feature"
        content: string;          // full feature file content
        type: PatternType | 'custom';
        callType: 'call' | 'callonce';
    }>;
    modifiedContent: string;      // feature content with the extracted Background blocks replaced by callonce
    /** Background steps that looked extractable but were left in place, with the reason. */
    skipped: Array<{ reason: string; lines: string }>;
}

interface ExtractionPattern {
    type: PatternType;
    /** Regex patterns that identify this pattern in step text */
    detect: RegExp[];
    title: string;
    scenario: string;
    /** Target file name under common/ */
    file: string;
}

/** Configuration belongs in karate-config; these lines are never moved. */
const URL_LINE = /baseUrl|urlVariable|^\s*(\*|Given|And)\s+(url|configure\s+url)\b/i;
const DEFINES = /^\s*(?:\*|Given|And)\s+(?:def|text|table|copy|json|string|xml|csv|yaml)\s+([A-Za-z_$][\w$]*)/;
const REF_COMMON = /read\(\s*['"](?:classpath:)?(?:\.\/)?common\/([^'"]+)['"]/g;
const QUOTED = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;

/**
 * Reusability engine for the user-initiated "extract reusable steps" action on HAND-WRITTEN features.
 * It is NOT run on generated output (the planner emits the shared-helper calls itself).
 *
 * Conservative by design: only whole contiguous blocks of Background steps that match a known pattern are
 * moved, verbatim, into an `@ignore` helper under common/. Scenario steps, url/baseUrl configuration, blocks
 * with literal credentials and steps depending on a variable that stays behind are left alone and reported.
 * Nothing is invented: no literal values, and no stub files for missing helpers (that is gate rule V2-REF-001).
 */
export class ReusabilityEngine {

    private static readonly PATTERNS: ExtractionPattern[] = [
        {
            type: 'auth', title: 'Authentication Helper', scenario: 'Get Auth Token', file: 'auth.feature',
            detect: [
                /^\s*\*\s*(def|text)\s+.*token/i,
                /^\s*\*\s*header\s+Authorization/i,
                /^\s*\*\s*call\s+.*auth/i,
                /^\s*Given\s+.*\/oauth\/token/i,
                /^\s*Given\s+.*\/auth\/login/i,
                /^\s*\*\s*def\s+auth(Token|Response|Header)/i,
            ],
        },
        {
            type: 'setup', title: 'Base Setup', scenario: 'Configure Settings', file: 'setup.feature',
            detect: [/^\s*\*\s*configure\s+(connectTimeout|readTimeout|ssl|retry)/i],
        },
        {
            type: 'headers', title: 'Shared Headers', scenario: 'Set Common Headers', file: 'headers.feature',
            detect: [
                /^\s*\*\s*header\s+Content-Type/i,
                /^\s*\*\s*header\s+Accept/i,
                /^\s*\*\s*headers\s+\{/i,
                /^\s*\*\s*def\s+headers\s*=/i,
            ],
        },
        {
            type: 'data', title: 'Test Data Setup', scenario: 'Create Test Data', file: 'testdata.feature',
            detect: [
                /^\s*\*\s*def\s+testData\s*=/i,
                /^\s*\*\s*def\s+payload\s*=/i,
                /^\s*\*\s*def\s+requestBody\s*=/i,
                /^\s*\*\s*table\s+/i,
            ],
        },
        {
            type: 'cleanup', title: 'Cleanup Helper', scenario: 'Cleanup Test Data', file: 'cleanup.feature',
            detect: [
                /^\s*\*\s*(Given|When)\s+.*delete/i,
                /^\s*\*\s*call\s+.*cleanup/i,
                /^\s*\*\s*def\s+cleanup/i,
            ],
        },
    ];

    /**
     * Extract whole contiguous Background blocks of known patterns into shared helper features.
     */
    static extract(featureContent: string): ReusabilityResult {
        const result: ReusabilityResult = { commonFiles: [], modifiedContent: featureContent, skipped: [] };
        const lines = featureContent.split('\n');
        const bg = lines.findIndex(l => /^\s*Background:/.test(l));
        if (bg < 0) { return result; }
        let end = bg + 1;
        while (end < lines.length && !/^\s*(@|Scenario( Outline)?:|Examples:|Rule:)/.test(lines[end])) { end++; }

        const existing = new Set<string>();
        for (const l of lines.slice(bg + 1, end)) {
            let m: RegExpExecArray | null;
            const re = new RegExp(REF_COMMON.source, 'g');
            while ((m = re.exec(l)) !== null) { existing.add(m[1]); }
        }

        const entries = this.classify(lines, bg + 1, end);
        const stayDefined = new Set<string>();
        const used = new Set<string>();
        const replacements: Array<{ from: number; to: number; text: string }> = [];

        // Group consecutive entries of the same pattern type into whole blocks.
        let i = 0;
        while (i < entries.length) {
            const e = entries[i];
            if (e.kind !== 'step' || !e.type) {
                if (e.kind === 'step' && e.url) {
                    result.skipped.push({ reason: 'URL configuration belongs in karate-config, not a shared helper', lines: e.text.trim() });
                }
                this.noteDefs(e, stayDefined);
                i++;
                continue;
            }
            let j = i;
            while (j + 1 < entries.length && entries[j + 1].kind === 'step' && entries[j + 1].type === e.type && !entries[j + 1].url) { j++; }
            const block = entries.slice(i, j + 1);
            const pattern = this.PATTERNS.find(p => p.type === e.type)!;
            const text = block.map(b => b.text.trim()).join('\n');
            const reason = this.blockRejection(block, pattern, stayDefined, existing, used);
            if (reason) {
                result.skipped.push({ reason, lines: text });
                block.forEach(b => this.noteDefs(b, stayDefined));
            } else {
                used.add(pattern.file);
                const indent = (block[0].text.match(/^\s*/) || [''])[0];
                replacements.push({ from: block[0].index, to: block[block.length - 1].index, text: `${indent}* callonce read('classpath:common/${pattern.file}')` });
                result.commonFiles.push({
                    path: `common/${pattern.file}`,
                    content: ['@ignore', `Feature: ${pattern.title}`, '', `Scenario: ${pattern.scenario}`, ...block.map(b => `  ${b.text.trim()}`), ''].join('\n'),
                    type: pattern.type,
                    callType: 'callonce',
                });
            }
            i = j + 1;
        }

        if (replacements.length > 0) {
            const out: string[] = [];
            let cursor = 0;
            for (const r of replacements) {
                out.push(...lines.slice(cursor, r.from), r.text);
                cursor = r.to + 1;
            }
            out.push(...lines.slice(cursor));
            result.modifiedContent = out.join('\n');
        }
        return result;
    }

    private static blockRejection(
        block: Entry[], pattern: ExtractionPattern, stayDefined: Set<string>, existing: Set<string>, used: Set<string>
    ): string | undefined {
        if (existing.has(pattern.file)) { return `The Background already references common/${pattern.file}`; }
        if (used.has(pattern.file)) { return `Another ${pattern.type} block was already extracted into common/${pattern.file}`; }
        for (const b of block) {
            if (!b.simple) { return 'Multi-line step; only single-line steps are moved'; }
            if (this.hasLiteralCredential(b.text)) { return 'Contains a literal credential; move it to karate-config or an environment variable first'; }
        }
        for (const b of block) {
            const dep = this.identifiers(b.text).find(id => stayDefined.has(id));
            if (dep) { return `Uses '${dep}', defined by an earlier step that stays in the feature`; }
        }
        return undefined;
    }

    private static hasLiteralCredential(step: string): boolean {
        if (containsCredentialValue(step)) { return true; }
        const lit = /^['"][^'"]+['"]$/;
        const def = /^\s*(?:\*|Given|And)\s+(?:def|text)\s+(\S+)\s*=\s*(.+?)\s*$/.exec(step);
        if (def && isSecretName(def[1]) && lit.test(def[2])) { return true; }
        const header = /^\s*(?:\*|Given|And)\s+header\s+(\S+)\s*=\s*(.+?)\s*$/.exec(step);
        return !!header && (isSecretKey(header[1]) || isSecretName(header[1])) && lit.test(header[2]);
    }

    private static identifiers(step: string): string[] {
        const body = step.replace(QUOTED, "''").replace(/^\s*(\*|Given|When|Then|And|But)\s+(def|text|table|copy|json|string|xml|csv|yaml)\s+[A-Za-z_$][\w$]*/, '');
        return body.match(/[A-Za-z_$][\w$]*/g) || [];
    }

    private static noteDefs(e: Entry, defined: Set<string>): void {
        const m = DEFINES.exec(e.text);
        if (m) { defined.add(m[1]); }
    }

    /** Label each Background line: step (with pattern type / url flag / single-line flag) or barrier. */
    private static classify(lines: string[], from: number, to: number): Entry[] {
        const out: Entry[] = [];
        let depth = 0;
        let inDoc = false;
        for (let k = from; k < to; k++) {
            const text = lines[k];
            const t = text.trim();
            if (t.includes('"""')) {
                const toggles = (t.match(/"""/g) || []).length;
                if (toggles % 2 === 1) { inDoc = !inDoc; }
                out.push({ kind: 'other', index: k, text, simple: false });
                continue;
            }
            const isStep = /^(\*|Given|When|Then|And|But)\s/.test(t);
            const before = depth;
            if (!inDoc && t && !t.startsWith('#')) {
                const bare = t.replace(QUOTED, '');
                depth += (bare.match(/[{[(]/g) || []).length - (bare.match(/[}\])]/g) || []).length;
            }
            if (inDoc || !isStep || before !== 0 || depth !== 0) {
                out.push({ kind: 'other', index: k, text, simple: false });
                continue;
            }
            const url = URL_LINE.test(t);
            const type = url ? undefined : this.PATTERNS.find(p => p.detect.some(r => r.test(text)))?.type;
            out.push({ kind: 'step', index: k, text, simple: true, type, url });
        }
        return out;
    }

    /**
     * Build the common/ directory path relative to a given output path.
     */
    static getCommonDir(outputPath: string): string {
        return path.join(path.dirname(outputPath), 'common');
    }
}

interface Entry {
    kind: 'step' | 'other';
    index: number;
    text: string;
    simple: boolean;
    type?: PatternType;
    url?: boolean;
}
