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
export class KarateCliExecutor {
    private static readonly KARATE_VERSION = '1.5.0.RC3';
    private static readonly JAR_NAME = `karate-${this.KARATE_VERSION}.jar`;

    /**
     * Get path to Karate standalone JAR
     */
    private static getJarPath(extensionPath: string): string {
        return path.join(extensionPath, 'lib', this.JAR_NAME);
    }

    /**
     * Check if Karate JAR exists, download if needed
     */
    static async ensureKarateJar(extensionPath: string): Promise<string> {
        const jarPath = this.getJarPath(extensionPath);
        const libDir = path.dirname(jarPath);

        // Create lib directory if it doesn't exist
        if (!fs.existsSync(libDir)) {
            fs.mkdirSync(libDir, { recursive: true });
        }

        // Download if not exists
        if (!fs.existsSync(jarPath)) {
            logger.info(`Karate JAR not found, downloading version ${this.KARATE_VERSION}...`);
            await this.downloadKarateJar(jarPath);
        }

        return jarPath;
    }

    /**
     * Clear JAR cache - useful for troubleshooting
     */
    static clearJarCache(extensionPath: string): boolean {
        const jarPath = this.getJarPath(extensionPath);
        if (fs.existsSync(jarPath)) {
            fs.unlinkSync(jarPath);
            logger.info('Karate JAR cache cleared');
            return true;
        }
        return false;
    }

    /**
     * Download Karate standalone JAR with progress notification
     */
    private static async downloadKarateJar(jarPath: string): Promise<void> {
        // Karate standalone JARs are distributed via GitHub Releases, not Maven Central
        const url = `https://github.com/karatelabs/karate/releases/download/v${this.KARATE_VERSION}/karate-${this.KARATE_VERSION}.jar`;

        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Downloading Karate JAR v${this.KARATE_VERSION}...`,
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
                vscode.window.showInformationMessage(`✅ Karate JAR v${this.KARATE_VERSION} downloaded successfully`);
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

    /**
     * Execute Karate tests using standalone JAR
     */
    static async execute(
        options: TestExecutionOptions,
        extensionPath: string,
        cancellationToken?: vscode.CancellationToken
    ): Promise<{ success: boolean; output: string }> {
        // Ensure JAR is available
        const jarPath = await this.ensureKarateJar(extensionPath);

        // Build command arguments
        const args = ['-jar', jarPath];

        // Add classpath for karate-config.js if exists
        const workingDir = options.workingDirectory || '';
        const configPath = path.join(workingDir, 'src', 'test', 'java');
        if (fs.existsSync(configPath)) {
            args.push('-cp', configPath);
        }

        // Add features/paths based on execution type
        switch (options.type) {
            case 'feature':
                args.push(options.target as string);
                break;

            case 'features':
                const features = options.target as string[];
                args.push(...features);
                break;

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

            case 'scenario':
                // For scenario execution, line-based targeting (:lineNumber) doesn't work reliably in Karate 1.5+
                // Extract just the file path and run the whole feature
                const target = options.target as string;
                const filePath = target.split(':')[0];
                args.push(filePath);
                logger.info(`Running feature for scenario (line targeting removed): ${filePath}`);
                break;
        }

        // Add parallel threads
        if (options.parallel && options.parallel > 1) {
            args.push('--threads', options.parallel.toString());
        }

        // Add environment
        if (options.environment) {
            args.push('--env', options.environment);
        }

        // Add output directory
        const outputDir = path.join(workingDir, 'target', 'karate-reports');
        args.push('--output', outputDir);

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
