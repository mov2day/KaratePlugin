import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { TestExecutionOptions, TestExecutionResult } from '../../types';
import { logger } from '../../utils/logger';

export interface BuildToolConfig {
    toolType: 'maven' | 'gradle';
    executable: string;
    buildFile: string;
}

/**
 * Executor for running Karate tests via build tools (Maven/Gradle)
 */
export class BuildToolExecutor {
    /**
     * Detect build tool in the workspace
     */
    static detectBuildTool(workingDirectory: string): BuildToolConfig | null {
        // Check for Maven
        const pomPath = path.join(workingDirectory, 'pom.xml');
        if (fs.existsSync(pomPath)) {
            return {
                toolType: 'maven',
                executable: this.getMavenExecutable(workingDirectory),
                buildFile: pomPath
            };
        }

        // Check for Gradle
        const gradlePaths = [
            path.join(workingDirectory, 'build.gradle'),
            path.join(workingDirectory, 'build.gradle.kts')
        ];

        for (const gradlePath of gradlePaths) {
            if (fs.existsSync(gradlePath)) {
                return {
                    toolType: 'gradle',
                    executable: this.getGradleExecutable(workingDirectory),
                    buildFile: gradlePath
                };
            }
        }

        return null;
    }

    /**
     * Get Maven executable (use wrapper if available)
     */
    private static getMavenExecutable(workingDirectory: string): string {
        const wrapperPath = path.join(workingDirectory, 'mvnw');
        if (fs.existsSync(wrapperPath)) {
            return './mvnw';
        }
        return 'mvn';
    }

    /**
     * Get Gradle executable (use wrapper if available)
     */
    private static getGradleExecutable(workingDirectory: string): string {
        const wrapperPath = path.join(workingDirectory, 'gradlew');
        if (fs.existsSync(wrapperPath)) {
            return './gradlew';
        }
        return 'gradle';
    }

    /**
     * Execute tests using Maven
     */
    static async executeMaven(
        options: TestExecutionOptions,
        config: BuildToolConfig,
        cancellationToken?: vscode.CancellationToken
    ): Promise<{ success: boolean; output: string }> {
        const args = ['test'];

        // Build Maven command based on execution type
        switch (options.type) {
            case 'feature':
            case 'features':
                // For specific features, use karate.options
                const features = Array.isArray(options.target) ? options.target : [options.target];
                const featurePaths = features.join(' ');
                args.push(`-Dkarate.options=${featurePaths}`);
                break;

            case 'tags':
                // Execute by tags
                if (options.tags && options.tags.length > 0) {
                    const tagFilter = options.tags.map(t => `@${t.replace(/^@/, '')}`).join(',');
                    args.push(`-Dkarate.options=--tags ${tagFilter}`);
                }
                break;

            case 'folder':
                // Execute all tests in folder (let Maven discover)
                break;

            case 'scenario':
                // For scenario, use karate line number selection
                const [featurePath, scenarioLine] = (options.target as string).split(':');
                args.push(`-Dkarate.options=${featurePath}:${scenarioLine}`);
                break;
        }

        // Add parallel threads if specified
        if (options.parallel && options.parallel > 1) {
            args.push(`-Dkarate.threads=${options.parallel}`);
        }

        // Add environment
        if (options.environment) {
            args.push(`-Dkarate.env=${options.environment}`);
        }

        logger.info(`Executing Maven: ${config.executable} ${args.join(' ')}`);

        return this.executeCommand(config.executable, args, options.workingDirectory || '', cancellationToken);
    }

    /**
     * Execute tests using Gradle
     */
    static async executeGradle(
        options: TestExecutionOptions,
        config: BuildToolConfig,
        cancellationToken?: vscode.CancellationToken
    ): Promise<{ success: boolean; output: string }> {
        const args = ['test'];

        // Build Gradle command based on execution type
        switch (options.type) {
            case 'feature':
            case 'features':
                const features = Array.isArray(options.target) ? options.target : [options.target];
                const featurePaths = features.join(' ');
                args.push(`-Dkarate.options=${featurePaths}`);
                break;

            case 'tags':
                if (options.tags && options.tags.length > 0) {
                    const tagFilter = options.tags.map(t => `@${t.replace(/^@/, '')}`).join(',');
                    args.push(`-Dkarate.options=--tags ${tagFilter}`);
                }
                break;

            case 'folder':
                // Let Gradle discover all tests
                break;

            case 'scenario':
                const [featurePath, scenarioLine] = (options.target as string).split(':');
                args.push(`-Dkarate.options=${featurePath}:${scenarioLine}`);
                break;
        }

        // Add parallel threads
        if (options.parallel && options.parallel > 1) {
            args.push(`-Dkarate.threads=${options.parallel}`);
        }

        // Add environment
        if (options.environment) {
            args.push(`-Dkarate.env=${options.environment}`);
        }

        logger.info(`Executing Gradle: ${config.executable} ${args.join(' ')}`);

        return this.executeCommand(config.executable, args, options.workingDirectory || '', cancellationToken);
    }

    /**
     * Execute build tool command
     */
    private static async executeCommand(
        executable: string,
        args: string[],
        cwd: string,
        cancellationToken?: vscode.CancellationToken
    ): Promise<{ success: boolean; output: string }> {
        return new Promise((resolve, reject) => {
            let output = '';
            let errorOutput = '';

            const process: ChildProcess = spawn(executable, args, {
                cwd,
                shell: true
            });

            // Handle cancellation
            if (cancellationToken) {
                cancellationToken.onCancellationRequested(() => {
                    process.kill();
                    reject(new Error('Test execution cancelled by user'));
                });
            }

            process.stdout?.on('data', (data) => {
                const text = data.toString();
                output += text;
                logger.info(text);
            });

            process.stderr?.on('data', (data) => {
                const text = data.toString();
                errorOutput += text;
                logger.error(text);
            });

            process.on('close', (code) => {
                const fullOutput = output + '\n' + errorOutput;

                if (code === 0) {
                    resolve({ success: true, output: fullOutput });
                } else {
                    // Non-zero exit code might still have results (failed tests)
                    resolve({ success: false, output: fullOutput });
                }
            });

            process.on('error', (error) => {
                logger.error('Build tool execution error', error);
                reject(error);
            });
        });
    }
}
