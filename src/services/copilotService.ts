import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { CopilotLogger } from '../utils/copilotLogger';
import { AgentSkillsService } from './agentSkillsService';
import { ContextBuilder } from '../utils/contextBuilder';
import { InputSanitizer } from './InputSanitizer';
import { AIProviderRegistry } from './ai/AIProviderRegistry';
import { AITask } from './ai/AIProvider';

export interface CopilotFullContext {
    type: 'openapi' | 'confluence' | 'combined' | 'postman' | 'coverage';
    openApiSpec?: string;
    confluencePage?: string;
    postmanCollection?: string;
    requirements?: string[];
    specFilePath?: string;
    collectionFilePath?: string;
    environmentFilePath?: string;
    featureFilePath?: string;
}

/**
 * Backward-compatible facade for existing call sites. All model discovery and
 * requests are delegated to AIProviderRegistry; this class contains no routing.
 */
export class CopilotService {
    static async initialize(): Promise<void> {
        // Kept for compatibility. Discovery must happen from a user action.
    }

    static async getAvailableModels(): Promise<string[]> {
        const models = await AIProviderRegistry.getInstance().getModels('copilot');
        return models.map(model => model.name || model.id);
    }

    static async getPreferredModel(): Promise<string> {
        const config = vscode.workspace.getConfiguration('karateDsl');
        return config.get<string>('ai.copilotModelId', '') || 'Automatic (quota-conscious)';
    }

    /** Legacy name: checks the provider selected for all AI operations. */
    static async isCopilotAvailable(): Promise<boolean> {
        try {
            await AIProviderRegistry.getInstance().getProvider();
            return true;
        } catch {
            return false;
        }
    }

    static async enhanceKarateTest(
        featureContent: string,
        context: string,
        fullContext?: CopilotFullContext
    ): Promise<string> {
        const safeContext = InputSanitizer.sanitizeUserInstruction(context);
        const contextType = fullContext?.type || 'general';
        const skillContext = await AgentSkillsService.buildSkillContextForPrompt(contextType);
        const evidence = this.buildInlineEvidence(fullContext);
        const prompt = `${evidence}${skillContext}

CURRENT KARATE FEATURE
${featureContent}

REQUEST
${safeContext}

Return the complete enhanced Karate feature. Preserve intended behavior and unrelated scenarios. Use functional negative testing only. Return pure Karate DSL without markdown.`;

        return this.completeFeature(prompt, featureContent, 'enhance-feature', context);
    }

    static async enhanceKarateTestComprehensive(
        featureContent: string,
        context: string,
        fullContext?: CopilotFullContext,
        token?: vscode.CancellationToken
    ): Promise<string> {
        const safeContext = InputSanitizer.sanitizeUserInstruction(context);
        const skillContext = await AgentSkillsService.buildSkillContextForPrompt(fullContext?.type || 'general');
        const prompt = `${this.buildInlineEvidence(fullContext)}${skillContext}

CURRENT KARATE FEATURE
${featureContent}

REQUEST
${safeContext}

Improve coverage only where supported by evidence. Check status assertions, resilient schema matching, boundary cases, readable names, reuse, isolation, and parallel safety. Do not invent server errors or undocumented response fields. Return the complete feature as pure Karate DSL.`;
        return this.completeFeature(prompt, featureContent, 'enhance-feature', context, token);
    }

    static async generateAdditionalScenarios(
        existingFeature: string,
        apiEndpoint: string,
        requirements?: string[]
    ): Promise<string[]> {
        try {
            const skillContext = await AgentSkillsService.buildSkillContextForPrompt('general');
            const requirementText = requirements?.length
                ? requirements.map(item => `- ${InputSanitizer.sanitizeUserInstruction(item)}`).join('\n')
                : 'No additional requirements supplied.';
            const prompt = `${skillContext}

ENDPOINT
${InputSanitizer.sanitizeUserInstruction(apiEndpoint)}

EXISTING FEATURE
${existingFeature}

ADDITIONAL REQUIREMENTS
${requirementText}

Generate 3-5 useful scenario blocks supported by the evidence. Focus on documented negative, boundary, not-found, and authorization behavior. Return only Scenario or Scenario Outline blocks as pure Karate DSL.`;
            const result = await AIProviderRegistry.getInstance().complete(prompt, {
                maxTokens: 4096,
                temperature: 0.2,
                task: 'generate-missing-test'
            });
            const cleaned = this.cleanCopilotResponse(result);
            CopilotLogger.logRequest('Generate Additional Scenarios', apiEndpoint, prompt);
            CopilotLogger.logResponse('Generate Additional Scenarios', cleaned, 0);
            return this.extractScenarios(cleaned);
        } catch (error) {
            logger.error('Failed to generate additional scenarios', error as Error);
            return [];
        }
    }

    static async getSuggestions(featureContent: string): Promise<string[]> {
        try {
            const result = await AIProviderRegistry.getInstance().complete(
                `Review this Karate feature and return five concise, concrete improvements as a numbered list. Do not rewrite the feature.\n\n${featureContent}`,
                { maxTokens: 2048, temperature: 0.2, task: 'suggest-reusability' }
            );
            return result.split('\n')
                .filter(line => /^\d+[.)]/.test(line.trim()))
                .map(line => line.replace(/^\d+[.)]\s*/, '').trim())
                .filter(Boolean);
        } catch (error) {
            logger.error('Failed to get Karate suggestions', error as Error);
            return [];
        }
    }

    static async enhanceTestWithFileContext(
        featureContent: string,
        context: string,
        contextType: 'openapi' | 'postman' | 'confluence' | 'combined' | 'coverage' | 'general',
        files: vscode.Uri[] = []
    ): Promise<string> {
        try {
            const skillContext = await AgentSkillsService.buildSkillContextForPrompt(contextType);
            const fileContext = files.map(uri => {
                try {
                    const content = fs.readFileSync(uri.fsPath, 'utf8');
                    return `SOURCE: ${path.basename(uri.fsPath)}\n${content}`;
                } catch (error) {
                    logger.warn(`Unable to read AI context file ${path.basename(uri.fsPath)}`, error as Error);
                    return '';
                }
            }).filter(Boolean).join('\n\n');
            const prompt = `${skillContext}

SOURCE EVIDENCE
${fileContext || 'No additional source file was supplied.'}

CURRENT KARATE FEATURE
${featureContent}

REQUEST
${InputSanitizer.sanitizeUserInstruction(context)}

Use the source evidence as the contract boundary. Return the complete Karate feature without markdown or explanations.`;
            return this.completeFeature(prompt, featureContent, this.taskForContext(contextType), context);
        } catch (error) {
            logger.error('Failed to enhance test with file context', error as Error);
            return featureContent;
        }
    }

    static createFileUri(filePath: string): vscode.Uri {
        return vscode.Uri.file(filePath);
    }

    static async createTempFile(content: string, extension: string): Promise<vscode.Uri> {
        return ContextBuilder.createTempFileFromContent(content, extension);
    }

    static async cleanupTempFiles(): Promise<void> {
        await ContextBuilder.cleanupTempFiles();
    }

    private static async completeFeature(
        prompt: string,
        fallback: string,
        task: AITask,
        logContext: string,
        cancellationToken?: vscode.CancellationToken
    ): Promise<string> {
        try {
            const result = await AIProviderRegistry.getInstance().complete(prompt, {
                maxTokens: 4096,
                temperature: 0.2,
                task,
                cancellationToken
            });
            const cleaned = this.cleanCopilotResponse(result);
            if (!this.isValidFeatureOutput(cleaned)) {
                logger.warn('AI output failed the Karate feature shape gate; preserving original content');
                return fallback;
            }
            CopilotLogger.logRequest('Karate AI Enhancement', logContext, prompt);
            CopilotLogger.logResponse('Karate AI Enhancement', cleaned, 0);
            return cleaned;
        } catch (error) {
            logger.error('Karate AI enhancement failed', error as Error);
            return fallback;
        }
    }

    private static taskForContext(contextType: 'openapi' | 'postman' | 'confluence' | 'combined' | 'coverage' | 'general'): AITask {
        switch (contextType) {
            case 'openapi': return 'generate-openapi';
            case 'postman': return 'generate-postman';
            case 'coverage': return 'analyze-coverage';
            case 'confluence':
            case 'combined': return 'generate-requirements';
            default: return 'enhance-feature';
        }
    }

    private static buildInlineEvidence(fullContext?: CopilotFullContext): string {
        if (!fullContext) return '';
        const sections: string[] = [];
        if (fullContext.openApiSpec) sections.push(`OPENAPI EVIDENCE\n${InputSanitizer.sanitizeSpec(fullContext.openApiSpec)}`);
        if (fullContext.postmanCollection) sections.push(`POSTMAN EVIDENCE\n${InputSanitizer.sanitizeSpec(fullContext.postmanCollection)}`);
        if (fullContext.confluencePage) sections.push(`REQUIREMENT EVIDENCE\n${InputSanitizer.sanitizeConfluence(fullContext.confluencePage)}`);
        if (fullContext.requirements?.length) sections.push(`REQUIREMENTS\n${fullContext.requirements.map(item => `- ${InputSanitizer.sanitizeUserInstruction(item)}`).join('\n')}`);
        return sections.length ? `${sections.join('\n\n')}\n\n` : '';
    }

    private static isValidFeatureOutput(content: string): boolean {
        return /^\s*Feature\s*:/mi.test(content)
            && /^\s*(Scenario|Scenario Outline)\s*:/mi.test(content)
            && !/```/.test(content);
    }

    private static cleanCopilotResponse(response: string): string {
        return response.replace(/```(?:gherkin|feature|karate)?\s*/gi, '').replace(/```/g, '').trim();
    }

    private static extractScenarios(text: string): string[] {
        const starts: number[] = [];
        const pattern = /^\s*(?:@[\w-]+(?:\s+@[\w-]+)*\s*\n\s*)*(?:Scenario|Scenario Outline)\s*:/gmi;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) starts.push(match.index);
        return starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length).trim()).filter(Boolean);
    }
}
