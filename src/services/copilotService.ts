import * as vscode from 'vscode';
import { logger } from '../utils/logger';

export interface CopilotFullContext {
    type: 'openapi' | 'confluence' | 'combined';
    openApiSpec?: string;
    confluencePage?: string;
    requirements?: string[];
}

export class CopilotService {
    private static readonly COPILOT_MODEL_SELECTOR: vscode.LanguageModelChatSelector = {
        vendor: 'copilot',
        family: 'gpt-4o'
    };

    /**
     * Check if Copilot is available
     */
    static async isCopilotAvailable(): Promise<boolean> {
        try {
            const models = await vscode.lm.selectChatModels(this.COPILOT_MODEL_SELECTOR);
            return models.length > 0;
        } catch (error) {
            logger.warn('Copilot is not available');
            return false;
        }
    }

    /**
     * Enhance Karate test with Copilot suggestions
     * @param featureContent - The generated Karate test
     * @param context - Brief context description
     * @param fullContext - Optional full source content (OpenAPI spec, Confluence page, etc.)
     */
    static async enhanceKarateTest(
        featureContent: string,
        context: string,
        fullContext?: CopilotFullContext
    ): Promise<string> {
        try {
            const models = await vscode.lm.selectChatModels(this.COPILOT_MODEL_SELECTOR);

            if (models.length === 0) {
                throw new Error('GitHub Copilot is not available. Please ensure you have an active Copilot subscription.');
            }

            const model = models[0];

            // Build enhanced context with full source data
            let contextSection = `Context: ${context}`;

            if (fullContext) {
                if (fullContext.openApiSpec) {
                    contextSection += `\n\nFull OpenAPI Specification:\n\`\`\`yaml\n${fullContext.openApiSpec}\n\`\`\``;
                }

                if (fullContext.confluencePage) {
                    // Strip HTML tags for cleaner context
                    const cleanContent = fullContext.confluencePage.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                    contextSection += `\n\nConfluence Page Content:\n${cleanContent.substring(0, 5000)}`; // Limit to avoid token limits
                }

                if (fullContext.requirements && fullContext.requirements.length > 0) {
                    contextSection += `\n\nExtracted Requirements:\n${fullContext.requirements.map((r, i) => `${i + 1}. ${r}`).join('\n')}`;
                }
            }

            // Create chat messages
            const messages = [
                vscode.LanguageModelChatMessage.User(
                    `You are an expert in Karate DSL test framework. I have generated a Karate feature file and need your help to improve it.

${contextSection}

Current Feature File:
\`\`\`gherkin
${featureContent}
\`\`\`

Please enhance this Karate test by:
1. Using the full context above to add more accurate test data and scenarios
2. Adding comprehensive assertions based on the actual API specification
3. Including edge cases and error scenarios relevant to the API
4. Adding meaningful comments where appropriate
5. Improving variable names and test data to match the actual API
6. Adding response schema validations using match expressions based on the spec
7. Suggesting additional test scenarios that are relevant to this specific API
8. Ensuring best practices for Karate DSL

Return ONLY the improved feature file content, no explanations.`
                )
            ];

            // Send request to Copilot
            const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

            let enhancedContent = '';
            for await (const fragment of response.text) {
                enhancedContent += fragment;
            }

            // Clean up the response (remove markdown code blocks if present)
            enhancedContent = this.cleanCopilotResponse(enhancedContent);

            logger.info('Successfully enhanced test with Copilot' + (fullContext ? ' using full context' : ''));
            return enhancedContent;

        } catch (error) {
            logger.error('Failed to enhance test with Copilot', error as Error);
            throw error;
        }
    }

    /**
     * Generate additional test scenarios with Copilot
     */
    static async generateAdditionalScenarios(
        existingFeature: string,
        apiEndpoint: string,
        requirements?: string[]
    ): Promise<string[]> {
        try {
            const models = await vscode.lm.selectChatModels(this.COPILOT_MODEL_SELECTOR);

            if (models.length === 0) {
                throw new Error('GitHub Copilot is not available');
            }

            const model = models[0];

            const requirementsText = requirements && requirements.length > 0
                ? `\n\nAdditional Requirements:\n${requirements.map((r, i) => `${i + 1}. ${r}`).join('\n')}`
                : '';

            const messages = [
                vscode.LanguageModelChatMessage.User(
                    `You are an expert in API testing with Karate DSL. 

API Endpoint: ${apiEndpoint}

Existing Test:
\`\`\`gherkin
${existingFeature}
\`\`\`${requirementsText}

Generate 3-5 additional test scenarios that cover:
- Edge cases (empty values, null, invalid data)
- Error handling (404, 400, 500 responses)
- Security scenarios (authentication, authorization)
- Performance considerations
- Data validation

Return ONLY the Scenario blocks (not the full feature file), one per line, in Karate DSL format.`
                )
            ];

            const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

            let scenariosText = '';
            for await (const fragment of response.text) {
                scenariosText += fragment;
            }

            // Parse scenarios
            const scenarios = this.extractScenarios(scenariosText);
            logger.info(`Generated ${scenarios.length} additional scenarios with Copilot`);

            return scenarios;

        } catch (error) {
            logger.error('Failed to generate additional scenarios', error as Error);
            return [];
        }
    }

    /**
     * Get Copilot suggestions for test improvements
     */
    static async getSuggestions(featureContent: string): Promise<string[]> {
        try {
            const models = await vscode.lm.selectChatModels(this.COPILOT_MODEL_SELECTOR);

            if (models.length === 0) {
                return [];
            }

            const model = models[0];

            const messages = [
                vscode.LanguageModelChatMessage.User(
                    `Review this Karate DSL test and provide 5 specific improvement suggestions:

\`\`\`gherkin
${featureContent}
\`\`\`

Return suggestions as a numbered list, one per line.`
                )
            ];

            const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

            let suggestionsText = '';
            for await (const fragment of response.text) {
                suggestionsText += fragment;
            }

            // Parse suggestions
            const suggestions = suggestionsText
                .split('\n')
                .filter(line => /^\d+\./.test(line.trim()))
                .map(line => line.replace(/^\d+\.\s*/, '').trim())
                .filter(s => s.length > 0);

            return suggestions;

        } catch (error) {
            logger.error('Failed to get Copilot suggestions', error as Error);
            return [];
        }
    }

    /**
     * Clean Copilot response by removing markdown code blocks
     */
    private static cleanCopilotResponse(response: string): string {
        // Remove markdown code blocks
        let cleaned = response.replace(/```gherkin\n?/g, '').replace(/```\n?/g, '');

        // Trim whitespace
        cleaned = cleaned.trim();

        return cleaned;
    }

    /**
     * Extract scenario blocks from text
     */
    private static extractScenarios(text: string): string[] {
        const scenarios: string[] = [];
        const lines = text.split('\n');
        let currentScenario: string[] = [];
        let inScenario = false;

        for (const line of lines) {
            if (line.trim().startsWith('Scenario:')) {
                if (currentScenario.length > 0) {
                    scenarios.push(currentScenario.join('\n'));
                }
                currentScenario = [line];
                inScenario = true;
            } else if (inScenario) {
                if (line.trim().length === 0 && currentScenario.length > 1) {
                    scenarios.push(currentScenario.join('\n'));
                    currentScenario = [];
                    inScenario = false;
                } else if (line.trim().length > 0) {
                    currentScenario.push(line);
                }
            }
        }

        if (currentScenario.length > 0) {
            scenarios.push(currentScenario.join('\n'));
        }

        return scenarios;
    }
}
