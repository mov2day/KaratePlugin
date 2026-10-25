// Source-neutral layout stage: regroups already-planned features (category split, size cap, section comments).
// Pure: no vscode, no logger, no I/O, no randomness. With the default options it returns its input unchanged.
import type { KarateScenario } from '../../types';
import type { GeneratorConfig, LayoutSplit } from '../config/GeneratorConfig';
import type { PlannedFeature } from '../plan/OpenApiPlanner';
import { slug } from '../plan/slug';

export type LayoutOptions = Pick<GeneratorConfig['layout'], 'splitBy' | 'maxScenariosPerFile' | 'sections'>;

// `exploratory` is a tag category only (KarateScenario.category has no such value), so scenarios that carry just the tag are read as exploratory.
const categoryOf = (s: KarateScenario): string => s.category ?? (s.tags?.includes('@exploratory') ? 'exploratory' : 'positive');
/** Files that must keep their planner grouping: crud lifecycles, security probes and the unsecured `-public` split. */
const isFixedGroup = (f: PlannedFeature): boolean =>
    (f.featureKind !== undefined && f.featureKind !== 'main') || f.relativePath.replace(/\.feature$/, '').endsWith('-public');

const stem = (p: string): string => p.replace(/\.feature$/, '');
const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Tags that never name a group: the default category taxonomy and draft markers. Key=value tags (`@op=`, `@domain=`) are skipped too. */
const NON_GROUP_TAGS = new Set(['@positive', '@negative', '@edge', '@boundary', '@security', '@exploratory', '@ignore', '@draft']);
const tagGroupOf = (s: KarateScenario): string => {
    const t = (s.tags ?? []).find(x => !NON_GROUP_TAGS.has(x) && !x.includes('='));
    return t ? slug(t.replace(/^@/, '')) || 'untagged' : 'untagged';
};
const keyOf: Record<Exclude<LayoutSplit, 'none'>, (s: KarateScenario) => string> = {
    category: categoryOf,
    tag: tagGroupOf,
    path: s => slug(s.domain ?? '') || 'general'
};

/** Splits each regroupable file by `keyOf`. The first group keeps the original file name so links stay stable. */
function splitBy(features: PlannedFeature[], mode: Exclude<LayoutSplit, 'none'>): PlannedFeature[] {
    const key = keyOf[mode];
    const taken = new Set(features.map(f => f.relativePath));
    const out: PlannedFeature[] = [];
    for (const f of features) {
        if (isFixedGroup(f)) {out.push(f); continue;}
        const groups = new Map<string, KarateScenario[]>();
        for (const s of f.feature.scenarios) {groups.set(key(s), [...(groups.get(key(s)) ?? []), s]);}
        if (groups.size <= 1) {out.push(f); continue;}
        // Categories put positive first and sort the rest; tag and path groups keep first-seen order.
        const order = mode === 'category'
            ? [...groups.keys()].sort((a, b) => (a === 'positive' ? -1 : b === 'positive' ? 1 : a < b ? -1 : a > b ? 1 : 0))
            : [...groups.keys()];
        order.forEach((group, idx) => {
            const scenarios = groups.get(group) as KarateScenario[];
            const meta = mode === 'category' ? { category: group } : {};
            if (idx === 0) {
                out.push({ ...f, ...meta, feature: { ...f.feature, scenarios } });
                return;
            }
            let path = `${stem(f.relativePath)}-${slug(group)}.feature`;
            for (let n = 2; taken.has(path); n++) {path = `${stem(f.relativePath)}-${slug(group)}-${n}.feature`;}
            taken.add(path);
            out.push({
                ...f,
                ...meta,
                relativePath: path,
                feature: { ...f.feature, name: `${f.feature.name} - ${titleCase(group)}`, scenarios }
            });
        });
    }
    return out;
}

function chunk(features: PlannedFeature[], max: number): PlannedFeature[] {
    if (max <= 0) {return features;}
    const taken = new Set(features.map(f => f.relativePath));
    const out: PlannedFeature[] = [];
    for (const f of features) {
        const all = f.feature.scenarios;
        if (all.length <= max) {out.push(f); continue;}
        const parts = Math.ceil(all.length / max);
        for (let p = 0; p < parts; p++) {
            let path = `${stem(f.relativePath)}-${p + 1}.feature`;
            for (let n = 2; taken.has(path); n++) {path = `${stem(f.relativePath)}-${p + 1}-${n}.feature`;}
            taken.add(path);
            out.push({
                ...f,
                relativePath: path,
                feature: { ...f.feature, name: `${f.feature.name} - Part ${p + 1}`, scenarios: all.slice(p * max, (p + 1) * max) }
            });
        }
    }
    return out;
}

function addSections(features: PlannedFeature[]): PlannedFeature[] {
    return features.map(f => {
        let previous: string | undefined;
        const scenarios = f.feature.scenarios.map(s => {
            const category = categoryOf(s);
            const header = category !== previous;
            previous = category;
            return header ? { ...s, section: category } : s;
        });
        return { ...f, feature: { ...f.feature, scenarios } };
    });
}

export function applyLayout(features: PlannedFeature[], layout: LayoutOptions): PlannedFeature[] {
    const split = layout.splitBy !== 'none';
    const max = layout.maxScenariosPerFile > 0 ? Math.floor(layout.maxScenariosPerFile) : 0;
    if (!split && max === 0 && !layout.sections) {return features;}
    let out = features;
    if (layout.splitBy !== 'none') {out = splitBy(out, layout.splitBy);}
    out = chunk(out, max);
    if (layout.sections) {out = addSections(out);}
    return out;
}
