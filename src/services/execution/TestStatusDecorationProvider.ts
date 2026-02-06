import * as vscode from 'vscode';
import * as path from 'path';
import { TestExecutionResult, ScenarioResult } from '../../types';
import { TestHistoryService } from '../execution/TestHistoryService';
import { logger } from '../../utils/logger';

/**
 * Provides test status decorations in the editor
 */
export class TestStatusDecorationProvider {
    private latestResult?: TestExecutionResult;
    private historyService?: TestHistoryService;

    // Decoration types
    private passedDecoration: vscode.TextEditorDecorationType;
    private failedDecoration: vscode.TextEditorDecorationType;
    private skippedDecoration: vscode.TextEditorDecorationType;
    private notRunDecoration: vscode.TextEditorDecorationType;

    constructor(private context: vscode.ExtensionContext) {
        // Initialize history service
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (workspaceRoot) {
            this.historyService = new TestHistoryService(workspaceRoot);
            this.loadLatestResult();
        }

        // Create decoration types
        this.passedDecoration = vscode.window.createTextEditorDecorationType({
            gutterIconPath: this.createGutterIcon('✓', '#4ade80'),
            gutterIconSize: 'contain',
            after: {
                contentText: ' ',
                color: '#4ade80',
                fontWeight: 'bold'
            }
        });

        this.failedDecoration = vscode.window.createTextEditorDecorationType({
            gutterIconPath: this.createGutterIcon('✗', '#ef4444'),
            gutterIconSize: 'contain',
            after: {
                contentText: ' ',
                color: '#ef4444',
                fontWeight: 'bold'
            }
        });

        this.skippedDecoration = vscode.window.createTextEditorDecorationType({
            gutterIconPath: this.createGutterIcon('○', '#f59e0b'),
            gutterIconSize: 'contain',
            after: {
                contentText: ' ',
                color: '#f59e0b'
            }
        });

        this.notRunDecoration = vscode.window.createTextEditorDecorationType({
            gutterIconPath: this.createGutterIcon('○', '#64748b'),
            gutterIconSize: 'contain',
            after: {
                contentText: ' ',
                color: '#64748b'
            }
        });

        // Listen for editor changes
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                this.updateDecorations(editor);
            }
        });

        // Update active editor
        if (vscode.window.activeTextEditor) {
            this.updateDecorations(vscode.window.activeTextEditor);
        }
    }

    /**
     * Load latest test result
     */
    private async loadLatestResult() {
        if (this.historyService) {
            this.latestResult = await this.historyService.getLatestResult() || undefined;
            this.refreshAllEditors();
        }
    }

    /**
     * Update with new test result
     */
    public updateResult(result: TestExecutionResult) {
        this.latestResult = result;
        this.refreshAllEditors();
    }

    /**
     * Refresh all open editors
     */
    private refreshAllEditors() {
        vscode.window.visibleTextEditors.forEach(editor => {
            this.updateDecorations(editor);
        });
    }

    /**
     * Update decorations for an editor
     */
    private updateDecorations(editor: vscode.TextEditor) {
        // Only decorate .feature files
        if (!editor.document.fileName.endsWith('.feature')) {
            return;
        }

        // Clear existing decorations
        editor.setDecorations(this.passedDecoration, []);
        editor.setDecorations(this.failedDecoration, []);
        editor.setDecorations(this.skippedDecoration, []);
        editor.setDecorations(this.notRunDecoration, []);

        if (!this.latestResult) {
            return;
        }

        // Find feature result for this file
        const featureResult = this.latestResult.features.find(
            f => f.absolutePath === editor.document.uri.fsPath
        );

        if (!featureResult) {
            return;
        }

        // Create decorations for each scenario
        const passedDecorations: vscode.DecorationOptions[] = [];
        const failedDecorations: vscode.DecorationOptions[] = [];
        const skippedDecorations: vscode.DecorationOptions[] = [];

        const text = editor.document.getText();
        const lines = text.split('\\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            if (line.startsWith('Scenario:') || line.match(/^Scenario\\s+Outline:/)) {
                const scenarioName = this.extractScenarioName(line);
                const scenario = featureResult.scenarios.find(s => s.name === scenarioName);

                if (scenario) {
                    const range = new vscode.Range(i, 0, i, lines[i].length);
                    const duration = (scenario.duration / 1000).toFixed(2) + 's';

                    const decoration: vscode.DecorationOptions = {
                        range,
                        hoverMessage: this.createHoverMessage(scenario)
                    };

                    if (scenario.status === 'passed') {
                        passedDecorations.push(decoration);
                    } else if (scenario.status === 'failed') {
                        failedDecorations.push(decoration);
                    } else if (scenario.status === 'skipped') {
                        skippedDecorations.push(decoration);
                    }
                }
            }
        }

        // Apply decorations
        editor.setDecorations(this.passedDecoration, passedDecorations);
        editor.setDecorations(this.failedDecoration, failedDecorations);
        editor.setDecorations(this.skippedDecoration, skippedDecorations);
    }

    /**
     * Create hover message for scenario
     */
    private createHoverMessage(scenario: ScenarioResult): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.isTrusted = true;

        md.appendMarkdown(`### ${scenario.status === 'passed' ? '✓ Passed' : scenario.status === 'failed' ? '✗ Failed' : '○ Skipped'}\n\n`);
        md.appendMarkdown(`**Duration:** ${(scenario.duration / 1000).toFixed(2)}s\n\n`);

        if (scenario.error) {
            md.appendMarkdown(`**Error:** \`${scenario.error}\`\n\n`);
        }

        if (scenario.steps && scenario.steps.length > 0) {
            md.appendMarkdown(`**Steps:**\n\n`);
            scenario.steps.forEach(step => {
                const icon = step.status === 'passed' ? '✓' : step.status === 'failed' ? '✗' : '○';
                md.appendMarkdown(`- ${icon} ${step.keyword} ${step.text}\n`);
            });
        }

        return md;
    }

    /**
     * Extract scenario name from line
     */
    private extractScenarioName(line: string): string {
        const match = line.match(/Scenario(?:\\s+Outline)?:\\s*(.+)/);
        return match ? match[1].trim() : '';
    }

    /**
     * Create gutter icon (SVG data URI)
     */
    private createGutterIcon(symbol: string, color: string): vscode.Uri {
        const svg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
                <circle cx="8" cy="8" r="6" fill="${color}" />
                <text x="8" y="12" text-anchor="middle" fill="white" font-size="10" font-weight="bold">${symbol}</text>
            </svg>
        `;

        const dataUri = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
        return vscode.Uri.parse(dataUri);
    }

    /**
     * Dispose decorations
     */
    public dispose() {
        this.passedDecoration.dispose();
        this.failedDecoration.dispose();
        this.skippedDecoration.dispose();
        this.notRunDecoration.dispose();
    }
}
