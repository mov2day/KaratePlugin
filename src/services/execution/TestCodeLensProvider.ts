import * as vscode from 'vscode';
import * as path from 'path';
import { TestExecutionResult, ScenarioResult } from '../../types';
import { TestHistoryService } from '../execution/TestHistoryService';
import { logger } from '../../utils/logger';

/**
 * Provides CodeLens actions for Karate feature files
 */
export class TestCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    private latestResult?: TestExecutionResult;
    private historyService?: TestHistoryService;

    constructor() {
        // Initialize history service
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (workspaceRoot) {
            this.historyService = new TestHistoryService(workspaceRoot);
            this.loadLatestResult();
        }
    }

    /**
     * Load latest test result
     */
    private async loadLatestResult() {
        if (this.historyService) {
            this.latestResult = await this.historyService.getLatestResult() || undefined;
            this._onDidChangeCodeLenses.fire();
        }
    }

    /**
     * Update with new test result
     */
    public updateResult(result: TestExecutionResult) {
        this.latestResult = result;
        this._onDidChangeCodeLenses.fire();
    }

    /**
     * Provide CodeLens for feature files
     */
    provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] {
        // Only provide for .feature files
        if (!document.fileName.endsWith('.feature')) {
            return [];
        }

        const codeLenses: vscode.CodeLens[] = [];
        const text = document.getText();
        const lines = text.split('\n');

        // Find Feature line
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Feature-level CodeLens
            if (line.startsWith('Feature:')) {
                const range = new vscode.Range(i, 0, i, line.length);

                // Run entire feature
                codeLenses.push(new vscode.CodeLens(range, {
                    title: '▶ Run Feature',
                    command: 'karate-dsl.runFeature',
                    arguments: [document.uri]
                }));

                // View last result if available
                const featureResult = this.getFeatureResult(document.uri.fsPath);
                if (featureResult) {
                    const status = featureResult.status === 'passed' ? '✓' :
                        featureResult.status === 'failed' ? '✗' : '○';
                    codeLenses.push(new vscode.CodeLens(range, {
                        title: `${status} Last Run: ${featureResult.passed}/${featureResult.scenarios.length} passed`,
                        command: 'karate-dsl.showExecutionReport',
                        arguments: []
                    }));
                }
            }

            // Scenario-level CodeLens
            if (line.startsWith('Scenario:') || line.match(/^Scenario\s+Outline:/)) {
                const range = new vscode.Range(i, 0, i, line.length);
                const scenarioName = this.extractScenarioName(line);

                // Run scenario
                codeLenses.push(new vscode.CodeLens(range, {
                    title: '▶ Run Scenario',
                    command: 'karate-dsl.runScenario',
                    arguments: [document.uri, i + 1, scenarioName]
                }));

                // Show last result if available
                const scenarioResult = this.getScenarioResult(document.uri.fsPath, scenarioName);
                if (scenarioResult) {
                    const status = scenarioResult.status === 'passed' ? '✓ Passed' :
                        scenarioResult.status === 'failed' ? '✗ Failed' : '○ Skipped';
                    const duration = (scenarioResult.duration / 1000).toFixed(2) + 's';

                    codeLenses.push(new vscode.CodeLens(range, {
                        title: `${status} (${duration})`,
                        command: 'karate-dsl.showScenarioDetails',
                        arguments: [scenarioResult]
                    }));
                }
            }
        }

        return codeLenses;
    }

    /**
     * Extract scenario name from line
     */
    private extractScenarioName(line: string): string {
        const match = line.match(/Scenario(?:\s+Outline)?:\s*(.+)/);
        return match ? match[1].trim() : '';
    }

    /**
     * Get feature result from latest execution
     */
    private getFeatureResult(featurePath: string) {
        if (!this.latestResult) return null;

        return this.latestResult.features.find(f => f.absolutePath === featurePath);
    }

    /**
     * Get scenario result from latest execution
     */
    private getScenarioResult(featurePath: string, scenarioName: string): ScenarioResult | null {
        const feature = this.getFeatureResult(featurePath);
        if (!feature) return null;

        return feature.scenarios.find(s => s.name === scenarioName) || null;
    }
}
