import * as vscode from 'vscode';
import { WorkspaceEntityStore } from './WorkspaceEntityStore';

export interface ManagementSnapshot {
    folderName: string;
    featureCount: number;
    runs: Array<Record<string, unknown>>;
    findings: Array<Record<string, unknown>>;
}

/** Keeps UI queries off the filesystem hot path and refreshes on editor or Git file changes. */
export class WorkspaceIndex implements vscode.Disposable {
    private readonly store: WorkspaceEntityStore;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly updateEmitter = new vscode.EventEmitter<ManagementSnapshot>();
    readonly onDidUpdate = this.updateEmitter.event;
    private runs: Array<Record<string, unknown>> = [];
    private findings: Array<Record<string, unknown>> = [];
    private featureCount = 0;
    private refreshTimer: NodeJS.Timeout | undefined;

    constructor(private readonly folder: vscode.WorkspaceFolder) {
        this.store = new WorkspaceEntityStore(folder.uri.fsPath);
        const managementFiles = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.karate-test-management/**/*.json'));
        const features = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*.feature'));
        for (const watcher of [managementFiles, features]) {
            this.disposables.push(watcher, watcher.onDidCreate(() => this.scheduleRefresh()), watcher.onDidChange(() => this.scheduleRefresh()), watcher.onDidDelete(() => this.scheduleRefresh()));
        }
    }

    async initialize(): Promise<void> {
        await this.refresh();
    }

    snapshot(): ManagementSnapshot {
        return { folderName: this.folder.name, featureCount: this.featureCount, runs: this.runs, findings: this.findings };
    }

    dispose(): void {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.updateEmitter.dispose();
        this.disposables.forEach(disposable => disposable.dispose());
    }

    private scheduleRefresh(): void {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => void this.refresh(), 150);
    }

    private async refresh(): Promise<void> {
        this.runs = this.store.list<Record<string, unknown>>('runs')
            .sort((left, right) => Number(right.timestamp || 0) - Number(left.timestamp || 0)).slice(0, 100);
        this.findings = this.store.list<Record<string, unknown>>('findings').slice(0, 500);
        this.featureCount = (await vscode.workspace.findFiles(new vscode.RelativePattern(this.folder, '**/*.feature'), '**/{node_modules,.git}/**')).length;
        this.updateEmitter.fire(this.snapshot());
    }
}
