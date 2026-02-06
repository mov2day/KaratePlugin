import { TestExecutionResult, TestSummary } from '../../types';

/**
 * Compares test execution results across runs
 */
export class TestResultComparator {
    /**
     * Compare two test execution results
     */
    static compare(current: TestExecutionResult, previous: TestExecutionResult): ComparisonResult {
        const newlyFailing = this.findNewlyFailingScenarios(current, previous);
        const newlyPassing = this.findNewlyPassingScenarios(current, previous);
        const stillFailing = this.findStillFailingScenarios(current, previous);

        return {
            current,
            previous,
            newlyFailing,
            newlyPassing,
            stillFailing,
            passRateChange: current.summary.passPercentage - previous.summary.passPercentage,
            improved: current.summary.passPercentage > previous.summary.passPercentage,
            degraded: current.summary.passPercentage < previous.summary.passPercentage
        };
    }

    /**
     * Find scenarios that are newly failing
     */
    private static findNewlyFailingScenarios(current: TestExecutionResult, previous: TestExecutionResult): FailedScenario[] {
        const newly: FailedScenario[] = [];

        for (const feature of current.features) {
            const prevFeature = previous.features.find(f => f.relativePath === feature.relativePath);
            if (!prevFeature) continue;

            for (const scenario of feature.scenarios) {
                if (scenario.status !== 'failed') continue;

                const prevScenario = prevFeature.scenarios.find(s => s.name === scenario.name);
                if (prevScenario && prevScenario.status !== 'failed') {
                    newly.push({
                        featureName: feature.name,
                        scenarioName: scenario.name,
                        error: scenario.error || 'Unknown error',
                        line: scenario.line
                    });
                }
            }
        }

        return newly;
    }

    /**
     * Find scenarios that are newly passing
     */
    private static findNewlyPassingScenarios(current: TestExecutionResult, previous: TestExecutionResult): PassedScenario[] {
        const newly: PassedScenario[] = [];

        for (const feature of current.features) {
            const prevFeature = previous.features.find(f => f.relativePath === feature.relativePath);
            if (!prevFeature) continue;

            for (const scenario of feature.scenarios) {
                if (scenario.status !== 'passed') continue;

                const prevScenario = prevFeature.scenarios.find(s => s.name === scenario.name);
                if (prevScenario && prevScenario.status === 'failed') {
                    newly.push({
                        featureName: feature.name,
                        scenarioName: scenario.name,
                        line: scenario.line
                    });
                }
            }
        }

        return newly;
    }

    /**
     * Find scenarios that are still failing
     */
    private static findStillFailingScenarios(current: TestExecutionResult, previous: TestExecutionResult): FailedScenario[] {
        const still: FailedScenario[] = [];

        for (const feature of current.features) {
            const prevFeature = previous.features.find(f => f.relativePath === feature.relativePath);
            if (!prevFeature) continue;

            for (const scenario of feature.scenarios) {
                if (scenario.status !== 'failed') continue;

                const prevScenario = prevFeature.scenarios.find(s => s.name === scenario.name);
                if (prevScenario && prevScenario.status === 'failed') {
                    still.push({
                        featureName: feature.name,
                        scenarioName: scenario.name,
                        error: scenario.error || 'Unknown error',
                        line: scenario.line
                    });
                }
            }
        }

        return still;
    }

    /**
     * Calculate trend over multiple runs
     */
    static calculateTrend(results: TestExecutionResult[]): TrendData {
        if (results.length === 0) {
            return { points: [], trend: 'stable', averagePassRate: 0 };
        }

        const points = results.map(r => ({
            timestamp: r.timestamp,
            passRate: r.summary.passPercentage,
            passed: r.summary.passed,
            failed: r.summary.failed,
            total: r.summary.totalScenarios
        }));

        // Calculate average
        const averagePassRate = points.reduce((sum, p) => sum + p.passRate, 0) / points.length;

        // Determine trend
        let trend: 'improving' | 'declining' | 'stable' = 'stable';
        if (points.length >= 3) {
            const firstThird = points.slice(0, Math.floor(points.length / 3));
            const lastThird = points.slice(-Math.floor(points.length / 3));

            const firstAvg = firstThird.reduce((sum, p) => sum + p.passRate, 0) / firstThird.length;
            const lastAvg = lastThird.reduce((sum, p) => sum + p.passRate, 0) / lastThird.length;

            if (lastAvg > firstAvg + 5) {
                trend = 'improving';
            } else if (lastAvg < firstAvg - 5) {
                trend = 'declining';
            }
        }

        return { points, trend, averagePassRate };
    }
}

export interface ComparisonResult {
    current: TestExecutionResult;
    previous: TestExecutionResult;
    newlyFailing: FailedScenario[];
    newlyPassing: PassedScenario[];
    stillFailing: FailedScenario[];
    passRateChange: number;
    improved: boolean;
    degraded: boolean;
}

export interface FailedScenario {
    featureName: string;
    scenarioName: string;
    error: string;
    line: number;
}

export interface PassedScenario {
    featureName: string;
    scenarioName: string;
    line: number;
}

export interface TrendData {
    points: {
        timestamp: number;
        passRate: number;
        passed: number;
        failed: number;
        total: number;
    }[];
    trend: 'improving' | 'declining' | 'stable';
    averagePassRate: number;
}
