import type { GeneratorConfig } from '../config/GeneratorConfig';
import type { ParsedFeature, ParsedScenario, Step, Tag } from './FeatureParser';

export interface Finding {
    ruleId: string;
    severity: 'error' | 'warning';
    line: number;
    message: string;
    fix?: string;
}

export interface QualityContext {
    /** Classpath-relative file names (e.g. `common/auth.feature`) that exist. */
    knownFiles?: Set<string>;
    config?: GeneratorConfig;
}

export interface Rule {
    id: string;
    severity: 'error' | 'warning';
    check(parsed: ParsedFeature, ctx: QualityContext): Finding[];
}

const MAX_SAFE = BigInt('9007199254740991');

const isFeatureIgnored = (p: ParsedFeature): boolean => p.tags.some(t => t.name === '@ignore');
const active = (p: ParsedFeature): ParsedScenario[] => p.scenarios.filter(s => !s.ignored);
const allSteps = (p: ParsedFeature, s: ParsedScenario): Step[] => [...(p.background?.steps ?? []), ...s.steps];
const isMethod = (s: Step): boolean => /^method\s+\S/i.test(s.text);
const refsStatus = (s: Step): boolean => /^(assert|match)\b/.test(s.text) && /\bresponseStatus\b/.test(s.text);
const isUrlStep = (s: Step): boolean => /^url\s+\S/.test(s.text) || /^configure\s+url\b/.test(s.text);

/** Replace quoted string contents so code-level patterns do not match inside literals. */
const stripStrings = (text: string): string => text.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");

function finder(rule: { id: string; severity: 'error' | 'warning' }) {
    return (line: number, message: string, fix?: string): Finding => ({ ruleId: rule.id, severity: rule.severity, line, message, ...(fix ? { fix } : {}) });
}

/** Tags a rule should evaluate: feature tags (unless the feature is ignored) plus tags of non-ignored scenarios. */
function activeTags(p: ParsedFeature): Tag[] {
    if (isFeatureIgnored(p)) return [];
    return [...p.tags, ...active(p).flatMap(s => s.tags)];
}

const SECRET_KEY = /(?:^|[^\w])['"]?(password|passwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|token)['"]?\s*[:=]\s*(['"])((?:(?!\2).)+)\2\s*(?:[,}]|$)/gi;
const AUTH_HEADER = /^header\s+Authorization\s*=\s*(['"])(Bearer|Basic|Token)\s+([^'"\s#$]{8,})\1\s*$/i;
const SECRET_HEADER = /^header\s+([\w-]*(?:api[-_]?key|secret|token|password)[\w-]*)\s*=\s*(['"])([^'"\s#$]{6,})\2\s*$/i;

const isSecretValue = (v: string): boolean => v.length > 0 && !v.startsWith('#') && !v.includes('${') && !/^<.*>$/.test(v);

const gherkin001: Rule = {
    id: 'V2-GHERKIN-001', severity: 'error',
    check: p => {
        const f = finder(gherkin001);
        return p.orphanSteps.map(s => f(s.line, 'Step is outside any Background or Scenario', 'Move the step into a Background or Scenario'));
    }
};

const lock001: Rule = {
    id: 'V2-LOCK-001', severity: 'error',
    check: p => {
        const f = finder(lock001);
        return activeTags(p).filter(t => /^@parallel\s*=\s*false$/i.test(t.name))
            .map(t => f(t.line, '@parallel=false is not supported in Karate v2', 'Use @lock=<name> to serialise scenarios'));
    }
};

const cfg001: Rule = {
    id: 'V2-CFG-001', severity: 'error',
    check: p => {
        const f = finder(cfg001);
        const out: Finding[] = [];
        const steps: Step[] = [...(isFeatureIgnored(p) ? [] : p.background?.steps ?? []), ...active(p).flatMap(s => s.steps)];
        for (const s of steps) {
            if (/^url\s+['"]https?:/i.test(s.text)) out.push(f(s.line, 'Hard-coded URL in feature', 'Use a config variable such as baseUrl'));
        }
        return out;
    }
};

const cfg002: Rule = {
    id: 'V2-CFG-002', severity: 'error',
    check: p => {
        const f = finder(cfg002);
        const out: Finding[] = [];
        const bgUrl = (p.background?.steps ?? []).some(isUrlStep);
        for (const s of active(p)) {
            const idx = s.steps.findIndex(isMethod);
            if (idx < 0) continue;
            if (bgUrl || s.steps.slice(0, idx).some(isUrlStep)) continue;
            out.push(f(s.steps[idx].line, 'Request is made but no url is set in Background or scenario', "Add '* url baseUrl' to Background"));
        }
        return out;
    }
};

const sec001: Rule = {
    id: 'V2-SEC-001', severity: 'error',
    check: p => {
        const f = finder(sec001);
        const out: Finding[] = [];
        for (const sc of active(p)) {
            for (const s of allSteps(p, sc)) {
                if (s.line < sc.startLine) continue; // Background steps are reported once below
                if (secretIn(s)) out.push(f(s.line, 'Literal secret value in step', "Read it from karate.sysenv(...) or a config variable"));
            }
        }
        if (!isFeatureIgnored(p)) {
            for (const s of p.background?.steps ?? []) {
                if (secretIn(s)) out.push(f(s.line, 'Literal secret value in step', "Read it from karate.sysenv(...) or a config variable"));
            }
        }
        return out;
    }
};

function secretIn(s: Step): boolean {
    if (AUTH_HEADER.test(s.text) || SECRET_HEADER.test(s.text)) return true;
    SECRET_KEY.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SECRET_KEY.exec(s.text)) !== null) {
        if (isSecretValue(m[3])) return true;
    }
    return false;
}

const assert001: Rule = {
    id: 'V2-ASSERT-001', severity: 'error',
    check: p => {
        const f = finder(assert001);
        const out: Finding[] = [];
        for (const s of active(p)) {
            const m = s.steps.find(isMethod);
            if (!m) continue;
            if (s.steps.some(x => /^status\s+\S/.test(x.text) || refsStatus(x))) continue;
            out.push(f(m.line, 'Scenario makes a request but never asserts the status', "Add 'Then status <code>'"));
        }
        return out;
    }
};

const assert002: Rule = {
    id: 'V2-ASSERT-002', severity: 'warning',
    check: p => {
        const f = finder(assert002);
        const out: Finding[] = [];
        for (const s of active(p)) {
            const m = s.steps.find(isMethod);
            if (!m) continue;
            const is2xx = s.steps.some(x => /^status\s+2\d\d\b/.test(x.text) || (refsStatus(x) && /\b2\d\d\b/.test(x.text)));
            if (!is2xx) continue;
            const hasBody = s.steps.some(x => /^(assert|match)\b/.test(x.text) && !/\bresponseStatus\b/.test(x.text));
            if (!hasBody) out.push(f(m.line, '2xx scenario has no body assertion', "Add a 'match response ...' step"));
        }
        return out;
    }
};

const draft001: Rule = {
    id: 'V2-DRAFT-001', severity: 'error',
    check: p => {
        const f = finder(draft001);
        const out: Finding[] = [];
        if (isFeatureIgnored(p)) return out;
        const blocks = [...(p.background ? [p.background] : []), ...active(p)];
        for (const b of blocks) {
            for (const s of b.steps) if (/TODO/.test(s.text)) out.push(f(s.line, 'TODO/placeholder step left in a non-@ignore scenario', 'Complete the step or tag the scenario @ignore'));
            for (const c of b.comments) if (/\bTODO\b/.test(c.text)) out.push(f(c.line, 'TODO comment left in a non-@ignore scenario', 'Complete the scenario or tag it @ignore'));
        }
        return out.sort((a, b) => a.line - b.line);
    }
};

const dup001: Rule = {
    id: 'V2-DUP-001', severity: 'error',
    check: p => {
        const f = finder(dup001);
        const seen = new Set<string>();
        const out: Finding[] = [];
        for (const s of p.scenarios) {
            if (!s.name) continue;
            if (seen.has(s.name)) out.push(f(s.startLine, `Duplicate scenario name "${s.name}"`, 'Give each scenario a unique name'));
            seen.add(s.name);
        }
        return out;
    }
};

const callRule = (rule: Rule, needle: string, message: string): Rule['check'] => p => {
    const f = finder(rule);
    const out: Finding[] = [];
    for (const sc of active(p)) {
        for (const s of sc.steps) if (stripStrings(s.text).includes(needle)) out.push(f(s.line, message));
    }
    return out;
};

const api001: Rule = { id: 'V2-API-001', severity: 'error', check: (p, c) => callRule(api001, 'karate.stop(', 'karate.stop() is not available in Karate v2')(p, c) };
const api002: Rule = { id: 'V2-API-002', severity: 'warning', check: (p, c) => callRule(api002, 'karate.toJava(', 'karate.toJava() is discouraged in Karate v2')(p, c) };

const num001: Rule = {
    id: 'V2-NUM-001', severity: 'error',
    check: p => {
        const f = finder(num001);
        const out: Finding[] = [];
        for (const sc of active(p)) {
            for (const s of sc.steps) {
                const re = /(?<![\w.])\d{16,}(?![\w.])/g;
                let m: RegExpExecArray | null;
                const code = stripStrings(s.text);
                while ((m = re.exec(code)) !== null) {
                    if (BigInt(m[0]) > MAX_SAFE) {
                        out.push(f(s.line, `Integer ${m[0]} exceeds JavaScript safe range`, 'Use a quoted string'));
                        break;
                    }
                }
            }
        }
        return out;
    }
};

const ref001: Rule = {
    id: 'V2-REF-001', severity: 'error',
    check: (p, ctx) => {
        const f = finder(ref001);
        const out: Finding[] = [];
        if (!ctx.knownFiles) return out;
        const known = ctx.knownFiles;
        const steps = [...(isFeatureIgnored(p) ? [] : p.background?.steps ?? []), ...active(p).flatMap(s => s.steps)];
        for (const s of steps) {
            const re = /read\(\s*(['"])classpath:([^'"]+)\1/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(s.text)) !== null) {
                const name = m[2].replace(/^\/+/, '').replace(/@[\w=-]+$/, '');
                if (/[#{}]/.test(name)) continue;
                if (!known.has(name)) out.push(f(s.line, `read('classpath:${m[2]}') does not resolve to a known file`, 'Create the file or fix the path'));
            }
        }
        return out;
    }
};

const TAG_CATEGORIES = ['positive', 'negative', 'edge', 'boundary', 'security', 'exploratory'] as const;

const tag001: Rule = {
    id: 'V2-TAG-001', severity: 'warning',
    check: (p, ctx) => {
        const f = finder(tag001);
        const out: Finding[] = [];
        if (!ctx.config) return out;
        const taxonomy = ctx.config.tags.taxonomy;
        for (const t of activeTags(p)) {
            const m = /^@(positive|negative|edge|boundary|security|exploratory)$/i.exec(t.name);
            if (!m) continue;
            const category = m[1].toLowerCase() as typeof TAG_CATEGORIES[number];
            const want = taxonomy[category];
            const wantTag = want.startsWith('@') ? want : `@${want}`;
            if (t.name !== wantTag) out.push(f(t.line, `Tag ${t.name} is not the configured ${category} tag`, `Use ${wantTag}`));
        }
        return out;
    }
};

export const RULES: Rule[] = [
    gherkin001, lock001, cfg001, cfg002, sec001, assert001, assert002,
    draft001, dup001, api001, api002, num001, ref001, tag001
];
