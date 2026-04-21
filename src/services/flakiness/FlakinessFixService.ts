import { ScenarioFlakiness } from './FlakinessAnalyzer';
import { AIProviderRegistry } from '../ai/AIProviderRegistry';
import { logger } from '../../utils/logger';

/**
 * FlakinessFixService — invokes AI to suggest stabilisation strategies
 * for flaky scenarios. Result is advisory only, not auto-applied.
 */
export class FlakinessFixService {

    /**
     * Generate AI-powered fix suggestion for a flaky scenario.
     * Returns suggestion text or undefined if AI unavailable.
     */
    async suggestFix(scenario: ScenarioFlakiness): Promise<string | undefined> {
        try {
            const registry = AIProviderRegistry.getInstance();
            const isAvailable = await registry.isAnyAvailable();

            if (!isAvailable) {
                logger.info('FlakinessFixService: no AI provider available, skipping suggestion');
                return undefined;
            }

            const prompt = this.buildPrompt(scenario);
            const result = await registry.complete(prompt, {
                maxTokens: 1024,
                temperature: 0.3,
                systemPrompt: 'You are a QA automation expert specialising in Karate DSL test stabilisation. Suggest concrete fixes for flaky tests. Be specific and actionable. No markdown code blocks.'
            });

            return result.trim() || undefined;
        } catch (error) {
            logger.error('FlakinessFixService: suggestion failed', error as Error);
            return undefined;
        }
    }

    private buildPrompt(scenario: ScenarioFlakiness): string {
        let prompt = `FLAKY TEST ANALYSIS

Feature: ${scenario.featurePath}
Scenario: ${scenario.scenarioName}
Pass Rate: ${(scenario.passRate * 100).toFixed(1)}% (${scenario.runCount} runs)
Flakiness Score: ${scenario.flakiness.toFixed(3)}
Trend: ${scenario.trend}`;

        if (scenario.lastFailure) {
            prompt += `\nLast Failure Error: ${scenario.lastFailure.error || 'No error message'}`;
        }

        prompt += `

TASK: Suggest 2-3 concrete stabilisation strategies for this flaky Karate test scenario.
Focus on:
- Explicit waits (retry until, pause)
- Data isolation (unique test data per run)
- Timing dependencies (async calls, eventual consistency)
- Environment sensitivity (config, ports, external services)

Return plain text suggestions, numbered. No code blocks.`;

        return prompt;
    }
}
