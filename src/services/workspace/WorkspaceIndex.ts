import * as vscode from 'vscode';
import { WorkspaceEntityStore } from './WorkspaceEntityStore';

export interface ManagementSnapshot {
    folderName: string;
    featureCount: number;
    runs: Array<Record<string, unknown>>;
    findings: Array<Record<string, unknown>>;
    runProfiles: Array<Record<string, unknown>>;
    environments: Array<Record<string, unknown>>;
    features: Array<{ path: string; scenarios: Array<{ name: string; tags: string[]; line: number }> }>;
}

/** Keeps UI queries off the filesystem hot path and refreshes on editor or Git file changes. */
export class WorkspaceIndex implements vscode.Disposable {
    private readonly store: WorkspaceEntityStore;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly updateEmitter = new vscode.EventEmitter<ManagementSnapshot>();
    readonly onDidUpdate = this.updateEmitter.event;
    private runs: Array<Record<string, unknown>> = [];
    private findings: Array<Record<string, unknown>> = [];
    private runProfiles: Array<Record<string, unknown>> = [];
    private environments: Array<Record<string, unknown>> = [];
    private featureCount = 0;
    private features: Array<{ path: string; scenarios: Array<{ name: string; tags: string[]; line: number }> }> = [];
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
        return {
            folderName: this.folder.name,
            featureCount: this.featureCount,
            runs: this.runs,
            findings: this.findings,
            runProfiles: this.runProfiles,
            environments: this.environments,
            features: this.features
        };
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
        this.runProfiles = this.store.list<Record<string, unknown>>('run-profiles')
            .sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
        this.environments = this.store.list<Record<string, unknown>>('environments')
            .sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
        const featureUris = await vscode.workspace.findFiles(new vscode.RelativePattern(this.folder, '**/*.feature'), '**/{node_modules,.git}/**');
        this.featureCount = featureUris.length;
        this.features = await Promise.all(featureUris.slice(0, 1500).map(async uri => {
            const document = await vscode.workspace.openTextDocument(uri);
            const tags: string[] = [];
            const scenarios: Array<{ name: string; tags: string[]; line: number }> = [];
            document.getText().split(/\r?\n/).forEach((line, index) => {
                const trimmed = line.trim();
                if (trimmed.startsWith('@')) {
                    tags.push(...trimmed.split(/\s+/));
                    return;
                }
                const header = trimmed.match(/^Scenario(?: Outline)?:\s*(.+)$/);
                if (header) {
                    scenarios.push({ name: header[1].trim(), tags: [...tags], line: index + 1 });
                    tags.length = 0;
                } else if (trimmed && !trimmed.startsWith('#')) {
                    tags.length = 0;
                }
            });
            return { path: vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/'), scenarios };
        }));
        this.updateEmitter.fire(this.snapshot());
    }
}
