import * as vscode from 'vscode';
import * as path from 'path';
import { OpenAPIParser } from '../services/openApiParser';
import { KarateGenerator } from '../services/karateGenerator';
import { ConfluenceClient } from '../services/confluenceClient';
import { ConfluenceParser } from '../services/confluenceParser';
import { ConfigManager } from '../utils/configManager';
import { FileUtils } from '../utils/fileUtils';
import { logger } from '../utils/logger';

export class KarateWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'karateGenerator.webview';
    private _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri, private readonly _context: vscode.ExtensionContext) { }

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

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.command) {
                case 'selectOpenAPIFile':
                    await this.handleSelectOpenAPIFile();
                    break;
                case 'generateFromOpenAPI':
                    await this.handleGenerateFromOpenAPI(data.filePath, data.useCopilot);
                    break;
                case 'generateFromConfluence':
                    await this.handleGenerateFromConfluence(data.pageUrl, data.useCopilot);
                    break;
                case 'generateCombined':
                    await this.handleGenerateCombined(data.openApiPath, data.confluenceUrl, data.useCopilot);
                    break;
                case 'getConfig':
                    await this.sendConfig();
                    break;
                case 'saveConfig':
                    await this.handleSaveConfig(data.config);
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

    private async handleGenerateFromOpenAPI(filePath: string, useCopilot: boolean) {
        try {
            this.sendProgress('Parsing OpenAPI specification...', 30);

            const parser = new OpenAPIParser();
            const endpoints = await parser.parseSpec(filePath);

            this.sendProgress('Generating Karate tests...', 60);

            const generator = new KarateGenerator();
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

        } catch (error) {
            this.sendError((error as Error).message);
            logger.error('Failed to generate from OpenAPI', error as Error);
        }
    }

    private async handleGenerateFromConfluence(pageUrl: string, useCopilot: boolean) {
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
            const scenarios = this.createScenariosFromConfluence(testData);

            const feature = {
                name: page.title,
                description: `Test scenarios from Confluence page ${pageId}`,
                scenarios
            };

            let featureContent = generator.featureToString(feature);

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

        } catch (error) {
            this.sendError((error as Error).message);
            logger.error('Failed to generate from Confluence', error as Error);
        }
    }

    private async handleGenerateCombined(openApiPath: string, confluenceUrl: string, useCopilot: boolean) {
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
            const scenarios = this.createScenariosFromConfluence(testData);

            const specFileName = path.basename(openApiPath, path.extname(openApiPath));
            const feature = {
                name: `${specFileName} - ${page.title}`,
                description: 'Combined tests from OpenAPI and Confluence',
                background: generator.generateBackground(),
                scenarios
            };

            let featureContent = generator.featureToString(feature);

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

            this.sendSuccess(`Generated ${scenarios.length} combined test scenarios`, uniqueFile, featureContent);
            logger.info(`Generated combined tests: ${uniqueFile}`);

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
        <h1>🥋 Karate Test Generator</h1>
        
        <div class="tabs">
            <button class="tab-button active" data-tab="openapi">OpenAPI</button>
            <button class="tab-button" data-tab="confluence">Confluence</button>
            <button class="tab-button" data-tab="combined">Combined</button>
            <button class="tab-button" data-tab="settings">Settings</button>
        </div>

        <!-- OpenAPI Tab -->
        <div class="tab-content active" id="openapi-tab">
            <h2>OpenAPI Spec</h2>
            <div class="form-group">
                <label>File:</label>
                <div class="file-input">
                    <input type="text" id="openapi-file" readonly placeholder="No file selected">
                    <button id="select-openapi-btn">📁 Browse</button>
                </div>
            </div>
            <div class="form-group">
                <label class="checkbox-label">
                    <input type="checkbox" id="openapi-copilot">
                    Use Copilot AI
                </label>
            </div>
            <button class="primary-button" id="generate-openapi-btn">🚀 Generate Tests</button>
        </div>

        <!-- Confluence Tab -->
        <div class="tab-content" id="confluence-tab">
            <h2>Confluence Page</h2>
            <div class="form-group">
                <label>Page URL or ID:</label>
                <input type="text" id="confluence-url" placeholder="URL or page ID">
            </div>
            <div class="form-group">
                <label class="checkbox-label">
                    <input type="checkbox" id="confluence-copilot">
                    Use Copilot AI
                </label>
            </div>
            <button class="primary-button" id="generate-confluence-btn">🚀 Generate Tests</button>
        </div>

        <!-- Combined Tab -->
        <div class="tab-content" id="combined-tab">
            <h2>Combined</h2>
            <div class="form-group">
                <label>OpenAPI File:</label>
                <div class="file-input">
                    <input type="text" id="combined-openapi-file" readonly placeholder="No file selected">
                    <button id="select-combined-openapi-btn">📁 Browse</button>
                </div>
            </div>
            <div class="form-group">
                <label>Confluence Page:</label>
                <input type="text" id="combined-confluence-url" placeholder="URL or page ID">
            </div>
            <div class="form-group">
                <label class="checkbox-label">
                    <input type="checkbox" id="combined-copilot">
                    Use Copilot AI
                </label>
            </div>
            <button class="primary-button" id="generate-combined-btn">🚀 Generate Tests</button>
        </div>

        <!-- Settings Tab -->
        <div class="tab-content" id="settings-tab">
            <h2>Settings</h2>
            <div class="form-group">
                <label>Output Path:</label>
                <input type="text" id="output-path" placeholder="src/test/karate">
            </div>
            <div class="form-group">
                <label>Template:</label>
                <select id="test-template">
                    <option value="standard">Standard</option>
                    <option value="detailed">Detailed</option>
                    <option value="minimal">Minimal</option>
                </select>
            </div>
            <div class="form-group">
                <label>Confluence URL:</label>
                <input type="text" id="confluence-base-url" placeholder="https://company.atlassian.net/wiki">
                <p class="info-text">Your Confluence instance URL</p>
            </div>
            <div class="form-group">
                <label>Confluence Email:</label>
                <input type="text" id="confluence-email" placeholder="email@company.com">
            </div>
            <button class="primary-button" id="save-settings-btn">💾 Save Settings</button>
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
                <button id="open-file-btn">Open File</button>
                <button id="copy-content-btn">Copy to Clipboard</button>
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
