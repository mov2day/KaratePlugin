import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../utils/logger';
import { SharedStyleService } from '../services/SharedStyleService';

/**
 * Batch generation command — generates tests for all OpenAPI specs in a folder.
 */
export async function generateFromDirectory(folderUri: vscode.Uri): Promise<void> {
    if (!folderUri) {
        return;
    }

    const folderPath = folderUri.fsPath;

    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Batch Test Generation',
            cancellable: true
        }, async (progress, token) => {
            progress.report({ increment: 0, message: 'Scanning for OpenAPI specs...' });

            // Recursively find spec files
            const specFiles = findSpecFiles(folderPath);
            if (specFiles.length === 0) {
                vscode.window.showWarningMessage('No OpenAPI spec files (.json, .yaml, .yml) found in folder.');
                return;
            }

            progress.report({ increment: 10, message: `Found ${specFiles.length} files. Validating...` });

            // Import dependencies
            const { OpenAPIParser } = await import('../services/openApiParser');
            const { KarateGenerator } = await import('../services/karateGenerator');
            const { FileUtils } = await import('../utils/fileUtils');

            const parser = new OpenAPIParser();
            const generator = new KarateGenerator();
            const sharedStyle = SharedStyleService.loadSharedStyle();
            if (sharedStyle) {
                generator.setStyle(sharedStyle);
            }

            const results: { file: string; success: boolean; scenarios: number; error?: string }[] = [];
            const increment = 80 / specFiles.length;

            for (let i = 0; i < specFiles.length; i++) {
                if (token.isCancellationRequested) {
                    break;
                }

                const specFile = specFiles[i];
                const baseName = path.basename(specFile);
                progress.report({
                    increment,
                    message: `Processing ${baseName} (${i + 1}/${specFiles.length})`
                });

                try {
                    // Validate spec
                    const SwaggerParser = require('@apidevtools/swagger-parser');
                    await SwaggerParser.validate(specFile);

                    // Parse and generate
                    const endpoints = await parser.parseSpec(specFile);
                    const specFileName = path.basename(specFile, path.extname(specFile));
                    const feature = generator.generateFromOpenAPI(endpoints, specFileName);
                    feature.background = generator.generateBackground();
                    const featureContent = generator.featureToString(feature);

                    // Save file
                    const outputPath = FileUtils.resolveOutputPath();
                    const outputFile = path.join(outputPath, `${specFileName}.feature`);
                    const uniqueFile = FileUtils.getUniqueFilename(outputFile);
                    FileUtils.writeFile(uniqueFile, featureContent);

                    results.push({ file: baseName, success: true, scenarios: endpoints.length });
                    logger.info(`Batch generation: ${baseName} → ${endpoints.length} scenarios`);

                } catch (error: any) {
                    results.push({ file: baseName, success: false, scenarios: 0, error: error.message });
                    logger.warn(`Batch generation: skipped ${baseName} — ${error.message}`);
                }
            }

            // Show summary
            const succeeded = results.filter(r => r.success);
            const failed = results.filter(r => !r.success);
            const totalScenarios = succeeded.reduce((sum, r) => sum + r.scenarios, 0);

            let message = `✅ Generated ${totalScenarios} scenarios from ${succeeded.length} spec(s)`;
            if (failed.length > 0) {
                message += ` | ⚠️ ${failed.length} file(s) skipped`;
            }

            const action = await vscode.window.showInformationMessage(
                message,
                'Show Details',
                'Dismiss'
            );

            if (action === 'Show Details') {
                const details = results.map(r =>
                    r.success
                        ? `✅ ${r.file}: ${r.scenarios} scenarios`
                        : `❌ ${r.file}: ${r.error}`
                ).join('\n');

                const doc = await vscode.workspace.openTextDocument({
                    content: `# Batch Generation Report\n\n${details}`,
                    language: 'markdown'
                });
                await vscode.window.showTextDocument(doc);
            }
        });
    } catch (error) {
        logger.error('Batch generation failed', error as Error);
        vscode.window.showErrorMessage(`Batch generation failed: ${error}`);
    }
}

/**
 * Recursively find .json, .yaml, .yml files in a directory.
 */
function findSpecFiles(dir: string): string[] {
    const files: string[] = [];
    const extensions = ['.json', '.yaml', '.yml'];

    function walk(currentDir: string): void {
        try {
            const entries = fs.readdirSync(currentDir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(currentDir, entry.name);
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    walk(fullPath);
                } else if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) {
                    files.push(fullPath);
                }
            }
        } catch {
            // Skip inaccessible directories
        }
    }

    walk(dir);
    return files;
}
