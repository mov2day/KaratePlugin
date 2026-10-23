// Source-neutral layout stage: regroups already-planned features (category split, size cap, section comments).
// Pure: no vscode, no logger, no I/O, no randomness. With the default options it returns its input unchanged.
import type { KarateScenario } from '../../types';
import type { GeneratorConfig, LayoutSplit } from '../config/GeneratorConfig';
import type { PlannedFeature } from '../plan/OpenApiPlanner';
import { slug } from '../plan/slug';

export type LayoutOptions = Pick<GeneratorConfig['layout'], 'splitBy' | 'maxScenariosPerFile' | 'sections'>;

/** Split modes that are accepted by the config but not implemented yet; they behave like 'none'. */
const UNIMPLEMENTED: readonly LayoutSplit[] = ['tag', 'path'];

export function layoutWarnings(layout: LayoutOptions): string[] {
    return UNIMPLEMENTED.includes(layout.splitBy)
        ? [`layout.splitBy "${layout.splitBy}" is not implemented yet; files are not split`]
        : [];
}

const categoryOf = (s: KarateScenario): string => s.category ?? 'positive';
/** Files that must keep their planner grouping: crud lifecycles, security probes and the unsecured `-public` split. */
const isFixedGroup = (f: PlannedFeature): boolean =>
    (f.featureKind !== undefined && f.featureKind !== 'main') || f.relativePath.replace(/\.feature$/, '').endsWith('-public');

const stem = (p: string): string => p.replace(/\.feature$/, '');
const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function splitByCategory(features: PlannedFeature[]): PlannedFeature[] {
    const taken = new Set(features.map(f => f.relativePath));
    const out: PlannedFeature[] = [];
    for (const f of features) {
        if (isFixedGroup(f)) {out.push(f); continue;}
        const groups = new Map<string, KarateScenario[]>();
        for (const s of f.feature.scenarios) {groups.set(categoryOf(s), [...(groups.get(categoryOf(s)) ?? []), s]);}
        if (groups.size <= 1) {out.push(f); continue;}
        // Positive keeps the original name so links stay stable; if there is none, the first category does.
        const order = [...groups.keys()].sort((a, b) => (a === 'positive' ? -1 : b === 'positive' ? 1 : a < b ? -1 : a > b ? 1 : 0));
        order.forEach((category, idx) => {
            const scenarios = groups.get(category) as KarateScenario[];
            if (idx === 0) {
                out.push({ ...f, category, feature: { ...f.feature, scenarios } });
                return;
            }
            let path = `${stem(f.relativePath)}-${slug(category)}.feature`;
            for (let n = 2; taken.has(path); n++) {path = `${stem(f.relativePath)}-${slug(category)}-${n}.feature`;}
            taken.add(path);
            out.push({
                ...f,
                relativePath: path,
                category,
                feature: { ...f.feature, name: `${f.feature.name} - ${titleCase(category)}`, scenarios }
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
    const split = layout.splitBy === 'category';
    const max = layout.maxScenariosPerFile > 0 ? Math.floor(layout.maxScenariosPerFile) : 0;
    if (!split && max === 0 && !layout.sections) {return features;}
    let out = features;
    if (split) {out = splitByCategory(out);}
    out = chunk(out, max);
    if (layout.sections) {out = addSections(out);}
    return out;
}
