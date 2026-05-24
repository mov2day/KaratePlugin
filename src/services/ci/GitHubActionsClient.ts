import axios, { AxiosInstance } from 'axios';
import { logger } from '../../utils/logger';

export interface WorkflowRunSummary {
    id: number;
    run_attempt?: number;
    name?: string;
    display_title?: string;
    html_url?: string;
    head_branch?: string;
    status?: string;
    conclusion?: string | null;
    updated_at?: string;
}

export interface WorkflowRunJobStep {
    name: string;
    number: number;
    conclusion?: string | null;
}

export interface WorkflowRunJob {
    id: number;
    name: string;
    conclusion?: string | null;
    steps?: WorkflowRunJobStep[];
}

export interface WorkflowRunArtifact {
    id: number;
    name: string;
    archive_download_url: string;
    expired: boolean;
}

export interface GitHubWorkflowSelection {
    owner: string;
    repo: string;
    workflow?: string;
    branch?: string;
    lookbackMinutes: number;
}

/**
 * Lightweight GitHub Actions REST client for CI pull-mode failure ingestion.
 */
export class GitHubActionsClient {
    private readonly api: AxiosInstance;

    constructor(private readonly token: string) {
        this.api = axios.create({
            baseURL: 'https://api.github.com',
            timeout: 30_000,
            headers: {
                'Accept': 'application/vnd.github+json',
                'Authorization': `Bearer ${token}`,
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });
    }

    async listFailedRuns(selection: GitHubWorkflowSelection): Promise<WorkflowRunSummary[]> {
        const { owner, repo, workflow, branch, lookbackMinutes } = selection;

        const path = workflow
            ? `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs`
            : `/repos/${owner}/${repo}/actions/runs`;

        const params: Record<string, string | number> = {
            status: 'failure',
            per_page: 30
        };
        if (branch) {
            params.branch = branch;
        }

        const response = await this.api.get(path, { params });
        const runs = (response.data?.workflow_runs || []) as WorkflowRunSummary[];
        const cutoff = Date.now() - (lookbackMinutes * 60_000);

        return runs.filter(run => {
            if (!run.updated_at) {
                return true;
            }
            return new Date(run.updated_at).getTime() >= cutoff;
        });
    }

    async listRunJobs(owner: string, repo: string, runId: number): Promise<WorkflowRunJob[]> {
        const response = await this.api.get(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs`, {
            params: { per_page: 100 }
        });
        return (response.data?.jobs || []) as WorkflowRunJob[];
    }

    async listRunArtifacts(owner: string, repo: string, runId: number): Promise<WorkflowRunArtifact[]> {
        const response = await this.api.get(`/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`, {
            params: { per_page: 100 }
        });
        return ((response.data?.artifacts || []) as WorkflowRunArtifact[]).filter(a => !a.expired);
    }

    async downloadArtifactArchive(owner: string, repo: string, artifactId: number): Promise<Buffer> {
        const response = await this.api.get(`/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`, {
            responseType: 'arraybuffer',
            maxRedirects: 5
        });
        return Buffer.from(response.data);
    }

    async downloadRunLogs(owner: string, repo: string, runId: number): Promise<Buffer> {
        const response = await this.api.get(`/repos/${owner}/${repo}/actions/runs/${runId}/logs`, {
            responseType: 'arraybuffer',
            maxRedirects: 5
        });
        return Buffer.from(response.data);
    }

    static isLikelyActionsConfigValid(selection: GitHubWorkflowSelection): boolean {
        return !!selection.owner && !!selection.repo && selection.lookbackMinutes > 0;
    }

    static toRunKey(run: WorkflowRunSummary): string {
        const attempt = run.run_attempt || 1;
        return `${run.id}:${attempt}`;
    }

    static logRunSummary(run: WorkflowRunSummary): void {
        logger.info(
            `GitHubActionsClient: run ${run.id} attempt=${run.run_attempt || 1} ` +
            `conclusion=${run.conclusion || 'unknown'} branch=${run.head_branch || 'unknown'}`
        );
    }
}

