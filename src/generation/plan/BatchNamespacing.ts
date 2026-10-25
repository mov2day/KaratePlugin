/** Decides how specs in a directory batch avoid overwriting each other's output. Pure. */

import { slug } from './slug';

export interface BatchSpec {
    specName: string;
    /** Feature paths (relative to the output root) the spec would write. */
    featurePaths: string[];
}

export interface BatchNamespace {
    /** Unique per-spec name used as `filePrefix` for data/schema files; undefined for a single-spec batch. */
    filePrefix?: string;
    /** Write this spec's features under `<outputRoot>/<folder>/` because a feature path is shared with another spec. */
    subfolder?: string;
}

const safe = (s: string): string => slug(s) || 'spec';

export function planBatchNamespacing(specs: BatchSpec[]): BatchNamespace[] {
    const names: string[] = [];
    const used = new Set<string>();
    for (const s of specs) {
        const base = safe(s.specName);
        let name = base;
        for (let n = 2; used.has(name); n++) {name = `${base}-${n}`;}
        used.add(name);
        names.push(name);
    }
    const owners = new Map<string, number>();
    for (const s of specs) {for (const p of new Set(s.featurePaths)) {owners.set(p, (owners.get(p) ?? 0) + 1);}}
    const multiple = specs.length > 1;
    return specs.map((s, i) => ({
        ...(multiple ? { filePrefix: names[i] } : {}),
        ...(s.featurePaths.some(p => (owners.get(p) ?? 0) > 1) ? { subfolder: names[i] } : {})
    }));
}
