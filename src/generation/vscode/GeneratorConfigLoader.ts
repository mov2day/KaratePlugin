import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GeneratorConfig, resolveGeneratorConfig } from '../config/GeneratorConfig';

export interface LoadedGeneratorConfig {
    config: GeneratorConfig;
    warnings: string[];
    source: 'file' | 'settings' | 'defaults';
}

type Plain = Record<string, unknown>;

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

        const settings: Plain = {};
        const put = (section: string, key: string, value: unknown): void => {
            if (value === undefined) return;
            const target = (settings[section] as Plain | undefined) ?? {};
            target[key] = value;
            settings[section] = target;
        };

        put('layout', 'strategy', read<string>('generation.structuringStrategy'));
        put('tags', 'auto', read<boolean>('generation.autoTag'));
        put('layout', 'outputRoot', read<string>('outputPath'));
        put('scenarios', 'outlineThreshold', read<number>('generation.scenarioOutlineThreshold'));
        put('data', 'smart', read<boolean>('generation.smartTestData'));
        put('scenarios', 'exploratory', read<boolean>('generation.exploratory'));
        put('config', 'mode', read<string>('generation.configMode'));

        const stylePath = read<string>('generation.sharedStylePath');
        if (stylePath) {
            const resolved = path.isAbsolute(stylePath) ? stylePath : path.join(workspaceRoot, stylePath);
            const style = GeneratorConfigLoader.readJson(resolved, warnings);
            if (style !== undefined) settings.style = style;
        }

        const configFile = root.get<string>('generation.configFile', '.karate-generator.json') || '.karate-generator.json';
        const filePath = path.isAbsolute(configFile) ? configFile : path.join(workspaceRoot, configFile);
        const fileExists = fs.existsSync(filePath);
        const file = fileExists ? GeneratorConfigLoader.readJson(filePath, warnings) : undefined;

        const resolved = resolveGeneratorConfig(file, settings as Partial<GeneratorConfig>);
        warnings.push(...resolved.warnings);
        const source = fileExists ? 'file' : explicit ? 'settings' : 'defaults';
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
