import * as vscode from 'vscode';
import { ConfluenceClient } from '../services/confluenceClient';
import { ConfluenceParser } from '../services/confluenceParser';
import { ConfigManager } from '../utils/configManager';
import { FileUtils } from '../utils/fileUtils';
import { logger } from '../utils/logger';
import { confluenceRequirementItems } from '../generation/adapters/requirements';
import { slug } from '../generation/plan/slug';
import { pickContract, runRequirementsGeneration, safeMessage } from '../generation/vscode/RequirementsRun';
import { reportSummary } from '../generation/vscode/reportSummary';
import { toIncrementalProgress } from '../generation/vscode/runGeneration';

/**
 * Command: karate-dsl.generateFromConfluence
 * Test cases on the page run through the shared generation pipeline: mapped to a linked OpenAPI contract when one is
 * chosen, otherwise honest @ignore drafts (steps and expected results stay as comments, never invented live steps).
 */
export async function generateFromConfluence(context: vscode.ExtensionContext): Promise<void> {
    let secretToken: string | undefined;
    try {
        // Step 1: Get Confluence page URL or ID
        const input = await vscode.window.showInputBox({
            prompt: 'Enter Confluence page URL or page ID',
            placeHolder: 'https://yourcompany.atlassian.net/wiki/spaces/SPACE/pages/123456 or 123456'
        });

        if (!input) {
            return;
        }

        // Extract page ID
        let pageId = input.trim();
        if (input.startsWith('http')) {
            const extractedId = ConfluenceClient.extractPageIdFromUrl(input);
            if (!extractedId) {
                vscode.window.showErrorMessage('Could not extract page ID from URL');
                return;
            }
            pageId = extractedId;
        }

        logger.info(`Processing Confluence page: ${pageId}`);

        const workspaceRoot = FileUtils.getWorkspaceRoot();
        if (!workspaceRoot) {throw new Error('No workspace folder is open');}

        // Step 2: Get Confluence credentials
        const baseUrl = ConfigManager.getConfluenceBaseUrl();
        const email = ConfigManager.getConfluenceEmail();
        const apiToken = await ConfigManager.getConfluenceApiToken(context);
        secretToken = apiToken;
        const authType = vscode.workspace.getConfiguration('karateDsl.confluence').get<'basic' | 'bearer'>('authType', 'basic');

        // Step 3: Optional contract link, then fetch and generate
        const contract = await pickContract();
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Generating Karate tests from Confluence',
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 30, message: 'Fetching Confluence page...' });
            const client = new ConfluenceClient(baseUrl, email || "", apiToken, authType);
            const page = await client.getPageById(pageId);

            progress.report({ increment: 20, message: 'Parsing page content...' });
            const testData = new ConfluenceParser().parsePageContent(page);
            const items = confluenceRequirementItems({ id: String(page.id ?? pageId), title: page.title }, testData);
            const pageContent = page.body.storage?.value || page.body.view?.value || '';

            const { build, run } = await runRequirementsGeneration({
                context, workspaceRoot, items, contract,
                name: slug(page.title) || `page-${pageId}`,
                mode: 'confluence', sourceRef: `Confluence page ${pageId}`,
                useAi: vscode.workspace.getConfiguration('karateDsl').get<boolean>('useCopilot', false),
                evidenceLabel: `Confluence: ${page.title}`, evidenceText: pageContent,
                progress: toIncrementalProgress(progress, { from: 50, to: 100 })
            });
            if (!run) {
                vscode.window.showWarningMessage(`No test cases or flows found in Confluence page. ${build.warnings.join('; ')}`.trim());
                return;
            }
            logger.info(`Generated Confluence tests: ${run.createdPaths.join(', ') || '(none)'}`);
            void reportSummary(run.summary, `Confluence: ${page.title}`, run.createdPaths[0]);
        });

    } catch (error) {
        // HTTP client errors can carry the base URL or token; mask both before logging or showing the message.
        const message = safeMessage(error, [secretToken, ConfigManager.getConfluenceBaseUrl()]);
        logger.error('Failed to generate tests from Confluence', new Error(message));
        vscode.window.showErrorMessage(`Failed to generate tests: ${message}`);
    }
}
