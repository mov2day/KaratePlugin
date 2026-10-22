/** Maps the UI/command scenario type selection onto generator config categories. Pure. */
import type { ScenarioCategory } from './GeneratorConfig';

const MAP: Record<string, ScenarioCategory[]> = {
    positive: ['positive'],
    negative: ['negative'],
    edge: ['edge', 'boundary'],
    boundary: ['boundary'],
    security: ['security']
};

/**
 * Categories for the selected types; `fallback` (the configured default) when nothing recognisable is selected.
 * Order follows the fallback list so output stays deterministic.
 */
export function categoriesForScenarioTypes(types: string[] | undefined, fallback: ScenarioCategory[]): ScenarioCategory[] {
    const wanted = new Set<ScenarioCategory>();
    for (const t of types ?? []) {
        for (const c of MAP[String(t).trim().toLowerCase()] ?? []) {wanted.add(c);}
    }
    if (wanted.size === 0) {return fallback;}
    const ordered = fallback.filter(c => wanted.has(c));
    return ordered.length > 0 ? ordered : [...wanted];
}
