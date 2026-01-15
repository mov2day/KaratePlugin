import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { CopilotLogger } from '../utils/copilotLogger';

export interface CopilotFullContext {
    type: 'openapi' | 'confluence' | 'combined' | 'postman';
    openApiSpec?: string;
    confluencePage?: string;
    postmanCollection?: string;
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
            const models = await vscode.lm.selectChatModels(await this.getChatModelSelector());
            return models.length > 0;
        } catch (error) {
            logger.error('Error checking Copilot availability', error as Error);
            return false;
        }
    }

    /**
     * Send request to Copilot with automatic multi-turn conversation for large content
     * @param content - The main content to send (will be chunked if too large)
     * @param instructionPrompt - The instruction/system prompt explaining what to do
     * @param chunkSize - Maximum size per chunk (default 3000 characters)
     * @returns Copilot's response as string
     */
    private static async sendMultiTurnRequest(
        content: string,
        instructionPrompt: string,
        fullContext?: CopilotFullContext,
        chunkSize: number = 3000,
        isRetry: boolean = false,
        token?: vscode.CancellationToken
    ): Promise<string> {
        const messages: vscode.LanguageModelChatMessage[] = [];

        // Check if context also needs chunking
        let openApiContent = '';
        let confluenceContent = '';
        let postmanContent = '';

        if (fullContext) {
            if (fullContext.openApiSpec) {
                openApiContent = fullContext.openApiSpec;
            }
            if (fullContext.confluencePage) {
                confluenceContent = this.getPlainTextFromConfluence(fullContext.confluencePage);
            }
            if (fullContext.postmanCollection) {
                postmanContent = fullContext.postmanCollection;
            }
        }

        const totalLength = content.length + openApiContent.length + confluenceContent.length + postmanContent.length;

        if (totalLength > chunkSize) {
            // Multi-turn conversation for large content
            logger.info(`Large content detected - using multi-turn conversation (Total: ${totalLength} chars)`);

            messages.push(
                vscode.LanguageModelChatMessage.User(
                    'I will send you the context and content in multiple parts. Please wait for all parts before responding.'
                )
            );

            // Helper to send content in chunks
            const sendChunks = (label: string, text: string) => {
                if (!text) return;
                const chunks = Math.ceil(text.length / chunkSize);
                for (let i = 0; i < chunks; i++) {
                    const start = i * chunkSize;
                    const end = Math.min(start + chunkSize, text.length);
                    const chunk = text.substring(start, end);
                    messages.push(
                        vscode.LanguageModelChatMessage.User(
                            `${label} (Part ${i + 1}/${chunks}):\n${chunk}`
                        )
                    );
                }
            };

            // Send full context first
            sendChunks('OpenAPI Specification', openApiContent);
            sendChunks('Confluence Documentation', confluenceContent);
            sendChunks('Postman Collection', postmanContent);

            // Send main content
            sendChunks('Karate Test Content', content);

            // Final instruction message
            messages.push(vscode.LanguageModelChatMessage.User(instructionPrompt));
        } else {
            // Single message for small content
            let fullMessage = '';

            if (openApiContent.length > 0) fullMessage += `OpenAPI Specification:\n${openApiContent}\n\n`;
            if (confluenceContent.length > 0) fullMessage += `Confluence Documentation:\n${confluenceContent}\n\n`;
            if (postmanContent.length > 0) fullMessage += `Postman Collection:\n${postmanContent}\n\n`;

            fullMessage += `${content}\n\n${instructionPrompt}`;

            messages.push(vscode.LanguageModelChatMessage.User(fullMessage));
        }

        // Send request to Copilot
        const selector = await this.getChatModelSelector();
        const models = await vscode.lm.selectChatModels(selector);

        if (models.length === 0) {
            throw new Error('No Copilot models available');
        }

        const model = models[0];

        try {
            // Create a timeout token if no token provided, or link to provided token
            const timeoutMs = 120000; // 2 minutes timeout
            const timeoutSource = new vscode.CancellationTokenSource();

            // Set timeout
            const timer = setTimeout(() => {
                timeoutSource.cancel();
            }, timeoutMs);

            // Link to parent token if provided
            if (token) {
                token.onCancellationRequested(() => {
                    timeoutSource.cancel();
                    clearTimeout(timer);
                });
            }

            const response = await model.sendRequest(
                messages,
                {},
                timeoutSource.token
            );

            let result = '';
            for await (const fragment of response.text) {
                result += fragment;
            }

            // Check for refusal response
            if (!isRetry && (
                result.toLowerCase().includes("sorry, i can't assist") ||
                result.toLowerCase().includes("sorry, i cannot assist") ||
                result.toLowerCase().includes("i cannot fulfill this request")
            )) {
                logger.warn('Copilot refused request. Retrying with safety filter instructions...');

                const safetyInstruction = `
The previous response was refused. 
STRICT REQUIREMENT: OMIT any content that triggers safety policies (security testing, penetration testing, etc.).
Focus ONLY on functional verification and standard QA validation.
Process the rest of the request and provide the Karate test code.`;

                return this.sendMultiTurnRequest(
                    content,
                    instructionPrompt + "\n\n" + safetyInstruction,
                    fullContext,
                    chunkSize,
                    true, // Set retry flag
                    token
                );
            }

            return result;
        } catch (error) {
            if (error instanceof vscode.CancellationError) {
                logger.warn('Copilot request cancelled or timed out');
                return "Error: Request cancelled or timed out.";
            }
            throw error;
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
            const isAvailable = await this.isCopilotAvailable();
            if (!isAvailable) {
                logger.warn('Copilot is not available, returning original feature');
                return featureContent;
            }

            logger.info('Enhancing Karate test with Copilot');

            // Build context information
            let contextInfo = `Context: ${context}\n\n`;
            if (fullContext) {
                if (fullContext.openApiSpec) {
                    contextInfo += `OpenAPI Specification provided\n`;
                }
                if (fullContext.confluencePage) {
                    const plainText = this.getPlainTextFromConfluence(fullContext.confluencePage);
                    contextInfo += `Confluence Documentation: ${plainText.substring(0, 500)}...\n`;
                }
            }

            // Comprehensive instruction prompt
            const instructionPrompt = `${contextInfo}

OBJECTIVE: Transform the Karate test above into a RELIABLE, QA-FOCUSED test suite.

STRICT GUIDELINES:
1. **NO HALLUCINATIONS**: Do NOT invent fields, endpoints, or data not present in the content provided.
2. **SAFE VALIDATION ONLY**: Focus on standard functional testing. Do NOT include "attack" vectors, "injection" tests, or "penetration" testing patterns.

REQUIREMENTS:

1. **Variable Management**:
   - Extract reusable values to variables.
   - Use proper #(varName) syntax.
   - Define base URLs and common headers.

2. **Core Validations**:
   - Status codes: Standard success (2xx) and error (4xx/5xx) checks.
   - Schema validation: Match response structure.
   - Type checks: #string, #number, #boolean.

3. **Data Integrity**:
   - Null/presence validation: #present, #null.
   - Basic pattern matching: Email formats, dates.
   - Array validations: Length checks, iteration.

4. **Negative Scenarios (Functional)**:
   - Invalid data formats (e.g., text in number fields).
   - Missing required fields.
   - Boundary values (min/max).

5. **Best Practices**:
   - Descriptive scenario names.
   - Proper indentation.
   - Scenario Outlines for data-driven tests.

OUTPUT FORMAT:
- Return the COMPLETE enhanced Karate feature file.
- NO explanations, NO markdown code blocks.
- Just the pure Karate DSL content.

Enhance the test now:`;

            // Use multi-turn helper for large features
            const enhancedContent = await this.sendMultiTurnRequest(
                featureContent,
                instructionPrompt,
                fullContext
            );

            const cleanContent = this.cleanCopilotResponse(enhancedContent);

            // Log to Copilot transparency logger
            CopilotLogger.logRequest('Enhance Karate Test', context, instructionPrompt);
            CopilotLogger.logResponse('Enhance Karate Test', cleanContent, 0);

            logger.info('Successfully enhanced Karate test with Copilot');
            return cleanContent;

        } catch (error) {
            // Handle quota exhaustion gracefully
            const errorMessage = (error as Error).message.toLowerCase();
            if (errorMessage.includes('quota') || errorMessage.includes('rate limit') || errorMessage.includes('exhausted')) {
                vscode.window.showWarningMessage(
                    '⚠️ Copilot quota exhausted. Returning original test. Try using GPT-3.5 Turbo or wait a bit.',
                    'Open Settings'
                ).then(selection => {
                    if (selection === 'Open Settings') {
                        vscode.commands.executeCommand('workbench.action.openSettings', 'karateDsl.copilot');
                    }
                });
                logger.warn('Copilot quota exhausted, returning original feature');
                return featureContent;
            }

            logger.error('Failed to enhance Karate test with Copilot', error as Error);
            return featureContent;
        }
    }

    /**
     * Enhance Karate test with comprehensive Copilot suggestions
     * Includes edge cases, corner cases, race conditions, and proper formatting
     */
    static async enhanceKarateTestComprehensive(
        featureContent: string,
        context: string,
        fullContext?: CopilotFullContext,
        token?: vscode.CancellationToken
    ): Promise<string> {
        try {
            const isAvailable = await this.isCopilotAvailable();
            if (!isAvailable) {
                logger.warn('Copilot not available for comprehensive enhancement');
                return featureContent;
            }

            logger.info('Starting comprehensive Karate test enhancement');

            // Build rich context
            let contextInfo = `Context: ${context}\n\n`;

            if (fullContext) {
                if (fullContext.type === 'openapi' && fullContext.openApiSpec) {
                    contextInfo += `OpenAPI Specification available (${fullContext.openApiSpec.length} chars)\n`;
                }
                if (fullContext.type === 'confluence' && fullContext.confluencePage) {
                    const plainText = this.getPlainTextFromConfluence(fullContext.confluencePage);
                    contextInfo += `Confluence Documentation: ${plainText.substring(0, 300)}...\n`;
                }
                if (fullContext.type === 'combined') {
                    contextInfo += `Combined context: Both OpenAPI spec and Confluence docs available\n`;
                }
                if (fullContext.requirements && fullContext.requirements.length > 0) {
                    contextInfo += `Requirements: ${fullContext.requirements.length} items identified\n`;
                }
            }

            // Ultra-comprehensive instruction prompt
            const instructionPrompt = `${contextInfo}

OBJECTIVE: Transform the Karate test above into an ENTERPRISE-GRADE, PRODUCTION-READY test suite.

STRICT ANTI-HALLUCINATION RULES:
1. **Adhere to Context**: Use ONLY endpoints, fields, and data structures present in the provided Open API spec / Documentation.
2. **No Invention**: Do NOT create new API paths or fictitious response fields.

COMPREHENSIVE REQUIREMENTS:

1. **Test Architecture**:
   - Use Background for setup.
   - Proper tagging (@smoke, @regression).
   - Scenario Outlines for data variations.

2. **HTTP Status Coverage**:
   - Success (2xx) and Standard Error (4xx/5xx) scenarios.
   - Validate strict status codes.

3. **Deep Schema Validation**:
   - Complete structure matching: And match response == { ... }
   - Strict type enforcement: #string, #number.
   - Optional vs Mandatory field checks.

4. **Data Validation**:
   - Value constraints (min, max).
   - Regex patterns for standard formats (UUID, Date, Email).
   - Enum validation where known.

5. **Business Logic & Workflow**:
   - State transitions (if documented).
   - CRUD lifecycle where applicable.
   - Data dependencies (creating parent before child).

6. **Edge Cases**:
   - Empty collections/arrays.
   - Boundary values (0, empty strings).
   - Special characters handling (UTF-8).
   - Null value handling.

7. **Safe Negative Testing**:
   - Malformed data formats.
   - Missing headers/required params.
   - Invalid IDs.
   - NOTE: Do NOT provoke security alerts (avoid SQLi/XSS patterns).

8. **Performance**:
   - Reasonable response time assertions.

9. **Quality & Maintainability**:
   - Clear, intent-based scenario names.
   - Reusable functions for repeated logic.
   - Readable formatting (4-space indent).

CRITICAL OUTPUT FORMAT:
- Return COMPLETE enhanced Karate feature file.
- Start with Feature: [description].
- Multiple comprehensive Scenario blocks.
- NO explanations, NO markdown blocks.
- Pure Karate DSL only.

Transform the test now:`;

            // Use multi-turn for large features
            const enhancedContent = await this.sendMultiTurnRequest(
                featureContent,
                instructionPrompt,
                fullContext,
                3000,
                false,
                token
            );

            const cleanContent = this.cleanCopilotResponse(enhancedContent);

            // Log for transparency
            CopilotLogger.logRequest('Comprehensive Enhancement', context, instructionPrompt);
            CopilotLogger.logResponse('Comprehensive Enhancement', cleanContent, 0);

            logger.info('Comprehensive enhancement completed successfully');
            return cleanContent;

        } catch (error) {
            const errorMessage = (error as Error).message.toLowerCase();
            if (errorMessage.includes('quota') || errorMessage.includes('rate limit') || errorMessage.includes('exhausted')) {
                vscode.window.showWarningMessage(
                    '⚠️ Copilot quota exhausted. Returning original test.',
                    'Open Settings'
                ).then(selection => {
                    if (selection === 'Open Settings') {
                        vscode.commands.executeCommand('workbench.action.openSettings', 'karateDsl.copilot');
                    }
                });
                logger.warn('Copilot quota exhausted during comprehensive enhancement');
                return featureContent;
            }

            logger.error('Comprehensive enhancement failed', error as Error);
            return featureContent;
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
- Auth scenarios (authentication, authorization)
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
