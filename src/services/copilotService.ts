import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { CopilotLogger } from '../utils/copilotLogger';

export interface CopilotFullContext {
    type: 'openapi' | 'confluence' | 'combined';
    openApiSpec?: string;
    confluencePage?: string;
    requirements?: string[];
}

export class CopilotService {
    private static availableModels: string[] | null = null;
    private static lastModelCheck: number = 0;
    private static readonly MODEL_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

    /**
     * Get all available Copilot models for the user
     */
    static async getAvailableModels(): Promise<string[]> {
        // Use cached result if recent
        const now = Date.now();
        if (this.availableModels && (now - this.lastModelCheck) < this.MODEL_CACHE_DURATION) {
            return this.availableModels;
        }

        try {
            // Query all Copilot models without family filter
            const allModels = await vscode.lm.selectChatModels({
                vendor: 'copilot'
            });

            // Extract unique model families
            const families = allModels
                .map(model => model.family)
                .filter((family, index, self) => self.indexOf(family) === index);

            this.availableModels = families.length > 0 ? families : ['gpt-4o']; // Fallback
            this.lastModelCheck = now;

            logger.info(`Available Copilot models: ${this.availableModels.join(', ')}`);
            return this.availableModels;
        } catch (error) {
            logger.warn('Failed to query available Copilot models', error as Error);
            // Return common defaults as fallback
            return ['gpt-4o', 'gpt-4', 'gpt-3.5-turbo'];
        }
    }

    /**
     * Get preferred model with intelligent fallback
     */
    static async getPreferredModel(): Promise<string> {
        const { ConfigManager } = require('../utils/configManager');
        const configured = ConfigManager.getCopilotModel();
        const available = await this.getAvailableModels();

        // If configured model is available, use it
        if (available.includes(configured)) {
            return configured;
        }

        // Fallback priority: gpt-4o > gpt-4 > gpt-3.5-turbo > first available
        const fallbackPriority = ['gpt-4o', 'gpt-4', 'gpt-3.5-turbo'];
        for (const model of fallbackPriority) {
            if (available.includes(model)) {
                logger.warn(`Configured model '${configured}' not available, using '${model}' instead`);
                vscode.window.showWarningMessage(
                    `Copilot model '${configured}' is not available. Using '${model}' instead. Check your GitHub Copilot subscription.`,
                    'Open Settings'
                ).then(selection => {
                    if (selection === 'Open Settings') {
                        vscode.commands.executeCommand('workbench.action.openSettings', 'karateDsl.copilot.model');
                    }
                });
                return model;
            }
        }

        // Use first available as last resort
        const fallback = available[0];
        logger.warn(`Using fallback model: ${fallback}`);
        return fallback;
    }

    /**
     * Get chat model selector based on user configuration with fallback
     */
    private static async getChatModelSelector(): Promise<vscode.LanguageModelChatSelector> {
        const preferredModel = await this.getPreferredModel();

        return {
            vendor: 'copilot',
            family: preferredModel
        };
    }

    /**
     * Check if Copilot is available
     */
    static async isCopilotAvailable(): Promise<boolean> {
        try {
            const selector = await this.getChatModelSelector();
            const models = await vscode.lm.selectChatModels(selector);
            return models.length > 0;
        } catch (error) {
            logger.warn('Copilot is not available');
            return false;
        }
    }

    /**
     * Extract plain text from Confluence page
     */
    private static getPlainTextFromConfluence(confluencePage: string): string {
        // Confluence API might return different formats
        // Try to parse if it's JSON with body formats
        try {
            const pageData = JSON.parse(confluencePage);
            // Try atlas_doc_format first (plain text), then view, then storage
            return pageData.body?.atlas_doc_format?.value ||
                pageData.body?.view?.value?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() ||
                pageData.body?.storage?.value?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() ||
                confluencePage;
        } catch {
            // If not JSON, assume it's already HTML/text content
            // Strip HTML tags and clean up
            return confluencePage
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/\s+/g, ' ')
                .trim();
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
            const selector = await this.getChatModelSelector();
            const models = await vscode.lm.selectChatModels(selector);

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
                    const plainText = this.getPlainTextFromConfluence(fullContext.confluencePage);
                    contextSection += `\n\nConfluence Page Content:\n${plainText}`;
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
            const promptText = messages[0].content.toString();
            CopilotLogger.logRequest(
                'Enhance Karate Test (Standard)',
                context,
                promptText
            );

            const startTime = Date.now();
            const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

            let enhancedContent = '';
            for await (const fragment of response.text) {
                enhancedContent += fragment;
            }

            const duration = Date.now() - startTime;

            // Clean up
            enhancedContent = this.cleanCopilotResponse(enhancedContent);

            CopilotLogger.logResponse(
                'Enhance Karate Test (Standard)',
                enhancedContent,
                duration
            );

            // Clean up the response (remove markdown code blocks if present)
            enhancedContent = this.cleanCopilotResponse(enhancedContent);

            logger.info('Successfully enhanced test with Copilot' + (fullContext ? ' using full context' : ''));
            return enhancedContent;

        } catch (error: any) {
            // Check for quota/rate limit errors
            if (error.message?.includes('quota') || error.message?.includes('rate limit') || error.message?.includes('exhausted')) {
                logger.warn('Copilot quota exhausted, returning original tests');
                vscode.window.showWarningMessage(
                    'Copilot quota exhausted. Tests generated without AI enhancement. Try GPT-3.5 Turbo or wait for quota reset.',
                    'Open Settings'
                ).then(selection => {
                    if (selection === 'Open Settings') {
                        vscode.commands.executeCommand('workbench.action.openSettings', 'karateDsl.copilot.model');
                    }
                });
                return featureContent;
            }

            logger.error('Failed to enhance test with Copilot', error as Error);
            throw error;
        }
    }

    /**
     * Enhance Karate test with comprehensive Copilot suggestions
     * Includes edge cases, corner cases, race conditions, and proper formatting
     */
    static async enhanceKarateTestComprehensive(
        featureContent: string,
        context: string,
        fullContext?: CopilotFullContext
    ): Promise<string> {
        try {
            const selector = await this.getChatModelSelector();
            const models = await vscode.lm.selectChatModels(selector);

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
                    const plainText = this.getPlainTextFromConfluence(fullContext.confluencePage);
                    contextSection += `\n\nConfluence Page Content:\n${plainText}`;
                }

                if (fullContext.requirements && fullContext.requirements.length > 0) {
                    contextSection += `\n\nExtracted Requirements:\n${fullContext.requirements.map((r, i) => `${i + 1}. ${r}`).join('\n')}`;
                }
            }

            // Create comprehensive prompt
            const messages = [
                vscode.LanguageModelChatMessage.User(
                    `You are an expert in Karate DSL test framework and API testing best practices.

${contextSection}

Current Feature File:
\`\`\`gherkin
${featureContent}
\`\`\`

Please enhance this Karate test with COMPREHENSIVE coverage:

## TEST COVERAGE REQUIREMENTS:

### 1. Positive Test Cases
- Success scenarios (200, 201, 204 responses)
- Valid data with all required fields
- Optional fields included and excluded
- Successful data creation, retrieval, update, deletion

### 2. Negative Test Cases
- Client errors: 400 (bad request), 401 (unauthorized), 403 (forbidden), 404 (not found)
- Missing required fields
- Invalid data types
- Invalid field values
- Unauthorized access attempts

### 3. Edge Cases
- Empty strings and arrays
- Null values where applicable
- Minimum and maximum boundary values
- Zero values for numeric fields
- Empty request bodies
- Very large valid values (near limits)

### 4. Corner Cases
- Special characters in strings (quotes, backslashes, unicode)
- Very long strings (test field length limits)
- Unusual but valid data combinations
- Timezone edge cases for dates
- Decimal precision for numbers
- Case sensitivity tests

### 5. Race Conditions & Concurrency
- Concurrent requests to same resource
- Create-then-delete scenarios
- Update conflicts
- Idempotency tests for POST/PUT

### 6. Security Tests
- Authentication required tests
- Authorization/permission tests
- SQL injection attempts (if applicable)
- XSS attempts (if applicable)
- Invalid tokens

## KARATE DSL BEST PRACTICES:

### Variable Usage
- Define reusable variables in Background section using 'def'
- Use meaningful variable names (not foo, bar, test)
- Generate realistic test data (real names, emails, UUIDs)
- Use Java interop for dynamic data: java.util.UUID.randomUUID()

### Scenario Outlines
- Use Scenario Outline for data-driven tests with multiple similar cases
- Create Examples table with descriptive column names
- Group related test cases in same outline

### Assertions & Validation
- Use 'match ==' for exact schema validation
- Use JSONPath for nested field validation
- Validate response headers (Content-Type, etc.)
- Check response time where relevant
- Validate array lengths and structure

### Code Quality
- Proper indentation (2 spaces per level)
- Meaningful scenario names describing what is tested
- Add comments for complex logic or business rules
- Organize scenarios logically (positive → negative → edge)
- Use descriptive variable names

### Formatting Standards
- Feature: [Feature Name]
- Background: (shared setup)
- Scenario: [Clear description]
- Scenario Outline: [Description with parameters]
- Proper spacing between scenarios
- Consistent quote style (prefer single quotes)

## OUTPUT REQUIREMENTS:
- Return ONLY the enhanced feature file content
- Include comprehensive test scenarios covering all categories above
- Use Scenario Outlines where multiple similar tests exist
- Add realistic test data
- Include detailed match assertions based on the API spec
- Ensure proper Karate DSL syntax and formatting
- NO explanations or markdown - just the feature file content`
                )
            ];

            // Log the request for transparency
            const promptText = messages[0].content.toString();
            CopilotLogger.logRequest(
                'Enhance Karate Test (Comprehensive)',
                context,
                promptText
            );

            const startTime = Date.now();

            // Send request to Copilot
            const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

            let enhancedContent = '';
            for await (const fragment of response.text) {
                enhancedContent += fragment;
            }

            // Clean up the response
            enhancedContent = this.cleanCopilotResponse(enhancedContent);

            const duration = Date.now() - startTime;

            // Log the response for transparency
            CopilotLogger.logResponse(
                'Enhance Karate Test (Comprehensive)',
                enhancedContent,
                duration
            );

            logger.info('Successfully enhanced test with comprehensive Copilot analysis');
            return enhancedContent;

        } catch (error: any) {
            // Check for quota/rate limit errors
            if (error.message?.includes('quota') || error.message?.includes('rate limit') || error.message?.includes('exhausted')) {
                logger.warn('Copilot quota exhausted, returning original tests');
                vscode.window.showWarningMessage(
                    'Copilot quota exhausted. Tests generated without AI enhancement. Try GPT-3.5 Turbo or wait for quota reset.',
                    'Open Settings'
                ).then(selection => {
                    if (selection === 'Open Settings') {
                        vscode.commands.executeCommand('workbench.action.openSettings', 'karateDsl.copilot.model');
                    }
                });
                return featureContent;
            }

            logger.error('Failed to enhance test with comprehensive Copilot', error as Error);
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
            const selector = await this.getChatModelSelector();
            const models = await vscode.lm.selectChatModels(selector);

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

            // Log the request for transparency
            const promptText = messages[0].content.toString();
            CopilotLogger.logRequest(
                'Generate Additional Scenarios',
                `Endpoint: ${apiEndpoint}`,
                promptText
            );

            const startTime = Date.now();
            const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

            let scenariosText = '';
            for await (const fragment of response.text) {
                scenariosText += fragment;
            }

            const duration = Date.now() - startTime;

            // Log the response for transparency
            CopilotLogger.logResponse(
                'Generate Additional Scenarios',
                scenariosText,
                duration
            );

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
            const selector = await this.getChatModelSelector();
            const models = await vscode.lm.selectChatModels(selector);

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
