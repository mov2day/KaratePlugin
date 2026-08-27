import * as vscode from 'vscode';
import { WorkspaceEntityStore } from './WorkspaceEntityStore';
import { FlakinessAnalyzer, FlakinessTier } from '../flakiness/FlakinessAnalyzer';

export interface ManagementSnapshot {
    folderName: string;
    featureCount: number;
    runs: Array<Record<string, unknown>>;
    findings: Array<Record<string, unknown>>;
    runProfiles: Array<Record<string, unknown>>;
    environments: Array<Record<string, unknown>>;
    coverageReports: Array<Record<string, unknown>>;
    healthReports: Array<Record<string, unknown>>;
    features: Array<{ path: string; scenarios: Array<{ name: string; tags: string[]; line: number; owner?: string; status?: string; zephyrKey?: string; flakiness?: number; flakinessTier?: FlakinessTier; flakinessRuns?: number }> }>;
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
    private coverageReports: Array<Record<string, unknown>> = [];
    private healthReports: Array<Record<string, unknown>> = [];
    private featureCount = 0;
    private features: Array<{ path: string; scenarios: Array<{ name: string; tags: string[]; line: number; owner?: string; status?: string; zephyrKey?: string; flakiness?: number; flakinessTier?: FlakinessTier; flakinessRuns?: number }> }> = [];
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
            coverageReports: this.coverageReports,
            healthReports: this.healthReports,
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
        const actions = this.store.list<Record<string, unknown>>('actions');
        this.coverageReports = actions
            .filter(action => action.kind === 'coverage-report')
            .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
            .slice(0, 10);
        this.healthReports = actions
            .filter(action => action.kind === 'health-report')
            .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
            .slice(0, 10);
        const flakiness = this.indexFlakiness();
        const traceability = new Map(this.store.list<{ featurePath?: string; scenarioName?: string; owner?: string; status?: string; zephyrKey?: string }>('traceability')
            .filter(item => item.featurePath && item.scenarioName)
            .map(item => [`${item.featurePath}\u0000${item.scenarioName}`, item]));
        const featureUris = await vscode.workspace.findFiles(new vscode.RelativePattern(this.folder, '**/*.feature'), '**/{node_modules,.git}/**');
        this.featureCount = featureUris.length;
        this.features = await Promise.all(featureUris.slice(0, 1500).map(async uri => {
            const document = await vscode.workspace.openTextDocument(uri);
            const tags: string[] = [];
            const scenarios: Array<{ name: string; tags: string[]; line: number; owner?: string; status?: string; zephyrKey?: string; flakiness?: number; flakinessTier?: FlakinessTier; flakinessRuns?: number }> = [];
            document.getText().split(/\r?\n/).forEach((line, index) => {
                const trimmed = line.trim();
                if (trimmed.startsWith('@')) {
                    tags.push(...trimmed.split(/\s+/));
                    return;
                }
                const header = trimmed.match(/^Scenario(?: Outline)?:\s*(.+)$/);
                if (header) {
                    const name = header[1].trim();
                    const featurePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
                    const linked = traceability.get(`${featurePath}\u0000${name}`);
                    const stability = flakiness.get(`${featurePath}\u0000${name}`);
                    scenarios.push({ name, tags: [...tags], line: index + 1, owner: linked?.owner, status: linked?.status, zephyrKey: linked?.zephyrKey, ...stability });
                    tags.length = 0;
                } else if (trimmed && !trimmed.startsWith('#')) {
                    tags.length = 0;
                }
            });
            return { path: vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/'), scenarios };
        }));
        this.updateEmitter.fire(this.snapshot());
    }

    /** Derive per-scenario stability from indexed history without reopening history files. */
    private indexFlakiness(): Map<string, { flakiness: number; flakinessTier: FlakinessTier; flakinessRuns: number }> {
        const outcomes = new Map<string, Array<{ timestamp: number; status: string }>>();
        for (const run of this.runs) {
            const timestamp = Number(run.timestamp || 0);
            const features = Array.isArray(run.features) ? run.features : [];
            for (const feature of features) {
                if (!feature || typeof feature !== 'object') continue;
                const source = feature as Record<string, unknown>;
                const featurePath = String(source.relativePath || source.name || '').replace(/\\/g, '/');
                const scenarios = Array.isArray(source.scenarios) ? source.scenarios : [];
                for (const scenario of scenarios) {
                    if (!scenario || typeof scenario !== 'object') continue;
                    const item = scenario as Record<string, unknown>;
                    if (typeof item.name !== 'string' || typeof item.status !== 'string') continue;
                    const key = `${featurePath}\u0000${item.name}`;
                    const history = outcomes.get(key) || [];
                    history.push({ timestamp, status: item.status });
                    outcomes.set(key, history);
                }
            }
        }
        const analyzer = new FlakinessAnalyzer();
        const thresholds = FlakinessAnalyzer.getConfiguredThresholds();
        const result = new Map<string, { flakiness: number; flakinessTier: FlakinessTier; flakinessRuns: number }>();
        for (const [key, history] of outcomes) {
            const recent = history.sort((left, right) => right.timestamp - left.timestamp).slice(0, 20);
            if (recent.length < 2) continue;
            const passRate = recent.filter(item => item.status === 'passed').length / recent.length;
            const score = analyzer.computeFlakiness(passRate);
            result.set(key, { flakiness: score, flakinessTier: analyzer.getTier(score, thresholds), flakinessRuns: recent.length });
        }
        return result;
    }
}
