import * as vscode from 'vscode';
import * as path from 'path';
import { PostmanParser, PostmanCollection, PostmanEnvironment } from './postmanParser';
import { InputSanitizer } from './InputSanitizer';
import { FileUtils } from '../utils/fileUtils';
import { logger } from '../utils/logger';
import { buildPostmanModel, redactedCollectionText } from '../generation/adapters/postman';
import { GeneratorConfigLoader } from '../generation/vscode/GeneratorConfigLoader';
import { runGenerationForModel } from '../generation/vscode/runGeneration';
import { writeSummaryDetails } from '../generation/vscode/reportSummary';

export interface ImportOptions {
    preserveFolders: boolean;
    convertScripts: boolean;
    includeAuth: boolean;
    useCopilot: boolean;
    environmentFile?: string;
}

export interface ImportResult {
    success: boolean;
    featuresCreated: number;
    warnings: string[];
    unsupportedFeatures: string[];
    createdFiles: string[];
}

/**
 * Service for importing Postman collections into Karate tests.
 * Both the folder-per-feature and the single-file path run through the shared generation pipeline.
 */
export class PostmanImportService {
    private parser: PostmanParser;

    /** `context` is required to run an import (skills, hash history); `importEnvironment` does not need it. */
    constructor(private readonly context?: vscode.ExtensionContext) {
        this.parser = new PostmanParser();
    }

    /**
     * Import a Postman collection
     */
    public async importCollection(
        collectionPath: string,
        outputDir: string,
        options: ImportOptions = {
            preserveFolders: true,
            convertScripts: true,
            includeAuth: true,
            useCopilot: false
        },
        token?: vscode.CancellationToken,
        progress?: (message: string, pct: number) => void
    ): Promise<ImportResult> {
        const result: ImportResult = {
            success: false,
            featuresCreated: 0,
            warnings: [],
            unsupportedFeatures: [],
            createdFiles: []
        };
        const cancelled = (): boolean => token?.isCancellationRequested === true;

        try {
            if (!this.context) {throw new Error('PostmanImportService needs the extension context');}
            const workspaceRoot = FileUtils.getWorkspaceRoot();
            if (!workspaceRoot) {throw new Error('No workspace folder is open');}

            // Parse and validate
            const parsed = this.parser.parseCollectionFile(collectionPath);
            const validation = this.parser.validateCollection(parsed);
            if (!validation.valid) {
                throw new Error(`Invalid collection: ${validation.errors.join(', ')}`);
            }
            const stats = this.parser.getCollectionStats(parsed);
            logger.info(`Collection stats: ${stats.totalRequests} requests, ${stats.totalFolders} folders`);
            const collection = this.applyOptions(parsed, options);

            let environment: PostmanEnvironment | undefined;
            if (options.environmentFile) {
                try {
                    environment = this.parser.parseEnvironmentFile(options.environmentFile);
                    logger.info(`Loaded ${environment.values.length} environment variables`);
                } catch (error) {
                    result.warnings.push(`Failed to load environment file: ${error}`);
                }
            }
            if (cancelled()) {throw new vscode.CancellationError();}

            // Generator config (folders -> features unless the user wants a single file)
            const loaded = await GeneratorConfigLoader.load(workspaceRoot);
            for (const w of loaded.warnings) {logger.warn(`Generator config: ${w}`);}
            const config = options.preserveFolders
                ? loaded.config
                : { ...loaded.config, layout: { ...loaded.config.layout, strategy: 'flat' as const } };

            const built = buildPostmanModel(collection, environment, { config, collectionName: collection.info.name });
            result.warnings.push(...built.warnings);
            result.unsupportedFeatures = built.unsupported.map(u => `${u.sourceRef}: ${u.reason}`);
            if (cancelled()) {throw new vscode.CancellationError();}

            const rel = path.relative(workspaceRoot, outputDir);
            const outputRoot = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : outputDir;
            // Credentials are removed before the collection is offered to the AI refiner as evidence.
            const evidence = [{
                label: 'postman-collection',
                text: InputSanitizer.sanitizeSpec(redactedCollectionText(collection)).slice(0, 30000)
            }];

            const run = await runGenerationForModel({
                context: this.context, workspaceRoot, model: built.model,
                sourceRef: path.basename(collectionPath), mode: 'postman', useAi: options.useCopilot,
                scenarios: built.features, classpathFiles: built.files, evidence, config, outputRoot,
                progress: progress ?? (() => undefined)
            });

            writeSummaryDetails(run.summary, `Postman: ${path.basename(collectionPath)}`);
            result.createdFiles = run.createdPaths;
            result.featuresCreated = run.createdPaths.length;
            result.warnings.push(...run.warnings);
            if (run.summary.level === 'warning') {result.warnings.push(run.summary.headline);}

            result.success = run.createdPaths.length > 0;
            if (!result.success) {result.warnings.push('No feature files were generated');}
            logger.info(`Successfully imported ${result.featuresCreated} feature files`);
        } catch (error) {
            if (error instanceof vscode.CancellationError) {throw error;}
            logger.error('Failed to import collection', error as Error);
            result.warnings.push(`Import failed: ${error}`);
        }

        return result;
    }

    /** Apply the import options that the adapter does not know about by trimming a copy of the collection. */
    private applyOptions(collection: PostmanCollection, options: ImportOptions): PostmanCollection {
        if (options.includeAuth && options.convertScripts) {return collection;}
        const clone = JSON.parse(JSON.stringify(collection)) as PostmanCollection;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const strip = (node: any): void => {
            if (!node || typeof node !== 'object') {return;}
            if (!options.includeAuth && 'auth' in node) {delete node.auth;}
            if (!options.convertScripts && 'event' in node) {delete node.event;}
            for (const child of node.item ?? []) {strip(child);}
            if (node.request) {strip(node.request);}
        };
        strip(clone);
        return clone;
    }

    /**
     * Import environment file only
     */
    public async importEnvironment(
        environmentPath: string,
        outputPath: string
    ): Promise<{ success: boolean; variableCount: number }> {
        try {
            const environment = this.parser.parseEnvironmentFile(environmentPath);
            const variables = this.parser.extractEnvironmentVariables(environment);

            // Create Karate config file
            const configLines: string[] = [];
            configLines.push('function fn() {');
            configLines.push('  var config = {');

            for (const [key, value] of variables) {
                configLines.push(`    ${key}: '${value}',`);
            }

            configLines.push('  };');
            configLines.push('  return config;');
            configLines.push('}');

            const configContent = configLines.join('\n');
            FileUtils.writeFile(outputPath, configContent);

            logger.info(`Created Karate config from environment: ${outputPath}`);

            return {
                success: true,
                variableCount: variables.size
            };
        } catch (error) {
            logger.error('Failed to import environment', error as Error);
            return {
                success: false,
                variableCount: 0
            };
        }
    }
}
