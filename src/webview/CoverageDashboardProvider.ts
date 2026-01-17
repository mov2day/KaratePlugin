import * as vscode from 'vscode';
import * as path from 'path';
import { EnhancedCoverageService, EnhancedCoverageReport } from '../services/enhancedCoverageService';
import { logger } from '../utils/logger';

/**
 * Webview provider for the interactive coverage dashboard
 */
export class CoverageDashboardProvider {
    public static readonly viewType = 'karateGenerator.coverageDashboard';
    private _currentReport?: EnhancedCoverageReport;
    private _coverageService: EnhancedCoverageService;

    constructor(private readonly _extensionUri: vscode.Uri) {
        this._coverageService = new EnhancedCoverageService();
    }

    /**
     * Show the coverage dashboard in a full panel
     */
    public async showDashboard() {
        // Create webview panel
        const panel = vscode.window.createWebviewPanel(
            'coverageDashboard',
            'Karate Test Coverage Dashboard',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this._extensionUri]
            }
        );

        // Set HTML content
        panel.webview.html = this._getHtmlForWebview(panel.webview);

        // Auto-scan for feature files on open
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (workspaceRoot) {
            const pattern = new vscode.RelativePattern(workspaceRoot, '**/*.feature');
            const files = await vscode.workspace.findFiles(pattern);

            panel.webview.postMessage({
                type: 'featuresFound',
                paths: files.map(f => f.fsPath),
                count: files.length
            });
        }

        // Handle messages from the webview
        panel.webview.onDidReceiveMessage(async (data) => {
            logger.info(`Coverage dashboard received message: ${data.command}`);
            console.log('Coverage dashboard message:', data);

            switch (data.command) {
                case 'selectSpecs':
                    logger.info('Handling selectSpecs');
                    await this.handleSelectSpecsForPanel(panel.webview);
                    break;
                case 'selectFeatures':
                    logger.info('Handling selectFeatures');
                    await this.handleSelectFeaturesForPanel(panel.webview);
                    break;
                case 'analyzeCoverage':
                    logger.info('Handling analyzeCoverage');
                    await this.handleAnalyzeCoverageForPanel(panel.webview, data.specPaths, data.featurePaths, data.useCopilot);
                    break;
                case 'generateTest':
                    logger.info('Handling generateTest');
                    await this.handleGenerateTest(data.endpoint, data.featurePaths);
                    break;
                case 'generateTestWithAI':
                    logger.info('Handling generateTestWithAI');
                    await this.handleGenerateTestWithAI(data.endpoint, data.featurePaths);
                    break;
                case 'viewDetails':
                    logger.info('Handling viewDetails');
                    await this.handleViewDetails(data.endpoint);
                    break;
                case 'exportReport':
                    logger.info('Handling exportReport');
                    await this.handleExportReport();
                    break;
                default:
                    logger.warn(`Unknown command: ${data.command}`);
            }
        });
    }

    private async handleSelectSpecsForPanel(webview: vscode.Webview) {
        logger.info('handleSelectSpecsForPanel called');
        console.log('Opening file picker for specs...');

        const fileUris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Select OpenAPI Spec(s)',
            filters: {
                'OpenAPI Spec': ['json', 'yaml', 'yml']
            }
        });

        logger.info(`File picker result: ${fileUris ? fileUris.length + ' files' : 'cancelled'}`);

        if (fileUris && fileUris.length > 0) {
            const paths = fileUris.map(f => f.fsPath);
            logger.info(`Sending specsSelected message with paths: ${paths.join(', ')}`);
            webview.postMessage({
                type: 'specsSelected',
                paths: paths
            });
        }
    }

    private async handleSelectFeaturesForPanel(webview: vscode.Webview) {
        logger.info('handleSelectFeaturesForPanel called');
        console.log('Opening file picker for features...');

        const fileUris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Select Feature File(s)',
            filters: {
                'Karate Feature': ['feature']
            }
        });

        logger.info(`File picker result: ${fileUris ? fileUris.length + ' files' : 'cancelled'}`);

        if (fileUris && fileUris.length > 0) {
            const paths = fileUris.map(f => f.fsPath);
            logger.info(`Sending featuresSelected message with paths: ${paths.join(', ')}`);
            webview.postMessage({
                type: 'featuresSelected',
                paths: paths,
                count: fileUris.length
            });
        }
    }

    private async handleAnalyzeCoverageForPanel(webview: vscode.Webview, specPaths: string[], featurePaths: string[], useCopilot: boolean) {
        try {
            webview.postMessage({ type: 'analysisStarted' });

            const report = await this._coverageService.analyzeMultipleSpecs(
                specPaths,
                featurePaths,
                useCopilot
            );

            this._currentReport = report;

            // Send report data to webview
            webview.postMessage({
                type: 'coverageReport',
                data: this.serializeReport(report)
            });

            logger.info(`Coverage analysis complete: ${report.percentage.toFixed(1)}%`);
        } catch (error) {
            logger.error('Coverage analysis failed', error as Error);
            webview.postMessage({
                type: 'analysisError',
                message: (error as Error).message
            });
        }
    }

    private serializeReport(report: EnhancedCoverageReport): any {
        return {
            specName: report.specName,
            percentage: report.percentage,
            totalEndpoints: report.totalEndpoints,
            coveredEndpoints: report.coveredEndpoints,
            endpoints: report.endpoints.map(e => ({
                path: e.path,
                method: e.method,
                covered: e.covered,
                scenarios: e.scenarios,
                missingTests: e.missingTests
            })),
            methodBreakdown: Array.from(report.methodBreakdown.entries()).map(([method, stats]) => ({
                method,
                total: stats.total,
                covered: stats.covered,
                percentage: stats.total > 0 ? (stats.covered / stats.total) * 100 : 0
            })),
            copilotInsights: report.copilotInsights
        };
    }

    private async handleGenerateTest(endpoint: any, featurePaths?: string[]) {
        try {
            const { KarateGenerator } = await import('../services/karateGenerator');
            const generator = new KarateGenerator();
            const fs = await import('fs');
            const path = await import('path');

            let targetFile: string | undefined;

            // Ask user if they want to append to an existing file
            if (featurePaths && featurePaths.length > 0) {
                const options = [
                    { label: '$(file-add) Create New Feature File', description: 'Generate a new file' },
                    ...featurePaths.map(p => ({
                        label: `$(file) Append to ${path.basename(p)}`,
                        description: p,
                        detail: 'Adds a new scenario to this file'
                    }))
                ];

                const selection = await vscode.window.showQuickPick(options, {
                    placeHolder: 'Where should the test be generated?'
                });

                if (!selection) return; // User cancelled

                if (selection.description !== 'Generate a new file') {
                    targetFile = selection.description;
                }
            }

            if (targetFile) {
                // APPEND MODE
                const content = fs.readFileSync(targetFile, 'utf-8');

                // Generate a simple scenario block (since we don't use AI here)
                // We try to infer if 'url' variable is used in background for slightly better code
                const hasUrlVar = content.includes('url baseUrl') || content.includes('url ');

                let scenario = `
  Scenario: ${endpoint.summary || `${endpoint.method} ${endpoint.path}`}
    Given path '${endpoint.path}'
    When method ${endpoint.method}
    Then status 200
`;
                // Simple indentation fix
                if (content.includes('  Scenario:')) {
                    // scenario is already indented 2 spaces
                } else if (content.includes('Scenario:')) {
                    scenario = scenario.replace(/^  /gm, ''); // Remove indentation if file uses 0 indent
                }

                const newContent = content + '\n' + scenario;
                fs.writeFileSync(targetFile, newContent);

                const doc = await vscode.workspace.openTextDocument(targetFile);
                await vscode.window.showTextDocument(doc);

                vscode.window.showInformationMessage(`Appended test to ${path.basename(targetFile)}`);

            } else {
                // NEW FILE MODE
                const feature = generator.generateFromOpenAPI([endpoint], endpoint.path.replace(/\//g, '_'));
                const scenario = generator.featureToString(feature);

                const doc = await vscode.workspace.openTextDocument({
                    content: scenario,
                    language: 'karate'
                });
                await vscode.window.showTextDocument(doc);
                vscode.window.showInformationMessage(`Generated test for ${endpoint.method} ${endpoint.path}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to generate test: ${(error as Error).message}`);
        }
    }

    private async handleGenerateTestWithAI(endpoint: any, featurePaths?: string[]) {
        try {
            const fs = await import('fs');
            const path = await import('path');
            let targetFile: string | undefined;

            // Ask user if they want to append to an existing file
            if (featurePaths && featurePaths.length > 0) {
                const options = [
                    { label: '$(file-add) Create New Feature File', description: 'Generate a new file' },
                    ...featurePaths.map(p => ({
                        label: `$(file) Append to ${path.basename(p)}`,
                        description: p,
                        detail: 'Adds AI-generated scenarios reusing background & style'
                    }))
                ];

                const selection = await vscode.window.showQuickPick(options, {
                    placeHolder: 'Where should the AI-generated test be added?'
                });

                if (!selection) return;

                if (selection.description !== 'Generate a new file') {
                    targetFile = selection.description;
                }
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Generating AI-enhanced test for ${endpoint.method} ${endpoint.path}`,
                cancellable: false
            }, async (progress) => {
                try {
                    progress.report({ increment: 10, message: 'Checking Copilot availability...' });

                    const { CopilotService } = await import('../services/copilotService');
                    const isAvailable = await CopilotService.isCopilotAvailable();

                    if (!isAvailable) {
                        vscode.window.showWarningMessage('GitHub Copilot is not available. Generating basic test instead.');
                        await this.handleGenerateTest(endpoint, targetFile ? [targetFile] : undefined);
                        return;
                    }

                    if (targetFile) {
                        // APPEND MODE (AI)
                        progress.report({ increment: 30, message: 'Reading existing file context...' });
                        const content = fs.readFileSync(targetFile, 'utf-8');

                        progress.report({ increment: 50, message: 'Generating scenarios matching file style...' });

                        const newScenarios = await CopilotService.generateAdditionalScenarios(
                            content,
                            `${endpoint.method} ${endpoint.path} - ${endpoint.summary || 'API Endpoint'}`,
                            ['Follow the style and background usage of the existing file', 'Generate valid Karate DSL scenarios']
                        );

                        if (newScenarios && newScenarios.length > 0) {
                            const appendContent = '\n' + newScenarios.join('\n\n');
                            fs.writeFileSync(targetFile, content + appendContent);

                            const doc = await vscode.workspace.openTextDocument(targetFile);
                            await vscode.window.showTextDocument(doc);

                            vscode.window.showInformationMessage(`AI appended ${newScenarios.length} scenarios to ${path.basename(targetFile)}`);
                        } else {
                            vscode.window.showWarningMessage('Copilot did not return valid scenarios');
                        }

                    } else {
                        // NEW FILE MODE (AI)
                        progress.report({ increment: 20, message: 'Generating basic test structure...' });

                        const { KarateGenerator } = await import('../services/karateGenerator');
                        const generator = new KarateGenerator();
                        const feature = generator.generateFromOpenAPI([endpoint], endpoint.path.replace(/\//g, '_'));
                        const basicTest = generator.featureToString(feature);

                        progress.report({ increment: 30, message: 'Enhancing with AI...' });

                        const enhancedTest = await CopilotService.enhanceKarateTestComprehensive(
                            basicTest,
                            `Generate comprehensive tests for ${endpoint.method} ${endpoint.path}`,
                            { type: 'openapi', openApiSpec: JSON.stringify(endpoint) }
                        );


                        progress.report({ increment: 40, message: 'Opening enhanced test...' });

                        // Show in editor
                        const doc = await vscode.workspace.openTextDocument({
                            content: enhancedTest || basicTest,
                            language: 'karate'
                        });
                        await vscode.window.showTextDocument(doc);

                        vscode.window.showInformationMessage(`✅ Generated AI-enhanced test for ${endpoint.method} ${endpoint.path}`);
                    }
                } catch (error) {
                    logger.error('Failed to generate AI test', error as Error);
                    vscode.window.showErrorMessage(`Failed to generate AI test: ${(error as Error).message}`);
                }
            });
        } catch (error) {
            // Outer catch
        }
    }

    private async handleViewDetails(endpoint: any) {
        const message = `
**Endpoint**: ${endpoint.method} ${endpoint.path}
**Status**: ${endpoint.covered ? '✅ Covered' : '❌ Not Covered'}
**Test Scenarios**: ${endpoint.scenarios.length}
**Missing Tests**: ${endpoint.missingTests.join(', ') || 'None'}
        `;

        vscode.window.showInformationMessage(message, { modal: true });
    }

    private async handleExportReport() {
        if (!this._currentReport) {
            vscode.window.showWarningMessage('No coverage report available');
            return;
        }

        const htmlContent = this._coverageService.exportToHtmlWithInsights(this._currentReport);

        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file('coverage-report.html'),
            filters: {
                'HTML': ['html']
            }
        });

        if (saveUri) {
            const fs = await import('fs');
            fs.writeFileSync(saveUri.fsPath, htmlContent);
            vscode.window.showInformationMessage(`Coverage report exported to ${saveUri.fsPath}`);
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const chartJsUri = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';

        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net;">
    <title>Coverage Dashboard</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
        }

        .dashboard-container {
            display: grid;
            grid-template-columns: 1fr 2fr 1fr;
            gap: 20px;
            height: 100vh;
        }

        .panel {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 20px;
            overflow-y: auto;
        }

        .panel-header {
            font-size: 18px;
            font-weight: bold;
            margin-bottom: 15px;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .endpoint-list {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }

        .endpoint-card {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            padding: 12px;
        }

        .endpoint-card.covered {
            border-left: 4px solid #4CAF50;
        }

        .endpoint-card.missing {
            border-left: 4px solid #f44336;
        }

        .endpoint-header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
        }

        .method-badge {
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: bold;
            color: white;
        }

        .method-badge.GET { background: #2196F3; }
        .method-badge.POST { background: #4CAF50; }
        .method-badge.PUT { background: #9C27B0; }
        .method-badge.DELETE { background: #f44336; }

        .endpoint-path {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }

        .endpoint-actions {
            display: flex;
            gap: 8px;
            margin-top: 8px;
        }

        .btn {
            padding: 6px 12px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .btn:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .chart-container {
            margin: 20px 0;
            height: 300px;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 15px;
            margin-bottom: 20px;
        }

        .stat-card {
            background: var(--vscode-input-background);
            padding: 15px;
            border-radius: 6px;
            text-align: center;
        }

        .stat-value {
            font-size: 32px;
            font-weight: bold;
            color: #4CAF50;
        }

        .stat-label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 5px;
        }

        .insights-panel {
            background: var(--vscode-input-background);
            border-radius: 6px;
            padding: 15px;
            margin-top: 15px;
        }

        .insight-item {
            margin-bottom: 12px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .insight-item:last-child {
            border-bottom: none;
        }

        .loading {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }

        .status-indicator {
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            margin-right: 8px;
        }


        .status-indicator.covered { background: #4CAF50; }
        .status-indicator.missing { background: #f44336; }

        .control-panel {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
        }

        .control-row {
            display: flex;
            gap: 15px;
            align-items: center;
            margin-bottom: 15px;
        }

        .control-label {
            font-weight: bold;
            min-width: 120px;
        }

        .control-input {
            flex: 1;
            padding: 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
        }

        .primary-btn {
            padding: 10px 20px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-weight: bold;
        }

        .primary-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .secondary-btn {
            padding: 8px 16px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
        }

        .checkbox-label {
            display: flex;
            align-items: center;
            gap: 8px;
        }
    </style>
</head>
<body>
    <!-- Control Panel -->
    <div class="control-panel">
        <h2 style="margin-bottom: 15px;">📊 Coverage Analysis Configuration</h2>
        
        <div class="control-row">
            <span class="control-label">OpenAPI Specs:</span>
            <input type="text" id="spec-paths" class="control-input" placeholder="No specs selected" readonly>
            <button class="secondary-btn" id="select-specs-btn">📂 Browse Specs</button>
        </div>

        <div class="control-row">
            <span class="control-label">Feature Files:</span>
            <input type="text" id="feature-paths" class="control-input" placeholder="No features selected" readonly>
            <button class="secondary-btn" id="select-features-btn">📂 Browse Features</button>
        </div>

        <div class="control-row">
            <label class="checkbox-label">
                <input type="checkbox" id="use-copilot">
                <span>🤖 Use GitHub Copilot for enhanced analysis</span>
            </label>
        </div>

        <div class="control-row">
            <button class="primary-btn" id="analyze-coverage-btn">🚀 Analyze Coverage</button>
            <button class="secondary-btn" id="refresh-coverage-btn" style="margin-left: 10px; display: none;">🔄 Refresh Analysis</button>
        </div>
    </div>

    <div class="dashboard-container">
        <!-- Left Panel: Endpoint List -->
        <div class="panel">
            <div class="panel-header">
                📊 Endpoint Coverage
            </div>
            <div id="endpoint-list" class="endpoint-list">
                <div class="loading">Select specs to analyze coverage</div>
            </div>
        </div>

        <!-- Center Panel: Charts -->
        <div class="panel">
            <div class="panel-header">
                📈 Karate Visual Test Coverage
            </div>
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-value" id="coverage-percentage">--</div>
                    <div class="stat-label">Total Coverage</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value" id="covered-count">--</div>
                    <div class="stat-label">Endpoints Covered</div>
                </div>
            </div>
            <div class="chart-container">
                <canvas id="coverage-donut"></canvas>
            </div>
            <div class="panel-header" style="margin-top: 30px;">
                📊 Method Breakdown
            </div>
            <div class="chart-container">
                <canvas id="method-bar"></canvas>
            </div>
        </div>

        <!-- Right Panel: Copilot Insights -->
        <div class="panel">
            <div class="panel-header">
                🤖 Copilot Insights
            </div>
            <div id="insights-container">
                <div class="loading">AI insights will appear here</div>
            </div>
        </div>
    </div>

    <script src="${chartJsUri}" nonce="${nonce}"></script>
    <script nonce="${nonce}">
        (function() {
            'use strict';
            
            console.log('=== Coverage Dashboard Script Starting ===');
            
            // Define variables at top level of IIFE for proper scope
            let vscode;
            let coverageChart, methodChart;
            let selectedSpecPaths = [];
            let selectedFeaturePaths = [];
            
            try {
                vscode = acquireVsCodeApi();
                console.log('VSCode API acquired successfully');
                
                function init() {
                    console.log('Initializing coverage dashboard...');
                    console.log('Document ready state:', document.readyState);
                    
                    try {
                        // Spec button
                        const specBtn = document.getElementById('select-specs-btn');
                        console.log('Spec button found:', !!specBtn);
                        if (specBtn) {
                            specBtn.addEventListener('click', function() {
                                console.log('Spec button clicked, sending message...');
                                try {
                                    vscode.postMessage({ command: 'selectSpecs' });
                                    console.log('Message sent successfully');
                                } catch (e) {
                                    console.error('Error sending message:', e);
                                }
                            });
                        }

                        // Feature button
                        const featBtn = document.getElementById('select-features-btn');
                        console.log('Feature button found:', !!featBtn);
                        if (featBtn) {
                            featBtn.addEventListener('click', function() {
                                console.log('Feature button clicked, sending message...');
                                try {
                                    vscode.postMessage({ command: 'selectFeatures' });
                                    console.log('Message sent successfully');
                                } catch (e) {
                                    console.error('Error sending message:', e);
                                }
                            });
                        }

                const analyzeBtn = document.getElementById('analyze-coverage-btn');
                const refreshBtn = document.getElementById('refresh-coverage-btn');
                
                console.log('Analyze button found:', !!analyzeBtn);
                console.log('Refresh button found:', !!refreshBtn);
                
                if (analyzeBtn) {
                    analyzeBtn.addEventListener('click', function() {
                        console.log('Analyze button clicked');
                        console.log('Current selectedSpecPaths:', selectedSpecPaths);
                        console.log('Current selectedFeaturePaths:', selectedFeaturePaths);
                        
                        if (selectedSpecPaths.length === 0) {
                            console.warn('No OpenAPI specs selected');
                            return;
                        }
                        if (selectedFeaturePaths.length === 0) {
                            console.warn('No feature files selected');
                            return;
                        }
                        
                        const useCopilot = document.getElementById('use-copilot').checked;
                        console.log('Sending analyze coverage message...', {
                            specPaths: selectedSpecPaths,
                            featurePaths: selectedFeaturePaths,
                            useCopilot: useCopilot
                        });
                        vscode.postMessage({
                            command: 'analyzeCoverage',
                            specPaths: selectedSpecPaths,
                            featurePaths: selectedFeaturePaths,
                            useCopilot: useCopilot
                        });
                    });
                }
                
                if (refreshBtn) {
                    refreshBtn.addEventListener('click', function() {
                        console.log('Refresh button clicked');
                        if (selectedSpecPaths.length === 0 || selectedFeaturePaths.length === 0) {
                            console.warn('No files selected for refresh');
                            return;
                        }
                        
                        const useCopilot = document.getElementById('use-copilot').checked;
                        console.log('Re-analyzing coverage with same files...');
                        vscode.postMessage({
                            command: 'analyzeCoverage',
                            specPaths: selectedSpecPaths,
                            featurePaths: selectedFeaturePaths,
                            useCopilot: useCopilot
                        });
                    });
                }
                
                console.log('Dashboard initialization complete');
                    } catch (initError) {
                        console.error('Error during initialization:', initError);
                    }
                }

                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', init);
                } else {
                    init();
                }

                // Listen for messages from extension (MUST be inside IIFE to access same variables)
                window.addEventListener('message', event => {
                    const message = event.data;
                    console.log('Received message from extension:', message.type);
                    
                    switch (message.type) {
                        case 'coverageReport':
                            renderReport(message.data);
                            // Show refresh button after first analysis
                            const refreshBtn = document.getElementById('refresh-coverage-btn');
                            if (refreshBtn) {
                                refreshBtn.style.display = 'inline-block';
                            }
                            break;
                        case 'analysisStarted':
                            showLoading();
                            break;
                        case 'analysisError':
                            showError(message.message);
                            break;
                        case 'specsSelected':
                            console.log('Specs selected, paths:', message.paths);
                            selectedSpecPaths = message.paths;
                            console.log('Updated selectedSpecPaths:', selectedSpecPaths);
                            const specDisplay = message.paths.length === 1 
                                ? message.paths[0].split('/').pop() 
                                : message.paths.length + ' specs selected';
                            document.getElementById('spec-paths').value = specDisplay;
                            break;
                        case 'featuresSelected':
                            console.log('Features selected, paths:', message.paths);
                            selectedFeaturePaths = message.paths;
                            console.log('Updated selectedFeaturePaths:', selectedFeaturePaths);
                            document.getElementById('feature-paths').value = message.count + ' feature files selected';
                            break;
                    }
                });

                // Event delegation for dynamically created priority AI buttons
                document.addEventListener('click', function(e) {
                    if (e.target && e.target.classList.contains('priority-ai-btn')) {
                        const method = e.target.getAttribute('data-method');
                        const path = e.target.getAttribute('data-path');
                        const description = e.target.getAttribute('data-description');
                        
                        console.log('Priority AI button clicked:', { method, path, description });
                vscode.postMessage({
                            command: 'generateTestWithAI',
                            endpoint: { method, path, description }
                        });
                    }
                });
                
            } catch (error) {
                console.error('=== CRITICAL ERROR ===', error);
            }
        // Helper functions (inside IIFE to access coverageChart, methodChart, vscode)

        function renderReport(data) {
            // Update stats
            document.getElementById('coverage-percentage').textContent = data.percentage.toFixed(1) + '%';
            document.getElementById('covered-count').textContent = data.coveredEndpoints + '/' + data.totalEndpoints;

            // Render endpoint list
            renderEndpointList(data.endpoints);

            // Render charts
            renderCoverageChart(data.percentage);
            renderMethodChart(data.methodBreakdown);

            // Render Copilot insights
            if (data.copilotInsights) {
                renderInsights(data.copilotInsights);
            }
        }

        function renderEndpointList(endpoints) {
            const container = document.getElementById('endpoint-list');
            container.innerHTML = '';

            endpoints.forEach(function(ep) {
                const card = document.createElement('div');
                card.className = 'endpoint-card ' + (ep.covered ? 'covered' : 'missing');
                
                const header = document.createElement('div');
                header.className = 'endpoint-header';
                header.innerHTML = '<span class="status-indicator ' + (ep.covered ? 'covered' : 'missing') + '"></span>' +
                                 '<span class="method-badge ' + ep.method + '">' + ep.method + '</span>' +
                                 '<span class="endpoint-path">' + ep.path + '</span>';
                
                const actions = document.createElement('div');
                actions.className = 'endpoint-actions';
                
                if (!ep.covered) {
                    const btn = document.createElement('button');
                    btn.className = 'btn';
                    btn.textContent = 'Generate Test';
                    btn.onclick = function() { vscode.postMessage({ command: 'generateTest', endpoint: ep, featurePaths: selectedFeaturePaths }); };
                    actions.appendChild(btn);
                    
                    const aiBtn = document.createElement('button');
                    aiBtn.className = 'btn';
                    aiBtn.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
                    aiBtn.textContent = '🤖 Generate with AI';
                    aiBtn.onclick = function() { vscode.postMessage({ command: 'generateTestWithAI', endpoint: ep, featurePaths: selectedFeaturePaths }); };
                    actions.appendChild(aiBtn);
                }
                
                const detBtn = document.createElement('button');
                detBtn.className = 'btn btn-secondary';
                detBtn.textContent = 'View Details';
                detBtn.onclick = function() { vscode.postMessage({ command: 'viewDetails', endpoint: ep }); };
                actions.appendChild(detBtn);
                
                card.appendChild(header);
                card.appendChild(actions);
                container.appendChild(card);
            });
        }

        function renderCoverageChart(percentage) {
            const ctx = document.getElementById('coverage-donut').getContext('2d');
            
            if (coverageChart) {
                coverageChart.destroy();
            }

            coverageChart = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: ['Covered', 'Not Covered'],
                    datasets: [{
                        data: [percentage, 100 - percentage],
                        backgroundColor: ['#4CAF50', '#f44336'],
                        borderWidth: 0
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: {
                                color: getComputedStyle(document.body).getPropertyValue('--vscode-foreground')
                            }
                        }
                    }
                }
            });
        }

        function renderMethodChart(methodBreakdown) {
            const ctx = document.getElementById('method-bar').getContext('2d');
            
            if (methodChart) {
                methodChart.destroy();
            }

            const labels = methodBreakdown.map(m => m.method);
            const data = methodBreakdown.map(m => m.percentage);
            const colors = labels.map(method => {
                switch(method) {
                    case 'GET': return '#2196F3';
                    case 'POST': return '#4CAF50';
                    case 'PUT': return '#9C27B0';
                    case 'DELETE': return '#f44336';
                    default: return '#757575';
                }
            });

            methodChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Coverage %',
                        data: data,
                        backgroundColor: colors,
                        borderWidth: 0
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            display: false
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            max: 100,
                            ticks: {
                                color: getComputedStyle(document.body).getPropertyValue('--vscode-foreground')
                            },
                            grid: {
                                color: 'rgba(128, 128, 128, 0.1)'
                            }
                        },
                        x: {
                            ticks: {
                                color: getComputedStyle(document.body).getPropertyValue('--vscode-foreground')
                            },
                            grid: {
                                display: false
                            }
                        }
                    }
                }
            });
        }

        function renderInsights(insights) {
            const container = document.getElementById('insights-container');
            if (!container) return;
            
            let html = '<div class="insights-panel">';
            
            // AI Tips
            html += '<div class="insight-item">' +
                    '<strong>💡 AI Tips:</strong>' +
                    '<p style="margin-top: 8px; font-size: 12px;">' +
                        'Quality: <strong>' + (insights.quality || 'N/A').toUpperCase() + '</strong><br>' +
                        'Coverage: <strong>' + (insights.coveragePercentage || 0).toFixed(1) + '%</strong>' +
                    '</p>' +
                    '</div>';
            
            // Priority Endpoints
            html += '<div class="insight-item">' +
                    '<strong>🎯 Priority Endpoints:</strong>' +
                    '<ul style="margin-top: 8px; font-size: 12px; padding-left: 20px;">';
            
            if (insights.priorityEndpoints && Array.isArray(insights.priorityEndpoints)) {
                insights.priorityEndpoints.slice(0, 5).forEach(function(ep) {
                    html += '<li style="margin-bottom: 10px;">' +
                            '<strong>' + ep.method + ' ' + ep.path + '</strong><br>' +
                            '<em>' + ep.reason + '</em><br>' +
                            '<button class="btn priority-ai-btn" style="margin-top: 5px; font-size: 10px; padding: 4px 8px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);" ' +
                            'data-method="' + ep.method + '" data-path="' + ep.path + '" data-description="' + (ep.reason || '') + '">' +
                            '🤖 Generate with AI</button>' +
                            '</li>';
                });
            }
            html += '</ul></div>';
            
            // Recommendations
            html += '<div class="insight-item">' +
                    '<strong>📋 Recommendations:</strong>' +
                    '<ul style="margin-top: 8px; font-size: 12px; padding-left: 20px;">';
            
            if (insights.recommendations && Array.isArray(insights.recommendations)) {
                insights.recommendations.forEach(function(rec) {
                    html += '<li>' + rec + '</li>';
                });
            }
            html += '</ul></div></div>';
            
            container.innerHTML = html;

            // Add event listeners to buttons
            const btns = container.querySelectorAll('.priority-ai-btn');
            btns.forEach(btn => {
                btn.onclick = function() {
                    const ep = {
                        method: this.getAttribute('data-method'),
                        path: this.getAttribute('data-path'),
                        description: this.getAttribute('data-description')
                    };
                    vscode.postMessage({ command: 'generateTestWithAI', endpoint: ep, featurePaths: selectedFeaturePaths });
                };
            });
        }

        function showLoading() {
            const list = document.getElementById('endpoint-list');
            if (list) list.innerHTML = '<div class="loading">Analyzing coverage...</div>';
            const insights = document.getElementById('insights-container');
            if (insights) insights.innerHTML = '<div class="loading">Generating AI insights...</div>';
        }

        function showError(message) {
            const list = document.getElementById('endpoint-list');
            if (list) list.innerHTML = '<div class="loading" style="color: #f44336;">Error: ' + message + '</div>';
        }
        
        })(); // End of IIFE
    </script>
</body>
</html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
