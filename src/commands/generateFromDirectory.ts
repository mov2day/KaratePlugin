import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../utils/logger';
import { OpenAPIParser } from '../services/openApiParser';
import { FileUtils } from '../utils/fileUtils';
import type { GenerationModel } from '../generation/model/TestModel';
import { planOpenApi } from '../generation/plan/OpenApiPlanner';
import { formatSummary, mergeResults } from '../generation/pipeline/Summary';
import type { GenerationSummary } from '../generation/pipeline/Summary';
import type { PipelineResult } from '../generation/pipeline/GenerationPipeline';
import { GeneratorConfigLoader } from '../generation/vscode/GeneratorConfigLoader';
import { reportSummary } from '../generation/vscode/reportSummary';
import { runGenerationForModel, toIncrementalProgress } from '../generation/vscode/runGeneration';

/**
 * Batch generation command — generates tests for all OpenAPI specs in a folder.
 */
export async function generateFromDirectory(folderUri: vscode.Uri, context: vscode.ExtensionContext): Promise<void> {
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

            const workspaceRoot = FileUtils.getWorkspaceRoot();
            if (!workspaceRoot) {
                vscode.window.showErrorMessage('No workspace folder is open.');
                return;
            }

            const parser = new OpenAPIParser();
            const loaded = await GeneratorConfigLoader.load(workspaceRoot);
            for (const w of loaded.warnings) { logger.warn(`Generator config: ${w}`); }
            const useAi = vscode.workspace.getConfiguration('karateDsl').get<boolean>('useCopilot', false);

            // Parse every spec first so colliding feature paths (two specs sharing a tag) can be separated.
            const failures: { file: string; error: string }[] = [];
            const parsed: { specFile: string; baseName: string; specName: string; model: GenerationModel }[] = [];
            for (const specFile of specFiles) {
                if (token.isCancellationRequested) { break; }
                const baseName = path.basename(specFile);
                try {
                    const model = await parser.parseModel(specFile);
                    parsed.push({ specFile, baseName, specName: path.basename(specFile, path.extname(specFile)), model });
                } catch (error: any) {
                    failures.push({ file: baseName, error: error.message });
                    logger.warn(`Batch generation: skipped ${baseName} — ${error.message}`);
                }
            }

            const owners = new Map<string, number>();
            const plannedPaths = parsed.map(p => planOpenApi(p.model, loaded.config).features.map(f => f.relativePath));
            plannedPaths.forEach(paths => new Set(paths).forEach(rel => owners.set(rel, (owners.get(rel) ?? 0) + 1)));
            const colliding = parsed.map((_, idx) => plannedPaths[idx].some(rel => (owners.get(rel) ?? 0) > 1));

            const results: PipelineResult[] = [];
            const succeeded: string[] = [];
            const increment = 80 / Math.max(1, parsed.length);

            for (let i = 0; i < parsed.length; i++) {
                if (token.isCancellationRequested) { break; }
                const spec = parsed[i];
                progress.report({ increment: 0, message: `Processing ${spec.baseName} (${i + 1}/${parsed.length})` });
                try {
                    const config = colliding[i]
                        ? { ...loaded.config, layout: { ...loaded.config.layout, outputRoot: `${loaded.config.layout.outputRoot}/${spec.specName}` } }
                        : loaded.config;
                    // Config discovery is shared; scaffold files are written once and later runs keep the existing ones.
                    const run = await runGenerationForModel({
                        context, workspaceRoot, model: spec.model, sourceRef: spec.baseName, mode: 'openapi', useAi,
                        config, progress: toIncrementalProgress(progress, { from: 0, to: increment })
                    });
                    results.push(run);
                    succeeded.push(spec.baseName);
                    logger.info(`Batch generation: ${spec.baseName} → ${run.createdPaths.length} feature file(s)`);
                } catch (error: any) {
                    failures.push({ file: spec.baseName, error: error.message });
                    logger.warn(`Batch generation: skipped ${spec.baseName} — ${error.message}`);
                }
            }

            const base = formatSummary(mergeResults(results));
            const details = [...base.details];
            if (colliding.some(Boolean)) {
                details.push('Note: specs that share feature paths were written to per-spec sub-folders');
            }
            if (failures.length > 0) {
                details.push(`Skipped specs (${failures.length})`);
                for (const f of failures) { details.push(`  ${f.file}: ${f.error}`); }
            }
            const summary: GenerationSummary = {
                headline: `${succeeded.length} of ${specFiles.length} spec(s) processed: ${base.headline}${failures.length ? `; ${failures.length} skipped` : ''}`,
                details,
                level: failures.length > 0 ? 'warning' : base.level
            };
            void reportSummary(summary, `Batch: ${path.basename(folderPath)}`);
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
