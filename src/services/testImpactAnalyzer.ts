import { SpecDiff, EndpointChange } from './specDiffAnalyzer';
import { SpecMetadata } from './specHashManager';
import { logger } from '../utils/logger';

/**
 * Information about a test affected by spec changes
 */
export interface AffectedTest {
    testPath: string;
    scenarioName: string;
    changeImpact: 'high' | 'medium' | 'low';
    suggestedAction: 'regenerate' | 'review' | 'delete';
    reason: string;
    endpointChange?: EndpointChange;
}

/**
 * Analyzes the impact of spec changes on existing tests
 */
export class TestImpactAnalyzer {

    /**
     * Analyze which tests are affected by spec changes
     */
    public analyzeImpact(
        diff: SpecDiff,
        metadata: SpecMetadata
    ): AffectedTest[] {
        const affected: AffectedTest[] = [];

        logger.info(`TestImpactAnalyzer: Analyzing impact for ${metadata.specPath}`);

        // Handle removed endpoints
        for (const removed of diff.removed) {
            const endpoint = metadata.endpoints.find(
                e => e.path === removed.path && e.method === removed.method
            );

            if (endpoint) {
                affected.push({
                    testPath: endpoint.testFilePath,
                    scenarioName: endpoint.testScenarioName,
                    changeImpact: 'high',
                    suggestedAction: 'delete',
                    reason: 'Endpoint no longer exists in specification',
                    endpointChange: removed
                });
            }
        }

        // Handle added endpoints
        for (const added of diff.added) {
            // New endpoints need new tests
            const testFile = metadata.generatedTests[0] || 'unknown';

            affected.push({
                testPath: testFile,
                scenarioName: `${added.method} ${added.path}`,
                changeImpact: 'medium',
                suggestedAction: 'regenerate',
                reason: 'New endpoint added to specification',
                endpointChange: added
            });
        }

        // Handle modified endpoints
        for (const modified of diff.modified) {
            const endpoint = metadata.endpoints.find(
                e => e.path === modified.path && e.method === modified.method
            );

            if (endpoint) {
                const hasBreaking = modified.details.some(d => d.isBreaking);

                affected.push({
                    testPath: endpoint.testFilePath,
                    scenarioName: endpoint.testScenarioName,
                    changeImpact: hasBreaking ? 'high' : 'medium',
                    suggestedAction: hasBreaking ? 'review' : 'regenerate',
                    reason: hasBreaking
                        ? 'Breaking changes detected - manual review required'
                        : 'Endpoint modified - test should be updated',
                    endpointChange: modified
                });
            }
        }

        logger.info(`TestImpactAnalyzer: Found ${affected.length} affected tests`);

        return affected;
    }

    /**
     * Group affected tests by file
     */
    public groupByFile(affected: AffectedTest[]): Map<string, AffectedTest[]> {
        const grouped = new Map<string, AffectedTest[]>();

        for (const test of affected) {
            const existing = grouped.get(test.testPath) || [];
            existing.push(test);
            grouped.set(test.testPath, existing);
        }

        return grouped;
    }

    /**
     * Get summary statistics
     */
    public getSummary(affected: AffectedTest[]): {
        total: number;
        toRegenerate: number;
        toReview: number;
        toDelete: number;
        highImpact: number;
    } {
        return {
            total: affected.length,
            toRegenerate: affected.filter(t => t.suggestedAction === 'regenerate').length,
            toReview: affected.filter(t => t.suggestedAction === 'review').length,
            toDelete: affected.filter(t => t.suggestedAction === 'delete').length,
            highImpact: affected.filter(t => t.changeImpact === 'high').length
        };
    }
}
