import * as vscode from 'vscode';
import * as path from 'path';
import { logger } from '../utils/logger';
import { CopilotLogger } from '../utils/copilotLogger';
import { AgentSkillsService } from './agentSkillsService';
import { ContextBuilder } from '../utils/contextBuilder';

export interface CopilotFullContext {
    type: 'openapi' | 'confluence' | 'combined' | 'postman' | 'coverage';
    openApiSpec?: string;
    confluencePage?: string;
    postmanCollection?: string;
    requirements?: string[];
    // File paths for file-based context (preferred over text content)
    specFilePath?: string;
    collectionFilePath?: string;
    environmentFilePath?: string;
    featureFilePath?: string;
}

export class CopilotService {
    private static availableModels: string[] | null = null;
    private static cachedModel: vscode.LanguageModelChat | undefined;
    private static lastModelCheck: number = 0;
    private static readonly MODEL_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

    /**
     * Initialize Copilot Service - Fetches and caches model at startup
     */
    static async initialize(): Promise<void> {
        try {
            // Background initialization of models
            const allModels = await vscode.lm.selectChatModels({
                vendor: 'copilot'
            });

            // Extract unique model families
            const families = allModels
                .map(model => model.family)
                .filter((family, index, self) => self.indexOf(family) === index);

            this.availableModels = families.length > 0 ? families : ['gpt-4o'];
            this.lastModelCheck = Date.now();

            logger.info(`Copilot initialized. Available models: ${this.availableModels.join(', ')}`);

            // Cache the preferred model object immediately
            try {
                const selector = await this.getChatModelSelector();
                const matchingModels = await vscode.lm.selectChatModels(selector);
                if (matchingModels.length > 0) {
                    this.cachedModel = matchingModels[0];
                    logger.info(`Copilot initialized. Cached model object for family: ${this.cachedModel.family}`);
                }
            } catch (err) {
                logger.warn('Failed to cache model object during initialization', err as Error);
            }

        } catch (error) {
            logger.warn('Failed to initialize Copilot models', error as Error);
            this.availableModels = ['gpt-4o']; // Default fallback
        }
    }


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
        let model = this.cachedModel;

        if (!model) {
            const selector = await this.getChatModelSelector();
            const models = await vscode.lm.selectChatModels(selector);
            if (models.length > 0) {
                model = models[0];
                this.cachedModel = model;
            }
        }

        if (!model) {
            throw new Error('No Copilot models available');
        }

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

            // Get skill knowledge base
            const contextType = fullContext?.type || 'general';
            const skillContext = await AgentSkillsService.buildSkillContextForPrompt(contextType);

            // Hardened instruction prompt
            const instructionPrompt = `${contextInfo}${skillContext}

OBJECTIVE: Transform the Karate test above into a RELIABLE, QA-FOCUSED test suite.

CRITICAL RULES — STRICT COMPLIANCE REQUIRED:
1. **ZERO HALLUCINATION**: Use ONLY endpoints, fields, and data types present in the provided spec/docs. Any field NOT in the input MUST NOT appear in the output.
2. **KARATE DSL ONLY**: Use correct Karate syntax — match, def, call, callonce, read, #() expressions, type markers (#string, #number, #boolean, #present, #null).
3. **REUSABILITY**: If auth/setup steps repeat across scenarios, extract to callonce read('common/auth.feature'). Use Background for shared URL, auth, and headers.
4. **NO ATTACK PATTERNS**: No SQL injection, XSS, or penetration testing patterns. Use functional negative testing only (empty values, missing fields, boundary values).

REQUIREMENTS:
1. **Background**: url, auth (callonce), common headers — 3-5 lines max.
2. **Status Codes**: Assert every request with Then status <code>.
3. **Schema Validation**: match response == { field: '#type' } using spec-defined fields only.
4. **Negative Scenarios**: Missing required fields, invalid formats, boundary values.
5. **Tags**: @positive, @negative, @edge on each scenario.
6. **Descriptive Names**: "GET /orders returns paginated list" not "Test 1".
7. **Scenario Outline**: Use for data-driven variations with Examples table.

BEFORE RETURNING, VERIFY:
- Every endpoint path exists in the provided spec
- Every response field matches the spec schema
- No duplicate auth/setup blocks (use call/callonce)
- All scenarios have descriptive names
- Status code assertions are present in every scenario

OUTPUT: Return the COMPLETE enhanced Karate feature file. NO explanations, NO markdown code blocks. Pure Karate DSL only.

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
            if (errorMessage.includes('quota') || errorMessage.includes('rate limit') || errorMessage.includes('exhausted') || errorMessage.includes('429')) {
                vscode.window.showErrorMessage(
                    '⚠️ Copilot quota exhausted for this model. Please switch to a different model in settings.',
                    'Change Model'
                ).then(selection => {
                    if (selection === 'Change Model') {
                        vscode.commands.executeCommand('karate-dsl.selectCopilotModel');
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
     * Includes edge cases, corner cases, and proper formatting
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

            // Get skill knowledge base
            const contextType = fullContext?.type || 'general';
            const skillContext = await AgentSkillsService.buildSkillContextForPrompt(contextType);

            // Hardened comprehensive instruction prompt
            const instructionPrompt = `${contextInfo}${skillContext}

OBJECTIVE: Transform the Karate test above into an ENTERPRISE-GRADE, PRODUCTION-READY test suite.

CRITICAL RULES — ABSOLUTE COMPLIANCE:
1. **ZERO HALLUCINATION**: Use ONLY endpoints, paths, fields, and schemas from the provided spec/docs. Do NOT invent ANY endpoint, field, or data structure.
2. **KARATE DSL PRECISION**: Use correct syntax — match (not assert for JSON), def, call, callonce, embedded expressions #(), type markers #string/#number/#boolean/#present/#null.
3. **REUSABILITY FIRST**: Extract auth to callonce read('common/auth.feature'). Shared headers/config in Background. No duplicate setup across scenarios.
4. **NO ATTACK PATTERNS**: Functional negative testing only — empty values, missing fields, boundary values. No SQLi/XSS.

COMPREHENSIVE REQUIREMENTS:

1. **Test Architecture**:
   - Background: url, auth (callonce), common headers — minimal, 3-5 lines
   - Tags: @positive, @negative, @edge, @boundary, @smoke on each scenario
   - Scenario Outlines with Examples tables for data-driven variations

2. **Status Code Coverage**:
   - Every request MUST have Then status <code>
   - Success (2xx), Client Error (4xx), Server Error (5xx) scenarios

3. **Schema Validation (spec-grounded)**:
   - match response == { ... } using ONLY fields from spec schema
   - Type markers: #string, #number, #boolean, ##string (optional)
   - Array validation: #[] #object, match each

4. **Data Validation**:
   - Boundary values (min/max from spec constraints)
   - Regex for documented formats (UUID, date, email)
   - Enum validation using #? _ == 'val1' || _ == 'val2'

5. **Business Logic & Workflow**:
   - CRUD lifecycle (create → read → update → delete → verify deleted)
   - Data dependencies (create parent before child)

6. **Edge Cases**:
   - Empty arrays/collections
   - Boundary values (0, empty string, max length)
   - Null handling with ##type markers

7. **Negative Testing (Functional)**:
   - Missing required fields → 400
   - Invalid data formats → 400
   - Non-existent resource IDs → 404
   - Unauthorized access → 401/403

8. **Performance**: assert responseTime < 3000

9. **Quality**:
   - Descriptive scenario names: "POST /orders with missing product name returns 400"
   - 4-space indentation, clean formatting
   - callonce for auth/setup, call for per-scenario helpers

BEFORE RETURNING, VERIFY:
- Every endpoint path exists in the provided spec
- Every response field matches the spec schema exactly
- No duplicate auth/setup blocks (use callonce in Background)
- All scenarios have intent-based descriptive names
- Status code assertions present in every scenario
- Tags (@positive/@negative/@edge) on every scenario

OUTPUT: Return COMPLETE enhanced Karate feature file. Start with Feature: [description]. NO explanations, NO markdown blocks. Pure Karate DSL only.

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
            let model = this.cachedModel;
            if (!model) {
                const selector = await this.getChatModelSelector();
                const models = await vscode.lm.selectChatModels(selector);
                if (models.length > 0) {
                    model = models[0];
                    this.cachedModel = model;
                }
            }

            if (!model) {
                throw new Error('GitHub Copilot is not available');
            }

            const requirementsText = requirements && requirements.length > 0
                ? `\n\nAdditional Requirements:\n${requirements.map((r, i) => `${i + 1}. ${r}`).join('\n')}`
                : '';

            // Get skill knowledge base for grounded generation
            const skillContext = await AgentSkillsService.buildSkillContextForPrompt('general');

            const messages = [
                vscode.LanguageModelChatMessage.User(
                    `You are an expert in API testing with Karate DSL.${skillContext}

API Endpoint: ${apiEndpoint}

Existing Test:
\`\`\`gherkin
${existingFeature}
\`\`\`${requirementsText}

CRITICAL RULES:
1. ZERO HALLUCINATION: Only use the endpoint path, fields, and schemas visible in the existing test above. Do NOT invent new endpoints or response fields.
2. Use correct Karate DSL syntax: match, def, #string, #number, #boolean, #present, #null.
3. Add @negative, @edge, @boundary tags to each scenario.
4. Use descriptive scenario names: "POST ${apiEndpoint} with missing required field returns 400".
5. Do NOT include SQL injection, XSS, or attack patterns. Use functional negative testing only.

Generate 3-5 additional test scenarios covering:
- Negative cases: missing required fields, invalid data formats → 400
- Edge cases: empty values, boundary values (0, max length) → 400
- Not found: non-existent resource IDs → 404
- Unauthorized: missing/invalid auth → 401/403
- Data validation: type mismatches, enum violations

Return ONLY the Scenario blocks (not the full feature file) in pure Karate DSL format. No markdown, no explanations.`
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
            let model = this.cachedModel;
            if (!model) {
                const selector = await this.getChatModelSelector();
                const models = await vscode.lm.selectChatModels(selector);
                if (models.length > 0) {
                    model = models[0];
                    this.cachedModel = model;
                }
            }

            if (!model) {
                return [];
            }

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

    /**
     * Enhanced test generation with file attachments and Agent Skills
     * This method uses file-based context instead of text chunking
     */
    static async enhanceTestWithFileContext(
        featureContent: string,
        context: string,
        contextType: 'openapi' | 'postman' | 'confluence' | 'combined' | 'coverage' | 'general',
        files: vscode.Uri[] = []
    ): Promise<string> {
        try {
            const isAvailable = await this.isCopilotAvailable();
            if (!isAvailable) {
                logger.warn('Copilot is not available, returning original feature');
                return featureContent;
            }

            logger.info(`Enhancing test with file-based context (${contextType}) and Agent Skills`);

            // Build comprehensive skill context
            const fullSkillContext = await AgentSkillsService.buildSkillContextForPrompt(contextType);

            const messages: vscode.LanguageModelChatMessage[] = [];

            // Check total file size to determine approach
            let totalSizeKB = 0;
            const fileContents: Array<{ fileName: string; content: string; sizeKB: number }> = [];

            // Read all files and calculate size
            for (const fileUri of files) {
                try {
                    const fs = await import('fs');
                    const stats = fs.statSync(fileUri.fsPath);
                    const fileSizeKB = stats.size / 1024;
                    totalSizeKB += fileSizeKB;

                    const content = fs.readFileSync(fileUri.fsPath, 'utf-8');
                    const fileName = path.basename(fileUri.fsPath);

                    fileContents.push({ fileName, content, sizeKB: fileSizeKB });
                    logger.info(`Read ${fileName}: ${fileSizeKB.toFixed(1)}KB`);
                } catch (error) {
                    logger.warn(`Failed to read file ${path.basename(fileUri.fsPath)}:`, error as Error);
                }
            }

            // Decision: Use multi-part for large files (>150KB total)
            const USE_MULTIPART = totalSizeKB > 150;

            if (USE_MULTIPART) {
                logger.info(`Large file size detected (${totalSizeKB.toFixed(1)}KB) - using multi-part approach`);
                return await this.enhanceWithMultiPart(featureContent, context, fileContents, fullSkillContext, contextType);
            }

            // Small files: Single request approach
            logger.info(`Small file size (${totalSizeKB.toFixed(1)}KB) - using single request`);

            // Build enhanced prompt with ACTUAL file content
            let promptText = `${context}\n\n`;

            // Include file contents
            if (fileContents.length > 0) {
                promptText += '=== SOURCE FILES (use ONLY these for generation) ===\n\n';

                for (const file of fileContents) {
                    promptText += `📄 File: ${file.fileName} (${file.sizeKB.toFixed(1)}KB)\n`;
                    promptText += '```\n';
                    promptText += file.content;
                    promptText += '\n```\n\n';
                }

                promptText += '=== END SOURCE FILES ===\n\n';
            }

            if (fullSkillContext) {
                promptText += fullSkillContext + '\n';
            }

            promptText += `Karate Test to Enhance:\n${featureContent}\n\nCRITICAL: Use ONLY endpoints, fields, and schemas from the source files above. Do NOT invent any endpoint or field not present in the source. Use correct Karate DSL: match, def, call, callonce, #string, #number, #boolean. Extract repeated auth/setup to callonce. Add @positive/@negative/@edge tags.\n\nBEFORE RETURNING, VERIFY: Every endpoint and field exists in the source files. No duplicate auth blocks. Status assertions in every scenario.\n\nOUTPUT: Return the COMPLETE enhanced Karate feature file. NO explanations, NO markdown blocks.`;

            messages.push(vscode.LanguageModelChatMessage.User(promptText));

            // Send request
            let model = this.cachedModel;
            if (!model) {
                const selector = await this.getChatModelSelector();
                const models = await vscode.lm.selectChatModels(selector);
                if (models.length > 0) {
                    model = models[0];
                    this.cachedModel = model;
                }
            }

            if (!model) {
                throw new Error('No Copilot models available');
            }

            const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

            let result = '';
            for await (const fragment of response.text) {
                result += fragment;
            }

            const cleanContent = this.cleanCopilotResponse(result);

            // Log for transparency
            const fileNames = fileContents.map(f => f.fileName).join(', ');
            CopilotLogger.logRequest(`Enhance Test (${contextType}) - Single Request`, context, `[Files: ${fileNames}] Total: ${totalSizeKB.toFixed(1)}KB`);
            CopilotLogger.logResponse(`Enhance Test (${contextType})`, cleanContent, 0);

            logger.info('Successfully enhanced test with file content (single request)');
            return cleanContent;

        } catch (error) {
            logger.error('Failed to enhance test with file context', error as Error);
            return featureContent;
        }
    }

    /**
     * Enhanced test generation using multi-part approach for large files
     * Sends file content in chunks to avoid token limits
     */
    private static async enhanceWithMultiPart(
        featureContent: string,
        context: string,
        fileContents: Array<{ fileName: string; content: string; sizeKB: number }>,
        skillContext: string,
        contextType: string
    ): Promise<string> {
        try {
            const messages: vscode.LanguageModelChatMessage[] = [];

            // Turn 1: Send context, skill knowledge, and rules
            let turn1 = `${context}\n\n`;
            if (skillContext) {
                turn1 += skillContext + '\n\n';
            }
            turn1 += 'CRITICAL RULES for this session:\n';
            turn1 += '1. ZERO HALLUCINATION: Use ONLY endpoints, fields, and schemas from the files I will send. Do NOT invent anything.\n';
            turn1 += '2. KARATE DSL: Use correct syntax — match, def, call, callonce, #string, #number, #boolean, #present, #null.\n';
            turn1 += '3. REUSABILITY: Extract auth to callonce, shared config in Background.\n';
            turn1 += '4. TAGS: @positive, @negative, @edge on each scenario.\n\n';
            turn1 += 'I will send you source files in the next messages. Analyze them for endpoints, schemas, and fields.';
            messages.push(vscode.LanguageModelChatMessage.User(turn1));
            messages.push(vscode.LanguageModelChatMessage.Assistant('I understand the rules. I will use ONLY the endpoints, fields, and schemas from your files. I will use correct Karate DSL syntax with proper tags and reusability. Please send the files.'));

            // Turn 2+: Send file contents (chunk if multiple files)
            for (const file of fileContents) {
                const fileMessage = `📄 Source File: ${file.fileName} (${file.sizeKB.toFixed(1)}KB) — use this as the ONLY source of truth for endpoints and schemas:\n\`\`\`\n${file.content}\n\`\`\``;
                messages.push(vscode.LanguageModelChatMessage.User(fileMessage));
                messages.push(vscode.LanguageModelChatMessage.Assistant('File content received. I have identified the endpoints, request/response schemas, and field types from this file. I will only use these in the enhanced test.'));
            }

            // Final turn: Send test to enhance with verification checklist
            const finalPrompt = `Based on the source files provided, enhance this Karate test:\n\n${featureContent}\n\nBEFORE RETURNING, VERIFY:\n- Every endpoint path exists in the source files\n- Every response field matches the source schema\n- No duplicate auth/setup (use callonce in Background)\n- Descriptive scenario names\n- Status code assertions in every scenario\n- @positive/@negative/@edge tags on every scenario\n\nOUTPUT: Return the COMPLETE enhanced Karate feature file. NO explanations, NO markdown blocks. Pure Karate DSL only.`;
            messages.push(vscode.LanguageModelChatMessage.User(finalPrompt));

            // Send multi-turn request
            let model = this.cachedModel;
            if (!model) {
                const selector = await this.getChatModelSelector();
                const models = await vscode.lm.selectChatModels(selector);
                if (models.length > 0) {
                    model = models[0];
                    this.cachedModel = model;
                }
            }

            if (!model) {
                throw new Error('No Copilot models available');
            }

            logger.info(`Sending multi-part request: ${messages.length} messages`);
            const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

            let result = '';
            for await (const fragment of response.text) {
                result += fragment;
            }

            const cleanContent = this.cleanCopilotResponse(result);

            // Log for transparency
            const fileNames = fileContents.map(f => f.fileName).join(', ');
            const totalSize = fileContents.reduce((sum, f) => sum + f.sizeKB, 0);
            CopilotLogger.logRequest(`Enhance Test (${contextType}) - Multi-Part`, context, `[Files: ${fileNames}] Total: ${totalSize.toFixed(1)}KB, ${messages.length} turns`);
            CopilotLogger.logResponse(`Enhance Test (${contextType})`, cleanContent, 0);

            logger.info(`Successfully enhanced test with multi-part approach (${messages.length} turns)`);
            return cleanContent;

        } catch (error) {
            logger.error('Multi-part enhancement failed', error as Error);
            throw error;
        }
    }

    /**
     * Helper method to create file URI from path
     */
    static createFileUri(filePath: string): vscode.Uri {
        return vscode.Uri.file(filePath);
    }

    /**
     * Helper method to create temp file for non-file content
     */
    static async createTempFile(content: string, extension: string): Promise<vscode.Uri> {
        return ContextBuilder.createTempFileFromContent(content, extension);
    }

    /**
     * Cleanup temporary files created during context building
     */
    static async cleanupTempFiles(): Promise<void> {
        await ContextBuilder.cleanupTempFiles();
    }
}
