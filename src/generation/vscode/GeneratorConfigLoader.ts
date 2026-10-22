import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveGeneratorConfig } from '../config/GeneratorConfig';
import type { GeneratorConfig } from '../config/GeneratorConfig';
import { mapSettingsToConfig } from '../config/SettingsMapping';
import type { LoaderSettings } from '../config/SettingsMapping';

export interface LoadedGeneratorConfig {
    config: GeneratorConfig;
    warnings: string[];
    source: 'file' | 'settings' | 'defaults';
}

/** Glue between VS Code settings / the generator config file and the pure resolver. */
export class GeneratorConfigLoader {
    static async load(workspaceRoot: string): Promise<LoadedGeneratorConfig> {
        const warnings: string[] = [];
        const root = vscode.workspace.getConfiguration('karateDsl');
        let explicit = false;

        const read = <T>(key: string): T | undefined => {
            const info = root.inspect<T>(key);
            const value = info?.workspaceFolderValue ?? info?.workspaceValue ?? info?.globalValue;
            if (value !== undefined) explicit = true;
            return value;
        };

        const raw: LoaderSettings = {
            structuringStrategy: read<string>('generation.structuringStrategy'),
            autoTag: read<boolean>('generation.autoTag'),
            outputPath: read<string>('outputPath'),
            scenarioOutlineThreshold: read<number>('generation.scenarioOutlineThreshold'),
            smartTestData: read<boolean>('generation.smartTestData'),
            exploratory: read<boolean>('generation.exploratory'),
            configMode: read<string>('generation.configMode')
        };

        const stylePath = read<string>('generation.sharedStylePath');
        if (stylePath) {
            const resolved = path.isAbsolute(stylePath) ? stylePath : path.join(workspaceRoot, stylePath);
            const style = GeneratorConfigLoader.readJson(resolved, warnings);
            if (style !== undefined) raw.style = style;
        }

        const configFile = root.get<string>('generation.configFile', '.karate-generator.json') || '.karate-generator.json';
        const filePath = path.isAbsolute(configFile) ? configFile : path.join(workspaceRoot, configFile);
        const file = GeneratorConfigLoader.readJson(filePath, warnings);

        const resolved = resolveGeneratorConfig(file, mapSettingsToConfig(raw));
        warnings.push(...resolved.warnings);
        const source = file !== undefined ? 'file' : explicit ? 'settings' : 'defaults';
        return { config: resolved.config, warnings, source };
    }

    private static readJson(filePath: string, warnings: string[]): unknown {
        try {
            if (!fs.existsSync(filePath)) return undefined;
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (e) {
            warnings.push(`Could not parse ${filePath}: ${e instanceof Error ? e.message : String(e)}; ignoring it`);
            return undefined;
        }
    }
}
