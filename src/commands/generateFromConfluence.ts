import * as vscode from 'vscode';
import * as path from 'path';
import { ConfluenceClient } from '../services/confluenceClient';
import { ConfluenceParser } from '../services/confluenceParser';
import { KarateGenerator } from '../services/karateGenerator';
import { ConfigManager } from '../utils/configManager';
import { FileUtils } from '../utils/fileUtils';
import { logger } from '../utils/logger';
import { KarateScenario, KarateStep } from '../types';

export async function generateFromConfluence(context: vscode.ExtensionContext): Promise<void> {
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

        // Step 2: Get Confluence credentials
        const baseUrl = ConfigManager.getConfluenceBaseUrl();
        const email = ConfigManager.getConfluenceEmail();
        const apiToken = await ConfigManager.getConfluenceApiToken(context);

        // Step 3: Fetch and parse page
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Generating Karate tests from Confluence',
            cancellable: false
        }, async (progress) => {
            // Fetch page
            progress.report({ increment: 30, message: 'Fetching Confluence page...' });
            const client = new ConfluenceClient(baseUrl, email, apiToken);
            const page = await client.getPageById(pageId);

            // Parse page content
            progress.report({ increment: 30, message: 'Parsing page content...' });
            const parser = new ConfluenceParser();
            const testData = parser.parsePageContent(page);

            // Generate Karate tests
            progress.report({ increment: 25, message: 'Generating Karate tests...' });
            const scenarios: KarateScenario[] = [];

            // Generate scenarios from test cases
            for (const testCase of testData.testCases) {
                const steps: KarateStep[] = [];

                // Convert test case steps to Karate steps
                for (let i = 0; i < testCase.steps.length; i++) {
                    steps.push({
                        keyword: i === 0 ? 'Given' : 'And',
                        text: `# ${testCase.steps[i]}`
                    });
                }

                // Add placeholder for actual API call
                steps.push({
                    keyword: 'When',
                    text: 'method get # TODO: Replace with actual API call'
                });

                // Add expected result
                if (testCase.expectedResult) {
                    steps.push({
                        keyword: 'Then',
                        text: `# Expected: ${testCase.expectedResult}`
                    });
                }

                scenarios.push({
                    name: testCase.name,
                    description: testCase.description,
                    steps
                });
            }

            // Generate scenarios from flow steps
            if (testData.flowSteps.length > 0 && scenarios.length === 0) {
                const steps: KarateStep[] = testData.flowSteps.map((step, i) => ({
                    keyword: i === 0 ? 'Given' : 'And',
                    text: `# ${step}`
                }));

                scenarios.push({
                    name: 'Flow from Confluence',
                    steps
                });
            }

            if (scenarios.length === 0) {
                vscode.window.showWarningMessage('No test cases or flows found in Confluence page');
                return;
            }

            // Create feature
            const generator = new KarateGenerator();
            const feature = {
                name: page.title,
                description: `Test scenarios from Confluence page ${pageId}`,
                scenarios
            };

            let featureContent = generator.featureToString(feature);

            // Optionally enhance with Copilot
            const config = vscode.workspace.getConfiguration('karateDsl');
            const useCopilot = config.get<boolean>('useCopilot', false);

            if (useCopilot) {
                progress.report({ increment: 5, message: 'Enhancing with GitHub Copilot...' });

                const { CopilotService } = await import('../services/copilotService');
                const isAvailable = await CopilotService.isCopilotAvailable();

                if (isAvailable) {
                    try {
                        const context = `Confluence page: ${page.title}, ${scenarios.length} scenarios`;

                        // Prepare full Confluence context
                        const confluenceContent = page.body.storage?.value || page.body.view?.value || '';

                        featureContent = await CopilotService.enhanceKarateTestComprehensive(
                            featureContent,
                            context,
                            {
                                type: 'confluence',
                                confluencePage: confluenceContent,
                                requirements: testData.requirements
                            }
                        );
                        logger.info('Enhanced tests with Copilot using full Confluence context');
                    } catch (error) {
                        logger.warn('Copilot enhancement failed, using original tests', error as Error);
                    }
                }
            }

            // Save file
            progress.report({ increment: 10, message: 'Saving feature file...' });
            const outputPath = FileUtils.resolveOutputPath();
            const sanitizedTitle = page.title.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
            const outputFile = path.join(outputPath, `${sanitizedTitle}.feature`);
            const uniqueFile = FileUtils.getUniqueFilename(outputFile);

            FileUtils.writeFile(uniqueFile, featureContent);

            // Show success
            const openFile = 'Open File';
            const result = await vscode.window.showInformationMessage(
                `Generated Karate tests: ${path.basename(uniqueFile)} (${scenarios.length} scenarios)`,
                openFile
            );

            if (result === openFile) {
                const doc = await vscode.workspace.openTextDocument(uniqueFile);
                await vscode.window.showTextDocument(doc);
            }

            logger.info(`Successfully generated tests from Confluence: ${uniqueFile}`);
        });

    } catch (error) {
        logger.error('Failed to generate tests from Confluence', error as Error);
        vscode.window.showErrorMessage(`Failed to generate tests: ${(error as Error).message}`);
    }
}
