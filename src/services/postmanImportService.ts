import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PostmanParser, PostmanCollection, PostmanEnvironment } from './postmanParser';
import { PostmanToKarateConverter } from './postmanToKarateConverter';
import { FileUtils } from '../utils/fileUtils';
import { logger } from '../utils/logger';

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
 * Service for importing Postman collections into Karate tests
 */
export class PostmanImportService {
    private parser: PostmanParser;
    private converter: PostmanToKarateConverter;

    constructor() {
        this.parser = new PostmanParser();
        this.converter = new PostmanToKarateConverter();
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
        token?: vscode.CancellationToken
    ): Promise<ImportResult> {
        const result: ImportResult = {
            success: false,
            featuresCreated: 0,
            warnings: [],
            unsupportedFeatures: [],
            createdFiles: []
        };

        try {
            // Parse collection
            const collection = this.parser.parseCollectionFile(collectionPath);

            // Validate collection
            const validation = this.parser.validateCollection(collection);
            if (!validation.valid) {
                throw new Error(`Invalid collection: ${validation.errors.join(', ')}`);
            }

            // Get collection stats
            const stats = this.parser.getCollectionStats(collection);
            logger.info(`Collection stats: ${stats.totalRequests} requests, ${stats.totalFolders} folders`);

            // Extract variables
            let variables = this.parser.extractVariables(collection);

            // Merge environment variables if provided
            if (options.environmentFile) {
                try {
                    const environment = this.parser.parseEnvironmentFile(options.environmentFile);
                    const envVars = this.parser.extractEnvironmentVariables(environment);
                    variables = new Map([...variables, ...envVars]);
                    logger.info(`Loaded ${envVars.size} environment variables`);
                } catch (error) {
                    result.warnings.push(`Failed to load environment file: ${error}`);
                }
            }

            // Extract all requests
            const requests = this.parser.extractRequests(collection);

            if (options.preserveFolders) {
                // Create feature files per folder
                const folderMap = this.groupRequestsByFolder(requests);

                for (const [folderPath, folderRequests] of folderMap) {
                    const featureFile = await this.createFeatureFileForFolder(
                        folderPath,
                        folderRequests,
                        variables,
                        outputDir,
                        options,
                        collection,
                        collectionPath,  // NEW: Pass collection path for file-based context
                        token
                    );

                    if (featureFile) {
                        result.createdFiles.push(featureFile);
                        result.featuresCreated++;
                    }
                }
            } else {
                // Create single feature file
                const featureFile = await this.createSingleFeatureFile(
                    collection.info.name,
                    requests,
                    variables,
                    outputDir,
                    options,
                    collection
                );

                if (featureFile) {
                    result.createdFiles.push(featureFile);
                    result.featuresCreated++;
                }
            }

            // Check for unsupported features
            result.unsupportedFeatures = this.detectUnsupportedFeatures(collection);

            result.success = true;
            logger.info(`Successfully imported ${result.featuresCreated} feature files`);

        } catch (error) {
            logger.error('Failed to import collection', error as Error);
            result.warnings.push(`Import failed: ${error}`);
        }

        return result;
    }

    /**
     * Group requests by folder path
     */
    private groupRequestsByFolder(
        requests: Array<{ request: any; path: string[] }>
    ): Map<string, Array<{ request: any; path: string[] }>> {
        const folderMap = new Map<string, Array<{ request: any; path: string[] }>>();

        for (const req of requests) {
            // Use folder path (excluding request name)
            const folderPath = req.path.slice(0, -1).join('/') || 'root';

            if (!folderMap.has(folderPath)) {
                folderMap.set(folderPath, []);
            }

            folderMap.get(folderPath)!.push(req);
        }

        return folderMap;
    }

    /**
     * Create feature file for a folder
     */
    private async createFeatureFileForFolder(
        folderPath: string,
        requests: Array<{ request: any; path: string[] }>,
        variables: Map<string, string>,
        outputDir: string,
        options: ImportOptions,
        collection: PostmanCollection,
        collectionPath: string,  // NEW: Collection file path for file-based context
        token?: vscode.CancellationToken
    ): Promise<string | null> {
        try {
            const scenarios: string[] = [];

            for (const { request, path: reqPath } of requests) {
                const scenarioName = reqPath[reqPath.length - 1];

                const scenario = this.converter.convertRequest(
                    request,
                    scenarioName,
                    variables
                );

                scenarios.push(scenario);
                scenarios.push(''); // Empty line between scenarios
            }

            // Create feature file
            const featureName = folderPath === 'root' ? collection.info.name : folderPath.split('/').pop()!;
            let featureContent = this.converter.createFeatureFile(featureName, scenarios, variables);

            // Enhance with Copilot if enabled
            if (options.useCopilot) {
                try {
                    const { CopilotService } = await import('./copilotService');
                    const isAvailable = await CopilotService.isCopilotAvailable();

                    if (isAvailable) {
                        logger.info(`Enhancing ${featureName} with Copilot...`);
                        featureContent = await this.enhanceWithCopilot(
                            featureContent,
                            collection,
                            requests,
                            collectionPath,  // NEW: Pass collection path
                            options.environmentFile,  // NEW: Pass environment file if present
                            token
                        );
                    }
                } catch (error) {
                    logger.warn('Copilot enhancement failed, using basic conversion', error as Error);
                }
            }

            // Determine output path
            const fileName = this.sanitizeFileName(featureName) + '.feature';
            const fullPath = path.join(outputDir, folderPath === 'root' ? '' : folderPath, fileName);

            // Ensure directory exists
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // Write file
            FileUtils.writeFile(fullPath, featureContent);
            logger.info(`Created feature file: ${fullPath}`);

            return fullPath;
        } catch (error) {
            logger.error(`Failed to create feature file for ${folderPath}`, error as Error);
            return null;
        }
    }

    /**
     * Enhance converted Karate test with Copilot using file-based context
     */
    private async enhanceWithCopilot(
        karateContent: string,
        collection: PostmanCollection,
        requests: Array<{ request: any; path: string[] }>,
        collectionPath: string,  // NEW: Collection file path
        environmentPath?: string,  // NEW: Environment file path
        token?: vscode.CancellationToken
    ): Promise<string> {
        const { CopilotService } = await import('./copilotService');

        // Build detailed context
        const requestDetails = requests.map(r => {
            const req = r.request;
            return `- ${req.method} ${typeof req.url === 'string' ? req.url : req.url.raw}`;
        }).join('\n');

        const context = `Convert Postman collection to production-ready Karate tests: ${collection.info.name}

Original Endpoints:
${requestDetails}

STRICT REQUIREMENTS:
- Use ONLY requests defined in the attached Postman collection
- NO hallucinations or invented endpoints
- Convert all test scripts to proper Karate assertions
- Transform pre-request scripts to Karate JavaScript
- Map Postman variables to Karate syntax: {{var}} → #(var)
- Include authentication setup from collection
- Generate comprehensive assertions for all scenarios
- Handle error cases and validation

CONVERSION GUIDELINES:
1. Status codes → Then status/And status
2. pm.expect() → And match/And assert
3. pm.environment.set() → * def variable = value
4. Response time → And assert responseTime < N
5. Header checks → And match header X == value`;

        try {
            // NEW: Use file-based context with Agent Skills
            const files: any[] = [];

            // Attach collection file
            const collectionUri = CopilotService.createFileUri(collectionPath);
            files.push(collectionUri);

            // Attach environment file if provided
            if (environmentPath && fs.existsSync(environmentPath)) {
                const envUri = CopilotService.createFileUri(environmentPath);
                files.push(envUri);
                logger.info('Including environment file in context');
            }

            const enhanced = await CopilotService.enhanceTestWithFileContext(
                karateContent,
                context,
                'postman',
                files  // ~10-20 tokens instead of 1000s!
            );

            return enhanced || karateContent;
        } catch (error) {
            logger.error('Copilot enhancement failed', error as Error);
            return karateContent;
        }
    }

    /**
     * Create single feature file for all requests
     */
    private async createSingleFeatureFile(
        collectionName: string,
        requests: Array<{ request: any; path: string[] }>,
        variables: Map<string, string>,
        outputDir: string,
        options: ImportOptions,
        collection: PostmanCollection
    ): Promise<string | null> {
        try {
            const scenarios: string[] = [];

            for (const { request, path: reqPath } of requests) {
                const scenarioName = reqPath.join(' > ');

                const scenario = this.converter.convertRequest(
                    request,
                    scenarioName,
                    variables
                );

                scenarios.push(scenario);
                scenarios.push('');
            }

            const featureContent = this.converter.createFeatureFile(collectionName, scenarios, variables);

            const fileName = this.sanitizeFileName(collectionName) + '.feature';
            const fullPath = path.join(outputDir, fileName);

            FileUtils.writeFile(fullPath, featureContent);
            logger.info(`Created feature file: ${fullPath}`);

            return fullPath;
        } catch (error) {
            logger.error('Failed to create single feature file', error as Error);
            return null;
        }
    }

    /**
     * Sanitize file name
     */
    private sanitizeFileName(name: string): string {
        return name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');
    }

    /**
     * Detect unsupported features in collection
     */
    private detectUnsupportedFeatures(collection: PostmanCollection): string[] {
        const unsupported: string[] = [];

        // Check for OAuth2 (complex to convert)
        if (collection.auth?.type === 'oauth2') {
            unsupported.push('OAuth2 authentication (requires manual configuration)');
        }

        // Check for GraphQL
        const requests = this.parser.extractRequests(collection);
        for (const { request } of requests) {
            if (request.body?.mode === 'graphql') {
                unsupported.push('GraphQL requests (not yet supported)');
                break;
            }
        }

        return unsupported;
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
