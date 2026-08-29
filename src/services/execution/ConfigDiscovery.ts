import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../../utils/logger';

/**
 * Configuration discovered from Karate project
 */
export interface KarateConfig {
    configJsPath?: string;          // karate-config.js location
    runnerClasses: string[];        // Java runner class names
    envVariables: Map<string, string>;  // Discovered env vars
    classpathEntries: string[];     // Additional classpath entries
    suggestedCommand?: string;      // LLM-suggested execution command
}

/**
 * Discovered file info
 */
interface DiscoveredFile {
    path: string;
    relativePath: string;
    type: 'config' | 'runner' | 'feature';
}

/**
 * Centralized config file discovery for Karate projects
 * Discovery is scoped to one resolved project root. Execution must remain
 * deterministic: AI suggestions are never part of command construction.
 */
export class ConfigDiscovery {

    // Cache for discovered configs (per workspace)
    private static configCache: Map<string, { config: KarateConfig; timestamp: number }> = new Map();
    private static readonly CACHE_TTL = 60000; // 1 minute cache

    // Classpath directories for compiled classes
    private static readonly CLASSPATH_DIRS = [
        'target/test-classes',
        'target/classes',
        'build/classes/java/test',
        'build/classes/java/main',
        'build/classes/kotlin/test',
        'out/test/classes',
        'out/classes',
        'bin'
    ];

    /**
     * Discover all Karate configuration in a workspace directory
     * Uses synchronous methods for backward compatibility
     */
    static discover(workingDir: string): KarateConfig {
        // Check cache first
        const cached = this.configCache.get(workingDir);
        if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
            return cached.config;
        }

        const config: KarateConfig = {
            runnerClasses: [],
            envVariables: new Map(),
            classpathEntries: []
        };

        // Check custom config path from settings first
        const customConfigPath = vscode.workspace.getConfiguration('karateDsl.execution').get<string>('configPath');
        if (customConfigPath) {
            const fullCustomPath = path.isAbsolute(customConfigPath)
                ? customConfigPath
                : path.join(workingDir, customConfigPath);
            if (fs.existsSync(fullCustomPath)) {
                config.configJsPath = fullCustomPath;
                logger.info(`Using custom config path: ${fullCustomPath}`);
            }
        }

        // Find karate-config using full directory scan
        if (!config.configJsPath) {
            config.configJsPath = this.findConfigFileSync(workingDir);
        }

        // Find runner classes
        config.runnerClasses = this.findRunnerClasses(workingDir);

        // Build classpath entries
        config.classpathEntries = this.buildClasspath(workingDir, config.configJsPath);

        // Add additional classpath from settings
        const additionalClasspath = vscode.workspace.getConfiguration('karateDsl.execution').get<string[]>('additionalClasspath', []);
        for (const entry of additionalClasspath) {
            const fullPath = path.isAbsolute(entry) ? entry : path.join(workingDir, entry);
            if (fs.existsSync(fullPath) && !config.classpathEntries.includes(fullPath)) {
                config.classpathEntries.push(fullPath);
            }
        }

        // Parse environment variables from config if it's a JS file
        if (config.configJsPath && config.configJsPath.endsWith('.js')) {
            config.envVariables = this.parseKarateConfigJs(config.configJsPath);
        }

        logger.info(`Config discovery complete: ${JSON.stringify({
            configJsPath: config.configJsPath,
            runnerClasses: config.runnerClasses.length,
            classpathEntries: config.classpathEntries.length,
            envVariables: config.envVariables.size
        })}`);

        // Cache the result
        this.configCache.set(workingDir, { config, timestamp: Date.now() });

        return config;
    }

    /**
     * Async discovery using VS Code workspace.findFiles for comprehensive search
     * This is the preferred method for universal project structure support
     */
    static async discoverAsync(workingDir: string): Promise<KarateConfig> {
        const config: KarateConfig = {
            runnerClasses: [],
            envVariables: new Map(),
            classpathEntries: []
        };

        // Check custom config path from settings first
        const customConfigPath = vscode.workspace.getConfiguration('karateDsl.execution').get<string>('configPath');
        if (customConfigPath) {
            const fullCustomPath = path.isAbsolute(customConfigPath)
                ? customConfigPath
                : path.join(workingDir, customConfigPath);
            if (fs.existsSync(fullCustomPath)) {
                config.configJsPath = fullCustomPath;
                logger.info(`Using custom config path: ${fullCustomPath}`);
            }
        }

        // Search only the resolved project. Workspace-wide searches can cross
        // multi-root boundaries and select a sibling project's configuration.
        if (!config.configJsPath) {
            config.configJsPath = this.findConfigFileSync(workingDir);
        }

        config.runnerClasses = this.findRunnerClasses(workingDir);
        logger.info(`Found ${config.runnerClasses.length} Karate runner classes in resolved project`);

        // Build classpath entries
        config.classpathEntries = this.buildClasspath(workingDir, config.configJsPath);

        // Add additional classpath from settings
        const additionalClasspath = vscode.workspace.getConfiguration('karateDsl.execution').get<string[]>('additionalClasspath', []);
        for (const entry of additionalClasspath) {
            const fullPath = path.isAbsolute(entry) ? entry : path.join(workingDir, entry);
            if (fs.existsSync(fullPath) && !config.classpathEntries.includes(fullPath)) {
                config.classpathEntries.push(fullPath);
            }
        }

        // Parse environment variables from config if it's a JS file
        if (config.configJsPath && config.configJsPath.endsWith('.js')) {
            config.envVariables = this.parseKarateConfigJs(config.configJsPath);
        }

        // Cache the result
        this.configCache.set(workingDir, { config, timestamp: Date.now() });

        logger.info(`Async config discovery complete: ${JSON.stringify({
            configJsPath: config.configJsPath,
            runnerClasses: config.runnerClasses.length,
            classpathEntries: config.classpathEntries.length
        })}`);

        return config;
    }

    /**
     * Synchronous config file search - scans entire directory tree
     */
    private static findConfigFileSync(workingDir: string): string | undefined {
        const configNames = ['karate-config.js', 'karate-config.java'];

        // Full recursive search of the workspace
        const found = this.findFileAnywhere(workingDir, configNames, 0, 10);
        if (found) {
            logger.info(`Found karate-config via full scan: ${found}`);
            return found;
        }

        logger.warn('No karate-config file found in workspace');
        return undefined;
    }

    /**
     * Recursively search for any of the given filenames anywhere in the directory tree
     */
    private static findFileAnywhere(
        dir: string,
        filenames: string[],
        currentDepth: number,
        maxDepth: number
    ): string | undefined {
        if (currentDepth > maxDepth) return undefined;

        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });

            // Check for target files in current directory
            for (const entry of entries) {
                if (entry.isFile() && filenames.includes(entry.name)) {
                    return path.join(dir, entry.name);
                }
            }

            // Recursively search subdirectories
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    // Skip non-source directories
                    const skipDirs = [
                        'node_modules', '.git', '.idea', '.vscode',
                        'target', 'build', 'out', 'dist', 'bin',
                        '__pycache__', '.gradle', '.mvn'
                    ];
                    if (skipDirs.includes(entry.name)) continue;

                    const found = this.findFileAnywhere(
                        path.join(dir, entry.name),
                        filenames,
                        currentDepth + 1,
                        maxDepth
                    );
                    if (found) return found;
                }
            }
        } catch (error) {
            // Ignore permission errors
        }

        return undefined;
    }

    /**
     * Find Java runner classes
     */
    static findRunnerClasses(workingDir: string): string[] {
        const runners: string[] = [];

        // Search in common Java source directories
        const searchDirs = [
            'src/test/java',
            'src/main/java',
            'test',
            'tests'
        ];

        for (const searchDir of searchDirs) {
            const fullPath = path.join(workingDir, searchDir);
            if (fs.existsSync(fullPath)) {
                const found = this.findRunnersInDir(fullPath);
                runners.push(...found);
            }
        }

        return runners;
    }

    /**
     * Find runners recursively in a directory
     */
    private static findRunnersInDir(dir: string): string[] {
        const runners: string[] = [];

        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    const skipDirs = ['node_modules', '.git', 'target', 'build', 'out'];
                    if (!skipDirs.includes(entry.name)) {
                        runners.push(...this.findRunnersInDir(fullPath));
                    }
                } else if (entry.isFile() && entry.name.endsWith('.java')) {
                    try {
                        const content = fs.readFileSync(fullPath, 'utf-8');
                        if (this.isKarateRunner(content)) {
                            const className = this.extractClassName(content, fullPath);
                            if (className) {
                                runners.push(className);
                            }
                        }
                    } catch { /* ignore read errors */ }
                }
            }
        } catch { /* ignore permission errors */ }

        return runners;
    }

    /**
     * Check if a Java file is a Karate runner
     */
    private static isKarateRunner(content: string): boolean {
        const karatePatterns = [
            /import\s+com\.intuit\.karate/,
            /@Karate\.Test/,
            /Runner\.(path|builder)/,
            /Karate\s*\.\s*run/,
            /@CucumberOptions/
        ];

        return karatePatterns.some(pattern => pattern.test(content));
    }

    /**
     * Extract fully qualified class name from file path
     */
    private static extractClassName(content: string, filePath: string): string | undefined {
        const className = content.match(/\b(?:class|record)\s+([A-Za-z_$][\w$]*)/)?.[1] || path.basename(filePath, '.java');
        if (!className) return undefined;
        const packageName = content.match(/\bpackage\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/)?.[1];
        return packageName ? `${packageName}.${className}` : className;
    }

    /**
     * Build classpath entries for Karate execution
     */
    private static buildClasspath(workingDir: string, configJsPath?: string): string[] {
        const entries: string[] = [];

        // Add directory containing karate-config.js
        if (configJsPath) {
            const configDir = path.dirname(configJsPath);
            if (!entries.includes(configDir)) {
                entries.push(configDir);
            }
        }

        // Add all common source and compiled directories
        const allDirs = [
            'src/test/java',
            'src/test/resources',
            'src/test/kotlin',
            'src/main/java',
            'src/main/resources',
            'test',
            'tests',
            ...this.CLASSPATH_DIRS
        ];

        for (const dir of allDirs) {
            const fullPath = path.join(workingDir, dir);
            if (fs.existsSync(fullPath) && !entries.includes(fullPath)) {
                entries.push(fullPath);
            }
        }

        return entries;
    }

    /**
     * Parse karate-config.js to extract environment variable names
     */
    static parseKarateConfigJs(configPath: string): Map<string, string> {
        const envVars = new Map<string, string>();

        try {
            const content = fs.readFileSync(configPath, 'utf-8');

            // Look for karate.env patterns
            const envMatch = content.match(/karate\.env\s*(?:=|==|===)\s*['"]([^'"]+)['"]/);
            if (envMatch) {
                envVars.set('karate.env', envMatch[1]);
            }

            // Look for config object assignments
            const configAssignments = content.matchAll(/config\.(\w+)\s*=\s*['"]([^'"]+)['"]/g);
            for (const match of configAssignments) {
                envVars.set(match[1], match[2]);
            }

            // Look for environment-specific blocks
            const envBlocks = content.matchAll(/if\s*\(\s*env\s*==\s*['"](\w+)['"]\s*\)/g);
            for (const match of envBlocks) {
                const envName = match[1];
                if (!envVars.has('availableEnvs')) {
                    envVars.set('availableEnvs', envName);
                } else {
                    envVars.set('availableEnvs', envVars.get('availableEnvs') + ',' + envName);
                }
            }

        } catch (error) {
            logger.warn(`Could not parse karate-config.js: ${error}`);
        }

        return envVars;
    }

    /**
     * Get the best runner class for a given feature file
     */
    static getRunnerForFeature(workingDir: string, featurePath: string): string | undefined {
        const runners = this.findRunnerClasses(workingDir);

        if (runners.length === 0) {
            return undefined;
        }

        // Try to find a runner in the same package as the feature
        const featureDir = path.dirname(featurePath);

        // Try multiple possible java roots
        const javaRoots = ['src/test/java', 'src/main/java', 'test', 'tests'];

        for (const root of javaRoots) {
            const rootPath = path.join(workingDir, root);
            if (featureDir.startsWith(rootPath)) {
                const relativePath = path.relative(rootPath, featureDir);
                const packagePrefix = relativePath.replace(/\\/g, '/').replace(/\//g, '.');

                const matchingRunner = runners.find(runner => runner.startsWith(packagePrefix));
                if (matchingRunner) {
                    return matchingRunner;
                }
            }
        }

        // A single project runner is safe. Multiple unmatched runners are
        // ambiguous and must be resolved by an explicit runnerClass setting.
        return runners.length === 1 ? runners[0] : undefined;
    }

    /**
     * Clear the config cache
     */
    static clearCache(): void {
        this.configCache.clear();
        logger.info('Config cache cleared');
    }
}
