import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { generateFromOpenAPI } from './commands/generateFromOpenAPI';
import { generateFromConfluence } from './commands/generateFromConfluence';
import { generateCombined } from './commands/generateCombined';
import { KarateWebviewProvider } from './webview/WebviewProvider';
import { CoverageDashboardProvider } from './webview/CoverageDashboardProvider';
import { ExecutionReportProvider } from './webview/ExecutionReportProvider';
import { SpecWatcher } from './services/specWatcher';
import { SpecHashManager } from './services/specHashManager';
import { SpecDiffAnalyzer } from './services/specDiffAnalyzer';
import { TestImpactAnalyzer } from './services/testImpactAnalyzer';
import { logger } from './utils/logger';
import { CopilotLogger } from './utils/copilotLogger';

// Notification tracking to prevent spam
const shownNotifications = new Map<string, number>(); // specPath -> timestamp
const processingSpecs = new Set<string>(); // specs currently being processed
const NOTIFICATION_COOLDOWN_MS = 30000; // 30 seconds cooldown

import { KarateCodeActionProvider } from './services/linter/KarateCodeActionProvider';
import { KarateLinter } from './services/linter/KarateLinter';
import { TestExecutor } from './services/execution/TestExecutor';
import { TestHistoryService } from './services/execution/TestHistoryService';
import { TestCodeLensProvider } from './services/execution/TestCodeLensProvider';
import { TestStatusDecorationProvider } from './services/execution/TestStatusDecorationProvider';
import { KarateCliExecutor } from './services/execution/KarateCliExecutor';
import { KarateTestController } from './services/execution/KarateTestController';
import { AgentSkillsService } from './services/agentSkillsService';

export function activate(context: vscode.ExtensionContext) {
    logger.info('Karate DSL Generator extension is now active');

    // Initialize Agent Skills with extension path for bundled skills
    AgentSkillsService.setExtensionPath(context.extensionPath);

    // Initialize Services
    const linter = new KarateLinter();
    context.subscriptions.push(linter);

    // Register Copilot Suggestion Command
    context.subscriptions.push(
        vscode.commands.registerCommand('karate-dsl.copilotSuggest', (document: vscode.TextDocument, range: vscode.Range) => {
            const { CopilotSuggestionService } = require('./services/linter/CopilotSuggestionService');
            new CopilotSuggestionService().suggestImprovement(document, range);
        })
    );

    // Register Health Command
    context.subscriptions.push(
        vscode.commands.registerCommand('karate-dsl.analyzeProjectHealth', () => {
            const { HealthDashboardPanel } = require('./services/health/HealthDashboardPanel');
            HealthDashboardPanel.createOrShow(context.extensionUri);
        })
    );

    // Register Code Actions
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { language: 'karate', scheme: 'file' },
            new KarateCodeActionProvider(),
            { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
        )
    );
    // Also support .feature files not yet detected as karate language? 
    // Usually extension sets association. Assume 'karate' or 'feature' check.
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { pattern: '**/*.feature' },
            new KarateCodeActionProvider(),
            { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
        )
    );

    // Initialize Copilot transparency logger & models
    const { CopilotService } = require('./services/copilotService');
    CopilotLogger.initialize(context);
    CopilotService.initialize();

    // Listen for model configuration changes to re-initialize
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('karateDsl.copilot.model')) {
                logger.info('Copilot model configuration changed. Re-initializing...');
                CopilotService.initialize();
            }
        })
    );

    // Register webview provider
    const webviewProvider = new KarateWebviewProvider(context.extensionUri, context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            KarateWebviewProvider.viewType,
            webviewProvider
        )
    );

    // Create coverage dashboard provider (for standalone panel only)
    const coverageDashboardProvider = new CoverageDashboardProvider(context.extensionUri);

    // Create execution report provider
    const executionReportProvider = new ExecutionReportProvider(context.extensionUri);

    // Initialize test executor
    const testExecutor = new TestExecutor(context.extensionPath);

    // Initialize test history service
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    let testHistoryService: TestHistoryService | undefined;
    if (workspaceRoot) {
        testHistoryService = new TestHistoryService(workspaceRoot);
    }

    // Register CodeLens provider for feature files
    const codeLensProvider = new TestCodeLensProvider();
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { language: 'karate', scheme: 'file' },
            codeLensProvider
        ),
        vscode.languages.registerCodeLensProvider(
            { pattern: '**/*.feature' },
            codeLensProvider
        )
    );

    // Register test status decorations provider
    const decorationProvider = new TestStatusDecorationProvider(context);

    // Register Test Explorer integration
    const testController = new KarateTestController(context, testExecutor);
    context.subscriptions.push(decorationProvider);

    // Initialize AI-Powered Test Maintenance
    const specHashManager = new SpecHashManager(context);
    const specDiffAnalyzer = new SpecDiffAnalyzer();
    const testImpactAnalyzer = new TestImpactAnalyzer();

    // Start watching for spec changes
    const specWatcher = new SpecWatcher(context, async (specPath, metadata) => {
        await handleSpecChange(specPath, metadata, webviewProvider, specHashManager, specDiffAnalyzer, testImpactAnalyzer);
    });
    specWatcher.startWatching();
    logger.info('AI-Powered Test Maintenance: Initialized');

    // Command registrations
    const openApiCommand = vscode.commands.registerCommand(
        'karate-dsl.generateFromOpenAPI',
        () => generateFromOpenAPI(context)
    );

    const confluenceCommand = vscode.commands.registerCommand(
        'karate-dsl.generateFromConfluence',
        () => generateFromConfluence(context)
    );

    const showCopilotActivityCommand = vscode.commands.registerCommand(
        'karate-dsl.showCopilotActivity',
        () => CopilotLogger.show()
    );

    const clearCopilotActivityCommand = vscode.commands.registerCommand(
        'karate-dsl.clearCopilotActivity',
        () => CopilotLogger.clear()
    );

    const selectCopilotModelCommand = vscode.commands.registerCommand(
        'karate-dsl.selectCopilotModel',
        async () => {
            try {
                // Get fresh list of available models
                const { CopilotService } = await import('./services/copilotService');
                const models = await CopilotService.getAvailableModels();

                // Add current selection indicator
                const { ConfigManager } = await import('./utils/configManager');
                const current = ConfigManager.getCopilotModel();

                const items = models.map(m => ({
                    label: m,
                    description: m === current ? '(Current)' : '',
                    detail: m === 'gpt-5-mini' ? 'Recommended for speed' : (m === 'claude-sonnet-4.5' ? 'Recommended for complex logic' : '')
                }));

                // Allow custom input
                items.push({
                    label: '$(pencil) Enter Custom Model ID...',
                    description: '',
                    detail: 'Manually enter a model ID not listed here'
                });

                const selection = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select GitHub Copilot Model for Karate Tests'
                });

                if (selection) {
                    let modelId = selection.label;

                    if (modelId.includes('Enter Custom Model ID')) {
                        const input = await vscode.window.showInputBox({
                            placeHolder: 'e.g., gpt-4-32k',
                            prompt: 'Enter the exact Model ID/Family'
                        });
                        if (!input) return;
                        modelId = input;
                    }

                    // Update setting
                    await vscode.workspace.getConfiguration('karateDsl').update('copilot.model', modelId, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage(`Copilot model set to: ${modelId}`);
                    logger.info(`User selected Copilot model: ${modelId}`);
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to select model: ${error}`);
            }
        }
    );

    const combinedCommand = vscode.commands.registerCommand(
        'karate-dsl.generateCombined',
        () => generateCombined(context)
    );

    const openPanelCommand = vscode.commands.registerCommand(
        'karate-dsl.openPanel',
        () => {
            vscode.commands.executeCommand('karateGenerator.mainView.focus');
        }
    );

    const generateFromExplorerCommand = vscode.commands.registerCommand(
        'karate-dsl.generateFromExplorer',
        async (uri: vscode.Uri) => {
            if (!uri) return;
            await vscode.commands.executeCommand('karateGenerator.mainView.focus');
            webviewProvider.postMessageToWebview({
                command: 'preFillSource',
                filePath: uri.fsPath,
                target: 'openapi'
            });
        }
    );

    const learnStyleFromExplorerCommand = vscode.commands.registerCommand(
        'karate-dsl.learnStyleFromExplorer',
        async (uri: vscode.Uri) => {
            if (!uri) return;
            await vscode.commands.executeCommand('karateGenerator.mainView.focus');
            webviewProvider.postMessageToWebview({
                command: 'preFillSource',
                filePath: uri.fsPath,
                target: 'style'
            });
        }
    );

    const generateFromExplorerDirectCommand = vscode.commands.registerCommand(
        'karate-dsl.generateFromExplorerDirect',
        async (uri: vscode.Uri) => {
            if (!uri) return;

            try {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "Generating Karate tests...",
                    cancellable: false
                }, async (progress) => {
                    progress.report({ increment: 20, message: "Parsing OpenAPI..." });

                    // Import services directly
                    const { OpenAPIParser } = await import('./services/openApiParser');
                    const { KarateGenerator } = await import('./services/karateGenerator');
                    const { FileUtils } = await import('./utils/fileUtils');

                    const parser = new OpenAPIParser();
                    const generator = new KarateGenerator();

                    // Parse spec
                    const endpoints = await parser.parseSpec(uri.fsPath);

                    progress.report({ increment: 50, message: "Generating tests..." });

                    // Generate tests
                    const specFileName = path.basename(uri.fsPath, path.extname(uri.fsPath));
                    const feature = generator.generateFromOpenAPI(endpoints, specFileName);
                    feature.background = generator.generateBackground();
                    const featureContent = generator.featureToString(feature);

                    // Save file
                    const outputPath = FileUtils.resolveOutputPath();
                    const outputFile = path.join(outputPath, `${specFileName}.feature`);
                    const uniqueFile = FileUtils.getUniqueFilename(outputFile);
                    FileUtils.writeFile(uniqueFile, featureContent);

                    progress.report({ increment: 100 });

                    logger.info(`Direct generation: ${uniqueFile}`);

                    // Show success with option to open file
                    const action = await vscode.window.showInformationMessage(
                        `✅ Generated ${endpoints.length} test scenarios`,
                        'Open File',
                        'Dismiss'
                    );

                    if (action === 'Open File') {
                        const doc = await vscode.workspace.openTextDocument(uniqueFile);
                        await vscode.window.showTextDocument(doc);
                    }

                    // Try to update history (if webview is ready)
                    try {
                        webviewProvider.postMessageToWebview({ command: 'getHistory' });
                    } catch (e) {
                        // Ignore if webview not ready
                    }
                });
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to generate tests: ${error}`);
                logger.error('Direct generation failed', error as Error);
            }
        }
    );

    const learnStyleFromExplorerDirectCommand = vscode.commands.registerCommand(
        'karate-dsl.learnStyleFromExplorerDirect',
        async (uri: vscode.Uri) => {
            if (!uri) return;

            try {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "Learning style from sample...",
                    cancellable: false
                }, async (progress) => {
                    progress.report({ increment: 50 });

                    // Import StyleAnalyzer directly
                    const { StyleAnalyzer } = await import('./services/styleAnalyzer');

                    const style = StyleAnalyzer.analyze(uri.fsPath);

                    progress.report({ increment: 100 });

                    logger.info(`Learned style from: ${uri.fsPath}`);

                    vscode.window.showInformationMessage(
                        `✅ Style patterns learned! Indentation: ${style.indentation}, ` +
                        `Case: ${style.variableCase}, Comments: ${style.commentStyle}`
                    );

                    // Try to update webview if ready
                    try {
                        webviewProvider.postMessageToWebview({
                            command: 'styleLearnedDirect',
                            style: style
                        });
                    } catch (e) {
                        // Ignore if webview not ready
                    }
                });
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to learn style: ${error}`);
                logger.error('Style learning failed', error as Error);
            }
        }
    );

    // Diagnostic command to view tracked specs
    const viewTrackedSpecsCommand = vscode.commands.registerCommand(
        'karate-dsl.viewTrackedSpecs',
        async () => {
            const trackedSpecs = await specHashManager.getTrackedSpecs();

            if (trackedSpecs.length === 0) {
                vscode.window.showInformationMessage('No OpenAPI specs are currently being tracked. Generate tests from a spec to start tracking.');
                return;
            }

            const items = trackedSpecs.map(spec => ({
                label: path.basename(spec),
                description: spec,
                detail: 'Click to check for changes'
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Tracked OpenAPI Specifications'
            });

            if (selected) {
                const hasChanges = await specWatcher.checkSpec(selected.description!);
                if (hasChanges) {
                    vscode.window.showInformationMessage(`Changes detected in ${selected.label}`);
                    const metadata = await specHashManager.getMetadata(selected.description!);
                    if (metadata) {
                        await handleSpecChange(selected.description!, metadata, webviewProvider, specHashManager, specDiffAnalyzer, testImpactAnalyzer);
                    }
                } else {
                    vscode.window.showInformationMessage(`No changes detected in ${selected.label}`);
                }
            }
        }
    );

    // Manual spec check command
    const checkSpecChangesCommand = vscode.commands.registerCommand(
        'karate-dsl.checkSpecChanges',
        async () => {
            const trackedSpecs = await specHashManager.getTrackedSpecs();

            if (trackedSpecs.length === 0) {
                vscode.window.showWarningMessage('No specs are being tracked. Generate tests from an OpenAPI spec first.');
                return;
            }

            let changesFound = 0;
            for (const specPath of trackedSpecs) {
                const hasChanges = await specWatcher.checkSpec(specPath);
                if (hasChanges) {
                    changesFound++;
                    const metadata = await specHashManager.getMetadata(specPath);
                    if (metadata) {
                        await handleSpecChange(specPath, metadata, webviewProvider, specHashManager, specDiffAnalyzer, testImpactAnalyzer);
                    }
                }
            }

            if (changesFound === 0) {
                vscode.window.showInformationMessage('✅ All tracked specs are up to date!');
            }
        }
    );

    // Manual OpenAPI diff comparison command
    const compareOpenAPIVersionsCommand = vscode.commands.registerCommand(
        'karate-dsl.compareOpenAPIVersions',
        async () => {
            try {
                const oldFile = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { 'OpenAPI': ['json', 'yaml', 'yml'] },
                    title: 'Select OLD OpenAPI Specification'
                });

                if (!oldFile || oldFile.length === 0) return;

                const newFile = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { 'OpenAPI': ['json', 'yaml', 'yml'] },
                    title: 'Select NEW OpenAPI Specification'
                });

                if (!newFile || newFile.length === 0) return;

                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Comparing OpenAPI specifications...',
                    cancellable: false
                }, async (progress) => {
                    const { ManualDiffService } = await import('./services/manualDiffService');
                    const { KarateGenerator } = await import('./services/karateGenerator');

                    const diffService = new ManualDiffService();
                    const generator = new KarateGenerator();

                    progress.report({ increment: 20 });
                    const diff = await diffService.compareSpecs(oldFile[0].fsPath, newFile[0].fsPath);

                    progress.report({ increment: 40 });
                    const featureFiles = await diffService.findFeatureFiles();

                    if (featureFiles.length === 0) {
                        vscode.window.showWarningMessage('No feature files found.');
                        return;
                    }

                    let updated = 0, added = 0, deprecated = 0;

                    for (const endpoint of diff.removed) {
                        const target = diffService.matchEndpointToFeatureFile(endpoint, featureFiles);
                        if (target) {
                            await diffService.removeScenarioFromFile(target, endpoint);
                            deprecated++;
                        }
                    }

                    for (const endpoint of diff.added) {
                        const target = diffService.matchEndpointToFeatureFile(endpoint, featureFiles);
                        const feature = generator.generateFromOpenAPI([endpoint], 'temp');
                        const content = generator.featureToString(feature);

                        if (target) {
                            await diffService.updateFeatureFile(target, endpoint, content);
                            added++;
                        }
                    }

                    for (const endpoint of diff.modified) {
                        const target = diffService.matchEndpointToFeatureFile(endpoint, featureFiles);
                        if (target) {
                            const feature = generator.generateFromOpenAPI([endpoint], 'temp');
                            const content = generator.featureToString(feature);
                            await diffService.updateFeatureFile(target, endpoint, content);
                            updated++;
                        }
                    }

                    vscode.window.showInformationMessage(
                        `✅ ${diff.summary} - Updated: ${updated}, Added: ${added}, Deprecated: ${deprecated}`
                    );
                });
            } catch (error) {
                logger.error('Error comparing specs', error as Error);
                vscode.window.showErrorMessage(`Failed: ${error}`);
            }
        }
    );

    // Show Coverage Dashboard command
    const showCoverageDashboardCommand = vscode.commands.registerCommand(
        'karate-dsl.showCoverageDashboard',
        async () => {
            await coverageDashboardProvider.showDashboard();
        }
    );

    // Postman Collection Import command
    const importPostmanCommand = vscode.commands.registerCommand(
        'karate-dsl.importPostmanCollection',
        async (uri?: vscode.Uri) => {
            try {
                // Select collection file
                const collectionFile = uri || await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { 'Postman Collection': ['json'] },
                    title: 'Select Postman Collection'
                });

                if (!collectionFile || (Array.isArray(collectionFile) && collectionFile.length === 0)) {
                    return;
                }

                const collectionPath = Array.isArray(collectionFile) ? collectionFile[0].fsPath : collectionFile.fsPath;

                // Ask for environment file (optional)
                const includeEnv = await vscode.window.showQuickPick(['Yes', 'No'], {
                    placeHolder: 'Do you want to include a Postman environment file?'
                });

                let environmentPath: string | undefined;
                if (includeEnv === 'Yes') {
                    const envFile = await vscode.window.showOpenDialog({
                        canSelectMany: false,
                        filters: { 'Postman Environment': ['json'] },
                        title: 'Select Postman Environment'
                    });

                    if (envFile && envFile.length > 0) {
                        environmentPath = envFile[0].fsPath;
                    }
                }

                // Ask if user wants to use Copilot
                const useCopilotChoice = await vscode.window.showQuickPick(['Yes', 'No'], {
                    placeHolder: 'Use GitHub Copilot to enhance variable and script conversion?'
                });

                const useCopilot = useCopilotChoice === 'Yes';

                // Ask for output directory
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (!workspaceFolders) {
                    vscode.window.showErrorMessage('No workspace folder open');
                    return;
                }

                const outputDir = path.join(workspaceFolders[0].uri.fsPath, 'src', 'test', 'karate');

                // Import with progress
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Importing Postman Collection...',
                    cancellable: true
                }, async (progress, token) => {
                    progress.report({ increment: 20, message: 'Parsing collection...' });

                    const { PostmanImportService } = await import('./services/postmanImportService');
                    const importService = new PostmanImportService();

                    progress.report({ increment: 40, message: 'Converting to Karate...' });

                    const result = await importService.importCollection(collectionPath, outputDir, {
                        preserveFolders: true,
                        convertScripts: true,
                        includeAuth: true,
                        useCopilot,
                        environmentFile: environmentPath
                    }, token);

                    progress.report({ increment: 100 });

                    if (result.success) {
                        const message = `✅ Successfully imported ${result.featuresCreated} feature file(s)!`;
                        const action = await vscode.window.showInformationMessage(
                            message,
                            'Open Folder',
                            'Dismiss'
                        );

                        if (action === 'Open Folder') {
                            const uri = vscode.Uri.file(outputDir);
                            await vscode.commands.executeCommand('revealInExplorer', uri);
                        }

                        // Show warnings if any
                        if (result.warnings.length > 0) {
                            vscode.window.showWarningMessage(
                                `Import completed with warnings: ${result.warnings.join(', ')}`
                            );
                        }

                        // Show unsupported features if any
                        if (result.unsupportedFeatures.length > 0) {
                            vscode.window.showInformationMessage(
                                `Note: ${result.unsupportedFeatures.join(', ')}`
                            );
                        }
                    } else {
                        vscode.window.showErrorMessage(`Import failed: ${result.warnings.join(', ')}`);
                    }
                });
            } catch (error) {
                if (error instanceof vscode.CancellationError) {
                    vscode.window.showInformationMessage('Import cancelled by user');
                    return;
                }
                logger.error('Postman import failed', error as Error);
                vscode.window.showErrorMessage(`Failed to import Postman collection: ${error}`);
            }
        }
    );

    // Test Execution Commands
    const runFeatureCommand = vscode.commands.registerCommand(
        'karate-dsl.runFeature',
        async (uri?: vscode.Uri) => {
            try {
                const featureUri = uri || vscode.window.activeTextEditor?.document.uri;
                if (!featureUri || !featureUri.fsPath.endsWith('.feature')) {
                    vscode.window.showWarningMessage('Please select a feature file to run');
                    return;
                }

                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `Running ${path.basename(featureUri.fsPath)}...`,
                    cancellable: true
                }, async (progress, token) => {
                    progress.report({ increment: 10, message: 'Starting execution...' });

                    const result = await testExecutor.execute({
                        type: 'feature',
                        target: featureUri.fsPath,
                        buildTool: vscode.workspace.getConfiguration('karateDsl').get('execution.defaultBuildTool') || 'cli',
                        workingDirectory: workspaceRoot
                    }, token);

                    progress.report({ increment: 90, message: 'Execution complete' });

                    // Save to history
                    if (testHistoryService) {
                        await testHistoryService.saveResult(result);
                    }

                    // Update providers
                    codeLensProvider.updateResult(result);
                    decorationProvider.updateResult(result);

                    // Show report
                    await executionReportProvider.showReport(result);

                    if (result.status === 'success') {
                        vscode.window.showInformationMessage(
                            `✅ Tests passed: ${result.summary.passed}/${result.summary.totalScenarios}`
                        );
                    } else if (result.status === 'failed') {
                        vscode.window.showErrorMessage(
                            `❌ Tests failed: ${result.summary.failed} failures, ${result.summary.passed} passed`
                        );
                    }
                });
            } catch (error) {
                logger.error('Feature execution failed', error as Error);
                vscode.window.showErrorMessage(`Failed to run feature: ${error}`);
            }
        }
    );

    const runScenarioCommand = vscode.commands.registerCommand(
        'karate-dsl.runScenario',
        async (uri?: vscode.Uri, line?: number, scenarioName?: string) => {
            try {
                const featureUri = uri || vscode.window.activeTextEditor?.document.uri;
                if (!featureUri) {
                    vscode.window.showWarningMessage('No feature file active');
                    return;
                }

                if (!featureUri.fsPath.endsWith('.feature')) {
                    vscode.window.showWarningMessage('Please open a .feature file to run scenarios');
                    return;
                }

                const editor = vscode.window.activeTextEditor;
                const scenarioLine = line !== undefined ? line : editor?.selection.active.line || 0;

                // Try to extract scenario name from document if not provided
                let detectedScenarioName = scenarioName;
                if (!detectedScenarioName && editor && editor.document.uri.fsPath === featureUri.fsPath) {
                    const document = editor.document;
                    // Search backwards from cursor to find the Scenario line
                    for (let i = scenarioLine; i >= 0; i--) {
                        const lineText = document.lineAt(i).text.trim();
                        if (lineText.startsWith('Scenario:') || lineText.match(/^Scenario\s+Outline:/)) {
                            const match = lineText.match(/Scenario(?:\s+Outline)?:\s*(.+)/);
                            if (match) {
                                detectedScenarioName = match[1].trim();
                                break;
                            }
                        }
                    }
                }

                const target = `${featureUri.fsPath}:${scenarioLine + 1}`;
                const displayName = detectedScenarioName || `line ${scenarioLine + 1}`;

                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `Running scenario: ${displayName}...`,
                    cancellable: true
                }, async (progress, token) => {
                    progress.report({ increment: 10, message: 'Starting execution...' });

                    const result = await testExecutor.execute({
                        type: 'scenario',
                        target,
                        buildTool: vscode.workspace.getConfiguration('karateDsl').get('execution.defaultBuildTool') || 'cli',
                        workingDirectory: workspaceRoot
                    }, token);

                    progress.report({ increment: 90, message: 'Execution complete' });

                    // Save and update
                    if (testHistoryService) await testHistoryService.saveResult(result);
                    codeLensProvider.updateResult(result);
                    decorationProvider.updateResult(result);

                    // Show report
                    await executionReportProvider.showReport(result);

                    if (result.status === 'success') {
                        vscode.window.showInformationMessage(`✅ Scenario "${displayName}" passed`);
                    } else if (result.status === 'failed') {
                        vscode.window.showErrorMessage(`❌ Scenario "${displayName}" failed`);
                    } else if (result.status === 'error') {
                        // Error already shown in TestExecutor
                    }
                });
            } catch (error) {
                logger.error('Scenario execution failed', error as Error);
                // Don't show error here as TestExecutor handles it
            }
        }
    );

    const runFolderCommand = vscode.commands.registerCommand(
        'karate-dsl.runFolder',
        async (uri?: vscode.Uri) => {
            try {
                const folderPath = uri?.fsPath || workspaceRoot;
                if (!folderPath) {
                    vscode.window.showWarningMessage('No folder selected');
                    return;
                }

                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `Running all tests in ${path.basename(folderPath)}...`,
                    cancellable: true
                }, async (progress, token) => {
                    const result = await testExecutor.execute({
                        type: 'folder',
                        target: folderPath,
                        buildTool: vscode.workspace.getConfiguration('karateDsl').get('execution.defaultBuildTool') || 'cli',
                        parallel: vscode.workspace.getConfiguration('karateDsl').get('execution.parallelThreads') || 1,
                        workingDirectory: workspaceRoot
                    }, token);

                    if (testHistoryService) await testHistoryService.saveResult(result);
                    codeLensProvider.updateResult(result);
                    decorationProvider.updateResult(result);
                    await executionReportProvider.showReport(result);

                    vscode.window.showInformationMessage(
                        `✅ Executed ${result.summary.totalScenarios} scenarios: ${result.summary.passed} passed, ${result.summary.failed} failed`
                    );
                });
            } catch (error) {
                logger.error('Folder execution failed', error as Error);
                vscode.window.showErrorMessage(`Failed to run folder: ${error}`);
            }
        }
    );

    const runByTagsCommand = vscode.commands.registerCommand(
        'karate-dsl.runByTags',
        async () => {
            try {
                const tags = await vscode.window.showInputBox({
                    prompt: 'Enter tags to filter (comma-separated)',
                    placeHolder: 'e.g., @smoke, @regression'
                });

                if (!tags) return;

                const tagList = tags.split(',').map(t => t.trim().replace(/^@/, ''));

                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `Running tests with tags: ${tagList.join(', ')}...`,
                    cancellable: true
                }, async (progress, token) => {
                    const result = await testExecutor.execute({
                        type: 'tags',
                        target: workspaceRoot || '',
                        tags: tagList,
                        buildTool: vscode.workspace.getConfiguration('karateDsl').get('execution.defaultBuildTool') || 'cli',
                        workingDirectory: workspaceRoot
                    }, token);

                    if (testHistoryService) await testHistoryService.saveResult(result);
                    codeLensProvider.updateResult(result);
                    decorationProvider.updateResult(result);
                    await executionReportProvider.showReport(result);
                });
            } catch (error) {
                logger.error('Tag-based execution failed', error as Error);
                vscode.window.showErrorMessage(`Failed to run tests by tags: ${error}`);
            }
        }
    );

    const showExecutionReportCommand = vscode.commands.registerCommand(
        'karate-dsl.showExecutionReport',
        async () => {
            await executionReportProvider.showReport();
        }
    );

    const showTestHistoryCommand = vscode.commands.registerCommand(
        'karate-dsl.showTestHistory',
        async () => {
            if (!testHistoryService) {
                vscode.window.showWarningMessage('No workspace folder open');
                return;
            }

            const history = await testHistoryService.getHistory(10);
            if (history.length === 0) {
                vscode.window.showInformationMessage('No test execution history available');
                return;
            }

            const items = history.map(h => ({
                label: `$(${h.status === 'success' ? 'check' : 'error'}) ${new Date(h.timestamp).toLocaleString()}`,
                description: `${h.summary.passed}/${h.summary.totalScenarios} passed (${h.summary.passPercentage.toFixed(1)}%)`,
                detail: `Duration: ${h.summary.executionTime}`,
                result: h
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a test run to view'
            });

            if (selected) {
                await executionReportProvider.showReport(selected.result);
            }
        }
    );

    // Clear Karate JAR cache command
    const clearKarateCacheCommand = vscode.commands.registerCommand(
        'karate-dsl.clearKarateCache',
        async () => {
            const cleared = KarateCliExecutor.clearJarCache(context.extensionPath);
            if (cleared) {
                vscode.window.showInformationMessage('✅ Karate JAR cache cleared. The JAR will be re-downloaded on next execution.');
            } else {
                vscode.window.showInformationMessage('No cached JAR found.');
            }
        }
    );

    // Session Recording Commands
    const startRecordingCommand = vscode.commands.registerCommand(
        'karate-dsl.startRecording',
        async () => {
            try {
                const { SessionRecorderService } = await import('./services/session/SessionRecorderService');
                const recorder = SessionRecorderService.getInstance();

                if (recorder.isRecording()) {
                    vscode.window.showWarningMessage('A recording session is already active');
                    return;
                }

                await recorder.startRecording();
            } catch (error) {
                logger.error('Failed to start recording', error as Error);
                vscode.window.showErrorMessage(`Failed to start recording: ${error}`);
            }
        }
    );

    const stopRecordingCommand = vscode.commands.registerCommand(
        'karate-dsl.stopRecording',
        async () => {
            try {
                const { SessionRecorderService } = await import('./services/session/SessionRecorderService');
                const recorder = SessionRecorderService.getInstance();

                if (!recorder.isRecording()) {
                    vscode.window.showWarningMessage('No active recording session');
                    return;
                }

                const requests = await recorder.stopRecording();

                if (requests.length > 0) {
                    // Trigger synthesis
                    vscode.commands.executeCommand('karate-dsl.synthesizeSession');
                }
            } catch (error) {
                logger.error('Failed to stop recording', error as Error);
                vscode.window.showErrorMessage(`Failed to stop recording: ${error}`);
            }
        }
    );

    const importHarCommand = vscode.commands.registerCommand(
        'karate-dsl.importHar',
        async () => {
            try {
                const { SessionRecorderService } = await import('./services/session/SessionRecorderService');
                const recorder = SessionRecorderService.getInstance();

                const requests = await recorder.importHarFile();

                if (requests.length > 0) {
                    // Offer to synthesize immediately
                    vscode.commands.executeCommand('karate-dsl.synthesizeSession');
                }
            } catch (error) {
                logger.error('Failed to import HAR file', error as Error);
                vscode.window.showErrorMessage(`Failed to import HAR file: ${error}`);
            }
        }
    );

    const synthesizeSessionCommand = vscode.commands.registerCommand(
        'karate-dsl.synthesizeSession',
        async () => {
            try {
                const { SessionRecorderService } = await import('./services/session/SessionRecorderService');
                const { ResourceLifecycleAnalyzer } = await import('./services/synthesis/ResourceLifecycleAnalyzer');
                const { CopilotService } = await import('./services/copilotService');
                const { FileUtils } = await import('./utils/fileUtils');

                const recorder = SessionRecorderService.getInstance();
                const requests = recorder.getSessionRequests();

                if (requests.length === 0) {
                    vscode.window.showWarningMessage('No requests to synthesize. Start recording or import a HAR file first.');
                    return;
                }

                // Ask if user wants to enhance with Copilot
                const useCopilot = await vscode.window.showQuickPick([
                    { label: '$(sparkle) Enhance with AI (Copilot)', value: true, description: 'Add validations, assertions, and comprehensive tests' },
                    { label: '$(file-code) Basic Generation', value: false, description: 'Generate simple request/response tests' }
                ], {
                    placeHolder: `Generate Karate tests from ${requests.length} requests`
                });

                if (!useCopilot) {
                    return;
                }

                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Synthesizing Karate tests...',
                    cancellable: true
                }, async (progress, token) => {
                    progress.report({ increment: 20, message: 'Analyzing resource lifecycles...' });

                    // Analyze for chained scenarios
                    const lifecycles = ResourceLifecycleAnalyzer.analyze(requests);

                    progress.report({ increment: 40, message: 'Generating base Karate DSL...' });

                    // Generate base Karate feature
                    let karateContent = ResourceLifecycleAnalyzer.generateKarate(requests, lifecycles);

                    // Enhance with Copilot if selected
                    if (useCopilot.value) {
                        progress.report({ increment: 60, message: 'Enhancing with AI validations...' });

                        // Build request summary for Copilot context
                        const requestSummary = requests.map(r => {
                            const respPreview = r.response?.body?.substring(0, 500) || '';
                            return `${r.method} ${r.path}\nStatus: ${r.response?.status}\nRequest Body: ${r.body?.substring(0, 200) || 'none'}\nResponse: ${respPreview}`;
                        }).join('\n---\n');

                        const enhancementPrompt = `
The following is a Karate feature file generated from recorded HTTP requests.

CAPTURED REQUESTS SUMMARY:
${requestSummary}

REQUIREMENTS - Add comprehensive enhancements:
1. **Status Code Validations**: Verify correct status codes
2. **Response Schema Validation**: Match response structure using Karate's 'match' syntax
3. **Field Type Checks**: Add #string, #number, #boolean, #array, #object checks
4. **Required Field Validation**: Use #present for mandatory fields
5. **Business Logic**: Add assertions for relationships between requests (e.g., created ID used in subsequent GET)
6. **Error Scenarios**: Add commented suggestions for negative tests
7. **Performance Assertions**: Add reasonable responseTime checks

OUTPUT: Return the COMPLETE enhanced Karate feature file.
Do NOT add markdown code blocks. Pure Karate DSL only.`;

                        try {
                            karateContent = await CopilotService.enhanceKarateTest(
                                karateContent,
                                'Session recording synthesis',
                                {
                                    type: 'postman', // Closest match for request/response data
                                    postmanCollection: requestSummary
                                }
                            );
                            logger.info('Successfully enhanced session with Copilot');
                        } catch (copilotError) {
                            logger.warn('Copilot enhancement failed, using basic generation', copilotError as Error);
                            vscode.window.showWarningMessage('AI enhancement failed. Using basic generation.');
                        }
                    }

                    progress.report({ increment: 80, message: 'Saving feature file...' });

                    // Save to file
                    const outputPath = FileUtils.resolveOutputPath();
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
                    const outputFile = path.join(outputPath, `recorded-session-${timestamp}.feature`);
                    FileUtils.writeFile(outputFile, karateContent);

                    progress.report({ increment: 100 });

                    // Open the generated file
                    const doc = await vscode.workspace.openTextDocument(outputFile);
                    await vscode.window.showTextDocument(doc);

                    const enhancedLabel = useCopilot.value ? ' (AI Enhanced)' : '';
                    vscode.window.showInformationMessage(
                        `✅ Generated Karate feature from ${requests.length} requests (${lifecycles.length} resource lifecycles)${enhancedLabel}`
                    );
                });
            } catch (error) {
                logger.error('Failed to synthesize session', error as Error);
                vscode.window.showErrorMessage(`Failed to synthesize session: ${error}`);
            }
        }
    );

    context.subscriptions.push(
        openApiCommand,
        confluenceCommand,
        combinedCommand,
        openPanelCommand,
        generateFromExplorerCommand,
        learnStyleFromExplorerCommand,
        generateFromExplorerDirectCommand,
        learnStyleFromExplorerDirectCommand,
        viewTrackedSpecsCommand,
        checkSpecChangesCommand,
        compareOpenAPIVersionsCommand,
        showCoverageDashboardCommand,
        importPostmanCommand,
        selectCopilotModelCommand,
        showCopilotActivityCommand,
        clearCopilotActivityCommand,
        runFeatureCommand,
        runScenarioCommand,
        runFolderCommand,
        runByTagsCommand,
        showExecutionReportCommand,
        showTestHistoryCommand,
        clearKarateCacheCommand,
        startRecordingCommand,
        stopRecordingCommand,
        importHarCommand,
        synthesizeSessionCommand
    );
}

/**
 * Handle spec change detection
 */
async function handleSpecChange(
    specPath: string,
    metadata: any,
    webviewProvider: KarateWebviewProvider,
    specHashManager: SpecHashManager,
    specDiffAnalyzer: SpecDiffAnalyzer,
    testImpactAnalyzer: TestImpactAnalyzer
) {
    try {
        logger.info(`Spec change detected: ${specPath}`);

        // Parse the current (new) spec
        const { OpenAPIParser } = await import('./services/openApiParser');
        const parser = new OpenAPIParser();
        const newEndpoints = await parser.parseSpec(specPath);

        // Create endpoint maps for comparison
        const oldPaths = new Set(metadata.endpoints.map((e: any) => `${e.method}:${e.path}`));
        const newPaths = new Set(newEndpoints.map((e: any) => `${e.method}:${e.path}`));

        const added = newEndpoints.filter((e: any) => !oldPaths.has(`${e.method}:${e.path}`));
        const removed = metadata.endpoints.filter((e: any) => !newPaths.has(`${e.method}:${e.path}`));

        // Create a simplified diff
        const diff = {
            added: added.map((e: any) => ({ path: e.path, method: e.method, changeType: 'added' as const, details: [] })),
            removed: removed.map((e: any) => ({ path: e.path, method: e.method, changeType: 'removed' as const, details: [] })),
            modified: [],
            breaking: [],
            summary: ''
        };

        // Generate summary
        const parts: string[] = [];
        if (diff.added.length > 0) parts.push(`${diff.added.length} endpoint${diff.added.length > 1 ? 's' : ''} added`);
        if (diff.removed.length > 0) parts.push(`${diff.removed.length} endpoint${diff.removed.length > 1 ? 's' : ''} removed`);
        diff.summary = parts.length > 0 ? parts.join(', ') : 'No changes detected';

        logger.info(`Diff summary: ${diff.summary}`);

        // Analyze impact
        const affected = testImpactAnalyzer.analyzeImpact(diff, metadata);

        if (affected.length === 0) {
            logger.info('No test impact detected');
            return;
        }

        // Check if this spec is currently being processed
        if (processingSpecs.has(specPath)) {
            logger.info(`Spec ${specPath} is currently being processed, skipping notification`);
            return;
        }

        // Check if we recently showed a notification for this spec
        const lastNotification = shownNotifications.get(specPath);
        const now = Date.now();
        if (lastNotification && (now - lastNotification) < NOTIFICATION_COOLDOWN_MS) {
            logger.info(`Notification cooldown active for ${specPath}, skipping`);
            return;
        }

        // Mark that we're showing a notification
        shownNotifications.set(specPath, now);

        // Show notification
        const fileName = path.basename(specPath);
        const action = await vscode.window.showInformationMessage(
            `📋 ${fileName} has changed (${diff.summary})`,
            'Update with Copilot',
            'Ignore'
        );

        if (action === 'Update with Copilot') {

            // Mark spec as being processed
            processingSpecs.add(specPath);
            logger.info(`Marked ${specPath} as processing, blocking further notifications`);

            // Use Copilot to intelligently fix tests
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Fixing tests with GitHub Copilot...',
                cancellable: false
            }, async (progress) => {
                try {
                    const { CopilotTestFixService } = await import('./services/copilotTestFixService');
                    const fixService = new CopilotTestFixService();

                    progress.report({ increment: 20, message: 'Analyzing changes...' });

                    // For Copilot fix, we need the old spec content
                    // We'll create a temporary file with the old content from metadata
                    const tempOldSpec = path.join(path.dirname(specPath), '.old-spec-temp.yaml');
                    const fs = await import('fs');

                    // Reconstruct old spec from metadata (simplified)
                    const oldSpecContent = `# Old spec (reconstructed from metadata)\npaths:\n${metadata.endpoints.map((e: any) => `  ${e.path}:\n    ${e.method}:\n      summary: ${e.operationId || 'endpoint'}`).join('\n')}`;
                    fs.writeFileSync(tempOldSpec, oldSpecContent, 'utf-8');

                    progress.report({ increment: 50, message: 'Applying AI-powered fixes...' });

                    const result = await fixService.fixTestsWithCopilot(
                        tempOldSpec,
                        specPath,
                        affected
                    );

                    // Clean up temp file
                    fs.unlinkSync(tempOldSpec);

                    // Update hash to prevent repeated notifications
                    const crypto = await import('crypto');
                    const content = fs.readFileSync(specPath, 'utf-8');
                    const newHash = crypto.createHash('sha256').update(content).digest('hex');
                    metadata.specHash = newHash;
                    await specHashManager.saveMetadata(metadata);
                    logger.info(`Updated hash after Copilot fix to prevent re-notification`);

                    progress.report({ increment: 100 });

                    if (result.errors.length > 0) {
                        vscode.window.showWarningMessage(
                            `✅ Updated ${result.updated} test(s) with Copilot. ${result.errors.length} error(s) occurred.`
                        );
                    } else {
                        vscode.window.showInformationMessage(
                            `✅ Successfully updated ${result.updated} test(s) with GitHub Copilot!`
                        );
                    }
                } catch (error) {
                    logger.error('Copilot fix failed', error as Error);
                    vscode.window.showErrorMessage(`Failed to fix tests with Copilot: ${error}`);
                } finally {
                    // Always remove processing flag
                    processingSpecs.delete(specPath);
                    logger.info(`Removed ${specPath} from processing, notifications re-enabled`);
                }
            });
        } else if (action === 'Ignore') {
            // Update the stored hash to current hash to prevent repeated notifications
            const fs = await import('fs');
            const crypto = await import('crypto');
            const content = fs.readFileSync(specPath, 'utf-8');
            const newHash = crypto.createHash('sha256').update(content).digest('hex');

            metadata.specHash = newHash;
            await specHashManager.saveMetadata(metadata);

            logger.info(`Ignored changes for ${specPath}, updated hash to prevent re-notification`);
            vscode.window.showInformationMessage('Changes ignored. You won\'t be notified about these changes again.');
        }
    } catch (error) {
        logger.error('Error handling spec change', error as Error);

        // Spec has invalid format or critical error
        // Untrack to prevent loop
        try {
            if (processingSpecs.has(specPath)) {
                processingSpecs.delete(specPath);
            }

            await specHashManager.deleteMetadata(specPath);
            logger.warn(`Untracked ${specPath} due to processing error`);

            // Show transient or less intrusive error
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Stop tracking ${path.basename(specPath)} due to error: ${(error as Error).message}`,
                cancellable: false
            }, async (progress) => {
                await new Promise(resolve => setTimeout(resolve, 3000)); // Show for 3s then dismiss
            });

        } catch (cleanupError) {
            logger.error('Failed to cleanup metadata', cleanupError as Error);
        }
    }
}



export function deactivate() {
    logger.info('Karate DSL Generator extension deactivated');
}
