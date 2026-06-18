import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import { spawn, ChildProcess } from 'child_process';
import { TestExecutionOptions } from '../../types';
import { logger } from '../../utils/logger';

/**
 * Direct Karate CLI executor using standalone JAR
 */
interface KarateJarResolution {
    jarPath: string;
    version: string;
    bundled: boolean;
    customPath: boolean;
}

export class KarateCliExecutor {
    private static readonly BUNDLED_KARATE_VERSION = '1.5.0.RC3';

    /**
     * Get path to Karate standalone JAR
     */
    private static getJarPath(extensionPath: string, version: string): string {
        return path.join(extensionPath, 'lib', `karate-${version}.jar`);
    }

    private static resolveJar(extensionPath: string): KarateJarResolution {
        const config = vscode.workspace.getConfiguration('karateDsl.execution');
        const configuredPath = (config.get<string>('jarPath', '') || '').trim();
        if (configuredPath) {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath || extensionPath;
            const jarPath = path.isAbsolute(configuredPath) ? configuredPath : path.join(workspaceRoot, configuredPath);
            const version = path.basename(jarPath).match(/^karate-(.+)\.jar$/)?.[1] || 'custom';
            return { jarPath, version, bundled: false, customPath: true };
        }

        const configuredVersion = (config.get<string>('karateVersion', '') || '').trim();
        if (configuredVersion) {
            return {
                jarPath: this.getJarPath(extensionPath, configuredVersion),
                version: configuredVersion,
                bundled: false,
                customPath: false
            };
        }

        return {
            jarPath: this.getJarPath(extensionPath, this.BUNDLED_KARATE_VERSION),
            version: this.BUNDLED_KARATE_VERSION,
            bundled: true,
            customPath: false
        };
    }

    /**
     * Check if Karate JAR exists, download if needed
     */
    static async ensureKarateJar(extensionPath: string): Promise<KarateJarResolution> {
        const selected = this.resolveJar(extensionPath);

        if (selected.customPath) {
            if (!fs.existsSync(selected.jarPath)) {
                throw new Error(`Configured Karate JAR not found: ${selected.jarPath}`);
            }
            if (fs.statSync(selected.jarPath).size === 0) {
                throw new Error(`Configured Karate JAR is empty: ${selected.jarPath}`);
            }
            return selected;
        }

        const libDir = path.dirname(selected.jarPath);

        // Create lib directory if it doesn't exist
        if (!fs.existsSync(libDir)) {
            fs.mkdirSync(libDir, { recursive: true });
        }

        // Download if not exists
        if (!fs.existsSync(selected.jarPath)) {
            logger.info(`Karate JAR not found, downloading version ${selected.version}...`);
            await this.downloadKarateJar(selected.jarPath, selected.version);
        }

        return selected;
    }

    /**
     * Clear JAR cache - useful for troubleshooting
     */
    static clearJarCache(extensionPath: string): boolean {
        const selected = this.resolveJar(extensionPath);
        if (selected.bundled) {
            return false;
        }
        if (fs.existsSync(selected.jarPath)) {
            fs.unlinkSync(selected.jarPath);
            logger.info('Karate JAR cache cleared');
            return true;
        }
        return false;
    }

    /**
     * Download Karate standalone JAR with progress notification
     */
    private static async downloadKarateJar(jarPath: string, version: string): Promise<void> {
        // Karate standalone JARs are distributed via GitHub Releases, not Maven Central
        const url = `https://github.com/karatelabs/karate/releases/download/v${version}/karate-${version}.jar`;

        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Downloading Karate JAR v${version}...`,
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 10, message: 'Connecting to GitHub Releases...' });

            return new Promise<void>((resolve, reject) => {
                https.get(url, (response) => {
                    // Check for redirect
                    if (response.statusCode === 301 || response.statusCode === 302) {
                        const redirectUrl = response.headers.location;
                        if (!redirectUrl) {
                            reject(new Error('Redirect without location header'));
                            return;
                        }

                        // Follow redirect
                        https.get(redirectUrl, (redirectResponse) => {
                            this.handleDownloadResponse(redirectResponse, jarPath, progress, resolve, reject);
                        }).on('error', (err) => {
                            logger.error('Failed to follow redirect', err);
                            reject(new Error(`Failed to download JAR: ${err.message}`));
                        });
                    } else if (response.statusCode === 200) {
                        this.handleDownloadResponse(response, jarPath, progress, resolve, reject);
                    } else {
                        reject(new Error(`HTTP ${response.statusCode}: Failed to download JAR`));
                    }
                }).on('error', (err) => {
                    logger.error('Failed to download Karate JAR', err);
                    vscode.window.showErrorMessage(`Failed to download Karate JAR: ${err.message}. Please check your internet connection.`);
                    reject(new Error(`Failed to download Karate JAR: ${err.message}`));
                });
            });
        });
    }

    /**
     * Handle download response and save to file
     */
    private static handleDownloadResponse(
        response: any,
        jarPath: string,
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        resolve: () => void,
        reject: (error: Error) => void
    ): void {
        const file = fs.createWriteStream(jarPath);
        const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;

        response.on('data', (chunk: Buffer) => {
            downloadedBytes += chunk.length;
            if (totalBytes > 0) {
                const percent = Math.floor((downloadedBytes / totalBytes) * 80);
                const mb = (downloadedBytes / 1024 / 1024).toFixed(1);
                const totalMb = (totalBytes / 1024 / 1024).toFixed(1);
                progress.report({ message: `Downloading... ${mb}MB / ${totalMb}MB` });
            }
        });

        response.pipe(file);

        file.on('finish', () => {
            file.close((err) => {
                if (err) {
                    logger.error('Error closing file after download', err);
                    if (fs.existsSync(jarPath)) {
                        fs.unlinkSync(jarPath);
                    }
                    reject(new Error(`Failed to save JAR: ${err.message}`));
                    return;
                }

                // Verify file exists and has content
                if (!fs.existsSync(jarPath)) {
                    reject(new Error('Downloaded file does not exist'));
                    return;
                }

                const stats = fs.statSync(jarPath);
                if (stats.size === 0) {
                    logger.error('Downloaded JAR is empty');
                    fs.unlinkSync(jarPath);
                    reject(new Error('Downloaded JAR file is empty'));
                    return;
                }

                progress.report({ increment: 100, message: 'Download complete!' });
                logger.info(`Karate JAR downloaded successfully (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
                vscode.window.showInformationMessage('Karate JAR downloaded successfully');
                resolve();
            });
        });

        file.on('error', (err) => {
            logger.error('Error writing JAR file', err);
            if (fs.existsSync(jarPath)) {
                fs.unlinkSync(jarPath);
            }
            reject(new Error(`Failed to write JAR file: ${err.message}`));
        });

        response.on('error', (err: Error) => {
            logger.error('Error during download', err);
            file.close(() => {
                if (fs.existsSync(jarPath)) {
                    fs.unlinkSync(jarPath);
                }
            });
            reject(new Error(`Download failed: ${err.message}`));
        });
    }

    private static async ensureJavaVersion(version: string): Promise<void> {
        if (!version.startsWith('2.')) {
            return;
        }

        const major = await this.getJavaMajorVersion();
        if (major !== undefined && major < 21) {
            throw new Error(`Karate ${version} requires Java 21+. Current Java major version: ${major}`);
        }
    }

    private static async getJavaMajorVersion(): Promise<number | undefined> {
        return new Promise((resolve) => {
            let output = '';
            const process = spawn('java', ['-version'], { shell: true });
            process.stdout?.on('data', data => output += data.toString());
            process.stderr?.on('data', data => output += data.toString());
            process.on('close', () => {
                const match = output.match(/version "(\d+)(?:\.(\d+))?/);
                if (!match) {
                    resolve(undefined);
                    return;
                }
                const first = Number(match[1]);
                resolve(first === 1 ? Number(match[2]) : first);
            });
            process.on('error', () => resolve(undefined));
        });
    }

    /**
     * Execute Karate tests using standalone JAR
     */
    static async execute(
        options: TestExecutionOptions,
        extensionPath: string,
        cancellationToken?: vscode.CancellationToken
    ): Promise<{ success: boolean; output: string }> {
        // Ensure JAR is available
        const jar = await this.ensureKarateJar(extensionPath);
        await this.ensureJavaVersion(jar.version);

        // Use ConfigDiscovery for comprehensive classpath handling
        const workingDir = options.workingDirectory || '';

        // Import ConfigDiscovery dynamically to avoid circular dependencies
        const { ConfigDiscovery } = await import('./ConfigDiscovery');

        // Use async discovery for comprehensive workspace search
        const karateConfig = await ConfigDiscovery.discoverAsync(workingDir);

        // Log discovered config
        logger.info(`Config discovery: configJs=${karateConfig.configJsPath}, runners=${karateConfig.runnerClasses.length}, classpath=${karateConfig.classpathEntries.length}`);

        // Get LLM-powered execution suggestions for optimal parameters
        const featurePath = typeof options.target === 'string' ? options.target : (options.target as string[])[0] || '';
        let executionParams = {
            classpath: karateConfig.classpathEntries,
            javaArgs: [] as string[],
            karateArgs: [] as string[]
        };

        try {
            executionParams = await ConfigDiscovery.suggestExecutionParams(workingDir, featurePath, karateConfig);
            logger.info(`LLM suggested ${executionParams.javaArgs.length} Java args, ${executionParams.karateArgs.length} Karate args`);
        } catch (error) {
            logger.warn('LLM suggestion failed, using default params', error as Error);
        }

        // Build command arguments - classpath MUST come before main class
        const args: string[] = [];

        // Add LLM-suggested Java args
        args.push(...executionParams.javaArgs);

        // Build classpath: include JAR and all discovered/suggested entries
        const classpathEntries = [jar.jarPath, ...executionParams.classpath];
        const classpathStr = classpathEntries.join(path.delimiter);
        args.push('-cp', classpathStr);
        logger.info(`Using classpath: ${classpathStr}`);

        // Use Karate CLI main class
        args.push('com.intuit.karate.Main');

        // Add features/paths based on execution type
        switch (options.type) {
            case 'feature':
                args.push(options.target as string);
                break;

            case 'features': {
                const features = options.target as string[];
                args.push(...features);
                break;
            }

            case 'folder':
                args.push(options.target as string);
                break;

            case 'tags':
                if (options.tags && options.tags.length > 0) {
                    args.push('--tags');
                    const tagFilter = options.tags.map(t => `@${t.replace(/^@/, '')}`).join(',');
                    args.push(tagFilter);
                }
                break;

            case 'scenario': {
                // For scenario execution, line-based targeting (:lineNumber) doesn't work reliably in Karate 1.5+
                // Extract just the file path and run the whole feature
                const target = options.target as string;
                const filePath = target.split(':')[0];
                args.push(filePath);
                logger.info(`Running feature for scenario (line targeting removed): ${filePath}`);
                break;
            }
        }

        // Add parallel threads
        if (options.parallel && options.parallel > 1) {
            args.push('--threads', options.parallel.toString());
        }

        // Add user-configured parameters from settings
        const execConfig = vscode.workspace.getConfiguration('karateDsl.execution');

        // User system properties - ALL go as -D JVM flags (including karate.env)
        const systemProperties = execConfig.get<Record<string, string>>('systemProperties', {});
        for (const [key, value] of Object.entries(systemProperties)) {
            args.unshift(`-D${key}=${value}`);
        }
        if (Object.keys(systemProperties).length > 0) {
            logger.info(`User system properties: ${Object.entries(systemProperties).map(([k, v]) => `${k}=${v}`).join(', ')}`);
        }

        // Add environment: user systemProperties karate.env takes priority
        // Also pass as --env flag for Karate CLI compatibility
        if (systemProperties['karate.env']) {
            args.push('--env', systemProperties['karate.env']);
            logger.info(`Using user-configured karate.env: ${systemProperties['karate.env']}`);
        } else if (options.environment) {
            args.push('--env', options.environment);
        }

        // Add output directory
        const outputDir = path.join(workingDir, 'target', 'karate-reports');
        args.push('--output', outputDir);

        // Add LLM-suggested Karate args
        if (executionParams.karateArgs.length > 0) {
            args.push(...executionParams.karateArgs);
        }

        // User JVM args (insert before -cp)
        const userJvmArgs = execConfig.get<string[]>('jvmArgs', []);
        if (userJvmArgs.length > 0) {
            args.unshift(...userJvmArgs);
            logger.info(`User JVM args: ${userJvmArgs.join(' ')}`);
        }

        // User Karate CLI args (append at the end)
        const userKarateArgs = execConfig.get<string[]>('karateArgs', []);
        if (userKarateArgs.length > 0) {
            args.push(...userKarateArgs);
            logger.info(`User Karate args: ${userKarateArgs.join(' ')}`);
        }

        logger.info(`Karate output directory: ${outputDir}`);
        logger.info(`Executing Karate CLI: java ${args.join(' ')}`);

        return this.executeCommand('java', args, workingDir, cancellationToken);
    }

    /**
     * Execute Java command
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
                    resolve({ success: false, output: fullOutput });
                }
            });

            process.on('error', (error) => {
                logger.error('Karate CLI execution error', error);
                reject(error);
            });
        });
    }
}
