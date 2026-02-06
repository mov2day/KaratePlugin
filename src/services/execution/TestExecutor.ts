import * as vscode from 'vscode';
import * as path from 'path';
import { TestExecutionOptions, TestExecutionResult } from '../../types';
import { BuildToolExecutor, BuildToolConfig } from './BuildToolExecutor';
import { KarateCliExecutor } from './KarateCliExecutor';
import { ResultParser } from './ResultParser';
import { logger } from '../../utils/logger';

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

        try {
            // Determine working directory
            const workingDirectory = options.workingDirectory || this.getWorkspaceRoot();
            if (!workingDirectory) {
                throw new Error('No workspace folder found. Please open a workspace.');
            }

            // Execute tests based on build tool preference
            let success = false;
            let output = '';

            if (options.buildTool === 'cli') {
                // Use direct CLI execution
                ({ success, output } = await KarateCliExecutor.execute(
                    { ...options, workingDirectory },
                    this.extensionPath,
                    cancellationToken
                ));
            } else {
                // Try to detect and use build tool
                const buildConfig = BuildToolExecutor.detectBuildTool(workingDirectory);

                if (buildConfig) {
                    const preferredTool = options.buildTool || buildConfig.toolType;

                    if (preferredTool === 'maven' && buildConfig.toolType === 'maven') {
                        ({ success, output } = await BuildToolExecutor.executeMaven(
                            { ...options, workingDirectory },
                            buildConfig,
                            cancellationToken
                        ));
                    } else if (preferredTool === 'gradle' && buildConfig.toolType === 'gradle') {
                        ({ success, output } = await BuildToolExecutor.executeGradle(
                            { ...options, workingDirectory },
                            buildConfig,
                            cancellationToken
                        ));
                    } else {
                        // Fallback to CLI if preferred tool doesn't match detected
                        ({ success, output } = await KarateCliExecutor.execute(
                            { ...options, workingDirectory },
                            this.extensionPath,
                            cancellationToken
                        ));
                    }
                } else {
                    // No build tool found, use CLI
                    logger.info('No build tool detected, using Karate CLI');
                    ({ success, output } = await KarateCliExecutor.execute(
                        { ...options, workingDirectory },
                        this.extensionPath,
                        cancellationToken
                    ));
                }
            }

            // Parse results - findReportDirectory now recursively searches for karate-summary.json
            const reportDir = ResultParser.findReportDirectory(workingDirectory);
            logger.info(`Report directory found: ${reportDir}`);
            console.log(`[TestExecutor] Report directory: ${reportDir}`);

            if (!reportDir) {
                logger.warn('Could not find karate-summary.json in target or build directories');
                return this.createErrorResult(executionId, startTime, options, 'Report file not found. Test may have failed to execute.');
            }

            const summaryFile = ResultParser.findSummaryFile(reportDir);
            logger.info(`Summary file: ${summaryFile}`);
            console.log(`[TestExecutor] Summary file: ${summaryFile}`);

            if (!summaryFile) {
                logger.warn('Report directory found but karate-summary.json is missing');
                return this.createErrorResult(executionId, startTime, options, 'Summary file not found in report directory');
            }

            // Parse the summary
            const parsedResult = ResultParser.parseKarateSummary(summaryFile, workingDirectory);

            // Build final result
            const duration = Date.now() - startTime;
            const result: TestExecutionResult = {
                id: executionId,
                timestamp: startTime,
                options,
                summary: parsedResult.summary!,
                features: parsedResult.features!,
                duration,
                status: parsedResult.status!
            };

            logger.info(`Test execution completed: ${result.status}`);
            logger.info(`Summary: ${result.summary.passed} passed, ${result.summary.failed} failed, ${result.summary.skipped} skipped`);

            return result;

        } catch (error) {
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
        return `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Get workspace root directory
     */
    private getWorkspaceRoot(): string | undefined {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            return workspaceFolders[0].uri.fsPath;
        }
        return undefined;
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
