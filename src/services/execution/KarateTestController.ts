import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TestExecutor } from './TestExecutor';
import { logger } from '../../utils/logger';

/**
 * VS Code Test Controller for Karate feature files
 * Integrates with the native Testing sidebar
 */
export class KarateTestController {
    private controller: vscode.TestController;
    private testExecutor: TestExecutor;
    private fileWatcher: vscode.FileSystemWatcher;

    constructor(
        context: vscode.ExtensionContext,
        testExecutor: TestExecutor
    ) {
        this.testExecutor = testExecutor;

        // Create test controller
        this.controller = vscode.tests.createTestController(
            'karateTestController',
            'Karate Tests'
        );
        context.subscriptions.push(this.controller);

        // Set up run profile
        const runProfile = this.controller.createRunProfile(
            'Run',
            vscode.TestRunProfileKind.Run,
            (request, token) => this.runTests(request, token),
            true
        );
        context.subscriptions.push(runProfile);

        // Watch for feature file changes
        this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.feature');
        this.fileWatcher.onDidCreate(uri => this.addFeatureFile(uri));
        this.fileWatcher.onDidChange(uri => this.updateFeatureFile(uri));
        this.fileWatcher.onDidDelete(uri => this.removeFeatureFile(uri));
        context.subscriptions.push(this.fileWatcher);

        // Initial scan
        this.scanWorkspace();
    }

    /**
     * Scan workspace for feature files
     */
    private async scanWorkspace() {
        const featureFiles = await vscode.workspace.findFiles('**/*.feature', '**/node_modules/**');

        logger.info(`Found ${featureFiles.length} feature files`);

        for (const uri of featureFiles) {
            await this.addFeatureFile(uri);
        }
    }

    /**
     * Add a feature file to test tree
     */
    private async addFeatureFile(uri: vscode.Uri) {
        try {
            const content = await fs.promises.readFile(uri.fsPath, 'utf-8');
            const fileName = path.basename(uri.fsPath);
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
            const relativePath = workspaceFolder
                ? path.relative(workspaceFolder.uri.fsPath, uri.fsPath)
                : fileName;

            // Create feature test item
            const featureItem = this.controller.createTestItem(
                uri.toString(),
                fileName,
                uri
            );
            featureItem.description = relativePath;
            featureItem.canResolveChildren = true;

            // Parse scenarios
            this.parseScenarios(content, featureItem, uri);

            // Add to root
            this.controller.items.add(featureItem);
        } catch (error) {
            logger.error(`Failed to add feature file: ${uri.fsPath}`, error as Error);
        }
    }

    /**
     * Parse scenarios from feature file content
     */
    private parseScenarios(content: string, featureItem: vscode.TestItem, uri: vscode.Uri) {
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Match Scenario or Scenario Outline
            const scenarioMatch = line.match(/^Scenario(?:\s+Outline)?:\s*(.+)$/);
            if (scenarioMatch) {
                const scenarioName = scenarioMatch[1].trim();
                const scenarioId = `${uri.toString()}:${i + 1}`;

                const scenarioItem = this.controller.createTestItem(
                    scenarioId,
                    scenarioName,
                    uri
                );
                scenarioItem.range = new vscode.Range(i, 0, i, line.length);

                featureItem.children.add(scenarioItem);
            }
        }
    }

    /**
     * Update feature file in test tree
     */
    private async updateFeatureFile(uri: vscode.Uri) {
        // Remove and re-add
        this.removeFeatureFile(uri);
        await this.addFeatureFile(uri);
    }

    /**
     * Remove feature file from test tree
     */
    private removeFeatureFile(uri: vscode.Uri) {
        this.controller.items.delete(uri.toString());
    }

    /**
     * Run tests
     */
    private async runTests(
        request: vscode.TestRunRequest,
        token: vscode.CancellationToken
    ) {
        const run = this.controller.createTestRun(request);
        const queue: vscode.TestItem[] = [];

        // Collect tests to run
        if (request.include) {
            request.include.forEach(test => queue.push(test));
        } else {
            this.controller.items.forEach(test => queue.push(test));
        }

        // Execute tests
        for (const test of queue) {
            if (token.isCancellationRequested) {
                run.skipped(test);
                continue;
            }

            await this.runTest(test, run, token);
        }

        run.end();
    }

    /**
     * Run individual test
     */
    private async runTest(
        test: vscode.TestItem,
        run: vscode.TestRun,
        token: vscode.CancellationToken
    ) {
        run.started(test);

        try {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
            if (!workspaceRoot) {
                run.errored(test, new vscode.TestMessage('No workspace folder open'));
                return;
            }

            // Determine if it's a feature or scenario
            const isScenario = test.id.includes(':');

            const buildTool = vscode.workspace.getConfiguration('karateDsl')
                .get('execution.defaultBuildTool') || 'cli';

            // Execute
            const result = await this.testExecutor.execute({
                type: 'scenario', // Always use scenario type logic which runs full feature
                target: isScenario ? test.parent?.uri?.fsPath || test.uri!.fsPath : test.uri!.fsPath,
                buildTool: buildTool as any,
                workingDirectory: workspaceRoot
            }, token);

            // Get the feature item to update children
            const featureTestItem = isScenario ? test.parent : test;

            if (featureTestItem && result.features.length > 0) {
                const featureResult = result.features[0];

                // Update feature level status
                if (featureResult.status === 'passed') {
                    run.passed(featureTestItem, featureResult.duration);
                } else {
                    run.failed(featureTestItem, new vscode.TestMessage(featureResult.error || 'Feature failed'), featureResult.duration);
                }

                // Update all scenarios
                featureTestItem.children.forEach(scenarioItem => {
                    const scenarioResult = featureResult.scenarios.find(s => s.name === scenarioItem.label);

                    if (scenarioResult) {
                        if (scenarioResult.status === 'passed') {
                            run.passed(scenarioItem, scenarioResult.duration);
                        } else if (scenarioResult.status === 'failed') {
                            // Find the failed step to get the real error
                            const failedStep = scenarioResult.steps.find(s => s.status === 'failed');
                            let errorMsg = scenarioResult.error || 'Scenario failed';
                            let detailedMsg = errorMsg;

                            if (failedStep) {
                                errorMsg = `${failedStep.keyword} ${failedStep.text}`;
                                detailedMsg = `${failedStep.keyword} ${failedStep.text}\n\nError: ${failedStep.errorMessage || 'Unknown error'}`;
                                if (failedStep.log) {
                                    detailedMsg += `\n\nLog:\n${failedStep.log}`;
                                }
                            }

                            const message = new vscode.TestMessage(detailedMsg);

                            // Add location if line number is available
                            if (scenarioResult.line) {
                                message.location = new vscode.Location(featureTestItem.uri!, new vscode.Position(scenarioResult.line - 1, 0));
                            }

                            run.failed(scenarioItem, message, scenarioResult.duration);
                        } else {
                            run.skipped(scenarioItem);
                        }
                    } else {
                        // Scenario not found in results (maybe not run?)
                        run.skipped(scenarioItem);
                    }
                });
            } else {
                // Fallback if no specific feature result structure (e.g. fatal error)
                if (result.status === 'success') {
                    run.passed(test, result.duration);
                } else {
                    run.failed(test, new vscode.TestMessage(result.error || 'Test failed'), result.duration);
                }
            }
        } catch (error) {
            logger.error('Test execution failed', error as Error);
            run.errored(test, new vscode.TestMessage(`Execution failed: ${error}`));
        }
    }

    /**
     * Refresh all tests
     */
    public refresh() {
        this.controller.items.forEach(item => {
            this.controller.items.delete(item.id);
        });
        this.scanWorkspace();
    }
}
