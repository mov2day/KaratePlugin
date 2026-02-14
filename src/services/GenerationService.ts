import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { logger } from '../utils/logger';
import { FileUtils } from '../utils/fileUtils';
import { ConfigManager } from '../utils/configManager';
import { OpenAPIParser } from './openApiParser';
import { KarateGenerator } from './karateGenerator';
import { ConfluenceClient } from './confluenceClient';
import { ConfluenceParser } from './confluenceParser';
import { FeatureStructurer, StructuringOptions } from './FeatureStructurer';
import { ReusabilityEngine } from './ReusabilityEngine';
import { SpecHashManager, SpecMetadata } from './specHashManager';
import { GenerationOptions, KarateStyle, KarateTemplate } from '../types';

/**
 * Service to handle all test generation logic
 * Encapsulates OpenAPI, Confluence, and Combined generation workflows
 */
export class GenerationService {
    private _learnedStyle: KarateStyle | null = null;
    private _template: string | null = null;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly historyManager: any,
        private readonly specHashManager: SpecHashManager
    ) { }

    public setLearnedStyle(style: KarateStyle | null) {
        this._learnedStyle = style;
    }

    public setTemplate(templateContent: string | null) {
        this._template = templateContent;
    }

    /**
     * Generate tests from OpenAPI specification
     */
    public async generateFromOpenAPI(
        options: GenerationOptions,
        progressCallback: (message: string, percentage: number) => void
    ): Promise<{ files: string[], content: string }> {
        try {
            if (!options.filePath) throw new Error('OpenAPI file path is required');

            progressCallback('Parsing OpenAPI specification...', 30);
            const parser = new OpenAPIParser();
            let endpoints = await parser.parseSpec(options.filePath);

            if (options.httpMethods && options.httpMethods.length > 0) {
                endpoints = endpoints.filter(e => options.httpMethods!.includes(e.method.toLowerCase()));
            }

            progressCallback('Generating Karate tests...', 60);
            const generator = new KarateGenerator();
            this.configureGenerator(generator);

            const specFileName = path.basename(options.filePath, path.extname(options.filePath));
            const strategy = ConfigManager.getStructuringStrategy();
            const outputPath = FileUtils.resolveOutputPath();
            const createdFiles: string[] = [];
            let firstContent = '';

            if (strategy !== 'flat') {
                // Structured Generation
                const structOptions: StructuringOptions = {
                    strategy,
                    autoTag: ConfigManager.isAutoTagEnabled(),
                    outputRoot: outputPath
                };
                const structured = generator.generateStructured(endpoints, structOptions, options.scenarioTypes);

                for (const file of structured.files) {
                    let content = file.content;
                    if (options.useCopilot) {
                        progressCallback(`Enhancing ${file.featureName} with Copilot...`, 80);
                        content = await this.enhanceWithCopilot(content, file.featureName, 'openapi', options, [options.filePath]);
                    }

                    const outputFile = path.join(outputPath, file.relativePath);
                    const uniqueFile = FileUtils.getUniqueFilename(outputFile);
                    content = this.applyReusability(content, uniqueFile);
                    FileUtils.writeFile(uniqueFile, content);
                    createdFiles.push(uniqueFile);
                    if (!firstContent) firstContent = content;
                }
            } else {
                // Flat Generation
                const feature = generator.generateFromOpenAPI(endpoints, specFileName, options.scenarioTypes);
                feature.background = generator.generateBackground();
                let content = generator.featureToString(feature);

                if (options.useCopilot) {
                    progressCallback('Enhancing with GitHub Copilot...', 80);
                    content = await this.enhanceWithCopilot(content, specFileName, 'openapi', options, [options.filePath]);
                }

                const outputFile = path.join(outputPath, `${specFileName}.feature`);
                const uniqueFile = FileUtils.getUniqueFilename(outputFile);
                content = this.applyReusability(content, uniqueFile);
                FileUtils.writeFile(uniqueFile, content);
                createdFiles.push(uniqueFile);
                firstContent = content;
            }

            // Record History & Metadata
            await this.historyManager.addToHistory({
                type: 'openapi',
                source: options.filePath,
                outputPath: createdFiles[0],
                template: ConfigManager.getTestTemplate()
            });
            await this.saveSpecMetadata(options.filePath, endpoints, createdFiles[0]);

            return { files: createdFiles, content: firstContent };

        } catch (error) {
            logger.error('Failed to generate from OpenAPI', error as Error);
            throw error;
        }
    }

    /**
     * Generate tests from Confluence
     */
    public async generateFromConfluence(
        options: GenerationOptions,
        progressCallback: (message: string, percentage: number) => void
    ): Promise<{ files: string[], content: string }> {
        try {
            if (!options.pageUrl) throw new Error('Confluence Page URL is required');

            progressCallback('Fetching Confluence page...', 30);
            const { page, scenarios } = await this.fetchConfluenceData(options.pageUrl);

            progressCallback('Generating Karate tests...', 60);
            const generator = new KarateGenerator();
            this.configureGenerator(generator);

            const feature = {
                name: page.title,
                description: `Test scenarios from Confluence page ${page.id}`,
                scenarios,
                background: generator.generateBackground()
            };

            let content = generator.featureToString(feature as any);

            if (options.useCopilot) {
                progressCallback('Enhancing with GitHub Copilot...', 80);
                const confluenceContent = page.body.storage?.value || page.body.view?.value || '';
                const { CopilotService } = await import('./copilotService');
                const isAvailable = await CopilotService.isCopilotAvailable();

                if (isAvailable) {
                    let tempUri: vscode.Uri | null = null;
                    try {
                        tempUri = await CopilotService.createTempFile(confluenceContent, '.html');
                        const context = `Generate comprehensive Karate API tests from Confluence documentation: ${page.title} with ${scenarios.length} scenarios.`;
                        content = await CopilotService.enhanceTestWithFileContext(content, context, 'confluence', [tempUri]);
                    } finally {
                        if (tempUri) await CopilotService.cleanupTempFiles();
                    }
                }
            }

            const outputPath = FileUtils.resolveOutputPath();
            const sanitizedTitle = page.title.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
            const outputFile = path.join(outputPath, `${sanitizedTitle}.feature`);
            const uniqueFile = FileUtils.getUniqueFilename(outputFile);
            content = this.applyReusability(content, uniqueFile);
            FileUtils.writeFile(uniqueFile, content);

            await this.historyManager.addToHistory({
                type: 'confluence',
                source: options.pageUrl,
                outputPath: uniqueFile,
                template: ConfigManager.getTestTemplate()
            });

            return { files: [uniqueFile], content };

        } catch (error) {
            logger.error('Failed to generate from Confluence', error as Error);
            throw error;
        }
    }

    /**
     * Combined Generation (OpenAPI + Confluence)
     */
    public async generateCombined(
        options: GenerationOptions,
        progressCallback: (message: string, percentage: number) => void
    ): Promise<{ files: string[], content: string }> {
        try {
            if (!options.openApiPath || !options.confluenceUrl) throw new Error('Both OpenAPI path and Confluence URL are required');

            progressCallback('Processing both sources...', 20);

            // 1. Parse OpenAPI
            const parser = new OpenAPIParser();
            let endpoints = await parser.parseSpec(options.openApiPath);
            if (options.httpMethods && options.httpMethods.length > 0) {
                endpoints = endpoints.filter(e => options.httpMethods!.includes(e.method.toLowerCase()));
            }

            // 2. Fetch Confluence
            const { page, scenarios: confluenceScenarios } = await this.fetchConfluenceData(options.confluenceUrl);
            const confluenceContent = page.body.storage?.value || page.body.view?.value || '';

            progressCallback('Generating combined tests...', 60);
            const generator = new KarateGenerator();
            this.configureGenerator(generator);

            const specFileName = path.basename(options.openApiPath, path.extname(options.openApiPath));
            const openApiScenarios = generator.generateFromOpenAPI(endpoints, specFileName, options.scenarioTypes).scenarios;
            const mergedScenarios = [...confluenceScenarios, ...openApiScenarios];

            const strategy = ConfigManager.getStructuringStrategy();
            const outputPath = FileUtils.resolveOutputPath();
            const createdFiles: string[] = [];
            let firstContent = '';

            if (strategy !== 'flat') {
                const structOptions: StructuringOptions = {
                    strategy,
                    autoTag: ConfigManager.isAutoTagEnabled(),
                    outputRoot: outputPath
                };
                const structured = FeatureStructurer.structureCombined(mergedScenarios, endpoints, confluenceContent, structOptions);

                for (const file of structured.files) {
                    let content = file.content;
                    if (options.useCopilot) {
                        progressCallback(`Enhancing ${file.featureName} with Copilot...`, 80);
                        const { CopilotService } = await import('./copilotService');
                        if (await CopilotService.isCopilotAvailable()) {
                            let tempUri: vscode.Uri | null = null;
                            try {
                                const files = [CopilotService.createFileUri(options.openApiPath)];
                                tempUri = await CopilotService.createTempFile(confluenceContent, '.html');
                                files.push(tempUri);

                                const context = this.buildEnhancementContext(file.featureName, 'combined', options, specFileName, page.title);
                                content = await CopilotService.enhanceTestWithFileContext(content, context, 'combined', files);
                            } finally {
                                if (tempUri) await CopilotService.cleanupTempFiles();
                            }
                        }
                    }

                    const outputFile = path.join(outputPath, file.relativePath);
                    const uniqueFile = FileUtils.getUniqueFilename(outputFile);
                    content = this.applyReusability(content, uniqueFile);
                    FileUtils.writeFile(uniqueFile, content);
                    createdFiles.push(uniqueFile);
                    if (!firstContent) firstContent = content;
                }
            } else {
                const feature = {
                    name: `${specFileName} - ${page.title}`,
                    description: `Combined AI tests: OpenAPI (${specFileName}) + Confluence (${page.title})`,
                    scenarios: mergedScenarios,
                    background: generator.generateBackground()
                };
                let content = generator.featureToString(feature as any);

                if (options.useCopilot) {
                    progressCallback('Enhancing with GitHub Copilot...', 80);
                    const { CopilotService } = await import('./copilotService');
                    if (await CopilotService.isCopilotAvailable()) {
                        let tempUri: vscode.Uri | null = null;
                        try {
                            const files = [CopilotService.createFileUri(options.openApiPath)];
                            tempUri = await CopilotService.createTempFile(confluenceContent, '.html');
                            files.push(tempUri);

                            const context = this.buildEnhancementContext(`${specFileName} - ${page.title}`, 'combined', options, specFileName, page.title);
                            content = await CopilotService.enhanceTestWithFileContext(content, context, 'combined', files);
                        } finally {
                            if (tempUri) await CopilotService.cleanupTempFiles();
                        }
                    }
                }

                const outputFile = path.join(outputPath, `${specFileName}_combined.feature`);
                const uniqueFile = FileUtils.getUniqueFilename(outputFile);
                content = this.applyReusability(content, uniqueFile);
                FileUtils.writeFile(uniqueFile, content);
                createdFiles.push(uniqueFile);
                firstContent = content;
            }

            await this.historyManager.addToHistory({
                type: 'combined',
                source: options.openApiPath,
                secondarySource: options.confluenceUrl,
                outputPath: createdFiles[0],
                template: ConfigManager.getTestTemplate()
            });

            return { files: createdFiles, content: firstContent };

        } catch (error) {
            logger.error('Failed to generate combined tests', error as Error);
            throw error;
        }
    }

    // --- Helper Methods ---

    private configureGenerator(generator: KarateGenerator) {
        if (this._learnedStyle) generator.setStyle(this._learnedStyle);
        if (this._template) generator.setTemplate(this._template);
    }

    private async enhanceWithCopilot(content: string, name: string, type: 'openapi' | 'confluence' | 'custom', options: GenerationOptions, filePaths: string[]): Promise<string> {
        const { CopilotService } = await import('./copilotService');
        const isAvailable = await CopilotService.isCopilotAvailable();

        if (isAvailable) {
            const context = this.buildEnhancementContext(name, type, options);
            const uris = filePaths.map(p => CopilotService.createFileUri(p));
            return await CopilotService.enhanceTestWithFileContext(content, context, type as any, uris);
        }
        return content;
    }

    private buildEnhancementContext(name: string, type: string, options: GenerationOptions, specName?: string, pageTitle?: string): string {
        const typesStr = options.scenarioTypes?.length ? ` Scenario types: ${options.scenarioTypes.join(', ')}.` : '';
        const instrStr = options.customInstruction ? ` Custom instruction: ${options.customInstruction}` : '';
        const methodsStr = options.httpMethods?.length ? ` HTTP methods: ${options.httpMethods.join(', ').toUpperCase()}.` : '';

        if (type === 'openapi') {
            return `Enhance Karate API tests for ${name} from OpenAPI specification.${methodsStr}${typesStr}${instrStr}`;
        } else if (type === 'combined') {
            return `Enhance Karate API tests for ${name} combining OpenAPI + Confluence: ${specName} + ${pageTitle}.${methodsStr}${typesStr}${instrStr}`;
        }
        return `Enhance Karate API tests for ${name} from documentation.${typesStr}${instrStr}`;
    }

    private async fetchConfluenceData(url: string) {
        let pageId = url.trim();
        if (url.startsWith('http')) {
            pageId = ConfluenceClient.extractPageIdFromUrl(url) || pageId;
        }

        const baseUrl = ConfigManager.getConfluenceBaseUrl();
        const email = ConfigManager.getConfluenceEmail();
        const apiToken = await ConfigManager.getConfluenceApiToken(this.context);
        const authType = vscode.workspace.getConfiguration('karateDsl.confluence').get<'basic' | 'bearer'>('authType', 'basic');

        const client = new ConfluenceClient(baseUrl, email || "", apiToken, authType);
        const page = await client.getPageById(pageId);

        const parser = new ConfluenceParser();
        const testData = parser.parsePageContent(page);

        // Re-use logic from WebviewProvider to create scenarios from test data
        // For cleaner code, we duplicate the simple mapping logic here or make it static in parser
        const scenarios = this.mapConfluenceDataToScenarios(testData);

        return { page, scenarios };
    }

    private mapConfluenceDataToScenarios(testData: any): any[] {
        const scenarios: any[] = [];
        for (const testCase of testData.testCases) {
            const steps: any[] = [];
            for (let i = 0; i < testCase.steps.length; i++) {
                steps.push({
                    keyword: i === 0 ? 'Given' : 'And',
                    text: `# ${testCase.steps[i]}`
                });
            }
            steps.push({ keyword: 'When', text: 'method get # TODO: Replace with actual API call' });
            if (testCase.expectedResult) {
                steps.push({ keyword: 'Then', text: `# Expected: ${testCase.expectedResult}` });
            }
            scenarios.push({
                name: testCase.name,
                description: testCase.description,
                steps
            });
        }
        return scenarios;
    }

    private applyReusability(content: string, outputPath: string): string {
        const result = ReusabilityEngine.extract(content);
        const createdPaths = new Set<string>();

        if (result.commonFiles.length > 0) {
            const commonDir = ReusabilityEngine.getCommonDir(outputPath);
            for (const file of result.commonFiles) {
                const filePath = path.join(commonDir, path.basename(file.path));
                FileUtils.writeFile(filePath, file.content);
                createdPaths.add(path.basename(file.path));
            }
            logger.info(`ReusabilityEngine: extracted ${result.commonFiles.length} common file(s) to ${commonDir}`);
        }

        // Phantom reference handling (Copied logic from WebviewProvider to keep it self-contained)
        // Ideally this should be in ReusabilityEngine itself but keeping scope limited to refactoring
        const readRefPattern = /read\(['"]common\/([^'"]+)['"]\)/g;
        let match: RegExpExecArray | null;
        while ((match = readRefPattern.exec(result.modifiedContent)) !== null) {
            const refFilename = match[1];
            if (!createdPaths.has(refFilename)) {
                const commonDir = ReusabilityEngine.getCommonDir(outputPath);
                const stubPath = path.join(commonDir, refFilename);
                if (!fs.existsSync(stubPath)) {
                    this.createStubFile(stubPath, refFilename);
                    createdPaths.add(refFilename);
                }
            }
        }

        return result.modifiedContent;
    }

    private createStubFile(stubPath: string, refFilename: string) {
        const featureName = refFilename.replace('.feature', '').replace(/-/g, ' ');
        let steps = ['  # TODO: Implement this shared helper', `  * def result = 'placeholder'`];

        if (refFilename.includes('setup')) {
            steps = ["  * def baseUrl = karate.properties['baseUrl'] || 'http://localhost:8080'", '  * url baseUrl', '  * configure ssl = true'];
        } else if (refFilename.includes('auth')) {
            steps = ["  * def token = 'mock-token-123'", "  * def authHeader = { Authorization: 'Bearer ' + token }"];
        } else if (refFilename.includes('headers')) {
            steps = ["  * def headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' }"];
        }

        const stubContent = [
            `Feature: ${featureName.charAt(0).toUpperCase() + featureName.slice(1)} Helper`,
            '',
            `Scenario: ${featureName}`,
            ...steps,
            '',
        ].join('\n');
        FileUtils.writeFile(stubPath, stubContent);
        logger.info(`ReusabilityEngine: created stub for phantom reference common/${refFilename}`);
    }

    private async saveSpecMetadata(specPath: string, endpoints: any[], testFilePath: string): Promise<void> {
        try {
            const specContent = fs.readFileSync(specPath, 'utf-8');
            const specHash = crypto.createHash('sha256').update(specContent).digest('hex');
            const specVersion = specContent.includes('"openapi"') ? '3.0' : '2.0';

            const metadata: SpecMetadata = {
                specPath: specPath,
                specHash: specHash,
                generatedTests: [testFilePath],
                lastGenerated: Date.now(),
                endpoints: endpoints.map(e => ({
                    path: e.path,
                    method: e.method,
                    operationId: e.operationId,
                    testScenarioName: `Test ${e.method} ${e.path}`,
                    testFilePath: testFilePath
                })),
                version: specVersion
            };

            await this.specHashManager.saveMetadata(metadata);
            logger.info(`Saved metadata for spec: ${path.basename(specPath)}`);
        } catch (error) {
            logger.error('Failed to save spec metadata', error as Error);
        }
    }
}
