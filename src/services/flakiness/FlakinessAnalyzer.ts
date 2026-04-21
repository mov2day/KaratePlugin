import * as crypto from 'crypto';
import { TestExecutionResult, ScenarioResult } from '../../types';
import { logger } from '../../utils/logger';

/**
 * Per-scenario run record for flakiness analysis.
 */
export interface ScenarioRunRecord {
    timestamp: number;
    status: 'passed' | 'failed' | 'skipped';
    duration: number;
    error?: string;
    runId: string;
}

/**
 * Per-scenario flakiness assessment.
 */
export interface ScenarioFlakiness {
    featurePath: string;
    scenarioName: string;
    passRate: number;         // 0.0 – 1.0
    runCount: number;
    flakiness: number;        // parabolic: f(x) = 1 - (2x-1)²
    trend: 'improving' | 'stable' | 'degrading';
    lastFailure?: ScenarioRunRecord;
    suggestedFix?: string;    // AI-generated (optional)
}

/**
 * Ranked report of all flaky scenarios.
 */
export interface FlakinessReport {
    analysisTimestamp: number;
    windowSize: number;
    threshold: number;
    totalScenarios: number;
    flakyCount: number;
    scenarios: ScenarioFlakiness[];
}

/**
 * FlakinessAnalyzer — reads test history, computes per-scenario flakiness scores.
 *
 * Scoring: f(x) = 1 - (2x-1)² where x = pass rate.
 * - 50% pass rate → score 1.0 (maximally flaky)
 * - 0% or 100% pass rate → score 0.0 (consistently failing/passing)
 */
export class FlakinessAnalyzer {

    /**
     * Analyze flakiness from execution history.
     */
    analyze(
        history: TestExecutionResult[],
        windowSize: number = 20,
        threshold: number = 0.15
    ): FlakinessReport {
        // Build per-scenario run map
        const scenarioMap = new Map<string, { featurePath: string; scenarioName: string; runs: ScenarioRunRecord[] }>();

        for (const run of history) {
            for (const feature of run.features) {
                for (const scenario of feature.scenarios) {
                    const key = this.scenarioKey(feature.relativePath, scenario.name);

                    if (!scenarioMap.has(key)) {
                        scenarioMap.set(key, {
                            featurePath: feature.relativePath,
                            scenarioName: scenario.name,
                            runs: []
                        });
                    }

                    scenarioMap.get(key)!.runs.push({
                        timestamp: run.timestamp,
                        status: scenario.status,
                        duration: scenario.duration,
                        error: scenario.error,
                        runId: run.id
                    });
                }
            }
        }

        // Score each scenario
        const scoredScenarios: ScenarioFlakiness[] = [];

        for (const [, data] of scenarioMap) {
            // Take last N runs
            const runs = data.runs
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, windowSize);

            if (runs.length < 2) {
                continue; // Need at least 2 runs for flakiness analysis
            }

            const passCount = runs.filter(r => r.status === 'passed').length;
            const passRate = passCount / runs.length;
            const flakiness = this.computeFlakiness(passRate);
            const trend = this.computeTrend(runs);
            const lastFailure = runs.find(r => r.status === 'failed');

            scoredScenarios.push({
                featurePath: data.featurePath,
                scenarioName: data.scenarioName,
                passRate,
                runCount: runs.length,
                flakiness,
                trend,
                lastFailure
            });
        }

        // Sort by flakiness descending
        scoredScenarios.sort((a, b) => b.flakiness - a.flakiness);

        const flakyCount = scoredScenarios.filter(s => s.flakiness >= threshold).length;

        logger.info(`Flakiness analysis: ${flakyCount} flaky scenarios out of ${scoredScenarios.length}`);

        return {
            analysisTimestamp: Date.now(),
            windowSize,
            threshold,
            totalScenarios: scoredScenarios.length,
            flakyCount,
            scenarios: scoredScenarios
        };
    }

    /**
     * Parabolic flakiness score: f(x) = 1 - (2x-1)²
     * - x=0.5 → 1.0 (maximally flaky)
     * - x=0.0 or x=1.0 → 0.0
     */
    computeFlakiness(passRate: number): number {
        const score = 1 - Math.pow(2 * passRate - 1, 2);
        return Math.max(0, Math.round(score * 1000) / 1000);
    }

    /**
     * Trend detection: compare first half vs second half of window.
     */
    computeTrend(runs: ScenarioRunRecord[]): 'improving' | 'stable' | 'degrading' {
        if (runs.length < 4) {
            return 'stable';
        }

        const mid = Math.floor(runs.length / 2);
        // Runs sorted newest-first: first half = recent, second half = older
        const recentHalf = runs.slice(0, mid);
        const olderHalf = runs.slice(mid);

        const recentPassRate = recentHalf.filter(r => r.status === 'passed').length / recentHalf.length;
        const olderPassRate = olderHalf.filter(r => r.status === 'passed').length / olderHalf.length;

        const diff = recentPassRate - olderPassRate;

        if (diff > 0.15) {
            return 'improving';
        }
        if (diff < -0.15) {
            return 'degrading';
        }
        return 'stable';
    }

    /**
     * Generate a stable key for a scenario.
     */
    private scenarioKey(featurePath: string, scenarioName: string): string {
        return crypto.createHash('md5').update(`${featurePath}::${scenarioName}`).digest('hex');
    }
}
