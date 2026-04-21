import * as vscode from 'vscode';
import * as path from 'path';
import { JiraClient } from '../services/jira/JiraClient';
import { JiraParser } from '../services/jira/JiraParser';
import { InputSanitizer } from '../services/InputSanitizer';
import { logger } from '../utils/logger';

/**
 * Command: karate-dsl.generateFromJira
 * Accepts issue key or JQL query, generates Karate tests from acceptance criteria.
 */
export async function generateFromJira(context: vscode.ExtensionContext): Promise<void> {
    try {
        // Check Jira configuration
        const config = vscode.workspace.getConfiguration('karateDsl');
        const baseUrl = config.get<string>('jira.baseUrl');

        if (!baseUrl) {
            const setup = await vscode.window.showWarningMessage(
                'Jira not configured. Set base URL and credentials in settings.',
                'Open Settings'
            );
            if (setup === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'karateDsl.jira');
            }
            return;
        }

        // Get credentials
        const email = config.get<string>('jira.email') || '';
        const authType = config.get<'basic' | 'bearer'>('jira.authType') || 'basic';

        // Get API token from secret storage
        const tokenKey = 'karateDsl.jira.apiToken';
        let apiToken = await context.secrets.get(tokenKey);

        if (!apiToken) {
            apiToken = await vscode.window.showInputBox({
                prompt: authType === 'bearer'
                    ? 'Enter your Jira Personal Access Token (PAT)'
                    : 'Enter your Jira API Token',
                password: true,
                placeHolder: 'Token will be stored securely'
            });

            if (!apiToken) {
                return;
            }

            await context.secrets.store(tokenKey, apiToken);
        }

        // Ask for issue key or JQL
        const input = await vscode.window.showInputBox({
            prompt: 'Enter Jira issue key (e.g., PROJ-1234) or JQL query',
            placeHolder: 'PROJ-1234 or project = MYPROJ AND type = Story'
        });

        if (!input) {
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Generating from Jira...',
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 20, message: 'Connecting to Jira...' });

            const client = new JiraClient(baseUrl, email, apiToken!, authType);
            const parser = new JiraParser();

            // Determine if input is issue key or JQL
            const isIssueKey = /^[A-Z]+-\d+$/i.test(input.trim());
            let issues;

            if (isIssueKey) {
                const issue = await client.getIssue(input.trim().toUpperCase());
                issues = [issue];
            } else {
                issues = await client.searchJQL(input);
            }

            if (issues.length === 0) {
                vscode.window.showWarningMessage('No Jira issues found.');
                return;
            }

            progress.report({ increment: 40, message: `Processing ${issues.length} issue(s)...` });

            // Parse all issues
            const contents = issues.map(issue => parser.parse(issue));

            // Generate Karate feature
            const featureLines: string[] = [];
            const featureName = isIssueKey
                ? `${input.trim().toUpperCase()} - ${contents[0].summary}`
                : `Jira Stories`;

            featureLines.push(`Feature: ${featureName}`);
            featureLines.push('');
            featureLines.push('  Background:');
            featureLines.push("    * url baseUrl");
            featureLines.push('');

            for (const content of contents) {
                // Sanitize content before using
                const sanitizedDesc = InputSanitizer.sanitizeJiraContent(content.description);

                featureLines.push(`  # Issue: ${content.issueKey} - ${content.summary}`);
                featureLines.push(`  # Type: ${content.issueType}`);

                for (let i = 0; i < content.acceptanceCriteria.length; i++) {
                    const ac = content.acceptanceCriteria[i];
                    const sanitizedAC = InputSanitizer.sanitizeJiraContent(ac);

                    featureLines.push(`  @jira-${content.issueKey.toLowerCase()}`);
                    featureLines.push(`  Scenario: ${content.issueKey} - ${sanitizedAC.substring(0, 80)}`);
                    featureLines.push(`    # Acceptance Criteria: ${sanitizedAC}`);
                    featureLines.push('    # TODO: Implement test steps based on acceptance criteria above');
                    featureLines.push("    * print 'Scenario placeholder'");
                    featureLines.push('');
                }
            }

            progress.report({ increment: 80, message: 'Saving feature file...' });

            // Optionally enhance with AI
            let featureContent = featureLines.join('\n');

            try {
                const { AIProviderRegistry } = await import('../services/ai/AIProviderRegistry');
                const registry = AIProviderRegistry.getInstance();
                const isAvailable = await registry.isAnyAvailable();

                if (isAvailable) {
                    progress.report({ message: 'Enhancing with AI...' });
                    const enhanced = await registry.complete(
                        `Convert these Jira acceptance criteria into executable Karate DSL test steps.
                        
${featureContent}

RULES:
- Replace placeholder steps with real Karate DSL (Given path, When method, Then status, And match)
- Use realistic test data
- Keep the Feature/Background/Scenario structure
- Keep @jira tags
- Return complete Karate feature file, no markdown

Transform now:`,
                        { maxTokens: 4096, temperature: 0.3 }
                    );

                    if (enhanced.trim()) {
                        featureContent = enhanced.replace(/```gherkin\n?/g, '').replace(/```\n?/g, '').trim();
                    }
                }
            } catch {
                // AI enhancement failed — use template
            }

            // Save file
            const { FileUtils } = await import('../utils/fileUtils');
            const outputPath = FileUtils.resolveOutputPath();
            const fileName = isIssueKey ? input.trim().toUpperCase() : 'jira-tests';
            const outputFile = path.join(outputPath, `${fileName}.feature`);
            const uniqueFile = FileUtils.getUniqueFilename(outputFile);
            FileUtils.writeFile(uniqueFile, featureContent);

            const totalScenarios = contents.reduce((sum, c) => sum + c.acceptanceCriteria.length, 0);
            const action = await vscode.window.showInformationMessage(
                `✅ Generated ${totalScenarios} scenarios from ${issues.length} Jira issue(s)`,
                'Open File',
                'Dismiss'
            );

            if (action === 'Open File') {
                const doc = await vscode.workspace.openTextDocument(uniqueFile);
                await vscode.window.showTextDocument(doc);
            }
        });
    } catch (error) {
        logger.error('Jira generation failed', error as Error);
        vscode.window.showErrorMessage(`Jira generation failed: ${error}`);
    }
}
