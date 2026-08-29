import * as fs from 'fs';
import * as path from 'path';
import { TestExecutionOptions } from '../../types';

export type ExecutionStrategy = 'cli' | 'maven' | 'gradle';

export interface ExecutionPreferences {
    defaultBuildTool?: 'auto' | ExecutionStrategy;
    runnerClass?: string;
    runnerMethod?: string;
    configPath?: string;
}

export interface ResolvedExecutionProject {
    strategy: ExecutionStrategy;
    projectRoot: string;
    workspaceRoot: string;
    buildFile?: string;
    runnerClass?: string;
    runnerMethod?: string;
    configDir?: string;
}

/**
 * Resolves an execution target to the nearest real Karate project. Resolution is
 * deterministic and bounded by the owning VS Code workspace folder.
 */
export class ProjectExecutionResolver {
    static resolve(
        options: TestExecutionOptions,
        workspaceRoot: string,
        preferences: ExecutionPreferences = {}
    ): ResolvedExecutionProject {
        const normalizedWorkspace = path.resolve(workspaceRoot);
        const targetPaths = this.getTargetPaths(options);
        for (const targetPath of targetPaths) {
            if (!this.isWithin(normalizedWorkspace, targetPath)) {
                throw new Error(`Execution target is outside the selected workspace: ${targetPath}`);
            }
        }

        const requested = options.buildTool || preferences.defaultBuildTool || 'auto';
        const candidates = targetPaths.map(target => this.findNearestProject(target, normalizedWorkspace));
        const discoveredRoots = new Set(candidates.filter(Boolean).map(candidate => candidate!.projectRoot));
        if (discoveredRoots.size > 1) {
            throw new Error('The selected targets belong to different build modules. Run each module separately.');
        }

        const discovered = candidates.find(Boolean);
        let strategy: ExecutionStrategy;
        let projectRoot: string;
        let buildFile: string | undefined;

        if (requested === 'auto') {
            strategy = discovered?.strategy || 'cli';
            projectRoot = discovered?.projectRoot || normalizedWorkspace;
            buildFile = discovered?.buildFile;
        } else if (requested === 'cli') {
            strategy = 'cli';
            projectRoot = discovered?.projectRoot || normalizedWorkspace;
            buildFile = discovered?.buildFile;
        } else {
            const explicit = candidates
                .map((_, index) => this.findNearestBuild(targetPaths[index], normalizedWorkspace, requested))
                .find(Boolean);
            if (!explicit) {
                throw new Error(`No ${requested === 'maven' ? 'pom.xml' : 'Gradle build file'} was found between the target and workspace root.`);
            }
            strategy = requested;
            projectRoot = explicit.projectRoot;
            buildFile = explicit.buildFile;
        }

        const legacyConfig = (preferences.configPath || '').trim();
        const explicitRunner = (options.runnerClass || preferences.runnerClass || '').trim();
        const legacyRunner = !explicitRunner && this.looksLikeRunnerClass(legacyConfig) ? legacyConfig : undefined;
        const configPath = options.configDir || (legacyRunner ? undefined : legacyConfig);
        const configDir = configPath ? this.resolveConfigDir(configPath, projectRoot) : undefined;

        return {
            strategy,
            projectRoot,
            workspaceRoot: normalizedWorkspace,
            buildFile,
            runnerClass: explicitRunner || legacyRunner,
            runnerMethod: options.runnerMethod || preferences.runnerMethod,
            configDir
        };
    }

    private static getTargetPaths(options: TestExecutionOptions): string[] {
        const rawTargets = Array.isArray(options.target) ? options.target : [options.target];
        return rawTargets.map(raw => {
            const legacyScenario = options.type === 'scenario' ? raw.match(/^(.*\.feature):(\d+)$/i) : undefined;
            const clean = legacyScenario ? legacyScenario[1] : raw;
            return path.resolve(clean);
        });
    }

    private static findNearestProject(targetPath: string, workspaceRoot: string): { strategy: ExecutionStrategy; projectRoot: string; buildFile: string } | undefined {
        let current = this.startDirectory(targetPath);
        while (this.isWithin(workspaceRoot, current)) {
            const pom = path.join(current, 'pom.xml');
            const gradle = ['build.gradle', 'build.gradle.kts'].map(file => path.join(current, file)).find(fs.existsSync);
            if (fs.existsSync(pom) && gradle) {
                throw new Error(`Both Maven and Gradle builds were found in ${current}. Select an explicit build tool.`);
            }
            if (fs.existsSync(pom)) return { strategy: 'maven', projectRoot: current, buildFile: pom };
            if (gradle) return { strategy: 'gradle', projectRoot: current, buildFile: gradle };
            if (current === workspaceRoot) break;
            current = path.dirname(current);
        }
        return undefined;
    }

    private static findNearestBuild(targetPath: string, workspaceRoot: string, strategy: 'maven' | 'gradle'): { projectRoot: string; buildFile: string } | undefined {
        let current = this.startDirectory(targetPath);
        while (this.isWithin(workspaceRoot, current)) {
            const names = strategy === 'maven' ? ['pom.xml'] : ['build.gradle', 'build.gradle.kts'];
            const buildFile = names.map(name => path.join(current, name)).find(fs.existsSync);
            if (buildFile) return { projectRoot: current, buildFile };
            if (current === workspaceRoot) break;
            current = path.dirname(current);
        }
        return undefined;
    }

    private static startDirectory(targetPath: string): string {
        try {
            return fs.statSync(targetPath).isDirectory() ? targetPath : path.dirname(targetPath);
        } catch {
            return path.extname(targetPath) ? path.dirname(targetPath) : targetPath;
        }
    }

    private static resolveConfigDir(configPath: string, projectRoot: string): string {
        const resolved = path.resolve(projectRoot, configPath);
        if (!fs.existsSync(resolved)) throw new Error(`Configured Karate config path was not found: ${resolved}`);
        return fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
    }

    private static looksLikeRunnerClass(value: string): boolean {
        return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value) && !/\.(?:js|java)$/i.test(value);
    }

    private static isWithin(root: string, candidate: string): boolean {
        const relative = path.relative(root, path.resolve(candidate));
        return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    }
}
