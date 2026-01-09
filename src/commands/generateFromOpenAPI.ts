import * as vscode from 'vscode';
import * as path from 'path';
import { OpenAPIParser } from '../services/openApiParser';
import { KarateGenerator } from '../services/karateGenerator';
import { FileUtils } from '../utils/fileUtils';
import { logger } from '../utils/logger';

export async function generateFromOpenAPI(context: vscode.ExtensionContext): Promise<void> {
    try {
        // Step 1: Select OpenAPI spec file
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
        logger.info(`Selected OpenAPI spec: ${specPath}`);

        // Step 2: Show progress
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Generating Karate tests from OpenAPI',
            cancellable: false
        }, async (progress) => {
            // Parse OpenAPI spec
            progress.report({ increment: 30, message: 'Parsing OpenAPI specification...' });
            const parser = new OpenAPIParser();
            const endpoints = await parser.parseSpec(specPath);

            if (endpoints.length === 0) {
                vscode.window.showWarningMessage('No endpoints found in OpenAPI specification');
                return;
            }

            // Generate Karate tests
            progress.report({ increment: 35, message: 'Generating Karate feature files...' });
            const generator = new KarateGenerator();

            const specFileName = path.basename(specPath, path.extname(specPath));
            const feature = generator.generateFromOpenAPI(endpoints, specFileName);

            // Add background
            feature.background = generator.generateBackground();

            // Convert to string
            const featureContent = generator.featureToString(feature);

            // Step 4: Optionally enhance with Copilot
            let finalContent = featureContent;
            const config = vscode.workspace.getConfiguration('karateDsl');
            const useCopilot = config.get<boolean>('useCopilot', false);

            if (useCopilot) {
                progress.report({ increment: 20, message: 'Enhancing with GitHub Copilot...' });

                const { CopilotService } = await import('../services/copilotService');
                const isAvailable = await CopilotService.isCopilotAvailable();

                if (isAvailable) {
                    try {
                        const context = `OpenAPI spec: ${specFileName}, ${endpoints.length} endpoints`;

                        // Read full OpenAPI spec content to send to Copilot
                        const fs = await import('fs');
                        const fullSpecContent = fs.readFileSync(specPath, 'utf-8');

                        finalContent = await CopilotService.enhanceKarateTestComprehensive(
                            featureContent,
                            context,
                            {
                                type: 'openapi',
                                openApiSpec: fullSpecContent
                            }
                        );
                        logger.info('Enhanced tests with Copilot using full OpenAPI context');
                    } catch (error) {
                        logger.warn('Copilot enhancement failed, using original tests', error as Error);
                        vscode.window.showWarningMessage('Copilot enhancement failed. Using original tests.');
                    }
                } else {
                    vscode.window.showWarningMessage('GitHub Copilot is not available. Please check your subscription.');
                }
            }

            // Step 5: Save to file
            progress.report({ increment: 5, message: 'Saving feature file...' });
            const outputPath = FileUtils.resolveOutputPath();
            const outputFile = path.join(outputPath, `${specFileName}.feature`);
            const uniqueFile = FileUtils.getUniqueFilename(outputFile);

            FileUtils.writeFile(uniqueFile, finalContent);

            progress.report({ increment: 10, message: 'Done!' });

            // Show success message
            const openFile = 'Open File';
            const result = await vscode.window.showInformationMessage(
                `Generated Karate tests: ${path.basename(uniqueFile)} (${endpoints.length} scenarios)`,
                openFile
            );

            if (result === openFile) {
                const doc = await vscode.workspace.openTextDocument(uniqueFile);
                await vscode.window.showTextDocument(doc);
            }

            logger.info(`Successfully generated Karate tests: ${uniqueFile}`);
        });

    } catch (error) {
        logger.error('Failed to generate tests from OpenAPI', error as Error);
        vscode.window.showErrorMessage(`Failed to generate tests: ${(error as Error).message}`);
    }
}
