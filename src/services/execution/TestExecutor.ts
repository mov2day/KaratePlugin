import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { TestExecutionOptions, TestExecutionResult } from '../../types';
import { BuildToolExecutor } from './BuildToolExecutor';
import { KarateCliExecutor } from './KarateCliExecutor';
import { ResultParser } from './ResultParser';
import { logger } from '../../utils/logger';
import { ProjectExecutionResolver } from './ProjectExecutionResolver';
import { readExecutionSettings } from './ExecutionSettings';
import { ProcessResult } from './ProcessRunner';
import { ConfigDiscovery } from './ConfigDiscovery';

/**
 * Main orchestrator for Karate test execution
 * Coordinates different execution modes and parsers
 */
export class TestExecutor {
    constructor(private extensionPath: string) { }

    /**
     * Execute Karate tests based on options
     */
    async execute(
        options: TestExecutionOptions,
        cancellationToken?: vscode.CancellationToken
    ): Promise<TestExecutionResult> {
        const executionId = this.generateExecutionId();
        const startTime = Date.now();

        logger.info(`Starting test execution: ${executionId}`);
        logger.info(`Execution type: ${options.type}`);
        logger.info(`Target: ${JSON.stringify(options.target)}`);
        logger.info(`Build tool: ${options.buildTool}`);

        try {
            const workspaceRoot = options.workingDirectory || this.getWorkspaceRoot(options);
            if (!workspaceRoot) {
                throw new Error('No workspace folder found. Please open a workspace.');
            }
            const settings = readExecutionSettings(this.getSettingsScope(options, workspaceRoot));
            let project = ProjectExecutionResolver.resolve(options, workspaceRoot, settings);
            const requestedStrategy = options.buildTool || settings.defaultBuildTool || 'auto';
            const runnerCount = project.strategy === 'cli' ? 0 : ConfigDiscovery.findRunnerClasses(project.projectRoot).length;
            const runnableProject = ProjectExecutionResolver.chooseRunnableStrategy(project, requestedStrategy, runnerCount);
            if (project.strategy !== runnableProject.strategy) {
                logger.info(`No Karate Java runner found in ${project.projectRoot}; using standalone CLI.`);
            }
            project = runnableProject;
            const resolvedOptions: TestExecutionOptions = {
                ...options,
                buildTool: project.strategy,
                workingDirectory: project.projectRoot,
                runnerClass: project.runnerClass,
                runnerMethod: project.runnerMethod,
                configDir: project.configDir
            };
            const outputDirectory = path.join(project.projectRoot, 'target', 'karate-plugin-runs', executionId);
            fs.mkdirSync(outputDirectory, { recursive: true });
            let processResult: ProcessResult;
            if (project.strategy === 'cli') {
                processResult = await KarateCliExecutor.execute(resolvedOptions, this.extensionPath, project, settings, outputDirectory, cancellationToken);
            } else {
                const plan = project.strategy === 'maven'
                    ? BuildToolExecutor.buildMavenPlan(resolvedOptions, project, settings, outputDirectory)
                    : BuildToolExecutor.buildGradlePlan(resolvedOptions, project, settings, outputDirectory);
                processResult = await BuildToolExecutor.execute(plan, cancellationToken);
            }

            let reportDir = ResultParser.findReportDirectory(outputDirectory, startTime);
            if (!reportDir && project.strategy !== 'cli') {
                // Custom runners may choose their own output directory or a Gradle
                // build may not forward karate.output.dir. Accept only a report
                // created after this process began, never an older workspace report.
                reportDir = ResultParser.findReportDirectory(project.projectRoot, startTime);
            }
            logger.info(`Report directory found: ${reportDir}`);

            if (!reportDir) {
                const detail = this.outputTail(processResult.output);
                return this.createErrorResult(executionId, startTime, resolvedOptions, `Karate did not produce a report${processResult.exitCode === null ? '' : ` (exit ${processResult.exitCode})`}.${detail}`);
            }

            const summaryFile = ResultParser.findSummaryFile(reportDir);
            logger.info(`Summary file: ${summaryFile}`);

            if (!summaryFile) {
                logger.warn('Report directory found but karate-summary.json is missing');
                return this.createErrorResult(executionId, startTime, resolvedOptions, 'Summary file not found in this execution report directory');
            }

            // Parse the summary
            const parsedResult = ResultParser.parseKarateSummary(summaryFile, project.projectRoot);
            if (parsedResult.summary!.totalScenarios === 0) {
                return this.createErrorResult(executionId, startTime, resolvedOptions, 'No scenarios matched the selected feature, line, folder, or tags.');
            }
            if (!processResult.success && parsedResult.status === 'success') {
                return this.createErrorResult(executionId, startTime, resolvedOptions, `The ${project.strategy} process failed even though its report contained no failed scenario.${this.outputTail(processResult.output)}`);
            }

            // Build final result
            const duration = Date.now() - startTime;
            const result: TestExecutionResult = {
                id: executionId,
                timestamp: startTime,
                options: resolvedOptions,
                summary: parsedResult.summary!,
                features: parsedResult.features!,
                duration,
                status: parsedResult.status!
            };

            logger.info(`Test execution completed: ${result.status}`);
            logger.info(`Summary: ${result.summary.passed} passed, ${result.summary.failed} failed, ${result.summary.skipped} skipped`);

            return result;

        } catch (error) {
            if (error instanceof vscode.CancellationError) throw error;
            logger.error('Test execution failed', error as Error);

            // Provide more specific error messages
            let errorMessage = (error as Error).message;

            if (errorMessage.includes('ENOENT') && errorMessage.includes('java')) {
                errorMessage = 'Java is not installed or not in PATH. Please install Java 8+ to run Karate tests.';
                vscode.window.showErrorMessage(errorMessage, 'Learn More').then(selection => {
                    if (selection === 'Learn More') {
                        vscode.env.openExternal(vscode.Uri.parse('https://www.java.com/en/download/'));
                    }
                });
            } else if (errorMessage.includes('No workspace folder')) {
                vscode.window.showErrorMessage(errorMessage);
            } else if (errorMessage.includes('cancelled')) {
                vscode.window.showInformationMessage('Test execution cancelled by user');
            } else if (errorMessage.includes('download')) {
                // JAR download error - already shown in KarateCliExecutor
            } else {
                // Generic error
                vscode.window.showErrorMessage(`Test execution failed: ${errorMessage}`, 'View Logs').then(selection => {
                    if (selection === 'View Logs') {
                        logger.show();
                    }
                });
            }

            return this.createErrorResult(
                executionId,
                startTime,
                options,
                errorMessage
            );
        }
    }

    /**
     * Generate unique execution ID
     */
    private generateExecutionId(): string {
        // Run IDs become entity filenames in .karate-test-management/runs.
        // UUIDs avoid same-name collisions across offline Git branches.
        return randomUUID();
    }

    /**
     * Get workspace root directory
     */
    private getWorkspaceRoot(options?: TestExecutionOptions): string | undefined {
        const target = options && (Array.isArray(options.target) ? options.target[0] : options.target);
        if (target) {
            const legacyPath = target.replace(/:(\d+)$/, '');
            const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(legacyPath));
            if (folder) return folder.uri.fsPath;
        }
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            return workspaceFolders[0].uri.fsPath;
        }
        return undefined;
    }

    private getSettingsScope(options: TestExecutionOptions, workspaceRoot: string): string {
        const target = Array.isArray(options.target) ? options.target[0] : options.target;
        return target ? target.replace(/:(\d+)$/, '') : workspaceRoot;
    }

    private outputTail(output: string): string {
        const lines = output.trim().split(/\r?\n/).filter(Boolean).slice(-12);
        return lines.length ? `\n${lines.join('\n')}` : '';
    }

    /**
     * Create an error result
     */
    private createErrorResult(
        id: string,
        timestamp: number,
        options: TestExecutionOptions,
        error: string
    ): TestExecutionResult {
        return {
            id,
            timestamp,
            options,
            summary: {
                totalFeatures: 0,
                totalScenarios: 0,
                passed: 0,
                failed: 0,
                skipped: 0,
                passPercentage: 0,
                executionTime: '0s'
            },
            features: [],
            duration: Date.now() - timestamp,
            status: 'error',
            error
        };
    }

    /**
     * Validate execution options
     */
    static validateOptions(options: TestExecutionOptions): { valid: boolean; error?: string } {
        if (!options.type) {
            return { valid: false, error: 'Execution type is required' };
        }

        if (!options.target) {
            return { valid: false, error: 'Target is required' };
        }

        if (options.type === 'tags' && (!options.tags || options.tags.length === 0)) {
            return { valid: false, error: 'Tags are required for tag-based execution' };
        }

        return { valid: true };
    }
}
