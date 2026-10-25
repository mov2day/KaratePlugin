import * as vscode from 'vscode';
import * as path from 'path';
import { OpenAPIParser } from '../services/openApiParser';
import { FileUtils } from '../utils/fileUtils';
import { logger } from '../utils/logger';
import { reportSummary } from '../generation/vscode/reportSummary';
import { runGenerationForModel, toIncrementalProgress } from '../generation/vscode/runGeneration';

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

        const workspaceRoot = FileUtils.getWorkspaceRoot();
        if (!workspaceRoot) {
            throw new Error('No workspace folder is open');
        }

        // Step 2: Show progress
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Generating Karate tests from OpenAPI',
            cancellable: false
        }, async (progress) => {
            progress.report({ message: 'Parsing OpenAPI specification...' });
            const model = await new OpenAPIParser().parseModel(specPath);

            if (model.operations.length === 0) {
                vscode.window.showWarningMessage('No endpoints found in OpenAPI specification');
                return;
            }

            const useAi = vscode.workspace.getConfiguration('karateDsl').get<boolean>('useCopilot', false);
            const run = await runGenerationForModel({
                context, workspaceRoot, model, sourceRef: path.basename(specPath), mode: 'openapi', useAi,
                progress: toIncrementalProgress(progress)
            });

            logger.info(`Generated Karate tests: ${run.createdPaths.join(', ') || '(none)'}`);
            void reportSummary(run.summary, `OpenAPI: ${path.basename(specPath)}`, run.createdPaths[0]);
        });

    } catch (error) {
        logger.error('Failed to generate tests from OpenAPI', error as Error);
        vscode.window.showErrorMessage(`Failed to generate tests: ${(error as Error).message}`);
    }
}
