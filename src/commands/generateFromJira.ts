import * as vscode from 'vscode';
import { JiraClient } from '../services/jira/JiraClient';
import { JiraParser } from '../services/jira/JiraParser';
import { InputSanitizer } from '../services/InputSanitizer';
import { jiraRequirementItems } from '../generation/adapters/requirements';
import { pickContract, runRequirementsGeneration, safeMessage } from '../generation/vscode/RequirementsRun';
import { reportSummary } from '../generation/vscode/reportSummary';
import { toIncrementalProgress } from '../generation/vscode/runGeneration';
import { FileUtils } from '../utils/fileUtils';
import { logger } from '../utils/logger';

/**
 * Command: karate-dsl.generateFromJira
 * Accepts issue key or JQL query; acceptance criteria run through the shared generation pipeline
 * (mapped to a linked OpenAPI contract when one is chosen, otherwise honest @ignore drafts).
 */
export async function generateFromJira(context: vscode.ExtensionContext): Promise<void> {
    let secretToken: string | undefined;
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
        secretToken = apiToken;

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

            secretToken = apiToken;
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

        const workspaceRoot = FileUtils.getWorkspaceRoot();
        if (!workspaceRoot) {throw new Error('No workspace folder is open');}
        const contract = await pickContract();

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

            progress.report({ increment: 20, message: `Processing ${issues.length} issue(s)...` });

            // Parse all issues; text is sanitised before it is used anywhere
            const items = jiraRequirementItems(issues.map(issue => {
                const content = parser.parse(issue);
                return {
                    issueKey: content.issueKey,
                    summary: InputSanitizer.sanitizeJiraContent(content.summary),
                    acceptanceCriteria: content.acceptanceCriteria.map(ac => InputSanitizer.sanitizeJiraContent(ac))
                };
            }));

            const { build, run } = await runRequirementsGeneration({
                context, workspaceRoot, items, contract,
                name: isIssueKey ? input.trim().toUpperCase() : 'jira',
                mode: 'jira', sourceRef: isIssueKey ? input.trim().toUpperCase() : 'Jira query',
                useAi: vscode.workspace.getConfiguration('karateDsl').get<boolean>('useCopilot', false),
                evidenceLabel: 'jira-acceptance-criteria',
                progress: toIncrementalProgress(progress, { from: 40, to: 100 })
            });
            if (!run) {
                vscode.window.showWarningMessage(`No acceptance criteria found in the Jira issue(s). ${build.warnings.join('; ')}`.trim());
                return;
            }
            logger.info(`Generated Jira tests: ${run.createdPaths.join(', ') || '(none)'}`);
            void reportSummary(run.summary, `Jira: ${items.map(i => i.id).join(', ').slice(0, 80)}`, run.createdPaths[0]);
        });
    } catch (error) {
        // The message may carry the base URL or token (HTTP client errors do); mask both before logging or showing it.
        const message = safeMessage(error, [secretToken, vscode.workspace.getConfiguration('karateDsl').get<string>('jira.baseUrl')]);
        logger.error('Jira generation failed', new Error(message));
        vscode.window.showErrorMessage(`Jira generation failed: ${message}`);
    }
}
