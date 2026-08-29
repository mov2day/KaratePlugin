import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TestExecutionOptions } from '../../types';
import { logger } from '../../utils/logger';
import { ConfigDiscovery } from './ConfigDiscovery';
import { buildKarateArguments, normalizedFeaturePath, serializeKarateOptions } from './ExecutionArguments';
import { ExecutionRuntimeSettings } from './ExecutionSettings';
import { ProcessResult, ProcessRunner } from './ProcessRunner';
import { ResolvedExecutionProject } from './ProjectExecutionResolver';

export interface BuildToolConfig {
    toolType: 'maven' | 'gradle';
    executable: string;
    buildFile: string;
}

export interface CommandPlan {
    executable: string;
    args: string[];
    cwd: string;
    environment?: NodeJS.ProcessEnv;
}

export class BuildToolExecutor {
    static detectBuildTool(workingDirectory: string): BuildToolConfig | null {
        const pom = path.join(workingDirectory, 'pom.xml');
        if (fs.existsSync(pom)) return { toolType: 'maven', executable: this.mavenExecutable(workingDirectory), buildFile: pom };
        const gradle = ['build.gradle', 'build.gradle.kts'].map(file => path.join(workingDirectory, file)).find(fs.existsSync);
        return gradle ? { toolType: 'gradle', executable: this.gradleExecutable(workingDirectory), buildFile: gradle } : null;
    }

    static buildMavenPlan(options: TestExecutionOptions, project: ResolvedExecutionProject, settings: ExecutionRuntimeSettings, outputDirectory: string): CommandPlan {
        const args = [settings.mavenGoal || 'test'];
        const runner = this.resolveRunner(options, project);
        if (runner) args.push(`-Dtest=${runner}${project.runnerMethod ? `#${project.runnerMethod}` : ''}`);
        args.push(`-Dkarate.options=${serializeKarateOptions([...buildKarateArguments(options, project.configDir), ...settings.karateArgs])}`);
        args.push(`-Dkarate.output.dir=${outputDirectory}`);
        this.addSystemProperties(args, options, settings);
        if (settings.jvmArgs.length) args.push(`-DargLine=${settings.jvmArgs.join(' ')}`);
        return { executable: this.mavenExecutable(project.projectRoot), args, cwd: project.projectRoot };
    }

    static buildGradlePlan(options: TestExecutionOptions, project: ResolvedExecutionProject, settings: ExecutionRuntimeSettings, outputDirectory: string): CommandPlan {
        const args = [settings.gradleTask || 'test'];
        const runner = this.resolveRunner(options, project);
        if (runner) args.push('--tests', `${runner}${project.runnerMethod ? `.${project.runnerMethod}` : ''}`);
        args.push(`-Dkarate.options=${serializeKarateOptions([...buildKarateArguments(options, project.configDir), ...settings.karateArgs])}`);
        args.push(`-Dkarate.output.dir=${outputDirectory}`);
        this.addSystemProperties(args, options, settings);
        const environment = settings.jvmArgs.length
            ? { JAVA_TOOL_OPTIONS: [process.env.JAVA_TOOL_OPTIONS, ...settings.jvmArgs].filter(Boolean).join(' ') }
            : undefined;
        return { executable: this.gradleExecutable(project.projectRoot), args, cwd: project.projectRoot, environment };
    }

    static execute(plan: CommandPlan, cancellationToken?: vscode.CancellationToken): Promise<ProcessResult> {
        logger.info(`Executing ${path.basename(plan.executable)} in ${plan.cwd}`);
        return ProcessRunner.run(plan.executable, plan.args, plan.cwd, cancellationToken, plan.environment);
    }

    private static resolveRunner(options: TestExecutionOptions, project: ResolvedExecutionProject): string | undefined {
        if (project.runnerClass) return project.runnerClass;
        const runners = ConfigDiscovery.findRunnerClasses(project.projectRoot);
        if (options.type === 'feature' || options.type === 'scenario') {
            const feature = normalizedFeaturePath(options);
            const matched = feature ? ConfigDiscovery.getRunnerForFeature(project.projectRoot, feature) : undefined;
            if (matched) return matched;
            if (runners.length > 1) throw new Error(`Multiple Karate runners match this project (${runners.join(', ')}). Configure karateDsl.execution.runnerClass.`);
        }
        return runners.length === 1 ? runners[0] : undefined;
    }

    private static addSystemProperties(args: string[], options: TestExecutionOptions, settings: ExecutionRuntimeSettings): void {
        for (const [key, value] of Object.entries(settings.systemProperties)) args.push(`-D${key}=${value}`);
        if (options.environment && !settings.systemProperties['karate.env']) args.push(`-Dkarate.env=${options.environment}`);
    }

    private static mavenExecutable(root: string): string {
        if (process.platform === 'win32' && fs.existsSync(path.join(root, 'mvnw.cmd'))) return path.join(root, 'mvnw.cmd');
        if (fs.existsSync(path.join(root, 'mvnw'))) return path.join(root, 'mvnw');
        return process.platform === 'win32' ? 'mvn.cmd' : 'mvn';
    }

    private static gradleExecutable(root: string): string {
        if (process.platform === 'win32' && fs.existsSync(path.join(root, 'gradlew.bat'))) return path.join(root, 'gradlew.bat');
        if (fs.existsSync(path.join(root, 'gradlew'))) return path.join(root, 'gradlew');
        return process.platform === 'win32' ? 'gradle.bat' : 'gradle';
    }
}
