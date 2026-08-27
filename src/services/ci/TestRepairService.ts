import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CIFailurePayload } from './CIFailureIngestor';
import { AIProviderRegistry } from '../ai/AIProviderRegistry';
import { logger } from '../../utils/logger';
import { ScenarioLocator } from './ScenarioLocator';

/**
 * TestRepairService — orchestrates AI-powered test repair.
 * Loads the failing feature, builds a stratified prompt, invokes AI,
 * and writes the fixed scenario back to disk.
 */
export class TestRepairService {
    private readonly scenarioLocator = new ScenarioLocator();

    /**
     * Attempt to repair a failing test based on CI failure payload.
     */
    async repair(payload: CIFailurePayload): Promise<boolean> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            logger.error('TestRepairService: no workspace folder');
            return false;
        }

        const featurePath = path.join(workspaceRoot, payload.featurePath);

        if (!fs.existsSync(featurePath)) {
            logger.error(`TestRepairService: feature file not found: ${featurePath}`);
            vscode.window.showErrorMessage(`CI Repair: Feature file not found: ${payload.featurePath}`);
            return false;
        }

        try {
            const originalContent = fs.readFileSync(featurePath, 'utf-8');

            // Backup if configured
            if (this.shouldBackup()) {
                const backupPath = featurePath + '.bak';
                fs.writeFileSync(backupPath, originalContent);
                logger.info(`TestRepairService: backup created at ${backupPath}`);
            }

            // Build repair prompt
            const prompt = this.buildRepairPrompt(payload, originalContent);

            // Invoke AI
            const registry = AIProviderRegistry.getInstance();
            const fixedContent = await registry.complete(prompt, {
                maxTokens: 4096,
                temperature: 0.2,
                systemPrompt: 'You are a Karate DSL test repair expert. Fix ONLY the broken scenario. Return the complete fixed Scenario block. Pure Karate DSL only. No markdown, no explanations.'
            });

            if (!fixedContent.trim()) {
                logger.warn('TestRepairService: AI returned empty response');
                vscode.window.showWarningMessage('CI Repair: AI could not generate a fix.');
                return false;
            }

            const cleanFix = this.cleanResponse(fixedContent);

            const updatedContent = this.replaceScenario(originalContent, payload, cleanFix);
            if (!updatedContent) {
                vscode.window.showErrorMessage(`CI Repair: refused to apply a fix because "${payload.scenarioName}" was not uniquely identified.`);
                return false;
            }

            if (this.shouldAutoApply()) {
                // Auto-apply: replace scenario in file
                fs.writeFileSync(featurePath, updatedContent);
                logger.info(`TestRepairService: auto-applied fix to ${featurePath}`);
                vscode.window.showInformationMessage(
                    `✅ CI Repair: Fixed "${payload.scenarioName}" in ${payload.featurePath}`
                );
            } else {
                // Show diff
                await this.showDiff(featurePath, originalContent, payload.scenarioName, updatedContent);
            }

            // Open the file and highlight the scenario
            const doc = await vscode.workspace.openTextDocument(featurePath);
            const editor = await vscode.window.showTextDocument(doc);
            const scenarioLine = this.findScenarioLine(doc.getText(), payload);
            if (scenarioLine >= 0) {
                const range = new vscode.Range(scenarioLine, 0, scenarioLine, 0);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            }

            return true;
        } catch (error) {
            logger.error('TestRepairService: repair failed', error as Error);
            vscode.window.showErrorMessage(`CI Repair failed: ${(error as Error).message}`);
            return false;
        }
    }

    private buildRepairPrompt(payload: CIFailurePayload, featureContent: string): string {
        let prompt = `REPAIR CONTEXT
  Feature file:  ${payload.featurePath}
  Scenario:      ${payload.scenarioName}
  Failed step:   ${payload.failedStep}
  Error:         ${payload.errorMessage}
`;

        if (payload.httpRequest) {
            prompt += `
HTTP EVIDENCE (from CI run)
  Request:   ${payload.httpRequest.method} ${payload.httpRequest.url}`;
            if (payload.httpRequest.body) {
                prompt += `\n  Body:      ${payload.httpRequest.body.substring(0, 500)}`;
            }
        }

        if (payload.httpResponse) {
            prompt += `\n  Response:  ${payload.httpResponse.status}`;
            if (payload.httpResponse.body) {
                prompt += ` — ${payload.httpResponse.body.substring(0, 500)}`;
            }
        }

        prompt += `

CURRENT FEATURE FILE:
${featureContent}

CONSTRAINT
  Fix ONLY the failed step and its immediate dependencies.
  Do NOT change any other scenario.
  Do NOT invent endpoints or fields not visible in the evidence.

OUTPUT
  Return the complete fixed Scenario block. Pure Karate DSL only.`;

        return prompt;
    }

    private replaceScenario(content: string, payload: CIFailurePayload, fixedScenario: string): string | undefined {
        const replaced = this.scenarioLocator.replace(content, {
            name: payload.scenarioName,
            tags: payload.scenarioTags,
            line: payload.scenarioLine
        }, fixedScenario);
        if (!replaced) {
            logger.warn(`TestRepairService: could not uniquely locate scenario "${payload.scenarioName}"`);
        }
        return replaced;
    }

    private async showDiff(filePath: string, originalContent: string, scenarioName: string, updatedContent: string): Promise<void> {

        // Create temp files for diff
        const originalUri = vscode.Uri.parse(`untitled:${filePath}.original`);
        const fixedUri = vscode.Uri.parse(`untitled:${filePath}.fixed`);

        // Show diff using vscode diff editor
        const title = `CI Repair: ${scenarioName}`;

        // Write to temp buffers
        const origDoc = await vscode.workspace.openTextDocument({ content: originalContent, language: 'feature' });
        const fixDoc = await vscode.workspace.openTextDocument({ content: updatedContent, language: 'feature' });

        await vscode.commands.executeCommand('vscode.diff', origDoc.uri, fixDoc.uri, title);

        // Offer to apply
        const choice = await vscode.window.showInformationMessage(
            `CI Repair: Apply fix for "${scenarioName}"?`,
            'Apply', 'Dismiss'
        );

        if (choice === 'Apply') {
            fs.writeFileSync(filePath, updatedContent);
            vscode.window.showInformationMessage(`✅ Fix applied to ${path.basename(filePath)}`);
        }
    }

    private findScenarioLine(content: string, payload: CIFailurePayload): number {
        return this.scenarioLocator.find(content, { name: payload.scenarioName, tags: payload.scenarioTags, line: payload.scenarioLine })?.startLine ?? -1;
    }

    private cleanResponse(response: string): string {
        return response
            .replace(/```gherkin\n?/g, '')
            .replace(/```\n?/g, '')
            .trim();
    }

    private shouldAutoApply(): boolean {
        const config = vscode.workspace.getConfiguration('karateDsl');
        return config.get<boolean>('ciRepair.autoApply') || false;
    }

    private shouldBackup(): boolean {
        const config = vscode.workspace.getConfiguration('karateDsl');
        return config.get<boolean>('ciRepair.backupBeforeRepair') !== false;
    }
}
