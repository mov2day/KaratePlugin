import * as vscode from 'vscode';
import { TestExecutionResult } from '../../types';
import { logger } from '../../utils/logger';
import { WorkspaceEntityStore } from '../workspace/WorkspaceEntityStore';
import { toWorkspaceAbsolutePath, toWorkspaceRelativePath } from '../workspace/workspacePaths';
import { normalizeHistoryLimit } from './historyRetention';

/**
 * Manages test execution history and persistence
 */
export class TestHistoryService {
    private readonly store: WorkspaceEntityStore;

    constructor(private workspaceRoot: string) {
        this.store = new WorkspaceEntityStore(workspaceRoot);
    }

    /**
     * Ensure history directory exists
     */
    private ensureHistoryDir(): void {
        this.store.initialize();
    }

    /**
     * Save test execution result to history
     */
    async saveResult(result: TestExecutionResult): Promise<void> {
        try {
            this.ensureHistoryDir();
            this.store.save('runs', this.forWorkspaceStorage(result), result.id);
            logger.info(`Saved test result to history: ${result.id}.json`);

            // Clean up old history
            await this.cleanupOldHistory();
        } catch (error) {
            logger.error('Failed to save test result to history', error as Error);
        }
    }

    /**
     * Get all test execution history
     */
    async getHistory(limit?: number): Promise<TestExecutionResult[]> {
        try {
            this.ensureHistoryDir();

            const results = this.store.list<TestExecutionResult & { createdAt: number; updatedAt: number }>('runs')
                .sort((a, b) => b.timestamp - a.timestamp)
                .map(result => this.forExecution(result));
            return limit ? results.slice(0, limit) : results;
        } catch (error) {
            logger.error('Failed to get test history', error as Error);
            return [];
        }
    }

    /**
     * Get specific test execution result by ID
     */
    async getResultById(id: string): Promise<TestExecutionResult | null> {
        try {
            const result = this.store.get<TestExecutionResult>('runs', id);
            return result ? this.forExecution(result) : null;
        } catch (error) {
            logger.error(`Failed to get test result: ${id}`, error as Error);
            return null;
        }
    }

    /**
     * Get latest test execution result
     */
    async getLatestResult(): Promise<TestExecutionResult | null> {
        const history = await this.getHistory(1);
        return history.length > 0 ? history[0] : null;
    }

    /**
     * Clean up old history files
     */
    private async cleanupOldHistory(): Promise<void> {
        try {
            const configuredLimit = vscode.workspace.getConfiguration('karateDsl').get<number>('execution.historyLimit', 50);
            const historyLimit = normalizeHistoryLimit(configuredLimit);
            const runs = this.store.list<TestExecutionResult & { id: string }>('runs')
                .sort((a, b) => b.timestamp - a.timestamp);
            for (const staleRun of runs.slice(historyLimit)) {
                this.store.remove('runs', staleRun.id);
                logger.info(`Removed old history file: ${staleRun.id}.json`);
            }
        } catch (error) {
            logger.warn('Failed to cleanup old history', error as Error);
        }
    }

    /**
     * Workspace state is Git-tracked and therefore must not bind a teammate's
     * history to this machine. Persist only paths relative to the workspace.
     */
    private forWorkspaceStorage(result: TestExecutionResult): TestExecutionResult {
        const options = result.options;
        return {
            ...result,
            options: {
                ...options,
                target: Array.isArray(options.target)
                    ? options.target.map(target => this.toRelativePath(target))
                    : this.toRelativePath(options.target),
                workingDirectory: options.workingDirectory ? this.toRelativePath(options.workingDirectory) : undefined
            }
        };
    }

    /** Rehydrate persisted run targets only at the execution-service boundary. */
    private forExecution(result: TestExecutionResult): TestExecutionResult {
        const options = result.options;
        return {
            ...result,
            options: {
                ...options,
                target: Array.isArray(options.target)
                    ? options.target.map(target => this.toAbsolutePath(target))
                    : this.toAbsolutePath(options.target),
                workingDirectory: options.workingDirectory ? this.toAbsolutePath(options.workingDirectory) : undefined
            }
        };
    }

    private toRelativePath(value: string): string {
        return toWorkspaceRelativePath(this.workspaceRoot, value);
    }

    private toAbsolutePath(value: string): string {
        return toWorkspaceAbsolutePath(this.workspaceRoot, value);
    }

    /**
     * Clear all history
     */
    async clearHistory(): Promise<void> {
        try {
            for (const run of this.store.list<TestExecutionResult & { id: string }>('runs')) this.store.remove('runs', run.id);
            logger.info('Cleared test execution history');
        } catch (error) {
            logger.error('Failed to clear history', error as Error);
        }
    }

    /**
     * Get test execution statistics over time
     */
    async getStatistics(): Promise<{
        totalExecutions: number;
        averagePassRate: number;
        trend: 'improving' | 'declining' | 'stable';
    }> {
        const history = await this.getHistory(10); // Last 10 runs

        if (history.length === 0) {
            return {
                totalExecutions: 0,
                averagePassRate: 0,
                trend: 'stable'
            };
        }

        const totalExecutions = history.length;
        const averagePassRate = history.reduce((sum, r) => sum + r.summary.passPercentage, 0) / totalExecutions;

        // Determine trend (compare first half vs second half)
        const midPoint = Math.floor(history.length / 2);
        const firstHalfAvg = history.slice(0, midPoint)
            .reduce((sum, r) => sum + r.summary.passPercentage, 0) / midPoint;
        const secondHalfAvg = history.slice(midPoint)
            .reduce((sum, r) => sum + r.summary.passPercentage, 0) / (history.length - midPoint);

        let trend: 'improving' | 'declining' | 'stable' = 'stable';
        if (secondHalfAvg > firstHalfAvg + 5) {
            trend = 'improving';
        } else if (secondHalfAvg < firstHalfAvg - 5) {
            trend = 'declining';
        }

        return {
            totalExecutions,
            averagePassRate: Math.round(averagePassRate * 100) / 100,
            trend
        };
    }
}
