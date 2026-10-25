import { parseFeature } from './FeatureParser';
import { RULES } from './rules';
import type { Finding, QualityContext } from './rules';

export { parseFeature } from './FeatureParser';
export type { ParsedFeature, ParsedScenario, Step } from './FeatureParser';
export type { Finding, QualityContext } from './rules';

export function runGate(text: string, ctx: QualityContext = {}): { findings: Finding[]; ok: boolean } {
    const parsed = parseFeature(text);
    const findings = RULES.flatMap(rule => rule.check(parsed, ctx)).sort((a, b) => a.line - b.line || a.ruleId.localeCompare(b.ruleId));
    return { findings, ok: !findings.some(f => f.severity === 'error') };
}
