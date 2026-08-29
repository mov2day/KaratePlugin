import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';
import { logger } from '../../utils/logger';

export interface ProcessResult {
    success: boolean;
    output: string;
    exitCode: number | null;
}

export class ProcessRunner {
    static run(executable: string, args: string[], cwd: string, cancellationToken?: vscode.CancellationToken, environment?: NodeJS.ProcessEnv): Promise<ProcessResult> {
        return new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            const child: ChildProcess = spawn(executable, args, {
                cwd,
                shell: false,
                detached: process.platform !== 'win32',
                env: environment ? { ...process.env, ...environment } : process.env
            });
            const cancellation = cancellationToken?.onCancellationRequested(() => {
                this.terminate(child);
                reject(new vscode.CancellationError());
            });
            child.stdout?.on('data', data => {
                const value = data.toString();
                stdout += value;
                logger.info(value);
            });
            child.stderr?.on('data', data => {
                const value = data.toString();
                stderr += value;
                logger.warn(value);
            });
            child.on('error', error => {
                cancellation?.dispose();
                reject(error);
            });
            child.on('close', code => {
                cancellation?.dispose();
                resolve({ success: code === 0, output: `${stdout}\n${stderr}`.trim(), exitCode: code });
            });
        });
    }

    private static terminate(child: ChildProcess): void {
        if (!child.pid) return;
        try {
            if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true });
            else process.kill(-child.pid, 'SIGTERM');
        } catch {
            child.kill('SIGTERM');
        }
    }
}
