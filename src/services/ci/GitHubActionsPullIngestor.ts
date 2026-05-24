import * as vscode from 'vscode';
import {
    GitHubActionsClient,
    GitHubWorkflowSelection,
    WorkflowRunArtifact,
    WorkflowRunSummary
} from './GitHubActionsClient';
import { CiFailureExtractor, DownloadedArtifact } from './CiFailureExtractor';
import { CIFailurePayload } from './CIFailureIngestor';
import { logger } from '../../utils/logger';

interface GitHubPullConfig {
    owner: string;
    repo: string;
    workflow?: string;
    branch: string;
    pollIntervalSec: number;
    artifactNamePattern: string;
    lookbackMinutes: number;
}

/**
 * Pulls failed GitHub Actions runs and emits CIFailurePayload events for repair flow.
 */
export class GitHubActionsPullIngestor implements vscode.Disposable {
    private static readonly GITHUB_TOKEN_KEY = 'karateDsl.github.token';
    private static readonly PROCESSED_RUNS_KEY = 'ciRepair.github.processedRuns';
    private static readonly MAX_PROCESSED_RUNS = 300;

    private timer: NodeJS.Timeout | undefined;
    private polling = false;
    private warnedMissingToken = false;

    private readonly extractor = new CiFailureExtractor();
    private readonly _onFailureReceived = new vscode.EventEmitter<CIFailurePayload>();
    readonly onFailureReceived = this._onFailureReceived.event;

    constructor(private readonly context: vscode.ExtensionContext) { }

    start(): void {
        if (this.timer) {
            return;
        }

        const config = this.getConfig();
        if (!this.isConfigured(config)) {
            logger.warn('GitHubActionsPullIngestor: owner/repo not configured, pull mode disabled');
            return;
        }

        const intervalMs = Math.max(30, config.pollIntervalSec) * 1000;
        void this.pollOnce();
        this.timer = setInterval(() => {
            void this.pollOnce();
        }, intervalMs);

        logger.info(`GitHubActionsPullIngestor: started polling every ${Math.max(30, config.pollIntervalSec)}s`);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
            logger.info('GitHubActionsPullIngestor: stopped');
        }
    }

    isRunning(): boolean {
        return !!this.timer;
    }

    async pollOnce(): Promise<void> {
        if (this.polling) {
            return;
        }

        this.polling = true;
        try {
            const token = await this.context.secrets.get(GitHubActionsPullIngestor.GITHUB_TOKEN_KEY);
            if (!token) {
                if (!this.warnedMissingToken) {
                    this.warnedMissingToken = true;
                    logger.warn('GitHubActionsPullIngestor: GitHub token missing; run karate-dsl.setGitHubToken');
                }
                return;
            }

            const config = this.getConfig();
            if (!this.isConfigured(config)) {
                return;
            }

            const client = new GitHubActionsClient(token);
            const selection: GitHubWorkflowSelection = {
                owner: config.owner,
                repo: config.repo,
                workflow: config.workflow,
                branch: config.branch,
                lookbackMinutes: config.lookbackMinutes
            };

            const runs = await client.listFailedRuns(selection);
            if (runs.length === 0) {
                return;
            }

            const processed = await this.getProcessedRuns();
            const processedSet = new Set<string>(processed);
            const sortedRuns = this.sortRunsNewestFirst(runs);

            for (const run of sortedRuns) {
                const runKey = GitHubActionsClient.toRunKey(run);
                if (processedSet.has(runKey)) {
                    continue;
                }

                GitHubActionsClient.logRunSummary(run);

                try {
                    const payload = await this.extractPayloadForRun(client, config, run);
                    if (payload) {
                        this._onFailureReceived.fire(payload);
                        processedSet.add(runKey);
                    } else {
                        logger.warn(`GitHubActionsPullIngestor: no repair payload extracted for run ${run.id}; will retry on next poll`);
                    }
                } catch (error) {
                    logger.error(`GitHubActionsPullIngestor: failed processing run ${run.id}`, error as Error);
                }
            }

            await this.setProcessedRuns(Array.from(processedSet));
        } catch (error) {
            logger.error('GitHubActionsPullIngestor: poll cycle failed', error as Error);
        } finally {
            this.polling = false;
        }
    }

    private async extractPayloadForRun(
        client: GitHubActionsClient,
        config: GitHubPullConfig,
        run: WorkflowRunSummary
    ): Promise<CIFailurePayload | null> {
        const jobs = await client.listRunJobs(config.owner, config.repo, run.id);
        const artifactsMeta = await client.listRunArtifacts(config.owner, config.repo, run.id);
        const artifacts = await this.downloadArtifacts(client, config.owner, config.repo, artifactsMeta, config.artifactNamePattern);

        let logsArchive: Buffer | undefined;
        try {
            logsArchive = await client.downloadRunLogs(config.owner, config.repo, run.id);
        } catch (error) {
            logger.warn(`GitHubActionsPullIngestor: unable to download logs for run ${run.id}`, error as Error);
        }

        return this.extractor.extract({
            run,
            jobs,
            artifacts,
            logsArchive,
            artifactNamePattern: config.artifactNamePattern
        });
    }

    private async downloadArtifacts(
        client: GitHubActionsClient,
        owner: string,
        repo: string,
        artifacts: WorkflowRunArtifact[],
        artifactNamePattern: string
    ): Promise<DownloadedArtifact[]> {
        const matcher = this.compileArtifactPattern(artifactNamePattern);
        const selected = artifacts.filter(a => matcher.test(a.name)).slice(0, 8);
        const downloaded: DownloadedArtifact[] = [];

        for (const artifact of selected) {
            try {
                const archive = await client.downloadArtifactArchive(owner, repo, artifact.id);
                downloaded.push({ name: artifact.name, archive });
            } catch (error) {
                logger.warn(`GitHubActionsPullIngestor: failed downloading artifact ${artifact.name}`, error as Error);
            }
        }

        return downloaded;
    }

    private compileArtifactPattern(pattern: string): RegExp {
        try {
            return new RegExp(pattern, 'i');
        } catch {
            return /karate|junit|test|report/i;
        }
    }

    private getConfig(): GitHubPullConfig {
        const config = vscode.workspace.getConfiguration('karateDsl');
        return {
            owner: config.get<string>('ciRepair.github.owner', '').trim(),
            repo: config.get<string>('ciRepair.github.repo', '').trim(),
            workflow: config.get<string>('ciRepair.github.workflow', '').trim() || undefined,
            branch: config.get<string>('ciRepair.github.branch', 'main').trim() || 'main',
            pollIntervalSec: config.get<number>('ciRepair.github.pollIntervalSec', 90),
            artifactNamePattern: config.get<string>('ciRepair.github.artifactNamePattern', 'karate|junit|test|report'),
            lookbackMinutes: config.get<number>('ciRepair.github.lookbackMinutes', 120)
        };
    }

    private isConfigured(config: GitHubPullConfig): boolean {
        return !!config.owner && !!config.repo;
    }

    private sortRunsNewestFirst(runs: WorkflowRunSummary[]): WorkflowRunSummary[] {
        return [...runs].sort((a, b) => {
            const aTime = a.updated_at ? new Date(a.updated_at).getTime() : 0;
            const bTime = b.updated_at ? new Date(b.updated_at).getTime() : 0;
            return bTime - aTime;
        });
    }

    private async getProcessedRuns(): Promise<string[]> {
        const workspaceRuns = this.context.workspaceState.get<string[]>(GitHubActionsPullIngestor.PROCESSED_RUNS_KEY, []);
        const globalRuns = this.context.globalState.get<string[]>(GitHubActionsPullIngestor.PROCESSED_RUNS_KEY, []);
        return Array.from(new Set([...workspaceRuns, ...globalRuns]));
    }

    private async setProcessedRuns(runKeys: string[]): Promise<void> {
        const trimmed = runKeys.slice(-GitHubActionsPullIngestor.MAX_PROCESSED_RUNS);
        await this.context.workspaceState.update(GitHubActionsPullIngestor.PROCESSED_RUNS_KEY, trimmed);
        await this.context.globalState.update(GitHubActionsPullIngestor.PROCESSED_RUNS_KEY, trimmed);
    }

    dispose(): void {
        this.stop();
        this._onFailureReceived.dispose();
    }
}
