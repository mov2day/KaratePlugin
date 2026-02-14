import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TestExecutionResult, TestExecutionOptions } from '../types';
import { TestHistoryService } from '../services/execution/TestHistoryService';
import { TestResultComparator } from '../services/execution/TestResultComparator';
import { logger } from '../utils/logger';

/**
 * Webview provider for the modern test execution report dashboard
 */
export class ExecutionReportProvider {
    public static readonly viewType = 'karateGenerator.executionReport';

    private _panel: vscode.WebviewPanel | undefined;
    private _currentResult?: TestExecutionResult;
    private _historyService?: TestHistoryService;

    constructor(private readonly _extensionUri: vscode.Uri) { }

    /**
     * Show the execution report dashboard
     */
    public async showReport(result?: TestExecutionResult) {
        logger.info(`[ExecutionReportProvider] showReport called with result: ${result ? 'yes' : 'no'}`);

        if (result) {
            this._currentResult = result;
            logger.info(`[ExecutionReportProvider] Current result features: ${result.features?.length}`);
            logger.info(`[ExecutionReportProvider] Current result scenarios: ${result.summary?.totalScenarios}`);
        }

        // Get workspace root for history service
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (workspaceRoot) {
            this._historyService = new TestHistoryService(workspaceRoot);
        }

        // Create or show panel
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.One);
            if (this._currentResult) {
                const serialized = this.serializeResult(this._currentResult);
                logger.info('[ExecutionReportProvider] Posting message to existing panel');
                this._panel.webview.postMessage({
                    type: 'executionResult',
                    data: serialized
                });
            }
        } else {
            logger.info('[ExecutionReportProvider] Creating new panel');
            this._panel = vscode.window.createWebviewPanel(
                ExecutionReportProvider.viewType,
                '🎯 Karate Test Execution Report',
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [this._extensionUri]
                }
            );

            this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

            // Handle messages from webview
            this._panel.webview.onDidReceiveMessage(async message => {
                if (message.command === 'webviewReady') {
                    // Webview is ready, send data now
                    logger.info('[ExecutionReportProvider] Webview ready signal received');
                    if (this._currentResult) {
                        const serialized = this.serializeResult(this._currentResult);
                        logger.info('[ExecutionReportProvider] Sending data after webview ready');
                        this._panel?.webview.postMessage({
                            type: 'executionResult',
                            data: serialized
                        });
                    }
                    // Load history
                    await this.loadHistory();
                } else if (message.command === 'error') {
                    // Log errors from webview
                    logger.error(`[Webview Error] ${message.error.message}`, message.error);
                    vscode.window.showErrorMessage(`Dashboard Error: ${message.error.message}`);
                } else {
                    await this.handleMessage(message);
                }
            });

            this._panel.onDidDispose(() => {
                this._panel = undefined;
            });
        }
    }

    /**
     * Handle messages from webview
     */
    private async handleMessage(message: any) {
        switch (message.command) {
            case 'loadHistory':
                await this.loadHistory();
                break;

            case 'loadResult':
                await this.loadResultById(message.id);
                break;

            case 'exportHtml':
                await this.exportHtmlReport();
                break;

            case 'openFeature':
                await this.openFeatureFile(message.path, message.line);
                break;

            case 'compareWithPrevious':
                await this.compareWithPrevious();
                break;
        }
    }

    /**
     * Load test execution history
     */
    private async loadHistory() {
        if (!this._historyService) return;

        const history = await this._historyService.getHistory(10);
        const stats = await this._historyService.getStatistics();
        const trend = TestResultComparator.calculateTrend(history);

        this._panel?.webview.postMessage({
            type: 'historyLoaded',
            history: history.map((h: TestExecutionResult) => this.serializeResult(h)),
            stats,
            trend
        });
    }

    /**
     * Load specific result by ID
     */
    private async loadResultById(id: string) {
        if (!this._historyService) return;

        const result = await this._historyService.getResultById(id);
        if (result) {
            this._currentResult = result;
            this._panel?.webview.postMessage({
                type: 'executionResult',
                data: this.serializeResult(result)
            });
        }
    }

    /**
     * Compare current result with previous
     */
    private async compareWithPrevious() {
        if (!this._currentResult || !this._historyService) return;

        const history = await this._historyService.getHistory(10);
        const previousIndex = history.findIndex((h: TestExecutionResult) => h.id === this._currentResult!.id);

        if (previousIndex >= 0 && previousIndex < history.length - 1) {
            const previous = history[previousIndex + 1];
            const comparison = TestResultComparator.compare(this._currentResult, previous);

            this._panel?.webview.postMessage({
                type: 'comparisonResult',
                data: comparison
            });
        } else {
            vscode.window.showInformationMessage('No previous test run available for comparison');
        }
    }

    /**
     * Export HTML report
     */
    private async exportHtmlReport() {
        if (!this._currentResult) {
            vscode.window.showWarningMessage('No test result available to export');
            return;
        }

        const htmlContent = this.generateHtmlReport(this._currentResult);

        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`karate-report-${this._currentResult.id}.html`),
            filters: { 'HTML': ['html'] }
        });

        if (saveUri) {
            fs.writeFileSync(saveUri.fsPath, htmlContent);
            vscode.window.showInformationMessage(`Report exported to ${saveUri.fsPath}`);
        }
    }

    /**
     * Open feature file at specific line
     */
    private async openFeatureFile(featurePath: string, line?: number) {
        try {
            const uri = vscode.Uri.file(featurePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc);

            if (line && line > 0) {
                const position = new vscode.Position(line - 1, 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position));
            }
        } catch (error) {
            logger.error(`Failed to open feature file: ${featurePath}`, error as Error);
        }
    }

    /**
     * Serialize test result for webview
     */
    private serializeResult(result: TestExecutionResult): any {
        logger.info(`[ExecutionReportProvider] Serializing result: features=${result.features?.length}, scenarios=${result.summary?.totalScenarios}, status=${result.status}`);

        const serialized = {
            id: result.id,
            timestamp: result.timestamp,
            status: result.status,
            summary: result.summary,
            features: result.features.map((f: any) => ({
                name: f.name,
                relativePath: f.relativePath,
                absolutePath: f.absolutePath,
                status: f.status,
                passed: f.passed,
                failed: f.failed,
                skipped: f.skipped,
                duration: f.duration,
                scenarios: f.scenarios.map((s: any) => ({
                    name: s.name,
                    line: s.line,
                    status: s.status,
                    duration: s.duration,
                    error: s.error,
                    tags: s.tags,
                    steps: s.steps
                }))
            })),
            duration: result.duration,
            error: result.error
        };

        logger.info(`[ExecutionReportProvider] Serialized features: ${serialized.features.length}`);
        logger.info(`[ExecutionReportProvider] First feature scenarios: ${serialized.features[0]?.scenarios?.length}`);

        return serialized;
    }

    /**
     * Generate standalone HTML report
     */
    private generateHtmlReport(result: TestExecutionResult): string {
        // This would generate a full standalone HTML report
        // For now, returning a basic template
        return `<!DOCTYPE html>
<html>
<head>
    <title>Karate Test Execution Report</title>
    <style>${this.getReportStyles()}</style>
</head>
<body>
    <h1>Karate Test Execution Report</h1>
    <div class="summary">
        <h2>Summary</h2>
        <p>Passed: ${result.summary.passed} | Failed: ${result.summary.failed} | Skipped: ${result.summary.skipped}</p>
        <p>Pass Rate: ${result.summary.passPercentage.toFixed(2)}%</p>
        <p>Duration: ${result.summary.executionTime}</p>
    </div>
    <!-- Full report would be generated here -->
</body>
</html>`;
    }

    private getReportStyles(): string {
        return `
            body { font-family: Arial, sans-serif; padding: 20px; }
            .summary { background: #f5f5f5; padding: 15px; border-radius: 8px; }
        `;
    }

    /**
     * Get HTML content for webview
     */
    private _getHtmlForWebview(webview: vscode.Webview): string {
        const nonce = getNonce();
        const chartJsUri = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';

        // Compute logo URI
        // Using existing icon from resources folder
        const logoUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'resources', 'icon.png')
        );

        // Relaxed CSP for debugging
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src * 'unsafe-inline'; script-src * 'unsafe-inline' 'unsafe-eval'; img-src * data:;">
    <title>Karate Execution Report</title>
    ${this.getStyles()}
</head>
<body>
    <div class="app-container">
        <!-- Sidebar Navigation -->
        <nav class="sidebar">
            <div class="brand">
                <img src="${logoUri}" alt="Karate Logo" class="brand-logo">
                <div class="brand-text">Karate<br><span>Report</span></div>
            </div>
            
            <ul class="nav-menu">
                <li class="nav-item active" data-target="dashboard-view" id="nav-dashboard">
                    <span class="nav-icon">📊</span>
                    <span class="nav-label">Dashboard</span>
                </li>
                <li class="nav-item" data-target="features-view" id="nav-features">
                    <span class="nav-icon">📑</span>
                    <span class="nav-label">Features</span>
                </li>
                <li class="nav-item" data-target="failures-view" id="nav-failures">
                    <span class="nav-icon">❌</span>
                    <span class="nav-label">Failures</span>
                </li>
                <li class="nav-item" data-target="history-view" id="nav-history">
                    <span class="nav-icon">📜</span>
                    <span class="nav-label">History</span>
                </li>
            </ul>

            <div class="sidebar-footer">
                <!-- Export button removed as requested -->
            </div>
        </nav>

        <!-- Main Content Area -->
        <main class="main-content">
            <header class="top-bar">
                <h1 id="page-title">Dashboard Overview</h1>
                <div class="header-tools">
                    <div class="status-badge" id="execution-status">Ready</div>
                    <div class="timestamp" id="execution-time-display">--:--</div>
                </div>
            </header>

            <div id="no-data" class="view-state active">
                <div class="empty-state">
                    <div class="empty-icon">🚀</div>
                    <h2>Ready to Run Tests</h2>
                    <p>Execute a Karate feature or scenario to generate the report.</p>
                </div>
            </div>

            <!-- DASHBOARD VIEW -->
            <div id="dashboard-view" class="view-state">
                <!-- Summary Cards -->
                <div class="summary-grid">
                    <div class="card summary-card">
                        <div class="card-icon blue">📦</div>
                        <div class="card-data">
                            <div class="card-value" id="card-features">0</div>
                            <div class="card-label">Features</div>
                        </div>
                    </div>
                    <div class="card summary-card">
                        <div class="card-icon purple">🎬</div>
                        <div class="card-data">
                            <div class="card-value" id="card-scenarios">0</div>
                            <div class="card-label">Scenarios</div>
                        </div>
                    </div>
                    <div class="card summary-card">
                        <div class="card-icon green">✅</div>
                        <div class="card-data">
                            <div class="card-value success" id="card-passed">0%</div>
                            <div class="card-label">Pass Rate</div>
                        </div>
                    </div>
                    <div class="card summary-card">
                        <div class="card-icon orange">⏱️</div>
                        <div class="card-data">
                            <div class="card-value" id="card-duration">0s</div>
                            <div class="card-label">Duration</div>
                        </div>
                    </div>
                </div>

                <!-- Charts Row -->
                <div class="charts-grid">
                    <div class="card chart-card">
                        <h3 class="card-title">Scenario Results</h3>
                        <div class="chart-wrapper donut-wrapper">
                            <canvas id="status-chart"></canvas>
                            <div class="chart-center-text">
                                <div id="center-total">0</div>
                                <span>Total</span>
                            </div>
                        </div>
                    </div>
                    <div class="card chart-card">
                        <h3 class="card-title">Feature Duration</h3>
                        <div class="chart-wrapper">
                            <canvas id="duration-chart"></canvas>
                        </div>
                    </div>
                </div>
            </div>

            <!-- FEATURES VIEW -->
            <div id="features-view" class="view-state">
                <div class="card table-card">
                    <div class="table-actions">
                        <input type="text" id="feature-search" placeholder="Search features..." class="search-input">
                    </div>
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>Feature</th>
                                <th class="text-center">Scenarios</th>
                                <th class="text-center">Passed</th>
                                <th class="text-center">Failed</th>
                                <th class="text-center">Duration</th>
                                <th class="text-center">Status</th>
                            </tr>
                        </thead>
                        <tbody id="features-tbody">
                            <!-- Populated by JS -->
                        </tbody>
                    </table>
                </div>
                
                <!-- Scenario Drilldown Modal/Panel handled by JS -->
                <div id="scenario-drilldown" class="drilldown-panel" style="display: none;">
                    <div class="panel-header">
                        <h2 id="drilldown-title">Feature Details</h2>
                        <button class="btn-close" id="btn-close-drilldown">×</button>
                    </div>
                    <div class="panel-content" id="drilldown-content">
                        <!-- Scenarios list -->
                    </div>
                </div>
            </div>

            <!-- FAILURES VIEW -->
            <div id="failures-view" class="view-state">
                <div class="card">
                    <div class="failure-list" id="failures-list">
                        <!-- Populated by JS -->
                        <div class="empty-state-small">
                            <p>No failures found! Great job! 🎉</p>
                        </div>
                    </div>
                </div>
            </div>

            <!-- HISTORY VIEW -->
            <div id="history-view" class="view-state">
                <div class="card chart-card full-width">
                     <h3 class="card-title">Execution History Trend</h3>
                     <div class="chart-wrapper wide">
                         <canvas id="history-chart"></canvas>
                     </div>
                </div>
            </div>

        </main>
    </div>

    <script src="${chartJsUri}" nonce="${nonce}"></script>
    <script nonce="${nonce}">
        ${this.getScript()}
    </script>
</body>
</html>`;
    }

    private getStyles(): string {
        return `<style>
            :root {
                --primary: #3b82f6;
                --success: #10b981;
                --danger: #f43f5e;
                --warning: #f59e0b;
                --dark: #0f172a;
                --sidebar-bg: #1e293b;
                --card-bg: #ffffff;
                --bg: #f1f5f9;
                --text: #334155;
                --text-light: #64748b;
                --border: #e2e8f0;
            }

            /* Dark Mode Support via VS Code context */
            body.vscode-dark {
                --card-bg: #1e293b;
                --bg: #0f172a;
                --text: #e2e8f0;
                --text-light: #94a3b8;
                --border: #334155;
            }

            * { box-sizing: border-box; margin: 0; padding: 0; }

            body {
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background-color: var(--bg);
                color: var(--text);
                height: 100vh;
                overflow: hidden;
            }

            .app-container {
                display: flex;
                height: 100vh;
                width: 100vw;
            }

            /* Sidebar */
            .sidebar {
                width: 240px;
                background-color: var(--sidebar-bg);
                color: white;
                display: flex;
                flex-direction: column;
                padding: 1.5rem 1rem;
                flex-shrink: 0;
            }

            .brand {
                display: flex;
                align-items: center;
                gap: 12px;
                margin-bottom: 2.5rem;
                padding: 0 0.5rem;
            }

            .brand-logo {
                width: 40px;
                height: 40px;
                object-fit: contain;
                /* No background needed if logo is transparent */
            }

            .brand-text {
                font-weight: 700;
                font-size: 18px;
                line-height: 1.2;
            }

            .brand-text span {
                font-size: 12px;
                opacity: 0.7;
                font-weight: 500;
                text-transform: uppercase;
                letter-spacing: 1px;
            }

            .nav-menu {
                list-style: none;
                flex: 1;
            }

            .nav-item {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 12px 16px;
                border-radius: 8px;
                cursor: pointer;
                transition: all 0.2s;
                margin-bottom: 4px;
                color: #94a3b8;
                font-weight: 500;
            }

            .nav-item:hover {
                background-color: rgba(255, 255, 255, 0.05);
                color: white;
            }

            .nav-item.active {
                background: linear-gradient(90deg, rgba(59, 130, 246, 0.1), transparent);
                color: #60a5fa;
                border-left: 3px solid #60a5fa;
            }

            .nav-icon { font-size: 18px; }

            .sidebar-footer { margin-top: auto; }

            .btn-export {
                width: 100%;
                padding: 12px;
                background: rgba(255, 255, 255, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.2);
                color: white;
                border-radius: 8px;
                cursor: pointer;
                font-weight: 600;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
                transition: all 0.2s;
            }

            .btn-export:hover {
                background: rgba(255, 255, 255, 0.2);
                transform: translateY(-1px);
            }

            /* Main Content */
            .main-content {
                flex: 1;
                padding: 2rem;
                overflow-y: auto;
                position: relative;
            }

            .top-bar {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 2rem;
            }

            h1 {
                font-size: 24px;
                font-weight: 700;
            }

            .header-tools {
                display: flex;
                gap: 16px;
                align-items: center;
            }

            .status-badge {
                padding: 6px 12px;
                border-radius: 20px;
                font-size: 12px;
                font-weight: 600;
                background: var(--border);
                color: var(--text-light);
            }

            .status-badge.passed { background: rgba(16, 185, 129, 0.15); color: var(--success); }
            .status-badge.failed { background: rgba(244, 63, 94, 0.15); color: var(--danger); }

            /* View States */
            .view-state { display: none; }
            .view-state.active { display: block; animation: fadeIn 0.3s ease; }

            @keyframes fadeIn {
                from { opacity: 0; transform: translateY(10px); }
                to { opacity: 1; transform: translateY(0); }
            }

            /* Cards */
            .card {
                background: var(--card-bg);
                border-radius: 12px;
                padding: 1.5rem;
                box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
                border: 1px solid var(--border);
            }

            /* Summary Grid */
            .summary-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 1.5rem;
                margin-bottom: 2rem;
            }

            .summary-card {
                display: flex;
                align-items: center;
                gap: 16px;
            }

            .card-icon {
                width: 48px;
                height: 48px;
                border-radius: 12px;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 24px;
            }

            .card-icon.blue { background: rgba(59, 130, 246, 0.1); color: #3b82f6; }
            .card-icon.purple { background: rgba(139, 92, 246, 0.1); color: #8b5cf6; }
            .card-icon.green { background: rgba(16, 185, 129, 0.1); color: #10b981; }
            .card-icon.orange { background: rgba(245, 158, 11, 0.1); color: #f59e0b; }

            .card-value { font-size: 24px; font-weight: 700; line-height: 1.2; }
            .card-value.success { color: var(--success); }
            .card-label { font-size: 13px; color: var(--text-light); }

            /* Charts Grid */
            .charts-grid {
                display: grid;
                grid-template-columns: 1fr 2fr;
                gap: 1.5rem;
            }

            .card-title {
                font-size: 16px;
                font-weight: 600;
                margin-bottom: 1.5rem;
                color: var(--text);
            }

            .chart-wrapper {
                position: relative;
                height: 250px;
                width: 100%;
            }

            .donut-wrapper {
                display: flex;
                align-items: center;
                justify-content: center;
            }

            .chart-center-text {
                position: absolute;
                text-align: center;
                pointer-events: none;
            }

            #center-total { font-size: 28px; font-weight: 800; color: var(--text); }

            /* Tables */
            .data-table {
                width: 100%;
                border-collapse: collapse;
            }

            .data-table th {
                text-align: left;
                padding: 12px 16px;
                font-size: 12px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                color: var(--text-light);
                border-bottom: 1px solid var(--border);
            }

            .data-table td {
                padding: 16px;
                border-bottom: 1px solid var(--border);
                font-size: 14px;
            }

            .data-table tr:hover td {
                background-color: rgba(59, 130, 246, 0.05);
            }

            .text-center { text-align: center; }

            .badge {
                padding: 4px 10px;
                border-radius: 12px;
                font-size: 11px;
                font-weight: 600;
            }

            .badge.passed { background: rgba(16, 185, 129, 0.15); color: var(--success); }
            .badge.failed { background: rgba(244, 63, 94, 0.15); color: var(--danger); }
            .badge.skipped { background: rgba(245, 158, 11, 0.15); color: var(--warning); }

            /* Buttons & Inputs */
            .search-input {
                width: 100%;
                padding: 10px 16px;
                background: var(--bg);
                border: 1px solid var(--border);
                border-radius: 8px;
                color: var(--text);
                margin-bottom: 1rem;
                outline: none;
            }

            .search-input:focus { border-color: var(--primary); }

            .table-actions { margin-bottom: 1rem; }

            /* Drilldown Panel */
            .drilldown-panel {
                position: fixed;
                top: 0;
                right: 0;
                width: 600px;
                height: 100vh;
                background: var(--card-bg);
                box-shadow: -4px 0 20px rgba(0,0,0,0.1);
                z-index: 100;
                display: flex;
                flex-direction: column;
                animation: slideIn 0.3s ease;
            }

            @keyframes slideIn {
                from { transform: translateX(100%); }
                to { transform: translateX(0); }
            }

            .panel-header {
                padding: 1.5rem;
                border-bottom: 1px solid var(--border);
                display: flex;
                justify-content: space-between;
                align-items: center;
            }

            .btn-close {
                background: none;
                border: none;
                font-size: 24px;
                cursor: pointer;
                color: var(--text-light);
            }

            .panel-content {
                padding: 1.5rem;
                overflow-y: auto;
                flex: 1;
            }

            /* Step Styles (reused but cleaner) */
            .scenario-block {
                border: 1px solid var(--border);
                border-radius: 8px;
                margin-bottom: 1rem;
                overflow: hidden;
            }

            .scenario-title-bar {
                padding: 12px 16px;
                background: rgba(0,0,0,0.02);
                border-bottom: 1px solid var(--border);
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-weight: 600;
            }

            .step-row {
                padding: 8px 16px;
                display: flex;
                align-items: center;
                border-bottom: 1px solid rgba(0,0,0,0.03);
            }
            
            .step-row:last-child { border-bottom: none; }

            .step-keyword {
                font-weight: 700;
                color: var(--primary);
                width: 60px;
                flex-shrink: 0;
            }

            .step-text { flex: 1; font-family: 'Courier New', monospace; font-size: 13px; }
            
            .step-status { margin-left: auto; font-size: 12px; }

            /* Empty States */
            .empty-state { text-align: center; padding: 4rem 1rem; color: var(--text-light); }
            .empty-icon { font-size: 48px; margin-bottom: 1rem; }
        </style>`;
    }

    private getScript(): string {
        return `
        (function() {
            const vscode = acquireVsCodeApi();
            let currentResult = null;
            let statusChart = null;
            let durationChart = null;
            let historyChart = null;

            console.log('[Karate] Dashboard script loaded');
            vscode.postMessage({ command: 'webviewReady' });

            // Navigation Logic
            document.querySelectorAll('.nav-item').forEach(item => {
                item.addEventListener('click', () => {
                    // Remove active class from all nav items
                    document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
                    // Add active class to clicked item
                    item.classList.add('active');

                    // Hide all views
                    document.querySelectorAll('.view-state').forEach(view => view.classList.remove('active'));
                    // Show target view
                    const targetId = item.getAttribute('data-target');
                    const targetView = document.getElementById(targetId);
                    if (targetView) {
                        targetView.classList.add('active');
                        // Resize charts if needed
                        if (targetId === 'dashboard-view') {
                            if (statusChart) statusChart.resize();
                            if (durationChart) durationChart.resize();
                        }
                        if (targetId === 'history-view') {
                             vscode.postMessage({ command: 'loadHistory' });
                        }
                    }
                });
            });

            // Feature Search
            const searchInput = document.getElementById('feature-search');
            if (searchInput) {
                searchInput.addEventListener('input', (e) => {
                    const term = e.target.value.toLowerCase();
                    const rows = document.querySelectorAll('#features-tbody tr');
                    rows.forEach(row => {
                        const text = row.textContent.toLowerCase();
                        row.style.display = text.includes(term) ? '' : 'none';
                    });
                });
            }

            // Drilldown Close
            document.getElementById('btn-close-drilldown')?.addEventListener('click', () => {
                document.getElementById('scenario-drilldown').style.display = 'none';
            });

            // Button Handlers
            document.getElementById('btn-export')?.addEventListener('click', () => {
                vscode.postMessage({ command: 'exportHtml' });
            });

            // Message Handling
            window.addEventListener('message', event => {
                const message = event.data;
                switch (message.type) {
                    case 'executionResult':
                        renderDashboard(message.data);
                        break;
                    case 'historyLoaded':
                        renderHistoryChart(message.history, message.trend);
                        break;
                }
            });

            function renderDashboard(result) {
                currentResult = result;
                
                // Hide empty state
                document.getElementById('no-data').classList.remove('active');
                
                // Switch to dashboard view by default if "no-data" was active
                if (!document.querySelector('.view-state.active') || document.querySelector('.view-state.active').id === 'no-data') {
                    document.getElementById('nav-dashboard').click();
                }

                // Update Header
                const date = new Date();
                document.getElementById('execution-time-display').textContent = date.toLocaleTimeString();
                const statusBadge = document.getElementById('execution-status');
                const failed = result.summary.failed > 0;
                statusBadge.textContent = failed ? 'FAILED' : 'PASSED';
                statusBadge.className = 'status-badge ' + (failed ? 'failed' : 'passed');

                // Update Summary Cards
                document.getElementById('card-features').textContent = result.features.length;
                document.getElementById('card-scenarios').textContent = result.summary.totalScenarios;
                document.getElementById('card-passed').textContent = result.summary.passPercentage.toFixed(0) + '%';
                
                // Format total duration
                const durationSec = parseFloat(result.summary.executionTime.replace('s', ''));
                document.getElementById('card-duration').textContent = durationSec.toFixed(2) + 's';
                
                // Center text for donut
                document.getElementById('center-total').textContent = result.summary.totalScenarios;

                // Render Charts
                renderCharts(result.summary, result.features);

                // Render Tables
                renderFeaturesTable(result.features);

                // Render Failures
                renderFailures(result.features);
            }

            function renderCharts(summary, features) {
                const ctxStatus = document.getElementById('status-chart');
                const ctxDuration = document.getElementById('duration-chart');

                if (statusChart) statusChart.destroy();
                if (durationChart) durationChart.destroy();

                // 1. Status Donut Chart
                statusChart = new Chart(ctxStatus, {
                    type: 'doughnut',
                    data: {
                        labels: ['Passed', 'Failed', 'Skipped'],
                        datasets: [{
                            data: [summary.passed, summary.failed, summary.skipped],
                            backgroundColor: ['#10b981', '#f43f5e', '#f59e0b'],
                            borderWidth: 0,
                            hoverOffset: 4
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        cutout: '75%',
                        plugins: {
                            legend: { position: 'bottom', labels: { usePointStyle: true, padding: 20 } }
                        }
                    }
                });

                // 2. Duration Bar Chart (Top 10 slowest features)
                const sortedFeatures = [...features].sort((a, b) => b.duration - a.duration).slice(0, 10);
                
                durationChart = new Chart(ctxDuration, {
                    type: 'bar',
                    data: {
                        labels: sortedFeatures.map(f => f.name.length > 20 ? f.name.substring(0, 20) + '...' : f.name),
                        datasets: [{
                            label: 'Duration (s)',
                            data: sortedFeatures.map(f => (f.duration / 1000).toFixed(2)),
                            backgroundColor: '#3b82f6',
                            borderRadius: 4
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        indexAxis: 'y',
                        scales: {
                            x: { grid: { display: false } },
                            y: { grid: { display: false } }
                        },
                        plugins: {
                            legend: { display: false }
                        }
                    }
                });
            }

            function renderFeaturesTable(features) {
                const tbody = document.getElementById('features-tbody');
                tbody.innerHTML = '';

                features.forEach(feature => {
                    const row = document.createElement('tr');
                    const statusClass = feature.failed > 0 ? 'failed' : (feature.skipped > 0 && feature.passed === 0 ? 'skipped' : 'passed');
                    
                    row.innerHTML = \`
                        <td><div style="font-weight: 500">\${feature.name}</div><div style="font-size: 11px; color: #94a3b8">\${feature.relativePath}</div></td>
                        <td class="text-center">\${feature.scenarios.length}</td>
                        <td class="text-center"><span style="color: #10b981; font-weight: 600">\${feature.passed}</span></td>
                        <td class="text-center"><span style="color: #f43f5e; font-weight: 600">\${feature.failed}</span></td>
                        <td class="text-center">\${(feature.duration / 1000).toFixed(2)}s</td>
                        <td class="text-center"><span class="badge \${statusClass}">\${statusClass.toUpperCase()}</span></td>
                    \`;

                    row.addEventListener('click', () => showFeatureDetails(feature));
                    tbody.appendChild(row);
                });
            }

            function renderFailures(features) {
                const container = document.getElementById('failures-list');
                container.innerHTML = '';
                
                let hasFailures = false;

                features.forEach(feature => {
                    const failedScenarios = feature.scenarios.filter(s => s.status === 'failed');
                    if (failedScenarios.length > 0) {
                        hasFailures = true;
                        
                        const featureBlock = document.createElement('div');
                        featureBlock.style.marginBottom = '20px';
                        featureBlock.innerHTML = \`<h3 style="margin-bottom: 10px; font-size: 14px; color: #f43f5e">
                             📂 \${feature.name} <span style="color: #94a3b8; font-size: 12px">(\${feature.relativePath})</span>
                        </h3>\`;

                        failedScenarios.forEach(scenario => {
                            const scenarioEl = renderScenarioElement(scenario);
                            featureBlock.appendChild(scenarioEl);
                        });

                        container.appendChild(featureBlock);
                    }
                });

                if (!hasFailures) {
                    container.innerHTML = '<div class="empty-state-small"><p>No failures found! Great job! 🎉</p></div>';
                }
            }

            function showFeatureDetails(feature) {
                const drilldown = document.getElementById('scenario-drilldown');
                const content = document.getElementById('drilldown-content');
                document.getElementById('drilldown-title').textContent = feature.name;
                
                content.innerHTML = '';
                
                feature.scenarios.forEach(scenario => {
                    content.appendChild(renderScenarioElement(scenario));
                });

                drilldown.style.display = 'flex';
            }

            function renderScenarioElement(scenario) {
                const scenarioDiv = document.createElement('div');
                scenarioDiv.className = 'scenario-block';
                
                // Title Bar
                const titleBar = document.createElement('div');
                titleBar.className = 'scenario-title-bar';
                titleBar.style.borderLeft = scenario.status === 'failed' ? '4px solid #f43f5e' : '4px solid #10b981';
                
                // Format duration (ms if < 1s, s otherwise)
                const duration = scenario.duration < 1000 
                    ? Math.round(scenario.duration) + 'ms' 
                    : (scenario.duration / 1000).toFixed(2) + 's';

                titleBar.innerHTML = \`
                    <span>\${scenario.name}</span>
                    <span class="badge \${scenario.status === 'failed' ? 'failed' : 'passed'}">\${duration}</span>
                \`;
                
                scenarioDiv.appendChild(titleBar);

                // Steps
                const stepsContainer = document.createElement('div');
                scenario.steps.forEach(step => {
                    const stepRow = document.createElement('div');
                    stepRow.className = 'step-row';
                    
                    const iconColor = step.status === 'passed' ? '#10b981' : (step.status === 'failed' ? '#f43f5e' : '#cbd5e1');
                    const icon = step.status === 'passed' ? '✓' : (step.status === 'failed' ? '✗' : '○');

                    // Step duration formatting
                    const stepDuration = step.duration < 1000 
                        ? Math.round(step.duration) + 'ms' 
                        : (step.duration / 1000).toFixed(2) + 's';

                    stepRow.innerHTML = \`
                        <div style="margin-right: 12px; color: \${iconColor}; font-weight: bold; width: 16px">\${icon}</div>
                        <div class="step-keyword">\${step.keyword}</div>
                        <div class="step-text">\${step.text}</div>
                        <div class="step-status" style="color: \${iconColor}">\${stepDuration}</div>
                    \`;

                    // Check for details
                    const hasDetails = step.httpRequest || step.errorMessage || step.log;
                    if (hasDetails) {
                        stepRow.style.cursor = 'pointer';
                        stepRow.addEventListener('click', () => {
                            let details = stepRow.nextElementSibling;
                            if (details && details.classList.contains('step-details-ui')) {
                                details.remove(); // Toggle off
                            } else {
                                details = document.createElement('div');
                                details.className = 'step-details-ui';
                                details.style.padding = '12px';
                                details.style.background = 'rgba(0,0,0,0.02)';
                                details.style.borderTop = '1px solid var(--border)';
                                details.innerHTML = renderStepDetailsContent(step);
                                stepRow.after(details); // Insert after current row
                            }
                        });
                    }

                    stepsContainer.appendChild(stepRow);
                });

                scenarioDiv.appendChild(stepsContainer);

                // Scenario Error (if unrelated to specific step)
                if (scenario.error) {
                    const err = document.createElement('div');
                    err.style.color = '#f43f5e';
                    err.style.padding = '12px';
                    err.style.fontSize = '12px';
                    err.textContent = scenario.error;
                    scenarioDiv.appendChild(err);
                }

                return scenarioDiv;
            }

            function renderStepDetailsContent(step) {
                let html = '';
                
                if (step.httpRequest) {
                    html += \`<div class="http-block">
                        <div class="http-header">📤 \${step.httpRequest.method} \${step.httpRequest.url}</div>
                        <div class="http-content">
                            \${step.httpRequest.body ? '<pre>' + step.httpRequest.body + '</pre>' : ''}
                        </div>
                    </div>\`;
                }

                if (step.errorMessage) {
                    html += \`<div class="error-block">
                        <div class="error-header">❌ Error Details</div>
                        <div class="error-content"><pre>\${step.errorMessage}</pre></div>
                    </div>\`;
                }
                
                if (step.log) {
                     html += \`<div class="log-block" style="margin-top: 8px">
                        <div class="log-header">📋 Output Log</div>
                        <div class="log-content"><pre>\${step.log}</pre></div>
                    </div>\`;
                }

                return html;
            }

            function renderHistoryChart(history, trend) {
                 const ctx = document.getElementById('history-chart');
                 if (!ctx) return;
                 if (historyChart) historyChart.destroy();

                 historyChart = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: trend.points.map(p => new Date(p.timestamp).toLocaleDateString()),
                        datasets: [{
                            label: 'Pass Rate %',
                            data: trend.points.map(p => p.passRate),
                            borderColor: '#10b981',
                            backgroundColor: 'rgba(16, 185, 129, 0.1)',
                            fill: true,
                            tension: 0.4
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: { legend: { display: false } },
                        scales: { y: { beginAtZero: true, max: 100, grid: { color: 'rgba(0,0,0,0.05)' } }, x: { grid: { display: false } } }
                    }
                });
            }
        })();
        `;
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
