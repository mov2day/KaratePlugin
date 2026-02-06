import * as fs from 'fs';
import * as path from 'path';
import { TestExecutionResult } from '../../types';
import { logger } from '../../utils/logger';

/**
 * Manages test execution history and persistence
 */
export class TestHistoryService {
    private static readonly HISTORY_DIR = '.karate-test-history';
    private static readonly MAX_HISTORY_ITEMS = 50; // Keep last 50 executions

    constructor(private workspaceRoot: string) { }

    /**
     * Get history directory path
     */
    private getHistoryDir(): string {
        return path.join(this.workspaceRoot, TestHistoryService.HISTORY_DIR);
    }

    /**
     * Ensure history directory exists
     */
    private ensureHistoryDir(): void {
        const historyDir = this.getHistoryDir();
        if (!fs.existsSync(historyDir)) {
            fs.mkdirSync(historyDir, { recursive: true });
        }
    }

    /**
     * Save test execution result to history
     */
    async saveResult(result: TestExecutionResult): Promise<void> {
        try {
            this.ensureHistoryDir();

            const filename = `${result.id}.json`;
            const filepath = path.join(this.getHistoryDir(), filename);

            fs.writeFileSync(filepath, JSON.stringify(result, null, 2));
            logger.info(`Saved test result to history: ${filename}`);

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

            const historyDir = this.getHistoryDir();
            const files = fs.readdirSync(historyDir)
                .filter(f => f.endsWith('.json'))
                .map(f => path.join(historyDir, f));

            // Sort by modified time (newest first)
            files.sort((a, b) => {
                const statA = fs.statSync(a);
                const statB = fs.statSync(b);
                return statB.mtimeMs - statA.mtimeMs;
            });

            // Apply limit
            const limitedFiles = limit ? files.slice(0, limit) : files;

            // Read and parse results
            const results: TestExecutionResult[] = [];
            for (const file of limitedFiles) {
                try {
                    const content = fs.readFileSync(file, 'utf-8');
                    const result = JSON.parse(content) as TestExecutionResult;
                    results.push(result);
                } catch (error) {
                    logger.warn(`Failed to parse history file: ${file}`);
                }
            }

            return results;
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
            const filepath = path.join(this.getHistoryDir(), `${id}.json`);

            if (!fs.existsSync(filepath)) {
                return null;
            }

            const content = fs.readFileSync(filepath, 'utf-8');
            return JSON.parse(content) as TestExecutionResult;
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
            const historyDir = this.getHistoryDir();
            const files = fs.readdirSync(historyDir)
                .filter(f => f.endsWith('.json'))
                .map(f => ({
                    path: path.join(historyDir, f),
                    mtime: fs.statSync(path.join(historyDir, f)).mtimeMs
                }));

            // Sort by modified time (oldest first)
            files.sort((a, b) => a.mtime - b.mtime);

            // Remove oldest files if exceeding limit
            if (files.length > TestHistoryService.MAX_HISTORY_ITEMS) {
                const filesToRemove = files.slice(0, files.length - TestHistoryService.MAX_HISTORY_ITEMS);
                for (const file of filesToRemove) {
                    fs.unlinkSync(file.path);
                    logger.info(`Removed old history file: ${path.basename(file.path)}`);
                }
            }
        } catch (error) {
            logger.warn('Failed to cleanup old history', error as Error);
        }
    }

    /**
     * Clear all history
     */
    async clearHistory(): Promise<void> {
        try {
            const historyDir = this.getHistoryDir();

            if (fs.existsSync(historyDir)) {
                const files = fs.readdirSync(historyDir)
                    .filter(f => f.endsWith('.json'));

                for (const file of files) {
                    fs.unlinkSync(path.join(historyDir, file));
                }

                logger.info('Cleared test execution history');
            }
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
