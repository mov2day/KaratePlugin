import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { OpenAPIParser } from '../services/openApiParser';
import { KarateGenerator } from '../services/karateGenerator';
import { FeatureStructurer, StructuringOptions } from '../services/FeatureStructurer';
import { ReusabilityEngine } from '../services/ReusabilityEngine';
import { ConfluenceClient } from '../services/confluenceClient';
import { ConfluenceParser } from '../services/confluenceParser';
import { ConfigManager } from '../utils/configManager';
import { FileUtils } from '../utils/fileUtils';
import { logger } from '../utils/logger';
import { SpecHashManager, SpecMetadata } from '../services/specHashManager';

export class KarateWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'karateGenerator.mainView';
    private _view?: vscode.WebviewView;
    private _historyManager: any;
    private _templateManager: any;
    private _learnedStyle: any = null;

    /**
     * Process feature content through ReusabilityEngine.
     * Extracts common patterns (auth, setup, headers, etc.) into shared feature files.
     */
    private applyReusability(content: string, outputPath: string): string {
        const result = ReusabilityEngine.extract(content);

        // Collect which common files the engine creates
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

        // Scan for phantom read('common/...') references from Copilot and create stubs
        const readRefPattern = /read\(['"]common\/([^'"]+)['"]\)/g;
        let match: RegExpExecArray | null;
        while ((match = readRefPattern.exec(result.modifiedContent)) !== null) {
            const refFilename = match[1];
            if (!createdPaths.has(refFilename)) {
                const commonDir = ReusabilityEngine.getCommonDir(outputPath);
                const stubPath = path.join(commonDir, refFilename);
                // Only create stub if the file doesn't already exist
                if (!fs.existsSync(stubPath)) {
                    const featureName = refFilename.replace('.feature', '').replace(/-/g, ' ');
                    let steps = [
                        '  # TODO: Implement this shared helper',
                        `  * def result = 'placeholder'`
                    ];

                    // Smart defaults based on filename
                    if (refFilename.includes('setup')) {
                        steps = [
                            "  * def baseUrl = karate.properties['baseUrl'] || 'http://localhost:8080'",
                            '  * url baseUrl',
                            '  * configure ssl = true'
                        ];
                    } else if (refFilename.includes('auth')) {
                        steps = [
                            "  * def token = 'mock-token-123'",
                            "  * def authHeader = { Authorization: 'Bearer ' + token }"
                        ];
                    } else if (refFilename.includes('headers')) {
                        steps = [
                            "  * def headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' }"
                        ];
                    } else if (refFilename.includes('data')) {
                        steps = [
                            "  * def data = { id: 1, name: 'Test Item' }"
                        ];
                    }

                    const stubContent = [
                        `Feature: ${featureName.charAt(0).toUpperCase() + featureName.slice(1)} Helper`,
                        '',
                        `Scenario: ${featureName}`,
                        ...steps,
                        '',
                    ].join('\n');
                    FileUtils.writeFile(stubPath, stubContent);
                    createdPaths.add(refFilename);
                    logger.info(`ReusabilityEngine: created stub for phantom reference common/${refFilename}`);
                }
            }
        }

        return result.modifiedContent;
    }
    private _specHashManager: SpecHashManager;

    constructor(private readonly _extensionUri: vscode.Uri, private readonly _context: vscode.ExtensionContext) {
        // Initialize SpecHashManager for AI-Powered Test Maintenance
        this._specHashManager = new SpecHashManager(_context);
    }

    public postMessageToWebview(message: any) {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Initialize managers
        const { HistoryManager } = require('../services/historyManager');
        const { TemplateManager } = require('../services/templateManager');
        this._historyManager = new HistoryManager(this._context);
        this._templateManager = new TemplateManager(this._context);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.command) {
                case 'selectOpenAPIFile':
                    await this.handleSelectOpenAPIFile();
                    break;
                case 'generateFromOpenAPI':
                    await this.handleGenerateFromOpenAPI(data.filePath, data.useCopilot, data.templateId, data.scenarioTypes, data.httpMethods, data.customInstruction);
                    break;
                case 'generateFromConfluence':
                    await this.handleGenerateFromConfluence(data.pageUrl, data.useCopilot, data.templateId);
                    break;
                case 'generateCombined':
                    await this.handleGenerateCombined(data.openApiPath, data.confluenceUrl, data.useCopilot, data.templateId, data.scenarioTypes, data.httpMethods, data.customInstruction);
                    break;
                case 'getConfig':
                    await this.sendConfig();
                    break;
                case 'saveConfig':
                    await this.handleSaveConfig(data.config);
                    break;
                case 'getHistory':
                    await this.sendHistory();
                    break;
                case 'getTemplates':
                    await this.sendTemplates();
                    break;
                case 'saveTemplate':
                    await this.handleSaveTemplate(data.template);
                    break;
                case 'learnStyle':
                    await this.handleLearnStyle(data.filePath);
                    break;
                case 'openGeneratedFile':
                    await this.handleOpenGeneratedFile(data.filePath);
                    break;
                case 'copyToClipboard':
                    await this.handleCopyToClipboard(data.content);
                    break;
                case 'syncTests':
                    await this.handleSyncTests(data.specPath, data.updatePlan);
                    break;
                case 'launchCoverageDashboard':
                    await vscode.commands.executeCommand('karate-dsl.showCoverageDashboard');
                    break;
            }
        });
    }

    private async handleSelectOpenAPIFile() {
        const fileUri = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Select OpenAPI Spec',
            filters: {
                'OpenAPI Spec': ['json', 'yaml', 'yml']
            }
        });

        if (fileUri && fileUri.length > 0) {
            this._view?.webview.postMessage({
                type: 'fileSelected',
                filePath: fileUri[0].fsPath
            });
        }
    }

    private async handleGenerateFromOpenAPI(filePath: string, useCopilot: boolean, templateId?: string, scenarioTypes?: string[], httpMethods?: string[], customInstruction?: string) {
        try {
            this.sendProgress('Parsing OpenAPI specification...', 30);

            const parser = new OpenAPIParser();
            let endpoints = await parser.parseSpec(filePath);

            // Filter by HTTP methods if specified
            if (httpMethods && httpMethods.length > 0) {
                endpoints = endpoints.filter(e => httpMethods.includes(e.method.toLowerCase()));
            }

            this.sendProgress('Generating Karate tests...', 60);

            const generator = new KarateGenerator();
            if (this._learnedStyle) {
                generator.setStyle(this._learnedStyle);
            }
            if (templateId) {
                const template = await this._templateManager.getTemplate(templateId);
                if (template) {
                    generator.setTemplate(template.content);
                }
            }

            const specFileName = path.basename(filePath, path.extname(filePath));
            const strategy = ConfigManager.getStructuringStrategy();
            const outputPath = FileUtils.resolveOutputPath();

            if (strategy !== 'flat') {
                // Structured output: multiple domain-grouped files
                const options: StructuringOptions = {
                    strategy,
                    autoTag: ConfigManager.isAutoTagEnabled(),
                    outputRoot: outputPath
                };

                const structured = generator.generateStructured(endpoints, options, scenarioTypes);

                // Copilot enhancement per file
                const createdFiles: string[] = [];
                for (const file of structured.files) {
                    let content = file.content;

                    if (useCopilot) {
                        this.sendProgress(`Enhancing ${file.featureName} with Copilot...`, 80);
                        const { CopilotService } = await import('../services/copilotService');
                        const isAvailable = await CopilotService.isCopilotAvailable();

                        if (isAvailable) {
                            const typesStr = scenarioTypes?.length ? ` Scenario types: ${scenarioTypes.join(', ')}.` : '';
                            const instrStr = customInstruction ? ` Custom instruction: ${customInstruction}` : '';
                            const methodsStr = httpMethods?.length ? ` HTTP methods: ${httpMethods.join(', ').toUpperCase()}.` : '';
                            const context = `Enhance Karate API tests for ${file.featureName} from OpenAPI specification: ${specFileName}.${methodsStr}${typesStr}${instrStr}`;
                            const specUri = CopilotService.createFileUri(filePath);
                            content = await CopilotService.enhanceTestWithFileContext(
                                content, context, 'openapi', [specUri]
                            );
                        }
                    }

                    const outputFile = path.join(outputPath, file.relativePath);
                    const uniqueFile = FileUtils.getUniqueFilename(outputFile);
                    content = this.applyReusability(content, uniqueFile);
                    FileUtils.writeFile(uniqueFile, content);
                    createdFiles.push(uniqueFile);
                }

                const firstFile = createdFiles[0] || outputPath;
                const firstContent = structured.files[0]?.content || '';
                this.sendSuccess(
                    `Generated ${endpoints.length} scenarios across ${createdFiles.length} domain files`,
                    firstFile,
                    firstContent
                );
                logger.info(`Generated structured tests: ${createdFiles.join(', ')}`);

                // Record history for first file
                await this._historyManager.addToHistory({
                    type: 'openapi',
                    source: filePath,
                    outputPath: firstFile,
                    template: ConfigManager.getTestTemplate()
                });
                await this.sendHistory();
                await this.saveSpecMetadata(filePath, endpoints, firstFile);

            } else {
                // Flat strategy: original single-file behavior
                const feature = generator.generateFromOpenAPI(endpoints, specFileName, scenarioTypes);
                feature.background = generator.generateBackground();
                let featureContent = generator.featureToString(feature);

                if (useCopilot) {
                    this.sendProgress('Enhancing with GitHub Copilot...', 80);
                    const { CopilotService } = await import('../services/copilotService');
                    const isAvailable = await CopilotService.isCopilotAvailable();

                    if (isAvailable) {
                        const typesStr = scenarioTypes?.length ? ` Scenario types: ${scenarioTypes.join(', ')}.` : '';
                        const instrStr = customInstruction ? ` Custom instruction: ${customInstruction}` : '';
                        const methodsStr = httpMethods?.length ? ` HTTP methods: ${httpMethods.join(', ').toUpperCase()}.` : '';
                        const context = `Generate comprehensive Karate API tests from OpenAPI specification: ${specFileName} with ${endpoints.length} endpoints.${methodsStr}${typesStr}${instrStr}`;
                        const specUri = CopilotService.createFileUri(filePath);
                        featureContent = await CopilotService.enhanceTestWithFileContext(
                            featureContent, context, 'openapi', [specUri]
                        );
                    }
                }

                const outputFile = path.join(outputPath, `${specFileName}.feature`);
                const uniqueFile = FileUtils.getUniqueFilename(outputFile);
                featureContent = this.applyReusability(featureContent, uniqueFile);
                FileUtils.writeFile(uniqueFile, featureContent);

                this.sendSuccess(`Generated ${endpoints.length} test scenarios`, uniqueFile, featureContent);
                logger.info(`Generated tests: ${uniqueFile}`);

                await this._historyManager.addToHistory({
                    type: 'openapi',
                    source: filePath,
                    outputPath: uniqueFile,
                    template: ConfigManager.getTestTemplate()
                });
                await this.sendHistory();
                await this.saveSpecMetadata(filePath, endpoints, uniqueFile);
            }

        } catch (error) {
            this.sendError((error as Error).message);
            logger.error('Failed to generate from OpenAPI', error as Error);
        }
    }

    private async handleGenerateFromConfluence(pageUrl: string, useCopilot: boolean, templateId?: string) {
        try {
            this.sendProgress('Fetching Confluence page...', 30);

            let pageId = pageUrl.trim();
            if (pageUrl.startsWith('http')) {
                const extractedId = ConfluenceClient.extractPageIdFromUrl(pageUrl);
                if (!extractedId) {
                    throw new Error('Could not extract page ID from URL');
                }
                pageId = extractedId;
            }

            const baseUrl = ConfigManager.getConfluenceBaseUrl();
            const email = ConfigManager.getConfluenceEmail();
            const apiToken = await ConfigManager.getConfluenceApiToken(this._context);
            const authType = vscode.workspace.getConfiguration('karateDsl.confluence').get<'basic' | 'bearer'>('authType', 'basic');

            const client = new ConfluenceClient(baseUrl, email || "", apiToken, authType);
            const page = await client.getPageById(pageId);

            this.sendProgress('Parsing page content...', 60);

            const parser = new ConfluenceParser();
            const testData = parser.parsePageContent(page);

            const generator = new KarateGenerator();
            if (this._learnedStyle) {
                generator.setStyle(this._learnedStyle);
            }
            if (templateId) {
                const template = await this._templateManager.getTemplate(templateId);
                if (template) {
                    generator.setTemplate(template.content);
                }
            }
            const scenarios = this.createScenariosFromConfluence(testData);

            const feature = {
                name: page.title,
                description: `Test scenarios from Confluence page ${pageId}`,
                scenarios,
                background: generator.generateBackground()
            };

            let featureContent = generator.featureToString(feature as any);

            // Copilot enhancement
            if (useCopilot) {
                this.sendProgress('Enhancing with GitHub Copilot...', 80);
                const { CopilotService } = await import('../services/copilotService');
                const isAvailable = await CopilotService.isCopilotAvailable();

                if (isAvailable) {
                    let tempUri: vscode.Uri | null = null;
                    try {
                        const confluenceContent = page.body.storage?.value || page.body.view?.value || '';
                        const context = `Generate comprehensive Karate API tests from Confluence documentation: ${page.title} with ${scenarios.length} scenarios.`;

                        tempUri = await CopilotService.createTempFile(confluenceContent, '.html');

                        featureContent = await CopilotService.enhanceTestWithFileContext(
                            featureContent,
                            context,
                            'confluence',
                            [tempUri]
                        );
                    } finally {
                        if (tempUri) {
                            await CopilotService.cleanupTempFiles();
                        }
                    }
                }
            }

            // Save file
            const outputPath = FileUtils.resolveOutputPath();
            const sanitizedTitle = page.title.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
            const outputFile = path.join(outputPath, `${sanitizedTitle}.feature`);
            const uniqueFile = FileUtils.getUniqueFilename(outputFile);
            featureContent = this.applyReusability(featureContent, uniqueFile);
            FileUtils.writeFile(uniqueFile, featureContent);

            this.sendSuccess(`Generated ${scenarios.length} test scenarios`, uniqueFile, featureContent);
            logger.info(`Generated tests: ${uniqueFile}`);

            // Record history
            await this._historyManager.addToHistory({
                type: 'confluence',
                source: pageUrl,
                outputPath: uniqueFile,
                template: ConfigManager.getTestTemplate()
            });
            await this.sendHistory();

        } catch (error) {
            this.sendError((error as Error).message);
            logger.error('Failed to generate from Confluence', error as Error);
        }
    }

    private async handleGenerateCombined(openApiPath: string, confluenceUrl: string, useCopilot: boolean, templateId?: string, scenarioTypes?: string[], httpMethods?: string[], customInstruction?: string) {
        try {
            this.sendProgress('Processing both sources...', 20);

            // Parse OpenAPI
            const parser = new OpenAPIParser();
            let endpoints = await parser.parseSpec(openApiPath);

            // Filter by HTTP methods if specified
            if (httpMethods && httpMethods.length > 0) {
                endpoints = endpoints.filter(e => httpMethods.includes(e.method.toLowerCase()));
            }

            // Fetch Confluence
            let pageId = confluenceUrl.trim();
            if (confluenceUrl.startsWith('http')) {
                pageId = ConfluenceClient.extractPageIdFromUrl(confluenceUrl) || pageId;
            }

            const baseUrl = ConfigManager.getConfluenceBaseUrl();
            const email = ConfigManager.getConfluenceEmail();
            const apiToken = await ConfigManager.getConfluenceApiToken(this._context);
            const authType = vscode.workspace.getConfiguration('karateDsl.confluence').get<'basic' | 'bearer'>('authType', 'basic');

            const client = new ConfluenceClient(baseUrl, email || "", apiToken, authType);
            const page = await client.getPageById(pageId);

            this.sendProgress('Generating combined tests...', 60);

            const confluenceParser = new ConfluenceParser();
            const testData = confluenceParser.parsePageContent(page);

            const generator = new KarateGenerator();
            if (this._learnedStyle) {
                generator.setStyle(this._learnedStyle);
            }
            if (templateId) {
                const template = await this._templateManager.getTemplate(templateId);
                if (template) {
                    generator.setTemplate(template.content);
                }
            }

            // Generate scenarios from BOTH sources
            const specFileName = path.basename(openApiPath, path.extname(openApiPath));
            const openApiScenarios = generator.generateFromOpenAPI(endpoints, specFileName, scenarioTypes).scenarios;
            const confluenceScenarios = this.createScenariosFromConfluence(testData);
            const mergedScenarios = [...confluenceScenarios, ...openApiScenarios];

            const strategy = ConfigManager.getStructuringStrategy();
            const outputPath = FileUtils.resolveOutputPath();
            const confluenceContent = page.body.storage?.value || page.body.view?.value || '';

            if (strategy !== 'flat') {
                // Structured output: domain-grouped files with combined naming
                const options: StructuringOptions = {
                    strategy,
                    autoTag: ConfigManager.isAutoTagEnabled(),
                    outputRoot: outputPath
                };

                const structured = FeatureStructurer.structureCombined(
                    mergedScenarios, endpoints, confluenceContent, options
                );

                const createdFiles: string[] = [];
                for (const file of structured.files) {
                    let content = file.content;

                    if (useCopilot) {
                        this.sendProgress(`Enhancing ${file.featureName} with Copilot...`, 80);
                        const { CopilotService } = await import('../services/copilotService');
                        const isAvailable = await CopilotService.isCopilotAvailable();

                        if (isAvailable) {
                            let tempUri: vscode.Uri | null = null;
                            try {
                                const files: vscode.Uri[] = [CopilotService.createFileUri(openApiPath)];
                                tempUri = await CopilotService.createTempFile(confluenceContent, '.html');
                                files.push(tempUri);

                                const typesStr = scenarioTypes?.length ? ` Scenario types: ${scenarioTypes.join(', ')}.` : '';
                                const instrStr = customInstruction ? ` Custom instruction: ${customInstruction}` : '';
                                const methodsStr = httpMethods?.length ? ` HTTP methods: ${httpMethods.join(', ').toUpperCase()}.` : '';
                                const context = `Enhance Karate API tests for ${file.featureName} combining OpenAPI + Confluence: ${specFileName} + ${page.title}.${methodsStr}${typesStr}${instrStr}`;
                                content = await CopilotService.enhanceTestWithFileContext(
                                    content, context, 'combined', files
                                );
                            } finally {
                                if (tempUri) { await CopilotService.cleanupTempFiles(); }
                            }
                        }
                    }

                    const outputFile = path.join(outputPath, file.relativePath);
                    const uniqueFile = FileUtils.getUniqueFilename(outputFile);
                    content = this.applyReusability(content, uniqueFile);
                    FileUtils.writeFile(uniqueFile, content);
                    createdFiles.push(uniqueFile);
                }

                const firstFile = createdFiles[0] || outputPath;
                const firstContent = structured.files[0]?.content || '';
                this.sendSuccess(
                    `Generated ${mergedScenarios.length} combined scenarios across ${createdFiles.length} domain files`,
                    firstFile,
                    firstContent
                );
                logger.info(`Generated structured combined tests: ${createdFiles.join(', ')}`);

                await this._historyManager.addToHistory({
                    type: 'combined',
                    source: openApiPath,
                    secondarySource: confluenceUrl,
                    outputPath: firstFile,
                    template: ConfigManager.getTestTemplate()
                });
                await this.sendHistory();

            } else {
                // Flat strategy: original single-file behavior
                const feature = {
                    name: `${specFileName} - ${page.title}`,
                    description: `Combined AI tests: OpenAPI (${specFileName}) + Confluence (${page.title})`,
                    scenarios: mergedScenarios,
                    background: generator.generateBackground()
                };

                let featureContent = generator.featureToString(feature as any);

                if (useCopilot) {
                    this.sendProgress('Enhancing with GitHub Copilot...', 80);
                    const { CopilotService } = await import('../services/copilotService');
                    const isAvailable = await CopilotService.isCopilotAvailable();

                    if (isAvailable) {
                        let tempUri: vscode.Uri | null = null;
                        try {
                            const files: vscode.Uri[] = [CopilotService.createFileUri(openApiPath)];
                            tempUri = await CopilotService.createTempFile(confluenceContent, '.html');
                            files.push(tempUri);

                            const typesStr = scenarioTypes?.length ? ` Scenario types: ${scenarioTypes.join(', ')}.` : '';
                            const instrStr = customInstruction ? ` Custom instruction: ${customInstruction}` : '';
                            const methodsStr = httpMethods?.length ? ` HTTP methods: ${httpMethods.join(', ').toUpperCase()}.` : '';
                            const context = `Generate comprehensive Karate API tests combining OpenAPI specification with Confluence documentation: ${specFileName} + ${page.title}.${methodsStr}${typesStr}${instrStr}`;
                            featureContent = await CopilotService.enhanceTestWithFileContext(
                                featureContent, context, 'confluence', files
                            );
                        } finally {
                            if (tempUri) { await CopilotService.cleanupTempFiles(); }
                        }
                    }
                }

                const outputFile = path.join(outputPath, `${specFileName}_combined.feature`);
                const uniqueFile = FileUtils.getUniqueFilename(outputFile);
                featureContent = this.applyReusability(featureContent, uniqueFile);
                FileUtils.writeFile(uniqueFile, featureContent);

                this.sendSuccess(`Generated ${mergedScenarios.length} combined test scenarios`, uniqueFile, featureContent);
                logger.info(`Generated combined tests: ${uniqueFile}`);

                await this._historyManager.addToHistory({
                    type: 'combined',
                    source: openApiPath,
                    secondarySource: confluenceUrl,
                    outputPath: uniqueFile,
                    template: ConfigManager.getTestTemplate()
                });
                await this.sendHistory();
            }

        } catch (error) {
            this.sendError((error as Error).message);
            logger.error('Failed to generate combined tests', error as Error);
        }
    }

    private createScenariosFromConfluence(testData: any): any[] {
        const scenarios: any[] = [];

        for (const testCase of testData.testCases) {
            const steps: any[] = [];

            for (let i = 0; i < testCase.steps.length; i++) {
                steps.push({
                    keyword: i === 0 ? 'Given' : 'And',
                    text: `# ${testCase.steps[i]}`
                });
            }

            steps.push({
                keyword: 'When',
                text: 'method get # TODO: Replace with actual API call'
            });

            if (testCase.expectedResult) {
                steps.push({
                    keyword: 'Then',
                    text: `# Expected: ${testCase.expectedResult}`
                });
            }

            scenarios.push({
                name: testCase.name,
                description: testCase.description,
                steps
            });
        }

        return scenarios;
    }

    private async handleSaveConfig(config: any) {
        const vsConfig = vscode.workspace.getConfiguration('karateDsl');

        if (config.outputPath) {
            await vsConfig.update('outputPath', config.outputPath, vscode.ConfigurationTarget.Global);
        }
        if (config.useCopilot !== undefined) {
            await vsConfig.update('useCopilot', config.useCopilot, vscode.ConfigurationTarget.Global);
        }
        if (config.testTemplate) {
            await vsConfig.update('testTemplate', config.testTemplate, vscode.ConfigurationTarget.Global);
        }
        if (config.confluenceBaseUrl !== undefined) {
            await vsConfig.update('confluence.baseUrl', config.confluenceBaseUrl, vscode.ConfigurationTarget.Global);
        }
        if (config.confluenceEmail !== undefined) {
            await vsConfig.update('confluence.email', config.confluenceEmail, vscode.ConfigurationTarget.Global);
        }

        this.sendMessage({ type: 'configSaved' });
    }

    private async sendConfig() {
        const config = vscode.workspace.getConfiguration('karateDsl');

        this.sendMessage({
            type: 'config',
            data: {
                outputPath: config.get('outputPath'),
                useCopilot: config.get('useCopilot'),
                testTemplate: config.get('testTemplate'),
                confluenceBaseUrl: config.get('confluence.baseUrl'),
                confluenceEmail: config.get('confluence.email')
            }
        });
    }

    private sendProgress(message: string, percentage: number) {
        this.sendMessage({ type: 'progress', message, percentage });
    }

    private sendSuccess(message: string, filePath: string, content: string) {
        this.sendMessage({ type: 'success', message, filePath, content });
    }

    private sendError(message: string) {
        this.sendMessage({ type: 'error', message });
    }

    private sendMessage(message: any) {
        this._view?.webview.postMessage(message);
    }

    private async sendHistory() {
        const history = this._historyManager.getHistory();
        this.sendMessage({ type: 'history', data: history });
    }

    private async sendTemplates() {
        const templates = this._templateManager.getAllTemplates();
        this.sendMessage({ type: 'templates', data: templates });
    }

    private async handleSaveTemplate(template: any) {
        await this._templateManager.saveCustomTemplate(template);
        await this.sendTemplates();
        vscode.window.showInformationMessage(`Template "${template.name}" saved.`);
    }

    private async handleLearnStyle(filePath?: string) {
        let selectedPath = filePath;

        if (!selectedPath) {
            const fileUri = await vscode.window.showOpenDialog({
                canSelectMany: false,
                openLabel: 'Select Sample Karate Test',
                filters: { 'Karate Feature': ['feature'] }
            });

            if (fileUri && fileUri.length > 0) {
                selectedPath = fileUri[0].fsPath;
            }
        }

        if (selectedPath) {
            const { StyleAnalyzer } = require('../services/styleAnalyzer');
            this._learnedStyle = StyleAnalyzer.analyze(selectedPath);

            this.sendMessage({ type: 'styleLearned', data: this._learnedStyle });
            vscode.window.showInformationMessage('Style patterns detected from sample.');
        }
    }

    private async handleOpenGeneratedFile(filePath: string) {
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc);
    }

    private async handleCopyToClipboard(content: string) {
        await vscode.env.clipboard.writeText(content);
        vscode.window.showInformationMessage('Content copied to clipboard.');
    }

    /**
     * Save metadata for spec change tracking
     */
    private async saveSpecMetadata(specPath: string, endpoints: any[], testFilePath: string): Promise<void> {
        try {
            // Calculate spec hash
            const specContent = fs.readFileSync(specPath, 'utf-8');
            const specHash = crypto.createHash('sha256').update(specContent).digest('hex');

            // Determine OpenAPI version (simplified)
            const specVersion = specContent.includes('"openapi"') ? '3.0' : '2.0';

            // Create metadata
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

            // Save metadata
            await this._specHashManager.saveMetadata(metadata);

            logger.info(`Saved metadata for spec: ${path.basename(specPath)} (${endpoints.length} endpoints)`);
        } catch (error) {
            logger.error('Failed to save spec metadata', error as Error);
        }
    }

    /**
     * Handle test synchronization request
     */
    private async handleSyncTests(specPath: string, updatePlan: any): Promise<void> {
        try {
            logger.info(`Syncing tests for ${specPath}`);

            // Import TestSyncManager
            const { TestSyncManager } = await import('../services/testSyncManager');
            const { KarateGenerator } = await import('../services/karateGenerator');

            const generator = new KarateGenerator();
            const syncManager = new TestSyncManager(this._specHashManager, generator);

            // Perform sync
            await syncManager.syncTests(specPath, updatePlan);

            // Refresh history
            await this.sendHistory();

            this.sendMessage({ type: 'syncComplete' });
        } catch (error) {
            logger.error('Failed to sync tests', error as Error);
            this.sendError(`Failed to sync tests: ${(error as Error).message}`);
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'style.css'));

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${styleUri}" rel="stylesheet">
    <title>Karate Test Generator</title>
</head>
<body>
    <div class="container">
        <!-- Header -->
        <div class="header">
            <div class="header-main" id="header-logo" style="cursor: pointer;">
                <div class="header-brand">
                    <img src="${webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'icon.svg'))}" class="brand-icon" alt="Karate Logo">
                    <h1>Karate Test Generator</h1>
                </div>
            </div>
            <div class="header-stats hidden" id="style-badge">
                <span class="badge">Learned Style Active</span>
            </div>
        </div>

        <!-- Unified Navigation Tabs -->
        <div class="tabs">
            <button class="tab-button" data-tab="home" id="home-tab-btn">
                <span>🏠</span> Home
            </button>
            <button class="tab-button active" data-tab="openapi">
                <span>📄</span> OpenAPI
            </button>
            <button class="tab-button" data-tab="confluence">
                <span>📋</span> Confluence
            </button>
            <button class="tab-button" data-tab="combined">
                <span>🔀</span> Combined
            </button>
            <button class="tab-button" data-tab="template">
                <span>📝</span> Templates
            </button>
            <button class="tab-button" data-tab="settings">
                <span>⚙️</span> Settings
            </button>
            <button class="tab-button" data-tab="sync">
                <span>🔄</span> Sync
            </button>
            <button class="tab-button" data-tab="coverage">
                <span>📊</span> Coverage
            </button>
            <button class="tab-button" data-tab="help">
                <span>❓</span> Help
            </button>
        </div>

        <!-- Dashboard / Welcome (Hidden when tabs are active) -->
        <div id="dashboard" class="dashboard-grid">
            <div class="welcome-card card" data-target="openapi">
                <div class="welcome-icon">📄</div>
                <h3>OpenAPI</h3>
                <p>Generate from Swagger/JSON</p>
            </div>
            <div class="welcome-card card" data-target="confluence">
                <div class="welcome-icon">📋</div>
                <h3>Confluence</h3>
                <p>Fetch from Wiki docs</p>
            </div>
            <div class="welcome-card card" data-target="template">
                <div class="welcome-icon">🎨</div>
                <h3>Personalize</h3>
                <p>Styles & Templates</p>
            </div>
            <div class="welcome-card card" data-target="help">
                <div class="welcome-icon">❓</div>
                <h3>Help & Guide</h3>
                <p>Features & Usage</p>
            </div>
        </div>

        <!-- OpenAPI Tab -->
        <div class="tab-content active" id="openapi-tab">
            <div class="card">
                <div class="card-header">
                    <span class="card-icon">📁</span>
                    <span class="card-title">Source File</span>
                </div>
                <div class="form-group">
                    <div class="file-input">
                        <div class="file-display" id="openapi-file-display" style="display: none;">
                            <span class="file-icon">📄</span>
                            <span class="file-path" id="openapi-file-path"></span>
                            <span class="file-clear" id="openapi-file-clear">✕</span>
                        </div>
                        <button id="select-openapi-btn" class="secondary-button">📂 Browse OpenAPI Spec</button>
                    </div>
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <span class="card-icon">⚙️</span>
                    <span class="card-title">Options</span>
                </div>
                <div class="form-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="openapi-copilot">
                        <span>🤖 AI Enhancement (Copilot)</span>
                    </label>
                </div>
                <div class="form-group">
                    <label class="control-section-label">Scenario Types</label>
                    <div class="checkbox-grid">
                        <label class="checkbox-label compact"><input type="checkbox" id="openapi-type-positive" checked><span>✅ Positive</span></label>
                        <label class="checkbox-label compact"><input type="checkbox" id="openapi-type-negative" checked><span>❌ Negative</span></label>
                        <label class="checkbox-label compact"><input type="checkbox" id="openapi-type-edge" checked><span>🔲 Edge Cases</span></label>
                        <label class="checkbox-label compact"><input type="checkbox" id="openapi-type-security"><span>🔒 Security</span></label>
                    </div>
                </div>
                <div class="form-group">
                    <label class="control-section-label">HTTP Methods</label>
                    <div class="checkbox-grid">
                        <label class="checkbox-label compact"><input type="checkbox" id="openapi-method-get" checked><span>GET</span></label>
                        <label class="checkbox-label compact"><input type="checkbox" id="openapi-method-post" checked><span>POST</span></label>
                        <label class="checkbox-label compact"><input type="checkbox" id="openapi-method-put" checked><span>PUT</span></label>
                        <label class="checkbox-label compact"><input type="checkbox" id="openapi-method-delete" checked><span>DELETE</span></label>
                        <label class="checkbox-label compact"><input type="checkbox" id="openapi-method-patch" checked><span>PATCH</span></label>
                    </div>
                </div>
                <div class="form-group copilot-only-section">
                    <label class="control-section-label">Custom Instruction <span class="badge-small">Copilot</span></label>
                    <textarea id="openapi-custom-instruction" rows="2" placeholder="e.g., Focus on payment retry scenarios"></textarea>
                </div>
            </div>

            <button class="primary-button" id="generate-openapi-btn">
                <span>🚀</span> Generate Tests
            </button>

            <!-- Recent OpenAPI History -->
            <div id="openapi-history" class="card history-section hidden">
                <div class="card-header">
                    <span class="card-icon">📊</span>
                    <span class="card-title">Recent OpenAPI</span>
                </div>
                <div id="openapi-history-list" class="history-list"></div>
            </div>
        </div>

        <!-- Confluence Tab -->
        <div class="tab-content" id="confluence-tab">
            <div class="card">
                <div class="card-header">
                    <span class="card-icon">🔗</span>
                    <span class="card-title">Confluence Page</span>
                </div>
                <div class="form-group">
                    <label>Page URL or ID</label>
                    <input type="text" id="confluence-url" placeholder="https://... or page ID">
                    <p class="info-text">Enter Confluence page URL or numeric page ID</p>
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <span class="card-icon">⚙️</span>
                    <span class="card-title">Options</span>
                </div>
                <div class="form-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="confluence-copilot">
                        <span>🤖 AI Enhancement (Copilot)</span>
                    </label>
                </div>
            </div>

            <button class="primary-button" id="generate-confluence-btn">
                <span>🚀</span> Generate Tests
            </button>
        </div>

        <!-- Combined Tab -->
        <div class="tab-content" id="combined-tab">
            <div class="card">
                <div class="card-header">
                    <span class="card-icon">📄</span>
                    <span class="card-title">OpenAPI Spec</span>
                </div>
                <div class="form-group">
                    <div class="file-input">
                        <div class="file-display" id="combined-file-display" style="display: none;">
                            <span class="file-icon">📄</span>
                            <span class="file-path" id="combined-file-path"></span>
                            <span class="file-clear" id="combined-file-clear">✕</span>
                        </div>
                        <button id="select-combined-openapi-btn" class="secondary-button">📂 Browse OpenAPI Spec</button>
                    </div>
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <span class="card-icon">📋</span>
                    <span class="card-title">Confluence Page</span>
                </div>
                <div class="form-group">
                    <label>Page URL or ID</label>
                    <input type="text" id="combined-confluence-url" placeholder="https://... or page ID">
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <span class="card-icon">⚙️</span>
                    <span class="card-title">Options</span>
                </div>
                <div class="form-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="combined-copilot">
                        <span>🤖 AI Enhancement (Copilot)</span>
                    </label>
                </div>
                <div class="form-group">
                    <label class="control-section-label">Scenario Types</label>
                    <div class="checkbox-grid">
                        <label class="checkbox-label compact"><input type="checkbox" id="combined-type-positive" checked><span>✅ Positive</span></label>
                        <label class="checkbox-label compact"><input type="checkbox" id="combined-type-negative" checked><span>❌ Negative</span></label>
                        <label class="checkbox-label compact"><input type="checkbox" id="combined-type-edge" checked><span>🔲 Edge Cases</span></label>
                        <label class="checkbox-label compact"><input type="checkbox" id="combined-type-security"><span>🔒 Security</span></label>
                    </div>
                </div>
                <div class="form-group">
                    <label class="control-section-label">HTTP Methods</label>
                    <div class="checkbox-grid">
                        <label class="checkbox-label compact"><input type="checkbox" id="combined-method-get" checked><span>GET</span></label>
                        <label class="checkbox-label compact"><input type="checkbox" id="combined-method-post" checked><span>POST</span></label>
                        <label class="checkbox-label compact"><input type="checkbox" id="combined-method-put" checked><span>PUT</span></label>
                        <label class="checkbox-label compact"><input type="checkbox" id="combined-method-delete" checked><span>DELETE</span></label>
                        <label class="checkbox-label compact"><input type="checkbox" id="combined-method-patch" checked><span>PATCH</span></label>
                    </div>
                </div>
                <div class="form-group copilot-only-section">
                    <label class="control-section-label">Custom Instruction <span class="badge-small">Copilot</span></label>
                    <textarea id="combined-custom-instruction" rows="2" placeholder="e.g., Include validation for business rules"></textarea>
                </div>
            </div>

            <button class="primary-button" id="generate-combined-btn">
                <span>🚀</span> Generate Tests
            </button>
        </div>

        <!-- Help Tab -->
        <div class="tab-content" id="help-tab">
            <div class="card">
                <div class="card-header">
                    <span class="card-icon">🧪</span>
                    <span class="card-title">Running Tests</span>
                </div>
                <div class="help-section">
                    <p><strong>Run directly from the editor:</strong></p>
                    <ul>
                        <li><strong>▶ Run Feature:</strong> Click the CodeLens above any <code>Feature:</code> line to run the entire feature.</li>
                        <li><strong>▶ Run Scenario:</strong> Click the CodeLens above any <code>Scenario:</code> line to run a single scenario.</li>
                        <li><strong>Testing Sidebar:</strong> All <code>.feature</code> files appear in the VS Code Testing tab. Run any combination from there.</li>
                        <li><strong>Run Folder / Tags:</strong> Use Command Palette → <code>Karate: Run Folder</code> or <code>Karate: Run by Tags</code>.</li>
                    </ul>
                    <p><strong>Build Tools:</strong> Supports <code>CLI</code> (standalone JAR), <code>Maven</code>, and <code>Gradle</code>. Set via <code>karateDsl.execution.defaultBuildTool</code>.</p>
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <span class="card-icon">⚙️</span>
                    <span class="card-title">Custom Execution Parameters</span>
                </div>
                <div class="help-section">
                    <p>Control how tests run via VS Code Settings (<code>Cmd+,</code>):</p>
                    <ul>
                        <li><strong>System Properties:</strong> <code>karateDsl.execution.systemProperties</code> — pass <code>-D</code> flags like <code>{"karate.env": "local"}</code></li>
                        <li><strong>JVM Args:</strong> <code>karateDsl.execution.jvmArgs</code> — e.g., <code>["-Xmx1g"]</code></li>
                        <li><strong>Karate Args:</strong> <code>karateDsl.execution.karateArgs</code> — e.g., <code>["--threads", "5"]</code></li>
                    </ul>
                    <p><strong>Priority:</strong> Your <code>systemProperties</code> always override auto-detected defaults.</p>
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <span class="card-icon">🔍</span>
                    <span class="card-title">Config Discovery</span>
                </div>
                <div class="help-section">
                    <p>The extension automatically discovers your project setup:</p>
                    <ul>
                        <li><strong>karate-config.js:</strong> Found via workspace-wide search — no hardcoded paths needed.</li>
                        <li><strong>Runner Classes:</strong> Java test runners are auto-detected for classpath.</li>
                        <li><strong>LLM Suggestions:</strong> Copilot analyzes your project and suggests optimal classpath and JVM args.</li>
                        <li><strong>Manual Override:</strong> Use <code>karateDsl.execution.configPath</code> to set an explicit path.</li>
                    </ul>
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <span class="card-icon">🤖</span>
                    <span class="card-title">Copilot Integration</span>
                </div>
                <div class="help-section">
                    <p><strong>AI-enhanced features:</strong></p>
                    <ul>
                        <li><strong>Enhance Tests:</strong> Select "AI Enhancement" before generating for smarter assertions, edge cases, and realistic data.</li>
                        <li><strong>Coverage Dashboard:</strong> AI analyzes coverage gaps and suggests missing test scenarios.</li>
                        <li><strong>Postman Import:</strong> Intelligent conversion of pre-request scripts to Karate assertions.</li>
                        <li><strong>HAR Import:</strong> AI enriches imported traffic with schema validation and error scenarios.</li>
                        <li><strong>Select Model:</strong> Command Palette → <code>Karate: Select Copilot Model</code> to choose your preferred model.</li>
                    </ul>
                    <p><strong>Note:</strong> Requires an active GitHub Copilot subscription and the VS Code Copilot extension.</p>
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <span class="card-icon">📄</span>
                    <span class="card-title">OpenAPI Generation</span>
                </div>
                <div class="help-section">
                    <p>1. Go to the <strong>OpenAPI</strong> tab or right-click a spec file in the Explorer.</p>
                    <p>2. Select your <code>.json</code>, <code>.yaml</code>, or <code>.yml</code> spec file.</p>
                    <p>3. (Optional) Check "AI Enhancement" for Copilot-powered tests.</p>
                    <p>4. Click <strong>Generate Tests</strong>.</p>
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <span class="card-icon">📋</span>
                    <span class="card-title">Confluence Integration</span>
                </div>
                <div class="help-section">
                    <p>Generate tests from API documentation pages.</p>
                    <ul>
                        <li><strong>Setup:</strong> Configure URL, Email, and Token in Settings.</li>
                        <li><strong>Auth Type:</strong> Choose 'Basic' (Cloud) or 'Bearer' (Data Center).</li>
                        <li><strong>Usage:</strong> Enter the full Page URL or Page ID in the Confluence tab.</li>
                    </ul>
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <span class="card-icon">📦</span>
                    <span class="card-title">Postman Import</span>
                </div>
                <div class="help-section">
                    <p>Convert Postman collections to Karate feature files:</p>
                    <p>1. Right-click a <code>.json</code> Postman collection in the Explorer.</p>
                    <p>2. Select <strong>Karate: Import Postman Collection</strong>.</p>
                    <p>3. Environment files nearby are auto-detected.</p>
                    <p>Variables, pre-request scripts, and test assertions are all converted.</p>
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <span class="card-icon">📥</span>
                    <span class="card-title">HAR File Import</span>
                </div>
                <div class="help-section">
                    <p>Convert real API traffic into Karate tests:</p>
                    <p>1. Export a <code>.har</code> file from Chrome/Firefox DevTools (Network tab → Export HAR).</p>
                    <p>2. Command Palette → <strong>Karate: Import HAR File</strong>.</p>
                    <p>3. Select requests to convert — filter by domain, method, or status code.</p>
                    <p>Copilot adds assertions, schema checks, and error scenarios automatically.</p>
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <span class="card-icon">🔄</span>
                    <span class="card-title">Auto-Maintenance</span>
                </div>
                <div class="help-section">
                    <p>The extension watches your OpenAPI files for changes.</p>
                    <p>When you save a change to a spec, a notification will appear offering to <strong>Update with Copilot</strong>. This preserves your custom logic while adding new endpoints and fields.</p>
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <span class="card-icon">🩺</span>
                    <span class="card-title">Project Health Doctor</span>
                </div>
                <div class="help-section">
                    <p>Real-time code quality analysis for your Karate project:</p>
                    <ul>
                        <li><strong>Linter:</strong> Catches hardcoded URLs, duplicate scenarios, indentation issues as you type.</li>
                        <li><strong>Security Scanner:</strong> Detects missing auth tests and hardcoded secrets.</li>
                        <li><strong>Quick Fixes:</strong> One-click auto-fixes for common issues.</li>
                        <li><strong>Health Dashboard:</strong> Visualize project structure and dependencies.</li>
                    </ul>
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <span class="card-icon">⚡</span>
                    <span class="card-title">Quick Actions</span>
                </div>
                <div class="help-section">
                    <p><strong>From Explorer:</strong> Right-click any file to see available actions:</p>
                    <ul>
                        <li><code>.json/.yaml</code> (OpenAPI): Generate Karate Tests</li>
                        <li><code>.json</code> (Postman): Import Postman Collection</li>
                        <li><code>.har</code>: Import HAR File</li>
                        <li><code>.feature</code>: Learn Style from File</li>
                    </ul>
                    <p><strong>From Command Palette:</strong> <code>Cmd+Shift+P</code> → type "Karate" to see all commands.</p>
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <span class="card-icon">🏗️</span>
                    <span class="card-title">Enterprise Features (v1.4.0)</span>
                </div>
                <div class="help-section">
                    <p><strong>Precision Controls:</strong> In OpenAPI & Combined tabs, use checkboxes to filter by scenario type (positive, negative, edge, security) and HTTP method (GET, POST, PUT, DELETE, PATCH). Add free-text instructions for Copilot.</p>
                    <p><strong>Structuring Strategies:</strong> Set <code>karateDsl.generation.structuringStrategy</code> to <code>domain</code> (default — groups by API domain), <code>flat</code> (single file), or <code>method</code> (groups by HTTP verb).</p>
                    <p><strong>Smart Reusability:</strong> Generated tests are auto-analyzed for repeated patterns (auth, setup, headers). Common steps are extracted to <code>common/</code> feature files with <code>call</code>/<code>callonce</code>.</p>
                    <p><strong>Agent Skills:</strong> Copilot prompts are hardened with 4 skill files for Karate DSL expertise, preventing hallucinations and enforcing best practices.</p>
                </div>
            </div>
        </div>

        <!-- Template Tab -->
        <div class="tab-content" id="template-tab">
            <div class="card">
                <div class="card-header">
                    <span class="card-icon">📝</span>
                    <span class="card-title">Template Designer</span>
                </div>
                <div class="form-group">
                    <label>Base Template</label>
                    <div class="flex-row">
                        <select id="template-select" class="flex-grow">
                            <option value="standard">Standard</option>
                            <option value="detailed">Detailed</option>
                            <option value="minimal">Minimal</option>
                        </select>
                        <button class="icon-button" id="refresh-templates-btn" title="Refresh templates">🔄</button>
                    </div>
                </div>
                <div class="form-group">
                    <label>Template Editor</label>
                    <div class="variable-chips">
                        <button class="chip" data-var="{{featureName}}" title="Insert Feature Name">{{featureName}}</button>
                        <button class="chip" data-var="{{scenarios}}" title="Insert Scenarios">{{scenarios}}</button>
                        <button class="chip" data-var="{{backgroundSteps}}" title="Insert Background Steps">{{backgroundSteps}}</button>
                    </div>
                    <textarea id="template-content-editor" class="code-editor" spellcheck="false" placeholder="Feature: {{featureName}}..."></textarea>
                </div>
                <div class="divider"></div>
                <div class="form-group">
                    <label>Save as New Template</label>
                    <div class="flex-row">
                        <input type="text" id="custom-template-name" placeholder="Expert Style..." class="flex-grow" style="height: 32px;">
                        <button class="secondary-button" id="save-custom-template-btn" style="width: 80px; flex-shrink: 0;">
                            <span>💾</span> Save
                        </button>
                    </div>
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <span class="card-icon">🎨</span>
                    <span class="card-title">Style Learning</span>
                </div>
                <div id="style-info" class="style-patterns hidden">
                    <div class="patterns-grid">
                        <div class="pattern-item">
                            <span class="pattern-label">Indentation</span>
                            <span id="detected-indent" class="pattern-value">-</span>
                        </div>
                        <div class="pattern-item">
                            <span class="pattern-label">Casing</span>
                            <span id="detected-case" class="pattern-value">-</span>
                        </div>
                    </div>
                </div>
                <div class="form-group">
                    <button class="secondary-button" id="learn-style-btn">
                        <span>📂</span> Browse Sample Test
                    </button>
                    <p class="info-text">Analyze existing tests to match their style</p>
                </div>
            </div>
        </div>

        <!-- Settings Tab -->
        <div class="tab-content" id="settings-tab">
            <div class="card">
                <div class="card-header">
                    <span class="card-icon">⚙️</span>
                    <span class="card-title">General Settings</span>
                </div>
                <div class="form-group">
                    <label>Output Path</label>
                    <input type="text" id="output-path" placeholder="src/test/karate">
                    <p class="info-text">Default location for generated test files</p>
                </div>
                <div class="form-group">
                    <label>Template Style</label>
                    <select id="test-template">
                        <option value="standard">Standard</option>
                        <option value="detailed">Detailed</option>
                        <option value="minimal">Minimal</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="use-copilot-checkbox">
                        <span>🤖 Enable GitHub Copilot Enhancement</span>
                    </label>
                    <p class="info-text">Use AI to enhance generated tests (requires GitHub Copilot subscription)</p>
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <span class="card-icon">🔗</span>
                    <span class="card-title">Confluence Settings</span>
                </div>
                <div class="form-group">
                    <label>Base URL</label>
                    <input type="text" id="confluence-base-url" placeholder="https://company.atlassian.net/wiki">
                    <p class="info-text">
                        <strong>Cloud:</strong> https://yourcompany.atlassian.net/wiki<br>
                        <strong>Server/Data Center:</strong> https://confluence.yourcompany.com
                    </p>
                </div>
                <div class="form-group">
                    <label>Email</label>
                    <input type="text" id="confluence-email" placeholder="email@company.com">
                    <p class="info-text">Your Confluence account email</p>
                </div>
                <div class="form-group">
                    <p class="info-text">
                        ℹ️ API Token will be requested when first connecting. 
                        Generate one at: <a href="https://id.atlassian.com/manage-profile/security/api-tokens">id.atlassian.com</a>
                    </p>
                </div>
            </div>

            <button class="primary-button" id="save-settings-btn">
                <span>💾</span> Save Settings
            </button>
        </div>

        <!-- Sync Tab (AI-Powered Test Maintenance) -->
        <div class="tab-content" id="sync-tab">
            <div class="card">
                <div class="card-header">
                    <span class="card-icon">🔄</span>
                    <span class="card-title">Spec Changes Detected</span>
                </div>
                
                <div id="sync-content" class="hidden">
                    <div class="sync-summary">
                        <h3 id="sync-spec-name">Loading...</h3>
                        <p class="text-muted" id="sync-last-generated">Last generated: --</p>
                        <p id="sync-summary-text" style="margin-top: 8px; font-weight: 600;">--</p>
                    </div>
                    
                    <div class="divider"></div>
                    
                    <div class="change-details">
                        <h4>Changes</h4>
                        <div id="sync-changes-list" class="change-list">
                            <!-- Dynamically populated -->
                        </div>
                    </div>
                    
                    <div class="divider"></div>
                    
                    <div class="affected-tests">
                        <h4>Affected Tests (<span id="sync-affected-count">0</span>)</h4>
                        <div id="sync-affected-list" class="test-list">
                            <!-- Dynamically populated -->
                        </div>
                    </div>
                    
                    <div class="sync-actions" style="margin-top: 16px;">
                        <button class="primary-button" id="sync-tests-btn">
                            <span>🔄</span> Update All Tests
                        </button>
                        <button class="secondary-button" id="ignore-sync-btn" style="margin-top: 8px;">
                            <span>🚫</span> Ignore Changes
                        </button>
                    </div>
                    
                    <div class="info-text" style="margin-top: 12px;">
                        <p>⚠️ A backup will be created before updating tests</p>
                    </div>
                </div>
                
                <div id="sync-empty" class="text-center" style="padding: 40px 20px;">
                    <p class="text-muted">No spec changes detected</p>
                    <p class="info-text" style="margin-top: 8px;">Changes will appear here automatically when tracked OpenAPI specs are modified</p>
                </div>
            </div>
        </div>

        <!-- Coverage Tab -->
        <div class="tab-content" id="coverage-tab">
            <div class="card">
                <div class="card-header">
                    <span class="card-icon">📊</span>
                    <span class="card-title">Test Coverage Dashboard</span>
                </div>
                <div class="form-group">
                    <p class="info-text">Analyze your API test coverage with interactive visualizations and AI-powered insights.</p>
                </div>
                
                <button class="primary-button" id="launch-coverage-btn" style="width: 100%; margin-top: 20px;">
                    <span>🚀</span> Launch Coverage Dashboard
                </button>
                
                <div class="info-text" style="margin-top: 16px;">
                    <p><strong>Features:</strong></p>
                    <ul style="margin-left: 20px; margin-top: 8px;">
                        <li>📈 Interactive charts and visualizations</li>
                        <li>🤖 AI-powered Copilot insights</li>
                        <li>🎯 Priority endpoint recommendations</li>
                        <li>📊 Method-level coverage breakdown</li>
                    </ul>
                </div>
            </div>
        </div>

        <!-- Progress Bar -->
        <div class="progress-container" id="progress-container" style="display: none;">
            <div class="progress-bar">
                <div class="progress-fill" id="progress-fill"></div>
            </div>
            <p class="progress-text" id="progress-text">Processing...</p>
        </div>

        <!-- Results -->
        <div class="results" id="results" style="display: none;">
            <h3>✅ Success!</h3>
            <p id="result-message"></p>
            <div class="result-actions">
                <button id="open-file-btn" class="secondary-button">📂 Open File</button>
                <button id="copy-content-btn" class="secondary-button">📋 Copy</button>
            </div>
            <div class="preview">
                <h4>Preview:</h4>
                <pre id="preview-content"></pre>
            </div>
        </div>

        <!-- Error -->
        <div class="error" id="error" style="display: none;">
            <h3>❌ Error</h3>
            <p id="error-message"></p>
        </div>
    </div>

    <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}
