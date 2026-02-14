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
 * Uses VS Code workspace search for universal discovery across any project structure
 * Includes LLM-powered execution parameter suggestions
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

        // Use VS Code workspace search to find all karate-config files
        if (!config.configJsPath) {
            const configFiles = await this.findFilesInWorkspace('**/karate-config.{js,java}');
            if (configFiles.length > 0) {
                // Prefer the one closest to workingDir, or in standard locations
                config.configJsPath = this.selectBestConfig(configFiles, workingDir);
                logger.info(`Found ${configFiles.length} karate-config files, selected: ${config.configJsPath}`);
            }
        }

        // Find runner classes via workspace search
        const runnerFiles = await this.findFilesInWorkspace('**/*Runner.java');
        const testRunnerFiles = await this.findFilesInWorkspace('**/*Test.java');
        const allRunnerFiles = [...runnerFiles, ...testRunnerFiles];

        for (const file of allRunnerFiles) {
            const content = fs.readFileSync(file.fsPath, 'utf-8');
            if (this.isKarateRunner(content)) {
                const className = this.extractClassName(file.fsPath, workingDir);
                if (className && !config.runnerClasses.includes(className)) {
                    config.runnerClasses.push(className);
                }
            }
        }
        logger.info(`Found ${config.runnerClasses.length} Karate runner classes via workspace search`);

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
     * Use LLM to analyze project and suggest optimal execution parameters
     */
    static async suggestExecutionParams(
        workingDir: string,
        featurePath: string,
        config: KarateConfig
    ): Promise<{ classpath: string[]; javaArgs: string[]; karateArgs: string[] }> {
        const result = {
            classpath: [...config.classpathEntries],
            javaArgs: [] as string[],
            karateArgs: [] as string[]
        };

        try {
            // Import CopilotService dynamically
            const { CopilotService } = await import('../copilotService');
            const isAvailable = await CopilotService.isCopilotAvailable();

            if (!isAvailable) {
                logger.info('Copilot not available, using default execution params');
                return result;
            }

            // Gather project context
            const projectInfo = await this.gatherProjectContext(workingDir, featurePath, config);

            // Ask LLM for execution suggestions
            const prompt = `Analyze this Karate project structure and suggest optimal execution parameters:

PROJECT CONTEXT:
${projectInfo}

CURRENT CONFIG:
- Config file: ${config.configJsPath || 'Not found'}
- Runner classes: ${config.runnerClasses.join(', ') || 'None found'}
- Classpath entries: ${config.classpathEntries.length} directories
- Feature to run: ${featurePath}

TASK: Suggest the best execution approach. Return JSON only:
{
  "additionalClasspath": ["any additional directories needed"],
  "javaArgs": ["-D flags if needed"],
  "karateArgs": ["--tags, --threads, etc if needed"],
  "reasoning": "brief explanation"
}`;

            const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            if (models.length > 0) {
                const messages = [vscode.LanguageModelChatMessage.User(prompt)];
                const response = await models[0].sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

                let responseText = '';
                for await (const fragment of response.text) {
                    responseText += fragment;
                }

                // Parse JSON from response
                const jsonMatch = responseText.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const suggestions = JSON.parse(jsonMatch[0]);

                    if (suggestions.additionalClasspath) {
                        for (const cp of suggestions.additionalClasspath) {
                            const fullPath = path.isAbsolute(cp) ? cp : path.join(workingDir, cp);
                            if (fs.existsSync(fullPath) && !result.classpath.includes(fullPath)) {
                                result.classpath.push(fullPath);
                            }
                        }
                    }

                    if (suggestions.javaArgs) {
                        result.javaArgs.push(...suggestions.javaArgs);
                    }

                    if (suggestions.karateArgs) {
                        result.karateArgs.push(...suggestions.karateArgs);
                    }

                    logger.info(`LLM execution suggestions: ${suggestions.reasoning || 'No reasoning provided'}`);
                }
            }
        } catch (error) {
            logger.warn('Failed to get LLM execution suggestions', error as Error);
        }

        return result;
    }

    /**
     * Gather project context for LLM analysis
     */
    private static async gatherProjectContext(
        workingDir: string,
        featurePath: string,
        config: KarateConfig
    ): Promise<string> {
        const lines: string[] = [];

        // List key directories
        lines.push('Directory Structure:');
        const dirs = ['src', 'test', 'tests', 'target', 'build'];
        for (const dir of dirs) {
            const fullPath = path.join(workingDir, dir);
            if (fs.existsSync(fullPath)) {
                lines.push(`  /${dir}/ exists`);
                // List first-level subdirs
                try {
                    const subdirs = fs.readdirSync(fullPath, { withFileTypes: true })
                        .filter(d => d.isDirectory())
                        .map(d => d.name)
                        .slice(0, 5);
                    if (subdirs.length > 0) {
                        lines.push(`    subdirs: ${subdirs.join(', ')}`);
                    }
                } catch { /* ignore */ }
            }
        }

        // Check for build files
        const buildFiles = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'package.json'];
        lines.push('\nBuild Files:');
        for (const file of buildFiles) {
            if (fs.existsSync(path.join(workingDir, file))) {
                lines.push(`  ${file} found`);
            }
        }

        // Feature file location
        lines.push(`\nFeature File: ${path.relative(workingDir, featurePath)}`);

        // Config file content preview (if exists)
        if (config.configJsPath && fs.existsSync(config.configJsPath)) {
            lines.push(`\nConfig File (${path.basename(config.configJsPath)}) preview:`);
            const content = fs.readFileSync(config.configJsPath, 'utf-8');
            lines.push(content.substring(0, 500) + (content.length > 500 ? '...' : ''));
        }

        return lines.join('\n');
    }

    /**
     * Find files using VS Code workspace API - searches entire workspace
     */
    private static async findFilesInWorkspace(pattern: string): Promise<vscode.Uri[]> {
        try {
            const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 100);
            return files;
        } catch (error) {
            logger.error(`Workspace search failed for pattern: ${pattern}`, error as Error);
            return [];
        }
    }

    /**
     * Select the best config file from multiple found
     */
    private static selectBestConfig(files: vscode.Uri[], workingDir: string): string {
        // Priority: closest to workingDir, then standard locations
        const priorityPaths = [
            'src/test/java/karate-config.js',
            'src/test/resources/karate-config.js',
            'karate-config.js'
        ];

        // Check priority paths first
        for (const priority of priorityPaths) {
            const match = files.find(f => f.fsPath.endsWith(priority.replace(/\//g, path.sep)));
            if (match) {
                return match.fsPath;
            }
        }

        // Otherwise, find the one closest to the workingDir
        let bestFile = files[0].fsPath;
        let shortestRelative = path.relative(workingDir, files[0].fsPath).length;

        for (const file of files) {
            const relative = path.relative(workingDir, file.fsPath);
            if (relative.length < shortestRelative) {
                shortestRelative = relative.length;
                bestFile = file.fsPath;
            }
        }

        return bestFile;
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
                const found = this.findRunnersInDir(fullPath, fullPath);
                runners.push(...found);
            }
        }

        return runners;
    }

    /**
     * Find runners recursively in a directory
     */
    private static findRunnersInDir(dir: string, baseDir: string): string[] {
        const runners: string[] = [];

        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    const skipDirs = ['node_modules', '.git', 'target', 'build', 'out'];
                    if (!skipDirs.includes(entry.name)) {
                        runners.push(...this.findRunnersInDir(fullPath, baseDir));
                    }
                } else if (entry.isFile() && entry.name.endsWith('.java')) {
                    try {
                        const content = fs.readFileSync(fullPath, 'utf-8');
                        if (this.isKarateRunner(content)) {
                            const className = this.extractClassName(fullPath, path.dirname(baseDir));
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
    private static extractClassName(filePath: string, baseDir: string): string | undefined {
        // Find java source root
        const javaRoots = ['src/test/java', 'src/main/java', 'test', 'tests'];

        for (const root of javaRoots) {
            const rootPath = path.join(baseDir, root);
            if (filePath.startsWith(rootPath)) {
                const relativePath = path.relative(rootPath, filePath);
                return relativePath
                    .replace(/\\/g, '/')
                    .replace(/\.java$/, '')
                    .replace(/\//g, '.');
            }
        }

        // Fallback: try to extract from file path structure
        const match = filePath.match(/(?:java|test|tests)[\/\\](.+)\.java$/);
        if (match) {
            return match[1].replace(/[\/\\]/g, '.');
        }

        return undefined;
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

        // Return the first runner as fallback
        return runners[0];
    }

    /**
     * Clear the config cache
     */
    static clearCache(): void {
        this.configCache.clear();
        logger.info('Config cache cleared');
    }
}
