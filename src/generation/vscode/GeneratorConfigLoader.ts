import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { KarateStyle } from '../../types';
import { resolveGeneratorConfig } from '../config/GeneratorConfig';
import type { GeneratorConfig } from '../config/GeneratorConfig';
import { layerStyle, mapSettingsToConfig } from '../config/SettingsMapping';
import type { LoaderSettings } from '../config/SettingsMapping';
import { mergeSettingsLayers, migrateSettingsWithWarnings } from './migrateSettings';

export interface LoadedGeneratorConfig {
    config: GeneratorConfig;
    warnings: string[];
    source: 'file' | 'settings' | 'defaults';
}

/** Glue between VS Code settings / the generator config file and the pure resolver. */
export class GeneratorConfigLoader {
    /** `opts.fallbackStyle` (e.g. a learned style) sits below the shared-style file and the config file. */
    static async load(workspaceRoot: string, opts: { fallbackStyle?: KarateStyle | null } = {}): Promise<LoadedGeneratorConfig> {
        const warnings: string[] = [];
        const root = vscode.workspace.getConfiguration('karateDsl');
        let explicit = false;

        const read = <T>(key: string): T | undefined => {
            const info = root.inspect<T>(key);
            const value = info?.workspaceFolderValue ?? info?.workspaceValue ?? info?.globalValue;
            if (value !== undefined) {explicit = true;}
            return value;
        };

        const raw: LoaderSettings = {
            structuringStrategy: read<string>('generation.structuringStrategy'),
            autoTag: read<boolean>('generation.autoTag'),
            outputPath: read<string>('outputPath'),
            scenarioOutlineThreshold: read<number>('generation.scenarioOutlineThreshold'),
            smartTestData: read<boolean>('generation.smartTestData'),
            exploratory: read<boolean>('generation.exploratory'),
            configMode: read<string>('generation.configMode'),
            aiEnrich: read<string>('generation.aiEnrich')
        };

        let sharedStyle: unknown;
        const stylePath = read<string>('generation.sharedStylePath');
        if (stylePath) {
            const resolved = path.isAbsolute(stylePath) ? stylePath : path.join(workspaceRoot, stylePath);
            const style = GeneratorConfigLoader.readJson(resolved, warnings);
            if (style !== undefined) {sharedStyle = style;}
        }
        const styleLayer = layerStyle(sharedStyle, opts.fallbackStyle ?? undefined);
        if (styleLayer !== undefined) {raw.style = styleLayer;}

        const configFile = root.get<string>('generation.configFile', '.karate-generator.json') || '.karate-generator.json';
        const filePath = path.isAbsolute(configFile) ? configFile : path.join(workspaceRoot, configFile);
        const file = GeneratorConfigLoader.readJson(filePath, warnings);

        // Settings split: SettingsMapping (above) maps the karateDsl.generation.* settings into the
        // settings layer; migrateSettings only supplies the legacy `testTemplate` preset, as the
        // lowest layer, and only when no config file exists (see docs/generation.md).
        let settingsLayer = mapSettingsToConfig(raw);
        if (file === undefined) {
            // No config file: legacy testTemplate becomes the lowest settings layer; explicit settings still win.
            const legacy = migrateSettingsWithWarnings({ testTemplate: read<string>('testTemplate') });
            warnings.push(...legacy.warnings);
            settingsLayer = mergeSettingsLayers(legacy.config, settingsLayer);
        }
        const resolved = resolveGeneratorConfig(file, settingsLayer);
        warnings.push(...resolved.warnings);
        const source = file !== undefined ? 'file' : explicit ? 'settings' : 'defaults';
        return { config: resolved.config, warnings, source };
    }

    private static readJson(filePath: string, warnings: string[]): unknown {
        try {
            if (!fs.existsSync(filePath)) {return undefined;}
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (e) {
            warnings.push(`Could not parse ${filePath}: ${e instanceof Error ? e.message : String(e)}; ignoring it`);
            return undefined;
        }
    }
}
