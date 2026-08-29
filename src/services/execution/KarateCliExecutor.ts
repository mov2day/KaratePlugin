import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import { spawn } from 'child_process';
import { TestExecutionOptions } from '../../types';
import { logger } from '../../utils/logger';
import { buildKarateArguments } from './ExecutionArguments';
import { ExecutionRuntimeSettings, readExecutionSettings } from './ExecutionSettings';
import { ProcessResult, ProcessRunner } from './ProcessRunner';
import { ResolvedExecutionProject } from './ProjectExecutionResolver';

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

    private static resolveJar(extensionPath: string, settings?: ExecutionRuntimeSettings, projectRoot?: string): KarateJarResolution {
        const scope = projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || extensionPath;
        const resolvedSettings = settings || readExecutionSettings(scope);
        const configuredPath = (resolvedSettings.jarPath || '').trim();
        if (configuredPath) {
            const jarPath = path.isAbsolute(configuredPath) ? configuredPath : path.join(scope, configuredPath);
            const version = path.basename(jarPath).match(/^karate-(.+)\.jar$/)?.[1] || 'custom';
            return { jarPath, version, bundled: false, customPath: true };
        }

        const configuredVersion = (resolvedSettings.karateVersion || '').trim();
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
    static async ensureKarateJar(extensionPath: string, settings?: ExecutionRuntimeSettings, projectRoot?: string): Promise<KarateJarResolution> {
        const selected = this.resolveJar(extensionPath, settings, projectRoot);

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
    static clearJarCache(extensionPath: string, projectRoot?: string): boolean {
        const selected = this.resolveJar(extensionPath, undefined, projectRoot);
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
        project: ResolvedExecutionProject,
        settings: ExecutionRuntimeSettings,
        outputDirectory: string,
        cancellationToken?: vscode.CancellationToken
    ): Promise<ProcessResult> {
        const jar = await this.ensureKarateJar(extensionPath, settings, project.projectRoot);
        await this.ensureJavaVersion(jar.version);
        const { ConfigDiscovery } = await import('./ConfigDiscovery');
        const karateConfig = await ConfigDiscovery.discoverAsync(project.projectRoot);
        logger.info(`Config discovery: configJs=${karateConfig.configJsPath}, runners=${karateConfig.runnerClasses.length}, classpath=${karateConfig.classpathEntries.length}`);
        const discoveredClasspath = karateConfig.classpathEntries;
        for (const configured of settings.additionalClasspath) {
            const fullPath = path.isAbsolute(configured) ? configured : path.join(project.projectRoot, configured);
            if (!fs.existsSync(fullPath)) throw new Error(`Configured classpath entry was not found: ${fullPath}`);
            if (!discoveredClasspath.includes(fullPath)) discoveredClasspath.push(fullPath);
        }
        const args = [
            ...settings.jvmArgs,
            ...Object.entries(settings.systemProperties).map(([key, value]) => `-D${key}=${value}`),
            '-cp', [jar.jarPath, ...discoveredClasspath].join(path.delimiter),
            'com.intuit.karate.Main',
            ...buildKarateArguments(options, project.configDir)
        ];
        const environment = settings.systemProperties['karate.env'] || options.environment;
        if (environment) args.push('--env', environment);
        args.push('--output', outputDirectory, ...settings.karateArgs);
        logger.info(`Executing Karate CLI in ${project.projectRoot}; report output ${outputDirectory}`);
        return ProcessRunner.run('java', args, project.projectRoot, cancellationToken);
    }
}
