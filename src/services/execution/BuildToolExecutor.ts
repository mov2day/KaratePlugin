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
        const workingDir = options.workingDirectory || '';

        // Use ConfigDiscovery to find runner classes
        const { ConfigDiscovery } = await import('./ConfigDiscovery');
        const karateConfig = ConfigDiscovery.discover(workingDir);

        // If we have runner classes, use them with -Dtest parameter
        if (karateConfig.runnerClasses.length > 0) {
            // Use the best runner for the feature if executing a specific feature
            let runnerClass: string | undefined;

            if (options.type === 'feature' && typeof options.target === 'string') {
                runnerClass = ConfigDiscovery.getRunnerForFeature(workingDir, options.target);
            } else {
                // Use first available runner
                runnerClass = karateConfig.runnerClasses[0];
            }

            if (runnerClass) {
                args.push(`-Dtest=${runnerClass}`);
                logger.info(`Using Karate runner class: ${runnerClass}`);
            }
        }

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

        // Add user-configured parameters from settings
        const execConfig = vscode.workspace.getConfiguration('karateDsl.execution');

        // User system properties (take priority)
        const systemProperties = execConfig.get<Record<string, string>>('systemProperties', {});
        for (const [key, value] of Object.entries(systemProperties)) {
            args.push(`-D${key}=${value}`);
        }

        // Add environment only if user hasn't set karate.env in systemProperties
        if (options.environment && !systemProperties['karate.env']) {
            args.push(`-Dkarate.env=${options.environment}`);
        }

        // User JVM args (via -Dargline for Maven Surefire)
        const userJvmArgs = execConfig.get<string[]>('jvmArgs', []);
        if (userJvmArgs.length > 0) {
            args.push(`-DargLine=${userJvmArgs.join(' ')}`);
        }

        // User Karate args (append to karate.options)
        const userKarateArgs = execConfig.get<string[]>('karateArgs', []);
        if (userKarateArgs.length > 0) {
            args.push(...userKarateArgs);
        }

        logger.info(`Executing Maven: ${config.executable} ${args.join(' ')}`);

        return this.executeCommand(config.executable, args, workingDir, cancellationToken);
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
        const workingDir = options.workingDirectory || '';

        // Use ConfigDiscovery to find runner classes
        const { ConfigDiscovery } = await import('./ConfigDiscovery');
        const karateConfig = ConfigDiscovery.discover(workingDir);

        // If we have runner classes, use them with --tests parameter
        if (karateConfig.runnerClasses.length > 0) {
            let runnerClass: string | undefined;

            if (options.type === 'feature' && typeof options.target === 'string') {
                runnerClass = ConfigDiscovery.getRunnerForFeature(workingDir, options.target);
            } else {
                runnerClass = karateConfig.runnerClasses[0];
            }

            if (runnerClass) {
                args.push(`--tests`, runnerClass);
                logger.info(`Using Karate runner class: ${runnerClass}`);
            }
        }

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

        // Add user-configured parameters from settings
        const execConfig = vscode.workspace.getConfiguration('karateDsl.execution');

        // User system properties (take priority)
        const systemProperties = execConfig.get<Record<string, string>>('systemProperties', {});
        for (const [key, value] of Object.entries(systemProperties)) {
            args.push(`-D${key}=${value}`);
        }

        // Add environment only if user hasn't set karate.env in systemProperties
        if (options.environment && !systemProperties['karate.env']) {
            args.push(`-Dkarate.env=${options.environment}`);
        }

        // User JVM args
        const userJvmArgs = execConfig.get<string[]>('jvmArgs', []);
        if (userJvmArgs.length > 0) {
            args.push(`-DjvmArgs=${userJvmArgs.join(' ')}`);
        }

        // User Karate args
        const userKarateArgs = execConfig.get<string[]>('karateArgs', []);
        if (userKarateArgs.length > 0) {
            args.push(...userKarateArgs);
        }

        logger.info(`Executing Gradle: ${config.executable} ${args.join(' ')}`);

        return this.executeCommand(config.executable, args, workingDir, cancellationToken);
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
