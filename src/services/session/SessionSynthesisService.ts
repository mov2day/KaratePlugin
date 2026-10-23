import * as vscode from 'vscode';
import * as path from 'path';
import { buildHarModel, redactedCaptureText } from '../../generation/adapters/har';
import { GeneratorConfigLoader } from '../../generation/vscode/GeneratorConfigLoader';
import { runGenerationForModel } from '../../generation/vscode/runGeneration';
import { writeSummaryDetails } from '../../generation/vscode/reportSummary';
import { FileUtils } from '../../utils/fileUtils';
import { logger } from '../../utils/logger';
import type { CapturedRequest } from './CapturedRequest';

export interface SynthesisOptions {
    /** Feature, scenario and file name stem (HAR file name, or the recording label). */
    name: string;
    /** 'har' for an imported HAR file, 'session' for a proxy recording. */
    mode: 'har' | 'session';
    useCopilot: boolean;
    /** Defaults to the `karateDsl.outputPath` setting. */
    outputDir?: string;
    allowedHosts?: string[];
    sourceRef: string;
}

export interface SynthesisResult {
    success: boolean;
    featuresCreated: number;
    warnings: string[];
    unsupportedFeatures: string[];
    createdFiles: string[];
}

/** Turns captured HTTP traffic (HAR import or proxy recording) into Karate features through the shared generation pipeline. */
export class SessionSynthesisService {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async synthesize(
        requests: CapturedRequest[],
        options: SynthesisOptions,
        token?: vscode.CancellationToken,
        progress?: (message: string, pct: number) => void
    ): Promise<SynthesisResult> {
        const result: SynthesisResult = { success: false, featuresCreated: 0, warnings: [], unsupportedFeatures: [], createdFiles: [] };
        const cancelled = (): boolean => token?.isCancellationRequested === true;
        try {
            const workspaceRoot = FileUtils.getWorkspaceRoot();
            if (!workspaceRoot) {throw new Error('No workspace folder is open');}

            const loaded = await GeneratorConfigLoader.load(workspaceRoot);
            for (const w of loaded.warnings) {logger.warn(`Generator config: ${w}`);}
            const config = loaded.config;

            const built = buildHarModel(requests, {
                config, name: options.name, mode: options.mode, allowedHosts: options.allowedHosts, sourceRef: options.sourceRef
            });
            result.warnings.push(...built.warnings);
            result.unsupportedFeatures = built.unsupported.map(u => `${u.sourceRef}: ${u.reason}`);
            if (built.features.length === 0) {
                result.warnings.push('No feature files were generated');
                return result;
            }
            if (cancelled()) {throw new vscode.CancellationError();}

            const outputDir = options.outputDir ?? FileUtils.resolveOutputPath();
            const rel = path.relative(workspaceRoot, outputDir);
            const outputRoot = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : outputDir;

            const run = await runGenerationForModel({
                context: this.context, workspaceRoot, model: built.model, sourceRef: options.sourceRef, mode: options.mode, useAi: options.useCopilot,
                scenarios: built.features, classpathFiles: built.files,
                // Credentials are removed before the capture is offered to the AI refiner as evidence.
                evidence: [{ label: 'recorded-traffic', text: redactedCaptureText(requests) }],
                config, outputRoot, progress: progress ?? (() => undefined)
            });

            writeSummaryDetails(run.summary, `${options.mode === 'har' ? 'HAR' : 'Session'}: ${options.sourceRef}`);
            result.createdFiles = run.createdPaths;
            result.featuresCreated = run.features.length;
            result.warnings.push(...run.warnings);
            if (run.summary.level === 'warning') {result.warnings.push(run.summary.headline);}
            const createdNew = run.features.filter(f => run.written.created.includes(f.path)).length;
            if (run.features.length > createdNew) {
                result.warnings.push(`${createdNew === 0 ? 'No new files: ' : ''}${run.features.length - createdNew} feature file(s) already existed and were refreshed or left unchanged`);
            }
            result.success = run.features.length > 0;
        } catch (error) {
            if (error instanceof vscode.CancellationError) {throw error;}
            logger.error('Failed to synthesize session', error as Error);
            result.warnings.push(`Synthesis failed: ${error}`);
        }
        return result;
    }
}
