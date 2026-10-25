import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { TestExecutionOptions } from '../../types';
import { logger } from '../../utils/logger';
import { buildKarateArguments } from './ExecutionArguments';
import { ExecutionRuntimeSettings, readExecutionSettings } from './ExecutionSettings';
import { KNOWN_JAR_SHA256, downloadVerified, isSafeVersion, karateJarUrl } from './KarateJarDownloader';
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
    private static cacheDir: string | undefined;

    /** Where downloaded jars live (the extension's global storage); unset falls back to <extension>/lib for dev runs. */
    static configureStorage(dir: string): void {
        this.cacheDir = dir;
    }

    private static getJarPath(extensionPath: string, version: string): string {
        return path.join(this.cacheDir ?? path.join(extensionPath, 'lib'), `karate-${version}.jar`);
    }

    static resolveJar(extensionPath: string, settings?: ExecutionRuntimeSettings, projectRoot?: string): KarateJarResolution {
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

        if (!isSafeVersion(selected.version)) {
            throw new Error(`Invalid Karate version: ${selected.version}`);
        }
        fs.mkdirSync(path.dirname(selected.jarPath), { recursive: true });

        if (!fs.existsSync(selected.jarPath)) {
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
     * Download Karate standalone JAR from GitHub Releases after explicit consent, verifying its SHA-256 when pinned
     */
    private static async downloadKarateJar(jarPath: string, version: string): Promise<void> {
        const url = karateJarUrl(version);
        const choice = await vscode.window.showInformationMessage(
            `Karate Test Management needs Karate ${version} to run tests. Download it from GitHub Releases (about 70 MB)? Alternatively set karateDsl.execution.jarPath to your own jar.`,
            { modal: true },
            'Download'
        );
        if (choice !== 'Download') {
            throw new Error(`Karate ${version} is required. Set karateDsl.execution.jarPath or allow the download.`);
        }
        logger.info(`Downloading Karate JAR ${version} from ${url}`);
        const sha256 = KNOWN_JAR_SHA256[version];
        if (!sha256) {
            logger.warn(`No pinned checksum for Karate ${version}; downloading unverified.`);
        }
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Downloading Karate JAR v${version}...`,
            cancellable: false
        }, async (progress) => {
            let last = 0;
            await downloadVerified(url, jarPath, sha256, (done, total) => {
                const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
                if (pct > last) { progress.report({ increment: pct - last, message: `${(done / 1048576).toFixed(1)} MB` }); last = pct; }
            });
        });
        logger.info('Karate JAR downloaded and verified');
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
            const process = spawn('java', ['-version'], { shell: false, windowsHide: true });
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
        const karateConfig = await ConfigDiscovery.discoverAsync(project.projectRoot, project.configDir);
        logger.info(`Config discovery: configJs=${karateConfig.configJsPath}, runners=${karateConfig.runnerClasses.length}, classpath=${karateConfig.classpathEntries.length}`);
        const discoveredClasspath = [...karateConfig.classpathEntries];
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
