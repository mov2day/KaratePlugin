import * as vscode from 'vscode';
import * as path from 'path';
import { OpenAPIParser } from '../services/openApiParser';
import { ConfluenceClient } from '../services/confluenceClient';
import { ConfluenceParser } from '../services/confluenceParser';
import { ConfigManager } from '../utils/configManager';
import { FileUtils } from '../utils/fileUtils';
import { logger } from '../utils/logger';
import { buildRequirementScenarios, confluenceRequirementItems } from '../generation/adapters/requirements';
import { requirementEvidence, safeMessage } from '../generation/vscode/RequirementsRun';
import { GeneratorConfigLoader } from '../generation/vscode/GeneratorConfigLoader';
import { reportSummary } from '../generation/vscode/reportSummary';
import { runGenerationForModel, toIncrementalProgress } from '../generation/vscode/runGeneration';

export async function generateCombined(context: vscode.ExtensionContext): Promise<void> {
    let secretToken: string | undefined;
    try {
        // Step 1: Select OpenAPI spec
        const fileUri = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Select OpenAPI Spec',
            filters: {
                'OpenAPI Spec': ['json', 'yaml', 'yml']
            }
        });

        if (!fileUri || fileUri.length === 0) {
            return;
        }

        const specPath = fileUri[0].fsPath;

        // Step 2: Get Confluence page
        const input = await vscode.window.showInputBox({
            prompt: 'Enter Confluence page URL or page ID',
            placeHolder: 'https://yourcompany.atlassian.net/wiki/spaces/SPACE/pages/123456 or 123456'
        });

        if (!input) {
            return;
        }

        let pageId = input.trim();
        if (input.startsWith('http')) {
            const extractedId = ConfluenceClient.extractPageIdFromUrl(input);
            if (!extractedId) {
                vscode.window.showErrorMessage('Could not extract page ID from URL');
                return;
            }
            pageId = extractedId;
        }

        const workspaceRoot = FileUtils.getWorkspaceRoot();
        if (!workspaceRoot) {
            throw new Error('No workspace folder is open');
        }

        // Step 3: Process both sources
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Generating combined Karate tests',
            cancellable: false
        }, async (progress) => {
            // Parse OpenAPI
            progress.report({ increment: 5, message: 'Parsing OpenAPI specification...' });
            const model = await new OpenAPIParser().parseModel(specPath);

            // Fetch Confluence page
            progress.report({ increment: 10, message: 'Fetching Confluence page...' });
            const baseUrl = ConfigManager.getConfluenceBaseUrl();
            const email = ConfigManager.getConfluenceEmail();
            const apiToken = await ConfigManager.getConfluenceApiToken(context);
            secretToken = apiToken;
            const authType = vscode.workspace.getConfiguration('karateDsl.confluence').get<'basic' | 'bearer'>('authType', 'basic');

            const confluenceClient = new ConfluenceClient(baseUrl, email || "", apiToken, authType);
            const page = await confluenceClient.getPageById(pageId);

            // Parse Confluence content
            progress.report({ increment: 5, message: 'Parsing Confluence content...' });
            const testData = new ConfluenceParser().parsePageContent(page);
            const specFileName = path.basename(specPath, path.extname(specPath));
            const loaded = await GeneratorConfigLoader.load(workspaceRoot);
            for (const w of loaded.warnings) {logger.warn(`Generator config: ${w}`);}
            const req = buildRequirementScenarios(confluenceRequirementItems({ id: String(page.id ?? pageId), title: page.title }, testData), { config: loaded.config, name: specFileName, model });
            const pageContent = page.body.storage?.value || page.body.view?.value || '';

            const useAi = vscode.workspace.getConfiguration('karateDsl').get<boolean>('useCopilot', false);
            const run = await runGenerationForModel({
                context, workspaceRoot, model, sourceRef: path.basename(specPath), mode: 'combined', useAi,
                extraFeatures: req.features.length > 0 ? req.features : undefined, classpathFiles: req.files, config: loaded.config, notes: req.warnings,
                evidence: requirementEvidence(`Confluence: ${page.title}`, pageContent),
                progress: toIncrementalProgress(progress, { from: 20, to: 100 })
            });

            logger.info(`Generated combined tests: ${run.createdPaths.join(', ') || '(none)'}`);
            void reportSummary(run.summary, `Combined: ${specFileName}`, run.createdPaths[0]);
        });

    } catch (error) {
        const message = safeMessage(error, [secretToken, ConfigManager.getConfluenceBaseUrl()]);
        logger.error('Failed to generate combined tests', new Error(message));
        vscode.window.showErrorMessage(`Failed to generate combined tests: ${message}`);
    }
}
