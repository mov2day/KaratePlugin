/**
 * Pure migration of the legacy `karateDsl.*` generation settings into a partial GeneratorConfig.
 * Used when no `.karate-generator.json` exists. No vscode import.
 *
 * `testTemplate` presets (documented defaults, explicit settings win over them):
 *   standard -> generator defaults (no overrides)
 *   detailed -> scenarios.exploratory = true (every category plus exploratory probes)
 *   minimal  -> scenarios.categories = positive + negative only
 */
import type { GeneratorConfig } from '../config/GeneratorConfig';
import { mapSettingsToConfig } from '../config/SettingsMapping';

export interface LegacySettings {
    testTemplate?: unknown;
    structuringStrategy?: unknown;
    autoTag?: unknown;
    outputPath?: unknown;
    sharedStylePath?: unknown;
    scenarioOutlineThreshold?: unknown;
    smartTestData?: unknown;
}

export interface MigrationResult {
    config: Partial<GeneratorConfig>;
    warnings: string[];
    /** Not part of GeneratorConfig; the loader still reads the shared style file from this path. */
    sharedStylePath?: string;
}

const TEMPLATES = ['standard', 'detailed', 'minimal'] as const;
const STRATEGIES = ['domain', 'flat', 'method'] as const;

type Layer = Record<string, Record<string, unknown>>;

/** Two-level merge: sections of `over` replace same-named keys of `base`. */
export function mergeSettingsLayers(base: Partial<GeneratorConfig>, over: Partial<GeneratorConfig>): Partial<GeneratorConfig> {
    const out: Layer = {};
    for (const layer of [base as unknown as Layer, over as unknown as Layer]) {
        for (const [section, value] of Object.entries(layer)) {
            out[section] = { ...(out[section] ?? {}), ...(value as Record<string, unknown>) };
        }
    }
    return out as unknown as Partial<GeneratorConfig>;
}

export function migrateSettingsWithWarnings(old: LegacySettings): MigrationResult {
    const warnings: string[] = [];
    const bad = (key: string, value: unknown, expected: string): void => {
        warnings.push(`Legacy setting karateDsl.${key} has unsupported value ${JSON.stringify(value)} (expected ${expected}); ignored`);
    };
    const clean: Record<string, unknown> = {};
    let template: Partial<GeneratorConfig> = {};

    if (old.testTemplate !== undefined) {
        if (typeof old.testTemplate === 'string' && (TEMPLATES as readonly string[]).includes(old.testTemplate)) {
            if (old.testTemplate === 'detailed') {
                template = { scenarios: { exploratory: true } } as unknown as Partial<GeneratorConfig>;
            } else if (old.testTemplate === 'minimal') {
                template = { scenarios: { categories: ['positive', 'negative'] } } as unknown as Partial<GeneratorConfig>;
            }
        } else {
            bad('testTemplate', old.testTemplate, TEMPLATES.join(' | '));
        }
    }
    if (old.structuringStrategy !== undefined) {
        if (typeof old.structuringStrategy === 'string' && (STRATEGIES as readonly string[]).includes(old.structuringStrategy)) {
            clean.structuringStrategy = old.structuringStrategy;
        } else {bad('generation.structuringStrategy', old.structuringStrategy, STRATEGIES.join(' | '));}
    }
    if (old.autoTag !== undefined) {
        if (typeof old.autoTag === 'boolean') {clean.autoTag = old.autoTag;} else {bad('generation.autoTag', old.autoTag, 'boolean');}
    }
    if (old.outputPath !== undefined) {
        if (typeof old.outputPath === 'string' && old.outputPath.trim() !== '') {clean.outputPath = old.outputPath;} else {bad('outputPath', old.outputPath, 'non-empty string');}
    }
    if (old.scenarioOutlineThreshold !== undefined) {
        const t = old.scenarioOutlineThreshold;
        if (typeof t === 'number' && Number.isInteger(t) && t >= 1 && t <= 10) {clean.scenarioOutlineThreshold = t;} else {bad('generation.scenarioOutlineThreshold', t, 'integer 1-10');}
    }
    if (old.smartTestData !== undefined) {
        if (typeof old.smartTestData === 'boolean') {clean.smartTestData = old.smartTestData;} else {bad('generation.smartTestData', old.smartTestData, 'boolean');}
    }
    const result: MigrationResult = { config: mergeSettingsLayers(template, mapSettingsToConfig(clean)), warnings };
    if (old.sharedStylePath !== undefined) {
        if (typeof old.sharedStylePath === 'string') {
            if (old.sharedStylePath !== '') {result.sharedStylePath = old.sharedStylePath;}
        } else {bad('generation.sharedStylePath', old.sharedStylePath, 'string path');}
    }
    return result;
}

export function migrateSettings(old: LegacySettings): Partial<GeneratorConfig> {
    return migrateSettingsWithWarnings(old).config;
}
