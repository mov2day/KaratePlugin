/** Pure mapping from VS Code `karateDsl.*` setting values to a partial GeneratorConfig. No vscode import. */
import type { GeneratorConfig } from './GeneratorConfig';

export interface LoaderSettings {
    structuringStrategy?: string;
    autoTag?: boolean;
    outputPath?: string;
    scenarioOutlineThreshold?: number;
    smartTestData?: boolean;
    exploratory?: boolean;
    configMode?: string;
    aiEnrich?: string;
    /** Parsed content of the shared style file, if any. */
    style?: unknown;
}

/** Undefined settings are omitted so lower-precedence layers (defaults) apply; validation is left to the resolver. */
export function mapSettingsToConfig(s: LoaderSettings): Partial<GeneratorConfig> {
    const out: Record<string, Record<string, unknown>> = {};
    const put = (section: string, key: string, value: unknown): void => {
        if (value === undefined) {return;}
        out[section] = { ...(out[section] ?? {}), [key]: value };
    };
    put('layout', 'strategy', s.structuringStrategy);
    put('layout', 'outputRoot', s.outputPath);
    put('tags', 'auto', s.autoTag);
    put('scenarios', 'outlineThreshold', s.scenarioOutlineThreshold);
    put('scenarios', 'exploratory', s.exploratory);
    put('data', 'smart', s.smartTestData);
    put('config', 'mode', s.configMode);
    put('ai', 'enrich', s.aiEnrich);
    if (s.style !== undefined) {out.style = s.style as Record<string, unknown>;}
    return out as unknown as Partial<GeneratorConfig>;
}

/**
 * Style for the settings layer: the shared-style file when one was read, otherwise the learned style.
 * Applied before the config file, so precedence is file > shared style > learned style > defaults.
 */
export function layerStyle(shared: unknown | undefined, learned: unknown | undefined): unknown | undefined {
    return shared !== undefined ? shared : learned;
}
