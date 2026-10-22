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
import { ReusabilityEngine } from './ReusabilityEngine';
import { SpecHashManager, SpecMetadata } from './specHashManager';
import { GenerationOptions, KarateStyle, KarateTemplate } from '../types';
import { SharedStyleService } from './SharedStyleService';
import { categoriesForScenarioTypes } from '../generation/config/ScenarioTypes';
import type { GeneratorConfig } from '../generation/config/GeneratorConfig';
import type { GenerationModel } from '../generation/model/TestModel';
import { requirementsFeature } from '../generation/plan/RequirementDrafts';
import type { PlannedFeature } from '../generation/plan/OpenApiPlanner';
import type { GenerationSummary } from '../generation/pipeline/Summary';
import { runGenerationForModel } from '../generation/vscode/runGeneration';

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
     * Generate tests from OpenAPI specification (via the generation pipeline)
     */
    public async generateFromOpenAPI(
        options: GenerationOptions,
        progressCallback: (message: string, percentage: number) => void
    ): Promise<{ files: string[], content: string, summary: GenerationSummary }> {
        try {
            if (!options.filePath) throw new Error('OpenAPI file path is required');

            progressCallback('Parsing OpenAPI specification...', 2);
            const model = await this.parseFilteredModel(options.filePath, options.httpMethods);
            const run = await this.runPipelineFor(model, options.filePath, 'openapi', options, progressCallback);
            const createdFiles = run.createdPaths;

            // Record History & Metadata
            await this.historyManager.addToHistory({
                type: 'openapi',
                source: options.filePath,
                outputPath: createdFiles[0],
                template: ConfigManager.getTestTemplate()
            });
            await this.saveSpecMetadata(options.filePath, this.endpointsOf(model), createdFiles[0]);

            return { files: createdFiles, content: run.firstContent, summary: run.summary };

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
     * Combined Generation (OpenAPI + Confluence). The OpenAPI part runs through the pipeline; Confluence test cases
     * become a separate all-draft requirements feature until real requirement mapping lands.
     */
    public async generateCombined(
        options: GenerationOptions,
        progressCallback: (message: string, percentage: number) => void
    ): Promise<{ files: string[], content: string, summary: GenerationSummary }> {
        try {
            if (!options.openApiPath || !options.confluenceUrl) throw new Error('Both OpenAPI path and Confluence URL are required');

            progressCallback('Processing both sources...', 2);
            const model = await this.parseFilteredModel(options.openApiPath, options.httpMethods);
            const { page, scenarios: confluenceScenarios } = await this.fetchConfluenceData(options.confluenceUrl);
            const confluenceContent = page.body.storage?.value || page.body.view?.value || '';

            const specFileName = path.basename(options.openApiPath, path.extname(options.openApiPath));
            const draft = requirementsFeature(specFileName, page.title, confluenceScenarios.map((sc: any) => ({
                name: sc.name,
                description: sc.description,
                steps: (sc.steps || [])
                    .map((st: any) => String(st.text))
                    .filter((t: string) => t.startsWith('# ') && !t.startsWith('# Expected: '))
                    .map((t: string) => t.slice(2)),
                expectedResult: (sc.steps || []).map((st: any) => /^# Expected: (.*)$/.exec(String(st.text))?.[1]).find(Boolean)
            })));

            const run = await this.runPipelineFor(model, options.openApiPath, 'combined', options, progressCallback, {
                extraFeatures: draft ? [draft] : undefined,
                evidence: confluenceContent ? [{ label: `Confluence: ${page.title}`, text: confluenceContent.slice(0, 20000) }] : undefined
            });
            const createdFiles = run.createdPaths;

            await this.historyManager.addToHistory({
                type: 'combined',
                source: options.openApiPath,
                secondarySource: options.confluenceUrl,
                outputPath: createdFiles[0],
                template: ConfigManager.getTestTemplate()
            });

            return { files: createdFiles, content: run.firstContent, summary: run.summary };

        } catch (error) {
            logger.error('Failed to generate combined tests', error as Error);
            throw error;
        }
    }

    // --- Helper Methods ---

    private configureGenerator(generator: KarateGenerator) {
        const sharedStyle = SharedStyleService.loadSharedStyle();
        if (sharedStyle) {
            generator.setStyle(sharedStyle);
        } else if (this._learnedStyle) {
            generator.setStyle(this._learnedStyle);
        }
        if (this._template) generator.setTemplate(this._template);
    }

    private async parseFilteredModel(specPath: string, httpMethods?: string[]): Promise<GenerationModel> {
        const model = await new OpenAPIParser().parseModel(specPath);
        if (httpMethods && httpMethods.length > 0) {
            const wanted = httpMethods.map(m => m.toLowerCase());
            model.operations = model.operations.filter(o => wanted.includes(o.method.toLowerCase()));
        }
        if (model.operations.length === 0) {
            throw new Error('No operations found in the OpenAPI specification for the selected HTTP methods');
        }
        return model;
    }

    private endpointsOf(model: GenerationModel): { path: string; method: string; operationId: string }[] {
        return model.operations.map(o => ({ path: o.path, method: o.method.toUpperCase(), operationId: o.id }));
    }

    private async runPipelineFor(
        model: GenerationModel,
        specPath: string,
        mode: 'openapi' | 'combined',
        options: GenerationOptions,
        progressCallback: (message: string, percentage: number) => void,
        extras: { extraFeatures?: PlannedFeature[]; evidence?: { label: string; text: string }[] } = {}
    ) {
        const workspaceRoot = FileUtils.getWorkspaceRoot();
        if (!workspaceRoot) throw new Error('No workspace folder is open');

        const run = await runGenerationForModel({
            context: this.context,
            workspaceRoot,
            model,
            sourceRef: path.basename(specPath),
            mode,
            useAi: options.useCopilot,
            extraFeatures: extras.extraFeatures,
            evidence: extras.evidence,
            customInstruction: options.customInstruction,
            configure: (c: GeneratorConfig) => ({
                ...c,
                scenarios: { ...c.scenarios, categories: categoriesForScenarioTypes(options.scenarioTypes, c.scenarios.categories) }
            }),
            progress: progressCallback
        });
        if (run.createdPaths.length === 0) {
            throw new Error(`No feature files were generated. ${run.warnings.join('; ')}`.trim());
        }
        return run;
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
