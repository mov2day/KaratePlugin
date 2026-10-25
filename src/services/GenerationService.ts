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
import { SpecHashManager, SpecMetadata } from './specHashManager';
import { GenerationOptions, KarateStyle, KarateTemplate } from '../types';
import { SharedStyleService } from './SharedStyleService';
import { categoriesForScenarioTypes } from '../generation/config/ScenarioTypes';
import type { GeneratorConfig } from '../generation/config/GeneratorConfig';
import type { GenerationModel } from '../generation/model/TestModel';
import { buildRequirementScenarios, confluenceRequirementItems } from '../generation/adapters/requirements';
import type { RequirementBuild } from '../generation/adapters/requirements';
import { GeneratorConfigLoader } from '../generation/vscode/GeneratorConfigLoader';
import { requirementEvidence } from '../generation/vscode/RequirementsRun';
import { slug } from '../generation/plan/slug';
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
    ): Promise<{ files: string[], content: string, summary: GenerationSummary }> {
        try {
            if (!options.pageUrl) throw new Error('Confluence Page URL is required');
            const workspaceRoot = FileUtils.getWorkspaceRoot();
            if (!workspaceRoot) throw new Error('No workspace folder is open');

            progressCallback('Fetching Confluence page...', 10);
            const { page, testData } = await this.fetchConfluenceData(options.pageUrl);
            const pageContent = page.body.storage?.value || page.body.view?.value || '';

            // Test cases become drafts (no contract is linked from here); the pipeline gates every feature.
            const loaded = await GeneratorConfigLoader.load(workspaceRoot, { fallbackStyle: this._learnedStyle });
            const req = buildRequirementScenarios(confluenceRequirementItems({ id: String(page.id), title: page.title }, testData), {
                config: loaded.config, name: slug(page.title) || `page-${page.id}`
            });
            if (req.features.length === 0) {
                throw new Error(`No test cases or flows found in the Confluence page. ${req.warnings.join('; ')}`.trim());
            }
            const notes = [...req.warnings, `Requirements written to ${req.features.map(f => f.relativePath).join(', ')} (under the generator output root)`];
            if (this._template) {
                const note = `Template '${options.templateId ?? 'custom'}' is ignored by the Karate v2 generator (use .karate-generator.json style/layout)`;
                logger.info(note);
                notes.push(note);
            }
            const run = await runGenerationForModel({
                context: this.context, workspaceRoot,
                model: { source: 'confluence', name: slug(page.title) || 'confluence', schemes: [], operations: [], unsupported: [] },
                sourceRef: `Confluence page ${page.id}`, mode: 'confluence', useAi: options.useCopilot,
                scenarios: req.features, classpathFiles: req.files, config: loaded.config, notes,
                evidence: requirementEvidence(`Confluence: ${page.title}`, pageContent),
                learnedStyle: this._learnedStyle,
                progress: (message, pct) => progressCallback(message, 15 + Math.round(pct * 0.85))
            });
            if (run.createdPaths.length === 0) {
                throw new Error(`No feature files were generated. ${run.warnings.join('; ')}`.trim());
            }

            await this.historyManager.addToHistory({
                type: 'confluence',
                source: options.pageUrl,
                outputPath: run.createdPaths[0],
                template: ConfigManager.getTestTemplate()
            });

            return { files: run.createdPaths, content: run.firstContent, summary: run.summary };

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
            const { page, testData } = await this.fetchConfluenceData(options.confluenceUrl);
            const confluenceContent = page.body.storage?.value || page.body.view?.value || '';

            const specFileName = path.basename(options.openApiPath, path.extname(options.openApiPath));
            const workspaceRoot = FileUtils.getWorkspaceRoot();
            if (!workspaceRoot) throw new Error('No workspace folder is open');
            const loaded = await GeneratorConfigLoader.load(workspaceRoot, { fallbackStyle: this._learnedStyle });
            // Requirements link to real operations of the same contract; unmatched ones stay honest drafts.
            const req: RequirementBuild = buildRequirementScenarios(confluenceRequirementItems({ id: String(page.id), title: page.title }, testData), {
                config: loaded.config, name: specFileName, model
            });

            const run = await this.runPipelineFor(model, options.openApiPath, 'combined', options, progressCallback, {
                extraFeatures: req.features.length > 0 ? req.features : undefined,
                classpathFiles: req.files,
                notes: [...req.warnings, `Requirements written to ${req.features.map(f => f.relativePath).join(', ')} (under the generator output root)`],
                evidence: requirementEvidence(`Confluence: ${page.title}`, confluenceContent)
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
        extras: { extraFeatures?: PlannedFeature[]; classpathFiles?: { path: string; content: string; owner: 'user' | 'generated' }[]; notes?: string[]; evidence?: { label: string; text: string }[] } = {}
    ) {
        const workspaceRoot = FileUtils.getWorkspaceRoot();
        if (!workspaceRoot) throw new Error('No workspace folder is open');

        const notes: string[] = [];
        if (this._template) {
            const note = `Template '${options.templateId ?? 'custom'}' is ignored by the Karate v2 generator (use .karate-generator.json style/layout)`;
            logger.info(note);
            notes.push(note);
        }

        const run = await runGenerationForModel({
            context: this.context,
            workspaceRoot,
            model,
            sourceRef: path.basename(specPath),
            mode,
            useAi: options.useCopilot,
            extraFeatures: extras.extraFeatures,
            classpathFiles: extras.classpathFiles,
            evidence: extras.evidence,
            customInstruction: options.customInstruction,
            learnedStyle: this._learnedStyle,
            notes: [...notes, ...(extras.notes ?? [])],
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

        const testData = new ConfluenceParser().parsePageContent(page);
        return { page, testData };
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
