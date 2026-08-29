import * as vscode from 'vscode';
import { ExecutionPreferences } from './ProjectExecutionResolver';

export interface ExecutionRuntimeSettings extends ExecutionPreferences {
    systemProperties: Record<string, string>;
    jvmArgs: string[];
    karateArgs: string[];
    additionalClasspath: string[];
    jarPath: string;
    karateVersion: string;
    mavenGoal: string;
    gradleTask: string;
}

export function readExecutionSettings(scopePath: string): ExecutionRuntimeSettings {
    const config = vscode.workspace.getConfiguration('karateDsl.execution', vscode.Uri.file(scopePath));
    return {
        defaultBuildTool: config.get<'auto' | 'cli' | 'maven' | 'gradle'>('defaultBuildTool', 'auto'),
        runnerClass: config.get<string>('runnerClass', ''),
        runnerMethod: config.get<string>('runnerMethod', ''),
        configPath: config.get<string>('configPath', ''),
        systemProperties: config.get<Record<string, string>>('systemProperties', {}),
        jvmArgs: config.get<string[]>('jvmArgs', []),
        karateArgs: config.get<string[]>('karateArgs', []),
        additionalClasspath: config.get<string[]>('additionalClasspath', []),
        jarPath: config.get<string>('jarPath', ''),
        karateVersion: config.get<string>('karateVersion', ''),
        mavenGoal: config.get<string>('mavenGoal', 'test'),
        gradleTask: config.get<string>('gradleTask', 'test')
    };
}
