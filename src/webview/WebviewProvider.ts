import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { KarateGenerator } from '../services/karateGenerator';
import { StructuringOptions } from '../services/FeatureStructurer';
import { ConfigManager } from '../utils/configManager';
import { FileUtils } from '../utils/fileUtils';
import { logger } from '../utils/logger';
import { SpecHashManager, SpecMetadata } from '../services/specHashManager';
import { GenerationService } from '../services/GenerationService';
import { GenerationOptions, KarateConfig, HistoryItem, KarateTemplate, TestExecutionOptions, WebviewMessage, KarateStyle } from '../types';
import { HistoryManager } from '../services/historyManager';
import { TemplateManager } from '../services/templateManager';
import { StyleAnalyzer } from '../services/styleAnalyzer';
import { SharedStyleService } from '../services/SharedStyleService';
import { WorkspaceIndex } from '../services/workspace/WorkspaceIndex';
import { WorkspaceEntityStore } from '../services/workspace/WorkspaceEntityStore';
import { QualityState, QualityWorkflowService } from '../services/workspace/QualityWorkflowService';
import { EnhancedCoverageReport, EnhancedCoverageService } from '../services/enhancedCoverageService';
import { CoverageDashboardProvider } from './CoverageDashboardProvider';
import { getProcessDescriptor } from '../shared/processCatalog';

export class KarateWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'karateGenerator.mainView';
    private _view?: vscode.WebviewView;
    private _expandedPanel?: vscode.WebviewPanel;
    private readonly _managementWebviews = new Set<vscode.Webview>();
    private readonly _readyManagementWebviews = new Set<vscode.Webview>();
    private _historyManager: HistoryManager | undefined;
    private _templateManager: TemplateManager | undefined;
    private _generationService: GenerationService | undefined;
    private _learnedStyle: KarateStyle | null = null;
    private readonly _workspaceIndexes = new Map<string, WorkspaceIndex>();
    private _activeManagementFolderPath: string | undefined;
    private _activeManagementArea: 'overview' | 'library' | 'runs' | 'quality' | 'create' | 'operations' = 'overview';
    private _pendingManagementArea: 'overview' | 'library' | 'runs' | 'quality' | 'create' | 'operations' | undefined;
    private _pendingHealthReport: Record<string, unknown> | undefined;
    private _pendingBugHunterReport: Record<string, unknown> | undefined;
    private readonly _coverageSelections = new Map<string, { specPaths: string[]; featurePaths: string[] }>();
    private readonly _coverageReports = new Map<string, EnhancedCoverageReport>();

    /**
     * Process feature content through ReusabilityEngine.
     * Extracts common patterns (auth, setup, headers, etc.) into shared feature files.
     */

    private _specHashManager: SpecHashManager;

    constructor(private readonly _extensionUri: vscode.Uri, private readonly _context: vscode.ExtensionContext) {
        // Initialize SpecHashManager for AI-Powered Test Maintenance
        this._specHashManager = new SpecHashManager(_context);
    }

    public postMessageToWebview(message: any) {
        for (const webview of [...this._managementWebviews]) this.postMessageSafely(webview, message);
    }

    public async showManagementArea(area: 'overview' | 'library' | 'runs' | 'quality' | 'create' | 'operations'): Promise<void> {
        this._activeManagementArea = area;
        this._pendingManagementArea = area;
        if (this._expandedPanel) {
            await this.openExpandedWorkspace(area);
            return;
        }
        await vscode.commands.executeCommand('karateGenerator.mainView.focus');
        this.postPendingManagementArea();
    }

    public async showHealthReport(report: Record<string, unknown>): Promise<void> {
        this._pendingHealthReport = report;
        await this.showManagementArea('quality');
        this.postPendingHealthReport();
    }

    public async showBugHunterReport(report: Record<string, unknown>): Promise<void> {
        this._pendingBugHunterReport = report;
        await this.showManagementArea('operations');
        this.postPendingBugHunterReport();
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

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview, 'sidebar');
        this._managementWebviews.add(webviewView.webview);
        webviewView.onDidDispose(() => this.removeManagementWebview(webviewView.webview));

        // Initialize managers
        // Initialize managers
        this._historyManager = new HistoryManager(this._context);
        this._templateManager = new TemplateManager(this._context);
        this._generationService = new GenerationService(this._context, this._historyManager, this._specHashManager);

        this.bindMessageHandler(webviewView.webview);
    }

    public async openExpandedWorkspace(area?: 'overview' | 'library' | 'runs' | 'quality' | 'create' | 'operations'): Promise<void> {
        if (area) {
            this._activeManagementArea = area;
            this._pendingManagementArea = area;
        }
        const existing = this._expandedPanel;
        if (existing) {
            try {
                existing.reveal(existing.viewColumn || vscode.ViewColumn.Active, false);
                this.postMessageToWebview({ type: 'expandedWorkspaceState', open: true });
                this.postPendingManagementArea();
                return;
            } catch {
                this.removeManagementWebview(existing.webview);
            }
        }
        const panel = vscode.window.createWebviewPanel(
            'karateManagementWorkspace',
            'Karate Test Management',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this._extensionUri] }
        );
        this._expandedPanel = panel;
        panel.webview.html = this._getHtmlForWebview(panel.webview, 'expanded');
        this._managementWebviews.add(panel.webview);
        this.bindMessageHandler(panel.webview);
        panel.onDidDispose(() => {
            this.removeManagementWebview(panel.webview);
            this.postMessageToWebview({ type: 'expandedWorkspaceState', open: Boolean(this._expandedPanel) });
        });
        this.postMessageToWebview({ type: 'expandedWorkspaceState', open: true });
    }

    private postMessageSafely(webview: vscode.Webview, message: unknown): void {
        if (!this._managementWebviews.has(webview)) return;
        try {
            void Promise.resolve(webview.postMessage(message)).catch(() => this.removeManagementWebview(webview));
        } catch {
            this.removeManagementWebview(webview);
        }
    }

    private removeManagementWebview(webview: vscode.Webview): void {
        this._managementWebviews.delete(webview);
        this._readyManagementWebviews.delete(webview);
        if (this._view?.webview === webview) this._view = undefined;
        if (this._expandedPanel?.webview === webview) this._expandedPanel = undefined;
    }

    private bindMessageHandler(webview: vscode.Webview): void {
        webview.onDidReceiveMessage(async (data: unknown) => {
            if (!isWebviewMessage(data)) {
                this.sendError('The test management workspace received an invalid request.');
                return;
            }
            const process = getProcessDescriptor(data);
            if (process) this.postMessageToWebview({ type: 'processState', ...process, running: true });
            try {
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
                case 'huntApiBugs':
                    await vscode.commands.executeCommand('karate-dsl.huntApiBugs');
                    break;
                case 'getManagementSnapshot':
                    await this.sendManagementSnapshot(data.folderPath);
                    break;
                case 'executeExtensionCommand':
                    await this.executeShellCommand(data.commandId, data.folderPath, data.useCopilot);
                    break;
                case 'advanceQualityFinding':
                    await this.advanceQualityFinding(data.id, data.nextState, data.folderPath);
                    break;
                case 'createRunProfile':
                    await this.createRunProfile(data.name, data.environment, data.parallel, data.folderPath);
                    break;
                case 'runProfile':
                    await this.runProfile(data.id, data.folderPath);
                    break;
                case 'rerunRun':
                    await this.rerunRun(data.options, data.folderPath);
                    break;
                case 'exportRunReport':
                    await this.exportRunReport(data.id, data.folderPath);
                    break;
                case 'requestScenarioRepair':
                    await this.requestScenarioRepair(data.featurePath, data.scenarioName, data.errorMessage, data.scenarioTags, data.scenarioLine, data.folderPath);
                    break;
                case 'analyzeCoverage':
                    await this.analyzeCoverage(data.specPaths, data.featurePaths, data.useCopilot, data.folderPath);
                    break;
                case 'selectCoverageSpecs':
                    await this.selectCoverageFiles('specs', data.folderPath);
                    break;
                case 'selectCoverageFeatures':
                    await this.selectCoverageFiles('features', data.folderPath);
                    break;
                case 'exportCoverageReport':
                    await this.exportCoverageReport(data.folderPath);
                    break;
                case 'generateCoverageTest':
                    await this.generateCoverageTest(data.endpoint, data.featurePaths, data.useCopilot, data.folderPath);
                    break;
                case 'saveTraceability':
                    await this.saveTraceability(data.featurePath, data.scenarioName, data.owner, data.status, data.zephyrKey, data.folderPath);
                    break;
                case 'openScenario':
                    await this.openScenario(data.featurePath, data.line, data.folderPath);
                    break;
                case 'managementReady':
                    this._readyManagementWebviews.add(webview);
                    await this.sendManagementSnapshot(this._activeManagementFolderPath, webview);
                    this.postMessageSafely(webview, { type: 'expandedWorkspaceState', open: Boolean(this._expandedPanel) });
                    this.postMessageSafely(webview, { type: 'navigateManagement', area: this._pendingManagementArea || this._activeManagementArea });
                    this.postPendingManagementArea();
                    this.postPendingHealthReport();
                    this.postPendingBugHunterReport();
                    break;
                case 'reportBug':
                    await this.executeShellCommandWithArguments('karate-dsl.reportBug', data.activeArea);
                    break;
                case 'openExpandedWorkspace':
                    await this.openExpandedWorkspace();
                    break;
                case 'focusManagementSidebar':
                    await vscode.commands.executeCommand('karateGenerator.mainView.focus');
                    break;
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.sendError(`Could not complete this action: ${message}`);
            } finally {
                if (process) this.postMessageToWebview({ type: 'processState', ...process, running: false });
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
            this.sendMessage({
                type: 'fileSelected',
                filePath: fileUri[0].fsPath
            });
        }
    }

    private async handleGenerateFromOpenAPI(filePath: string, useCopilot: boolean, templateId?: string, scenarioTypes?: string[], httpMethods?: string[], customInstruction?: string) {
        try {
            const service = this._generationService;
            if (!service) {
                throw new Error('GenerationService not initialized');
            }

            service.setLearnedStyle(this._learnedStyle);
            if (templateId) {
                const template = await this._templateManager?.getTemplate(templateId);
                service.setTemplate(template?.content || null);
            }

            const options: GenerationOptions = {
                filePath,
                useCopilot,
                templateId,
                scenarioTypes,
                httpMethods,
                customInstruction
            };

            const result = await service.generateFromOpenAPI(options, (msg, pct) => this.sendProgress(msg, pct));

            this.sendSuccess(
                `Generated tests for ${path.basename(filePath)}`,
                result.files[0],
                result.content
            );
            await this.sendHistory();

        } catch (error) {
            this.sendError((error as Error).message);
            logger.error('Failed to generate from OpenAPI', error as Error);
        }
    }

    private async handleGenerateFromConfluence(pageUrl: string, useCopilot: boolean, templateId?: string) {
        try {
            const service = this._generationService;
            if (!service) {
                throw new Error('GenerationService not initialized');
            }

            service.setLearnedStyle(this._learnedStyle);
            if (templateId) {
                const template = await this._templateManager?.getTemplate(templateId);
                service.setTemplate(template?.content || null);
            }

            const options: GenerationOptions = {
                pageUrl,
                useCopilot,
                templateId
            };

            const result = await service.generateFromConfluence(options, (msg, pct) => this.sendProgress(msg, pct));

            this.sendSuccess(
                `Generated tests from Confluence`,
                result.files[0],
                result.content
            );
            await this.sendHistory();

        } catch (error) {
            this.sendError((error as Error).message);
            logger.error('Failed to generate from Confluence', error as Error);
        }
    }

    private async handleGenerateCombined(openApiPath: string, confluenceUrl: string, useCopilot: boolean, templateId?: string, scenarioTypes?: string[], httpMethods?: string[], customInstruction?: string) {
        try {
            const service = this._generationService;
            if (!service) {
                throw new Error('GenerationService not initialized');
            }

            service.setLearnedStyle(this._learnedStyle);
            if (templateId) {
                const template = await this._templateManager?.getTemplate(templateId);
                service.setTemplate(template?.content || null);
            }

            const options: GenerationOptions = {
                openApiPath,
                confluenceUrl,
                useCopilot,
                templateId,
                scenarioTypes,
                httpMethods,
                customInstruction
            };

            const result = await service.generateCombined(options, (msg, pct) => this.sendProgress(msg, pct));

            this.sendSuccess(
                `Generated combined tests`,
                result.files[0],
                result.content
            );
            await this.sendHistory();

        } catch (error) {
            this.sendError((error as Error).message);
            logger.error('Failed to generate combined tests', error as Error);
        }
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

    private sendMessage(message: any, target?: vscode.Webview) {
        if (target) {
            this.postMessageSafely(target, message);
            return;
        }
        this.postMessageToWebview(message);
    }

    private async sendHistory() {
        const historyManager = this._historyManager;
        if (!historyManager) { return; }
        const history = historyManager.getHistory();
        this.sendMessage({ type: 'history', data: history });
    }

    private async sendTemplates() {
        const templateManager = this._templateManager;
        if (!templateManager) { return; }
        const templates = templateManager.getAllTemplates();
        this.sendMessage({ type: 'templates', data: templates });
    }

    private async handleSaveTemplate(template: any) {
        const templateManager = this._templateManager;
        if (!templateManager) { return; }
        await templateManager.saveCustomTemplate(template);
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
            const sharedStyle = SharedStyleService.loadSharedStyle();
            if (sharedStyle) {
                generator.setStyle(sharedStyle);
            }
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

    private async sendManagementSnapshot(folderPath?: string, target?: vscode.Webview): Promise<void> {
        const folder = vscode.workspace.workspaceFolders?.find(candidate => candidate.uri.fsPath === folderPath)
            || vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            this.sendMessage({ type: 'managementSnapshot', data: { runs: [], findings: [], featureCount: 0 } }, target);
            return;
        }
        this._activeManagementFolderPath = folder.uri.fsPath;
        let index = this._workspaceIndexes.get(folder.uri.fsPath);
        if (!index) {
            index = new WorkspaceIndex(folder);
            this._workspaceIndexes.set(folder.uri.fsPath, index);
            index.onDidUpdate(snapshot => {
                if (this._activeManagementFolderPath === folder.uri.fsPath) {
                    this.sendMessage({ type: 'managementSnapshot', data: this.withFolderMetadata(folder, snapshot) });
                }
            });
            await index.initialize();
        }
        this.sendMessage({ type: 'managementSnapshot', data: this.withFolderMetadata(folder, index.snapshot()) }, target);
    }

    private postPendingManagementArea(): void {
        if (!this._pendingManagementArea || this._readyManagementWebviews.size === 0) return;
        this._activeManagementArea = this._pendingManagementArea;
        for (const webview of [...this._readyManagementWebviews]) {
            this.postMessageSafely(webview, { type: 'navigateManagement', area: this._pendingManagementArea });
        }
        this._pendingManagementArea = undefined;
    }

    private postPendingHealthReport(): void {
        if (!this._pendingHealthReport || this._readyManagementWebviews.size === 0) return;
        for (const webview of [...this._readyManagementWebviews]) {
            this.postMessageSafely(webview, { type: 'healthReport', data: this._pendingHealthReport });
        }
        this._pendingHealthReport = undefined;
    }

    private postPendingBugHunterReport(): void {
        if (!this._pendingBugHunterReport || this._readyManagementWebviews.size === 0) return;
        for (const webview of [...this._readyManagementWebviews]) {
            this.postMessageSafely(webview, { type: 'bugHunterReport', data: this._pendingBugHunterReport });
        }
        this._pendingBugHunterReport = undefined;
    }

    private withFolderMetadata(folder: vscode.WorkspaceFolder, snapshot: ReturnType<WorkspaceIndex['snapshot']>) {
        return {
            ...snapshot,
            folderPath: folder.uri.fsPath,
            folders: (vscode.workspace.workspaceFolders || []).map(item => ({ name: item.name, path: item.uri.fsPath }))
        };
    }

    private async executeShellCommand(commandId: unknown, folderPath?: string, useCopilot?: boolean): Promise<void> {
        const allowed = new Set([
            'karate-dsl.runFolder', 'karate-dsl.runByTags', 'karate-dsl.showCoverageDashboard', 'karate-dsl.analyzeProjectHealth', 'karate-dsl.checkSpecChanges',
            'karate-dsl.generateFromOpenAPI', 'karate-dsl.importPostmanCollection', 'karate-dsl.importHar',
            'karate-dsl.generateFromGraphQL', 'karate-dsl.generateFromJira', 'karate-dsl.generateFromConfluence',
            'karate-dsl.generateCombined', 'karate-dsl.generateFromDirectory', 'karate-dsl.startRecording',
            'karate-dsl.huntApiBugs', 'karate-dsl.showCIBridgeGuide', 'karate-dsl.reportBug',
            'karate-dsl.setClaudeApiKey', 'karate-dsl.setGitHubToken', 'karate-dsl.setZephyrToken',
            'karate-dsl.showMcpConnectionInfo', 'karate-dsl.configureAI', 'workbench.action.openSettings'
        ]);
        if (typeof commandId !== 'string' || !allowed.has(commandId)) {
            this.sendError('This action is not available from the test management workspace.');
            return;
        }
        if (commandId === 'karate-dsl.runFolder' || commandId === 'karate-dsl.runByTags') {
            await this.executeShellCommandWithArguments(commandId, { folderPath });
        } else if (commandId === 'karate-dsl.analyzeProjectHealth' || commandId === 'karate-dsl.checkSpecChanges') {
            await this.executeShellCommandWithArguments(commandId, folderPath);
        } else if (useCopilot !== undefined && (commandId === 'karate-dsl.importPostmanCollection' || commandId === 'karate-dsl.importHar')) {
            await this.executeShellCommandWithArguments(commandId, { source: 'management', useCopilot });
        } else {
            await this.executeShellCommandWithArguments(commandId);
        }
    }

    private async executeShellCommandWithArguments(commandId: string, ...args: unknown[]): Promise<void> {
        const isExecution = ['karate-dsl.runFeature', 'karate-dsl.runScenario', 'karate-dsl.runFolder', 'karate-dsl.runByTags'].includes(commandId);
        try {
            if (isExecution) this.postMessageToWebview({ type: 'executionState', running: true });
            await vscode.commands.executeCommand(commandId, ...args);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.sendError(`Could not complete this action: ${message}`);
        } finally {
            if (isExecution) this.postMessageToWebview({ type: 'executionState', running: false });
            if (commandId === 'karate-dsl.checkSpecChanges') await this.sendManagementSnapshot(this._activeManagementFolderPath);
        }
    }

    private async advanceQualityFinding(id: string, nextState: QualityState, folderPath?: string): Promise<void> {
        const folder = vscode.workspace.workspaceFolders?.find(candidate => candidate.uri.fsPath === folderPath)
            || vscode.workspace.workspaceFolders?.[0];
        if (!folder) return;
        try {
            const workflow = new QualityWorkflowService(new WorkspaceEntityStore(folder.uri.fsPath));
            workflow.advance(id, nextState);
            await this.sendManagementSnapshot(folder.uri.fsPath);
        } catch (error) {
            this.sendError(error instanceof Error ? error.message : String(error));
        }
    }

    private async createRunProfile(name: string, environment: string, parallel: number, folderPath?: string): Promise<void> {
        const folder = vscode.workspace.workspaceFolders?.find(candidate => candidate.uri.fsPath === folderPath)
            || vscode.workspace.workspaceFolders?.[0];
        const trimmedName = name.trim();
        if (!folder || !trimmedName) {
            this.sendError('A run profile needs a name.');
            return;
        }
        const store = new WorkspaceEntityStore(folder.uri.fsPath);
        const environmentName = environment.trim();
        const workerCount = Number.isFinite(parallel) ? Math.max(1, Math.floor(parallel)) : 1;
        if (environmentName && !store.list<{ name?: string }>('environments').some(item => item.name === environmentName)) {
            store.save('environments', { name: environmentName });
        }
        store.save('run-profiles', { name: trimmedName, environment: environmentName, parallel: workerCount });
        await this.sendManagementSnapshot(folder.uri.fsPath);
    }

    private async runProfile(id: string, folderPath?: string): Promise<void> {
        const folder = vscode.workspace.workspaceFolders?.find(candidate => candidate.uri.fsPath === folderPath)
            || vscode.workspace.workspaceFolders?.[0];
        if (!folder) return;
        const profile = new WorkspaceEntityStore(folder.uri.fsPath).get<{ environment?: string; parallel?: number }>('run-profiles', id);
        if (!profile) {
            this.sendError('This run profile no longer exists.');
            return;
        }
        await this.executeShellCommandWithArguments('karate-dsl.runFolder', {
            folderPath: folder.uri.fsPath,
            environment: profile.environment,
            parallel: profile.parallel
        });
    }

    private async rerunRun(options: TestExecutionOptions, folderPath?: string): Promise<void> {
        const folder = vscode.workspace.workspaceFolders?.find(candidate => candidate.uri.fsPath === folderPath)
            || vscode.workspace.workspaceFolders?.[0];
        if (!folder) return;
        const resolveTarget = (target: string): string | undefined => {
            if (path.isAbsolute(target)) return undefined;
            const absolute = path.resolve(folder.uri.fsPath, target);
            const relative = path.relative(folder.uri.fsPath, absolute);
            return (relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) ? absolute : undefined;
        };
        const targets = Array.isArray(options.target) ? options.target.map(resolveTarget) : [resolveTarget(options.target)];
        if (targets.some(target => !target)) {
            this.sendError('This historic run refers to a path outside the selected workspace. It cannot be rerun safely.');
            return;
        }
        const resolvedTargets = targets as string[];
        await this.executeShellCommandWithArguments('karate-dsl.runFolder', {
            folderPath: folder.uri.fsPath,
            options: { ...options, target: Array.isArray(options.target) ? resolvedTargets : resolvedTargets[0], workingDirectory: folder.uri.fsPath }
        });
    }

    private async exportRunReport(id: string, folderPath?: string): Promise<void> {
        const folder = vscode.workspace.workspaceFolders?.find(candidate => candidate.uri.fsPath === folderPath)
            || vscode.workspace.workspaceFolders?.[0];
        const run = folder ? new WorkspaceEntityStore(folder.uri.fsPath).get<any>('runs', id) : undefined;
        if (!folder || !run) {
            this.sendError('This run is no longer available for export.');
            return;
        }
        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(folder.uri, `karate-run-${id.slice(0, 8)}.html`),
            filters: { HTML: ['html'] }
        });
        if (!saveUri) return;
        const scenarioRows = (run.features || []).flatMap((feature: any) => (feature.scenarios || []).map((scenario: any) => `
            <tr><td>${escapeHtml(feature.relativePath || feature.name || '')}</td><td>${escapeHtml(scenario.name || '')}</td><td>${escapeHtml(scenario.status || '')}</td><td>${escapeHtml(scenario.error || '')}</td></tr>`)).join('');
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>Karate run ${escapeHtml(id)}</title><style>body{font:14px system-ui;margin:32px;color:#202124}table{width:100%;border-collapse:collapse}th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left}h1{font-size:22px}.summary{display:flex;gap:24px;margin:20px 0}</style></head><body><h1>Karate test run</h1><p>${escapeHtml(new Date(run.timestamp).toLocaleString())}</p><div class="summary"><strong>${escapeHtml(run.status)}</strong><span>${run.summary?.passed || 0} passed</span><span>${run.summary?.failed || 0} failed</span><span>${escapeHtml(run.summary?.executionTime || '')}</span></div><table><thead><tr><th>Feature</th><th>Scenario</th><th>Status</th><th>Error</th></tr></thead><tbody>${scenarioRows}</tbody></table></body></html>`;
        await fs.promises.writeFile(saveUri.fsPath, html, 'utf8');
        this.sendMessage({ type: 'success', message: `Run report exported to ${path.basename(saveUri.fsPath)}.` });
    }

    private async requestScenarioRepair(featurePath: string, scenarioName: string, errorMessage: string, scenarioTags?: string[], scenarioLine?: number, folderPath?: string): Promise<void> {
        const folder = vscode.workspace.workspaceFolders?.find(candidate => candidate.uri.fsPath === folderPath)
            || vscode.workspace.workspaceFolders?.[0];
        if (!folder || !featurePath || !scenarioName) return;
        try {
            const { TestRepairService } = await import('../services/ci/TestRepairService');
            const repaired = await new TestRepairService().repair({
                source: 'generic',
                featurePath,
                scenarioName,
                scenarioTags,
                scenarioLine,
                failedStep: 'Failed scenario from execution history',
                errorMessage: errorMessage || 'No execution error detail was recorded.',
                timestamp: Date.now()
            }, folder.uri.fsPath);
            if (repaired) this.sendMessage({ type: 'success', message: `Repair review prepared for ${scenarioName}.` });
            await this.sendManagementSnapshot(folder.uri.fsPath);
        } catch (error) {
            this.sendError(`Could not prepare repair: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async selectCoverageFiles(kind: 'specs' | 'features', folderPath?: string): Promise<void> {
        const folder = vscode.workspace.workspaceFolders?.find(candidate => candidate.uri.fsPath === folderPath)
            || vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            this.sendError('Open a workspace folder before selecting coverage inputs.');
            return;
        }
        const selected = await vscode.window.showOpenDialog({
            canSelectMany: true,
            defaultUri: folder.uri,
            title: kind === 'specs' ? 'Select OpenAPI specifications' : 'Select Karate feature files',
            openLabel: kind === 'specs' ? 'Use specifications' : 'Use feature files',
            filters: kind === 'specs'
                ? { 'OpenAPI Specification': ['json', 'yaml', 'yml'] }
                : { 'Karate Feature': ['feature'] }
        });
        if (!selected?.length) return;
        const paths = selected.map(item => item.fsPath);
        const current = this._coverageSelections.get(folder.uri.fsPath) || { specPaths: [], featurePaths: [] };
        const next = kind === 'specs' ? { ...current, specPaths: paths } : { ...current, featurePaths: paths };
        this._coverageSelections.set(folder.uri.fsPath, next);
        this.sendMessage({ type: kind === 'specs' ? 'coverageSpecsSelected' : 'coverageFeaturesSelected', data: paths });
    }

    private async analyzeCoverage(specPaths: string[], featurePaths: string[], useCopilot: boolean, folderPath?: string): Promise<void> {
        const folder = vscode.workspace.workspaceFolders?.find(candidate => candidate.uri.fsPath === folderPath)
            || vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            this.sendError('Open a workspace folder before analysing coverage.');
            return;
        }
        const selected = this._coverageSelections.get(folder.uri.fsPath);
        const trustedSpecs = selected?.specPaths.filter(item => specPaths.includes(item)) || [];
        const trustedFeatures = selected?.featurePaths.filter(item => featurePaths.includes(item)) || [];
        if (!trustedSpecs.length || !trustedFeatures.length) {
            this.sendError('Select at least one OpenAPI specification and one Karate feature file before analysing coverage.');
            return;
        }
        try {
            const report = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Analysing Karate coverage',
                cancellable: false
            }, () => new EnhancedCoverageService().analyzeMultipleSpecs(trustedSpecs, trustedFeatures, useCopilot));
            this._coverageReports.set(folder.uri.fsPath, report);
            this.recordCoverageFindings(folder, report);
            const serialized = this.serializeCoverageReport(report);
            new WorkspaceEntityStore(folder.uri.fsPath).save('actions', { kind: 'coverage-report', ...serialized });
            this.sendMessage({ type: 'coverageReport', data: serialized });
            await this.sendManagementSnapshot(folder.uri.fsPath);
            this.sendMessage({ type: 'success', message: `Coverage analysis complete: ${report.percentage.toFixed(1)}% across ${report.totalEndpoints} endpoints.` });
        } catch (error) {
            this.sendError(`Coverage analysis failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async exportCoverageReport(folderPath?: string): Promise<void> {
        const folder = vscode.workspace.workspaceFolders?.find(candidate => candidate.uri.fsPath === folderPath)
            || vscode.workspace.workspaceFolders?.[0];
        const report = folder ? this._coverageReports.get(folder.uri.fsPath) : undefined;
        if (!folder || !report) {
            this.sendError('Run coverage analysis before exporting a report.');
            return;
        }
        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(folder.uri, 'karate-coverage-report.html'),
            filters: { HTML: ['html'] }
        });
        if (!saveUri) return;
        await fs.promises.writeFile(saveUri.fsPath, new EnhancedCoverageService().exportToHtmlWithInsights(report), 'utf8');
        this.sendMessage({ type: 'success', message: `Coverage report exported to ${path.basename(saveUri.fsPath)}.` });
    }

    private async generateCoverageTest(endpoint: { path: string; method: string; operationId?: string }, featurePaths: string[], useCopilot: boolean, folderPath?: string): Promise<void> {
        const folder = vscode.workspace.workspaceFolders?.find(candidate => candidate.uri.fsPath === folderPath)
            || vscode.workspace.workspaceFolders?.[0];
        const selected = folder ? this._coverageSelections.get(folder.uri.fsPath) : undefined;
        const trustedFeatures = selected?.featurePaths.filter(item => featurePaths.includes(item)) || [];
        if (!folder || !trustedFeatures.length) {
            this.sendError('Select the target feature files again before generating coverage.');
            return;
        }
        await new CoverageDashboardProvider(this._extensionUri).generateTestForEndpoint(endpoint, trustedFeatures, useCopilot);
    }

    private recordCoverageFindings(folder: vscode.WorkspaceFolder, report: EnhancedCoverageReport): void {
        const workflow = new QualityWorkflowService(new WorkspaceEntityStore(folder.uri.fsPath));
        for (const endpoint of report.endpoints.filter(endpoint => !endpoint.covered)) {
            const method = endpoint.method.toUpperCase();
            workflow.recordCoverageGap({
                title: `Missing coverage: ${method} ${endpoint.path}`,
                severity: 'normal',
                description: endpoint.missingTests.join('\n') || `No Karate scenario covers ${method} ${endpoint.path}.`,
                sourceRef: `${method} ${endpoint.path}`
            });
        }
    }

    private serializeCoverageReport(report: EnhancedCoverageReport) {
        return {
            specName: report.specName,
            percentage: report.percentage,
            totalEndpoints: report.totalEndpoints,
            coveredEndpoints: report.coveredEndpoints,
            endpoints: report.endpoints.map(endpoint => ({
                path: endpoint.path,
                method: endpoint.method,
                operationId: endpoint.operationId,
                covered: endpoint.covered,
                scenarios: endpoint.scenarios,
                missingTests: endpoint.missingTests
            })),
            methodBreakdown: Array.from(report.methodBreakdown.entries()).map(([method, stats]) => ({
                method,
                total: stats.total,
                covered: stats.covered,
                percentage: stats.total ? (stats.covered / stats.total) * 100 : 0
            })),
            copilotInsights: report.copilotInsights
        };
    }

    private async saveTraceability(featurePath: string, scenarioName: string, owner: string, status: string, zephyrKey: string, folderPath?: string): Promise<void> {
        const folder = vscode.workspace.workspaceFolders?.find(candidate => candidate.uri.fsPath === folderPath)
            || vscode.workspace.workspaceFolders?.[0];
        if (!folder || !featurePath || !scenarioName) return;
        const store = new WorkspaceEntityStore(folder.uri.fsPath);
        const existing = store.list<{ id: string; featurePath?: string; scenarioName?: string }>('traceability')
            .find(item => item.featurePath === featurePath && item.scenarioName === scenarioName);
        store.save('traceability', { featurePath, scenarioName, owner: owner.trim(), status: status.trim(), zephyrKey: zephyrKey.trim() }, existing?.id);
        await this.sendManagementSnapshot(folder.uri.fsPath);
    }

    private async openScenario(featurePath: string, line: number, folderPath?: string): Promise<void> {
        const folder = vscode.workspace.workspaceFolders?.find(candidate => candidate.uri.fsPath === folderPath)
            || vscode.workspace.workspaceFolders?.[0];
        if (!folder || path.isAbsolute(featurePath) || line < 1) return;
        const absolute = path.resolve(folder.uri.fsPath, featurePath);
        const relative = path.relative(folder.uri.fsPath, absolute);
        if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.existsSync(absolute)) {
            this.sendError('This scenario no longer resolves inside the selected workspace.');
            return;
        }
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
        const editor = await vscode.window.showTextDocument(document);
        const position = new vscode.Position(Math.min(line - 1, document.lineCount - 1), 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }

    private _getHtmlForWebview(webview: vscode.Webview, layout: 'sidebar' | 'expanded' = 'sidebar') {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'test-management.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'test-management.css'));
        const appIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'icon.svg'));
        const nonce = crypto.randomBytes(16).toString('base64');
        return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource};"><link rel="stylesheet" href="${styleUri}"><title>Karate Test Management</title></head><body data-management-layout="${layout}" data-app-icon="${appIconUri}"><div id="root"></div><script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;

        // Retired v1 markup is kept as a non-compiled source-history reference.
        /*
        const legacyScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));
        const legacyStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'style.css'));

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
            <button class="tab-button" data-tab="bughunt">
                <span>🐞</span> Bug Hunt
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
            <div class="welcome-card card" data-target="bughunt">
                <div class="welcome-icon">🐞</div>
                <h3>Bug Hunt</h3>
                <p>Probe APIs from OpenAPI</p>
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
                    <span class="card-icon">🚀</span>
                    <span class="card-title">Quick Start</span>
                </div>
                <div class="help-section">
                    <p><strong>First run in a new workspace:</strong></p>
                    <ul>
                        <li><strong>Open the extension:</strong> Activity Bar → <strong>Karate Test Generator</strong> or Command Palette → <code>Karate: Open Test Generator</code>.</li>
                        <li><strong>Pick an input:</strong> Generate from <code>OpenAPI</code>, <code>Confluence</code>, <code>Combined</code>, <code>GraphQL</code>, <code>Jira</code>, <code>Directory</code>, <code>Postman</code>, or <code>HAR</code>.</li>
                        <li><strong>Optional AI setup:</strong> Enable Copilot in Settings, choose a model with <code>Karate: Select Copilot Model</code>, or store a Claude key with <code>Karate: Set Claude API Key</code>.</li>
                        <li><strong>Generate and run:</strong> Create feature files, then use CodeLens, the Testing view, or Command Palette run commands to execute them.</li>
                    </ul>
                </div>
            </div>

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
                        <li><strong>Run Folder / Tags:</strong> Use Command Palette → <code>Karate: Run All Tests in Folder</code> or <code>Karate: Run Tests by Tags</code>.</li>
                        <li><strong>Reports & History:</strong> Use <code>Karate: Show Test Execution Report</code> and <code>Karate: Show Test History</code> to inspect past runs.</li>
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
                    <span class="card-title">AI Providers & Activity</span>
                </div>
                <div class="help-section">
                    <p><strong>AI-enhanced features:</strong></p>
                    <ul>
                        <li><strong>Enhance Tests:</strong> Select "AI Enhancement" before generating for smarter assertions, edge cases, and realistic data.</li>
                        <li><strong>Coverage Dashboard:</strong> AI analyzes coverage gaps and suggests missing test scenarios.</li>
                        <li><strong>Postman Import:</strong> Intelligent conversion of pre-request scripts to Karate assertions.</li>
                        <li><strong>HAR Import:</strong> AI enriches imported traffic with schema validation and error scenarios.</li>
                        <li><strong>Select Model:</strong> Command Palette → <code>Karate: Select Copilot Model</code> to choose your preferred model.</li>
                        <li><strong>Claude Key:</strong> Use <code>Karate: Set Claude API Key</code> when a Claude-backed flow is configured.</li>
                        <li><strong>Activity Log:</strong> Use <code>Karate: Show Copilot Activity Log</code> to inspect prompts, usage, and responses.</li>
                    </ul>
                    <p><strong>Note:</strong> Copilot-specific features require an active GitHub Copilot subscription and the VS Code Copilot extension.</p>
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
                    <span class="card-icon">🧩</span>
                    <span class="card-title">Combined & Other Inputs</span>
                </div>
                <div class="help-section">
                    <p><strong>Beyond a single OpenAPI file:</strong></p>
                    <ul>
                        <li><strong>Combined:</strong> Use <code>Karate: Generate Combined Tests</code> to merge OpenAPI structure with Confluence business context.</li>
                        <li><strong>GraphQL:</strong> Right-click <code>.graphql</code>/<code>.gql</code> files or use <code>Karate: Generate Tests from GraphQL</code>.</li>
                        <li><strong>Jira:</strong> Use <code>Karate: Generate Tests from Jira</code> when requirements live in Jira issues.</li>
                        <li><strong>Directory:</strong> Use <code>Karate: Generate Tests from Directory</code> on a folder to batch process multiple specs.</li>
                    </ul>
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
                    <span class="card-icon">📊</span>
                    <span class="card-title">Coverage, Flakiness & Style</span>
                </div>
                <div class="help-section">
                    <ul>
                        <li><strong>Coverage:</strong> Use <code>Karate: Show Test Coverage Dashboard</code> to compare spec endpoints against generated tests and create missing scenarios.</li>
                        <li><strong>Flakiness:</strong> Execution summaries and reports show stability tiers (<code>stable</code>, <code>watch</code>, <code>flaky</code>, <code>broken</code>). Tune them with <code>karateDsl.flakiness.*</code>.</li>
                        <li><strong>Shared Team Style:</strong> Set <code>karateDsl.generation.sharedStylePath</code> to apply a workspace-wide <code>.karate-style.json</code>.</li>
                        <li><strong>Learn from Existing Tests:</strong> Right-click a <code>.feature</code> file and use the style learning actions to match local conventions.</li>
                    </ul>
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
                    <span class="card-icon">🛠️</span>
                    <span class="card-title">CI Repair & MCP</span>
                </div>
                <div class="help-section">
                    <ul>
                        <li><strong>CI Pull Mode:</strong> Enable <code>karateDsl.ciRepair.enabled</code>, keep <code>karateDsl.ciRepair.mode</code> as <code>pull</code> (default), and store a PAT with <code>Karate: Set GitHub Token</code>.</li>
                        <li><strong>Webhook / Bridge:</strong> Use <code>Karate: Show CI Bridge Guide</code> for GitHub Actions and other CI integration snippets.</li>
                        <li><strong>MCP Host:</strong> Enable <code>karateDsl.mcp.enabled</code> to expose the extension-managed MCP server.</li>
                        <li><strong>Connection Snippet:</strong> Use <code>Karate: Show MCP Connection Info</code> to copy the JSON config and rotate the Bearer token stored in SecretStorage.</li>
                    </ul>
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
                        <li><code>.graphql/.gql</code>: Generate Tests from GraphQL</li>
                        <li><code>.feature</code>: Learn Style from File</li>
                        <li><strong>Folder:</strong> Generate Tests from Directory</li>
                    </ul>
                    <p><strong>From Command Palette:</strong> Open the command palette and type "Karate" to see all commands.</p>
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <span class="card-icon">🏗️</span>
                    <span class="card-title">Advanced Team Features</span>
                </div>
                <div class="help-section">
                    <p><strong>Precision Controls:</strong> In OpenAPI & Combined tabs, use checkboxes to filter by scenario type (positive, negative, edge, security) and HTTP method (GET, POST, PUT, DELETE, PATCH). Add free-text instructions for Copilot.</p>
                    <p><strong>Structuring Strategies:</strong> Set <code>karateDsl.generation.structuringStrategy</code> to <code>domain</code> (default — groups by API domain), <code>flat</code> (single file), or <code>method</code> (groups by HTTP verb).</p>
                    <p><strong>Smart Reusability:</strong> Generated tests are auto-analyzed for repeated patterns (auth, setup, headers). Common steps are extracted to <code>common/</code> feature files with <code>call</code>/<code>callonce</code>.</p>
                    <p><strong>Agent Skills:</strong> Copilot prompts are hardened with skill files for Karate DSL expertise, preventing hallucinations and enforcing best practices.</p>
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

        <!-- Bug Hunt Tab -->
        <div class="tab-content" id="bughunt-tab">
            <div class="card">
                <div class="card-header">
                    <span class="card-icon">🐞</span>
                    <span class="card-title">API Bug Hunter</span>
                </div>
                <div class="form-group">
                    <p class="info-text">Run bounded OpenAPI probes and export findings as Karate regression scenarios.</p>
                </div>

                <button class="primary-button" id="launch-bug-hunter-btn" style="width: 100%; margin-top: 20px;">
                    <span>🚀</span> Hunt API Bugs
                </button>

                <div class="info-text" style="margin-top: 16px;">
                    <p><strong>Report shows:</strong></p>
                    <ul style="margin-left: 20px; margin-top: 8px;">
                        <li>Every executed probe</li>
                        <li>Every skipped probe with reason</li>
                        <li>HTTP status and generated regression findings</li>
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
        */
    }
}

function isWebviewMessage(data: unknown): data is WebviewMessage {
    if (!data || typeof data !== 'object' || typeof (data as { command?: unknown }).command !== 'string') return false;
    const message = data as Record<string, unknown>;
    switch (message.command) {
        case 'getManagementSnapshot': return message.folderPath === undefined || typeof message.folderPath === 'string';
        case 'executeExtensionCommand':
            return typeof message.commandId === 'string'
                && (message.folderPath === undefined || typeof message.folderPath === 'string')
                && (message.useCopilot === undefined || typeof message.useCopilot === 'boolean');
        case 'advanceQualityFinding':
            return typeof message.id === 'string'
                && typeof message.nextState === 'string'
                && ['New', 'Investigating', 'Fixed', 'Verified'].includes(message.nextState)
                && (message.folderPath === undefined || typeof message.folderPath === 'string');
        case 'createRunProfile':
            return typeof message.name === 'string'
                && typeof message.environment === 'string'
                && typeof message.parallel === 'number'
                && Number.isFinite(message.parallel)
                && (message.folderPath === undefined || typeof message.folderPath === 'string');
        case 'runProfile':
            return typeof message.id === 'string' && (message.folderPath === undefined || typeof message.folderPath === 'string');
        case 'rerunRun':
            return isExecutionOptions(message.options) && (message.folderPath === undefined || typeof message.folderPath === 'string');
        case 'exportRunReport':
            return typeof message.id === 'string' && (message.folderPath === undefined || typeof message.folderPath === 'string');
        case 'requestScenarioRepair':
            return ['featurePath', 'scenarioName', 'errorMessage'].every(key => typeof message[key] === 'string')
                && (message.scenarioTags === undefined || (Array.isArray(message.scenarioTags) && message.scenarioTags.every(tag => typeof tag === 'string')))
                && (message.scenarioLine === undefined || (typeof message.scenarioLine === 'number' && Number.isInteger(message.scenarioLine) && message.scenarioLine > 0))
                && (message.folderPath === undefined || typeof message.folderPath === 'string');
        case 'selectCoverageSpecs': case 'selectCoverageFeatures': case 'exportCoverageReport':
            return message.folderPath === undefined || typeof message.folderPath === 'string';
        case 'analyzeCoverage':
            return Array.isArray(message.specPaths) && message.specPaths.every(item => typeof item === 'string')
                && Array.isArray(message.featurePaths) && message.featurePaths.every(item => typeof item === 'string')
                && typeof message.useCopilot === 'boolean'
                && (message.folderPath === undefined || typeof message.folderPath === 'string');
        case 'generateCoverageTest':
            return isCoverageEndpoint(message.endpoint)
                && Array.isArray(message.featurePaths) && message.featurePaths.every(item => typeof item === 'string')
                && typeof message.useCopilot === 'boolean'
                && (message.folderPath === undefined || typeof message.folderPath === 'string');
        case 'saveTraceability':
            return ['featurePath', 'scenarioName', 'owner', 'status', 'zephyrKey'].every(key => typeof message[key] === 'string')
                && (message.folderPath === undefined || typeof message.folderPath === 'string');
        case 'openScenario':
            return typeof message.featurePath === 'string' && typeof message.line === 'number' && Number.isInteger(message.line) && message.line > 0
                && (message.folderPath === undefined || typeof message.folderPath === 'string');
        case 'managementReady': return true;
        case 'reportBug': return typeof message.activeArea === 'string';
        case 'openExpandedWorkspace': case 'focusManagementSidebar': return true;
        // Legacy generation messages remain supported for existing callers. Their command
        // handlers retain their own validation and all shell-originating operations use the
        // stricter cases above.
        case 'selectOpenAPIFile': case 'generateFromOpenAPI': case 'generateFromConfluence':
        case 'generateCombined': case 'getConfig': case 'saveConfig': case 'getHistory':
        case 'getTemplates': case 'saveTemplate': case 'learnStyle': case 'openGeneratedFile':
        case 'copyToClipboard': case 'syncTests': case 'launchCoverageDashboard': case 'huntApiBugs':
            return true;
        default: return false;
    }
}

function isExecutionOptions(value: unknown): value is TestExecutionOptions {
    if (!value || typeof value !== 'object') return false;
    const options = value as Record<string, unknown>;
    return typeof options.type === 'string'
        && ['feature', 'features', 'folder', 'tags', 'scenario'].includes(options.type)
        && (typeof options.target === 'string' || (Array.isArray(options.target) && options.target.every(target => typeof target === 'string')))
        && (options.tags === undefined || (Array.isArray(options.tags) && options.tags.every(tag => typeof tag === 'string')))
        && (options.environment === undefined || typeof options.environment === 'string')
        && (options.parallel === undefined || (typeof options.parallel === 'number' && Number.isFinite(options.parallel)))
        && (options.buildTool === undefined || (typeof options.buildTool === 'string' && ['auto', 'maven', 'gradle', 'cli'].includes(options.buildTool)))
        && (options.scenarioLine === undefined || (typeof options.scenarioLine === 'number' && Number.isInteger(options.scenarioLine) && options.scenarioLine > 0))
        && (options.scenarioName === undefined || typeof options.scenarioName === 'string')
        && (options.runnerClass === undefined || typeof options.runnerClass === 'string')
        && (options.runnerMethod === undefined || typeof options.runnerMethod === 'string')
        && (options.configDir === undefined || typeof options.configDir === 'string')
        && (options.workingDirectory === undefined || typeof options.workingDirectory === 'string');
}

function isCoverageEndpoint(value: unknown): value is { path: string; method: string; operationId?: string } {
    if (!value || typeof value !== 'object') return false;
    const endpoint = value as Record<string, unknown>;
    return typeof endpoint.path === 'string'
        && typeof endpoint.method === 'string'
        && (endpoint.operationId === undefined || typeof endpoint.operationId === 'string');
}

function escapeHtml(value: unknown): string {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character] || character));
}
