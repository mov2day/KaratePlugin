import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { OpenAPIParser } from '../services/openApiParser';
import { KarateGenerator } from '../services/karateGenerator';
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
                    await this.handleGenerateFromOpenAPI(data.filePath, data.useCopilot, data.templateId);
                    break;
                case 'generateFromConfluence':
                    await this.handleGenerateFromConfluence(data.pageUrl, data.useCopilot, data.templateId);
                    break;
                case 'generateCombined':
                    await this.handleGenerateCombined(data.openApiPath, data.confluenceUrl, data.useCopilot, data.templateId);
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

    private async handleGenerateFromOpenAPI(filePath: string, useCopilot: boolean, templateId?: string) {
        try {
            this.sendProgress('Parsing OpenAPI specification...', 30);

            const parser = new OpenAPIParser();
            const endpoints = await parser.parseSpec(filePath);

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
            const feature = generator.generateFromOpenAPI(endpoints, specFileName);
            feature.background = generator.generateBackground();

            let featureContent = generator.featureToString(feature);

            // Copilot enhancement
            if (useCopilot) {
                this.sendProgress('Enhancing with GitHub Copilot...', 80);
                const { CopilotService } = await import('../services/copilotService');
                const isAvailable = await CopilotService.isCopilotAvailable();

                if (isAvailable) {
                    const fs = await import('fs');
                    const fullSpecContent = fs.readFileSync(filePath, 'utf-8');
                    const context = `OpenAPI spec: ${specFileName}, ${endpoints.length} endpoints`;

                    featureContent = await CopilotService.enhanceKarateTest(
                        featureContent,
                        context,
                        { type: 'openapi', openApiSpec: fullSpecContent }
                    );
                }
            }

            // Save file
            const outputPath = FileUtils.resolveOutputPath();
            const outputFile = path.join(outputPath, `${specFileName}.feature`);
            const uniqueFile = FileUtils.getUniqueFilename(outputFile);
            FileUtils.writeFile(uniqueFile, featureContent);

            this.sendSuccess(`Generated ${endpoints.length} test scenarios`, uniqueFile, featureContent);
            logger.info(`Generated tests: ${uniqueFile}`);

            // Record history
            await this._historyManager.addToHistory({
                type: 'openapi',
                source: filePath,
                outputPath: uniqueFile,
                template: ConfigManager.getTestTemplate()
            });
            await this.sendHistory();

            // Save metadata for AI-Powered Test Maintenance
            await this.saveSpecMetadata(filePath, endpoints, uniqueFile);

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

            const client = new ConfluenceClient(baseUrl, email, apiToken);
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
                    const confluenceContent = page.body.storage?.value || page.body.view?.value || '';
                    const context = `Confluence page: ${page.title}, ${scenarios.length} scenarios`;

                    featureContent = await CopilotService.enhanceKarateTest(
                        featureContent,
                        context,
                        { type: 'confluence', confluencePage: confluenceContent, requirements: testData.requirements }
                    );
                }
            }

            // Save file
            const outputPath = FileUtils.resolveOutputPath();
            const sanitizedTitle = page.title.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
            const outputFile = path.join(outputPath, `${sanitizedTitle}.feature`);
            const uniqueFile = FileUtils.getUniqueFilename(outputFile);
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

    private async handleGenerateCombined(openApiPath: string, confluenceUrl: string, useCopilot: boolean, templateId?: string) {
        try {
            this.sendProgress('Processing both sources...', 20);

            // Parse OpenAPI
            const parser = new OpenAPIParser();
            const endpoints = await parser.parseSpec(openApiPath);

            // Fetch Confluence
            let pageId = confluenceUrl.trim();
            if (confluenceUrl.startsWith('http')) {
                pageId = ConfluenceClient.extractPageIdFromUrl(confluenceUrl) || pageId;
            }

            const baseUrl = ConfigManager.getConfluenceBaseUrl();
            const email = ConfigManager.getConfluenceEmail();
            const apiToken = await ConfigManager.getConfluenceApiToken(this._context);

            const client = new ConfluenceClient(baseUrl, email, apiToken);
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
            const openApiScenarios = generator.generateFromOpenAPI(endpoints, specFileName).scenarios;
            const confluenceScenarios = this.createScenariosFromConfluence(testData);

            // Merge: Confluence requirements first, then the rest of the API surface
            const mergedScenarios = [...confluenceScenarios, ...openApiScenarios];

            const feature = {
                name: `${specFileName} - ${page.title}`,
                description: `Combined AI tests: OpenAPI (${specFileName}) + Confluence (${page.title})`,
                scenarios: mergedScenarios,
                background: generator.generateBackground()
            };

            let featureContent = generator.featureToString(feature as any);

            // Copilot enhancement
            if (useCopilot) {
                this.sendProgress('Enhancing with GitHub Copilot...', 80);
                const { CopilotService } = await import('../services/copilotService');
                const isAvailable = await CopilotService.isCopilotAvailable();

                if (isAvailable) {
                    const fs = await import('fs');
                    const fullSpecContent = fs.readFileSync(openApiPath, 'utf-8');
                    const confluenceContent = page.body.storage?.value || page.body.view?.value || '';
                    const context = `Combined: OpenAPI ${specFileName} + Confluence ${page.title}`;

                    featureContent = await CopilotService.enhanceKarateTest(
                        featureContent,
                        context,
                        {
                            type: 'combined',
                            openApiSpec: fullSpecContent,
                            confluencePage: confluenceContent,
                            requirements: testData.requirements
                        }
                    );
                }
            }

            // Save file
            const outputPath = FileUtils.resolveOutputPath();
            const outputFile = path.join(outputPath, `${specFileName}_combined.feature`);
            const uniqueFile = FileUtils.getUniqueFilename(outputFile);
            FileUtils.writeFile(uniqueFile, featureContent);

            this.sendSuccess(`Generated ${mergedScenarios.length} combined test scenarios`, uniqueFile, featureContent);
            logger.info(`Generated combined tests: ${uniqueFile}`);

            // Record history
            await this._historyManager.addToHistory({
                type: 'combined',
                source: openApiPath,
                secondarySource: confluenceUrl,
                outputPath: uniqueFile,
                template: ConfigManager.getTestTemplate()
            });
            await this.sendHistory();

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
            </div>

            <button class="primary-button" id="generate-combined-btn">
                <span>🚀</span> Generate Tests
            </button>
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
                    <span class="card-icon">📁</span>
                    <span class="card-title">Output Settings</span>
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
            </div>

            <div class="card">
                <div class="card-header">
                    <span class="card-icon">🔗</span>
                    <span class="card-title">Confluence Settings</span>
                </div>
                <div class="form-group">
                    <label>Base URL</label>
                    <input type="text" id="confluence-base-url" placeholder="https://company.atlassian.net/wiki">
                </div>
                <div class="form-group">
                    <label>Email</label>
                    <input type="text" id="confluence-email" placeholder="email@company.com">
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
