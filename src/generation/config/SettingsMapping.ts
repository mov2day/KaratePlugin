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
    if (s.style !== undefined) {out.style = s.style as Record<string, unknown>;}
    return out as unknown as Partial<GeneratorConfig>;
}
