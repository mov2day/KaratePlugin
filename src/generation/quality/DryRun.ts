/**
 * Optional Karate v2 dry-run parse check (pure; no vscode). Runs `<cli> run -D -o <outDir> <files>` through an
 * injected `exec` and maps parse errors to `V2-PARSE-001` findings. Environmental problems never fail generation:
 * they yield `skipped`.
 *
 * LIMITATION: the real Karate v2 console output format could not be verified (no v2 CLI was available when this
 * was written). `parseDryRunOutput` is therefore liberal about locations (`<path>.feature:<line>`, `at <path>.feature:<line>`,
 * `line <n>`) and conservative otherwise (a line must also look like an error). The exit code is authoritative.
 */
import type { Finding } from './rules';

export interface DryRunOptions {
    cli: { command: string; args: string[] } | undefined;
    root: string;
    files: string[];
    outDir: string;
    exec: (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ code: number; out: string }>;
    timeoutMs?: number;
}

export interface DryRunOutcome {
    status: 'passed' | 'failed' | 'skipped';
    message: string;
    findings: Finding[];
    /** Capped (2,000 chars) raw CLI output, present when the CLI ran. */
    output?: string;
}

export interface ParsedDryRunError {
    file?: string;
    line: number;
    message: string;
}

export const NO_CLI_MESSAGE = 'Karate v2 CLI not found; static quality gate only';
const OUTPUT_CAP = 2000;
const MESSAGE_CAP = 200;

export function capOutput(out: string): string {
    return out.length > OUTPUT_CAP ? out.slice(0, OUTPUT_CAP) : out;
}

// Only strong error words count; generic words such as "failed", "invalid", "expected", "cannot" or "parse" alone do not.
const ERRORISH = /(\berror\b|\bunexpected\b|\bsyntax\b|outside a\b|\bmalformed\b|failed to parse|cannot parse)/i;
const FILE_LINE = /([^\s:'"()]+\.feature):(\d+)/;
const BARE_LINE = /\bline\s+(\d+)\b/i;
const SYNTAX_NO_LOC = /(SyntaxError|syntax error|parse error|unexpected token)/i;
const NOISE = /^\s*(\[(info|warn|warning|debug|trace)\]|(info|warn|warning|debug|trace)\b)|\bno errors?\b|\b0 (failed|errors?)\b|\breport\b/i;
const MAX_FINDINGS = 20;

function clip(s: string): string {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > MESSAGE_CAP ? t.slice(0, MESSAGE_CAP - 1) + '…' : t;
}

/** Findings need a `.feature:<n>` location; the no-location syntax fallback applies only when no located line exists. */
export function parseDryRunOutput(out: string): ParsedDryRunError[] {
    const lines = out.split(/\r?\n/);
    const located: ParsedDryRunError[] = [];
    const unlocated: ParsedDryRunError[] = [];
    for (let i = 0; i < lines.length; i++) {
        const text = lines[i].trim();
        if (!text || NOISE.test(text)) {continue;}
        const fl = FILE_LINE.exec(text);
        if (fl && ERRORISH.test(text)) {
            located.push({ file: fl[1], line: Number(fl[2]), message: clip(text) });
            continue;
        }
        if (SYNTAX_NO_LOC.test(text)) {
            // stack style: the location may be on one of the next two lines
            let loc: RegExpExecArray | null = null;
            for (let j = i + 1; j <= i + 2 && j < lines.length && !loc; j++) {loc = FILE_LINE.exec(lines[j]);}
            if (loc) {
                located.push({ file: loc[1], line: Number(loc[2]), message: clip(text) });
            } else {
                const bl = BARE_LINE.exec(text);
                unlocated.push({ line: bl ? Number(bl[1]) : 1, message: clip(text) });
            }
        }
    }
    const all = located.length > 0 ? located : unlocated;
    const seen = new Set<string>();
    const out2: ParsedDryRunError[] = [];
    for (const e of all) {
        const k = `${e.file ?? ''}:${e.line}:${e.message}`;
        if (seen.has(k)) {continue;}
        seen.add(k);
        out2.push(e);
        if (out2.length >= MAX_FINDINGS) {break;}
    }
    return out2;
}

export function isKarateV2(versionOutput: string): boolean {
    const m = /(?:karate\s*(?:version:?\s*)?v?|^\s*v?)(\d+)\.\d+/im.exec(versionOutput);
    return m ? Number(m[1]) >= 2 : false;
}

export function parseJavaMajor(versionOutput: string): number | undefined {
    const m = /version\s+"(\d+)(?:\.(\d+))?/i.exec(versionOutput);
    if (!m) {return undefined;}
    const first = Number(m[1]);
    return first === 1 && m[2] !== undefined ? Number(m[2]) : first;
}

export function isJava21(versionOutput: string): boolean {
    const v = parseJavaMajor(versionOutput);
    return v !== undefined && v >= 21;
}

export function dryRunDecision(mode: 'auto' | 'off', cliAvailable: boolean): 'disabled' | 'no-cli' | 'run' {
    if (mode === 'off') {return 'disabled';}
    return cliAvailable ? 'run' : 'no-cli';
}

const OLD_JAVA = /(UnsupportedClassVersionError|class file version 6[5-9]|requires Java 2\d|Java 21 or (?:newer|higher)|major version 6[5-9])/i;

export async function dryRun(opts: DryRunOptions): Promise<DryRunOutcome> {
    const skipped = (message: string): DryRunOutcome => ({ status: 'skipped', message, findings: [] });
    if (!opts.cli) {return skipped(NO_CLI_MESSAGE);}
    const files = opts.files.filter(f => f.endsWith('.feature'));
    if (files.length === 0) {return skipped('No feature files to dry-run');}
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const args = [...opts.cli.args, 'run', '-D', '-o', opts.outDir, ...files];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let res: { code: number; out: string };
    try {
        res = await Promise.race([
            opts.exec(opts.cli.command, args, { cwd: opts.root, timeoutMs }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Dry run timed out after ${timeoutMs} ms`)), timeoutMs); })
        ]);
    } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        return skipped(clip(m));
    } finally {
        if (timer) {clearTimeout(timer);}
    }
    // parse the full output (bounded by the exec buffer); cap only what is displayed
    const full = res.out ?? '';
    const out = capOutput(full);
    if (res.code === 0) {return { status: 'passed', message: 'Karate v2 dry run parsed all feature files', findings: [], output: out };}
    if (OLD_JAVA.test(full)) {return skipped('Java 21 or newer is required for Karate v2');}
    const errors = parseDryRunOutput(full);
    if (errors.length === 0) {
        return skipped(`exit code ${res.code} without parse errors (${clip(out).slice(0, 120) || 'no output'})`);
    }
    const findings: Finding[] = errors.map(e => ({
        ruleId: 'V2-PARSE-001', severity: 'error' as const, line: e.line,
        message: clip(e.file && !e.message.includes(e.file) ? `${e.file}: ${e.message}` : e.message)
    }));
    return { status: 'failed', message: `Karate v2 dry run reported ${findings.length} parse error${findings.length === 1 ? '' : 's'}`, findings, output: out };
}
