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
import { buildPrompt } from '../generation/ai/PromptBuilder';
import { cleanOutput, refine } from '../generation/ai/AiRefiner';
import type { RefineResult } from '../generation/ai/AiRefiner';
import { DEFAULT_GENERATOR_CONFIG } from '../generation/config/GeneratorConfig';
import type { SourceKind } from '../generation/model/TestModel';

type Evidence = { label: string; text: string };

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
    /** Outcome of the most recent whole-feature refinement (undefined until one runs); the pipeline reports rejections from it. */
    static lastRefinement?: RefineResult;

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
        const request = `${safeContext}\n\nPreserve intended behavior and unrelated scenarios. Use functional negative testing only.`;
        return this.completeFeature({
            feature: featureContent, request, skillContext, evidence: this.buildInlineEvidence(fullContext),
            task: 'enhance-feature', mode: this.modeForContext(contextType), logContext: context
        });
    }

    static async enhanceKarateTestComprehensive(
        featureContent: string,
        context: string,
        fullContext?: CopilotFullContext,
        token?: vscode.CancellationToken
    ): Promise<string> {
        const safeContext = InputSanitizer.sanitizeUserInstruction(context);
        const contextType = fullContext?.type || 'general';
        const skillContext = await AgentSkillsService.buildSkillContextForPrompt(contextType);
        const request = `${safeContext}\n\nImprove coverage only where supported by evidence. Check status assertions, resilient schema matching, boundary cases, readable names, reuse, isolation, and parallel safety. Do not invent server errors or undocumented response fields.`;
        return this.completeFeature({
            feature: featureContent, request, skillContext, evidence: this.buildInlineEvidence(fullContext),
            task: 'enhance-feature', mode: this.modeForContext(contextType), logContext: context, cancellationToken: token
        });
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
            const built = buildPrompt({
                task: 'generate-missing-test',
                mode: 'combined',
                skills: skillContext,
                evidence: [{ label: 'endpoint', text: InputSanitizer.sanitizeUserInstruction(apiEndpoint) }],
                feature: existingFeature,
                request: `ADDITIONAL REQUIREMENTS\n${requirementText}\n\nGenerate 3-5 useful scenario blocks supported by the evidence. Focus on documented negative, boundary, not-found, and authorization behavior.`
            });
            const prompt = built.user;
            const result = await AIProviderRegistry.getInstance().complete(prompt, {
                maxTokens: 4096,
                temperature: 0.2,
                systemPrompt: built.system,
                task: 'generate-missing-test'
            });
            const cleaned = cleanOutput(result);
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
            const evidence: Evidence[] = files.map(uri => {
                try {
                    return { label: path.basename(uri.fsPath), text: fs.readFileSync(uri.fsPath, 'utf8') };
                } catch (error) {
                    logger.warn(`Unable to read AI context file ${path.basename(uri.fsPath)}`, error as Error);
                    return undefined;
                }
            }).filter((item): item is Evidence => item !== undefined);
            return await this.completeFeature({
                feature: featureContent,
                request: `${InputSanitizer.sanitizeUserInstruction(context)}\n\nUse the source evidence as the contract boundary.`,
                skillContext, evidence, task: this.taskForContext(contextType), mode: this.modeForContext(contextType), logContext: context
            });
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

    private static async completeFeature(o: {
        feature: string;
        request: string;
        skillContext: string;
        evidence: Evidence[];
        task: AITask;
        mode: SourceKind;
        logContext: string;
        cancellationToken?: vscode.CancellationToken;
    }): Promise<string> {
        this.lastRefinement = undefined;
        try {
            const result = await refine({
                feature: o.feature,
                mode: o.mode,
                task: o.task,
                evidence: o.evidence,
                request: o.request,
                skills: { select: () => ({ text: o.skillContext }) },
                knownFiles: new Set<string>(),
                config: DEFAULT_GENERATOR_CONFIG,
                ai: async p => {
                    CopilotLogger.logRequest('Karate AI Enhancement', o.logContext, p.user);
                    const out = await AIProviderRegistry.getInstance().complete(p.user, {
                        maxTokens: 4096,
                        temperature: 0.2,
                        systemPrompt: p.system,
                        task: o.task,
                        cancellationToken: o.cancellationToken
                    });
                    CopilotLogger.logResponse('Karate AI Enhancement', out, 0);
                    return out;
                }
            });
            this.lastRefinement = result;
            if (result.status === 'rejected') {
                logger.warn(`AI refinement rejected (${result.findings.map(f => f.ruleId).join(', ') || 'no findings'}); preserving original content`);
            }
            return result.text;
        } catch (error) {
            logger.error('Karate AI enhancement failed', error as Error);
            return o.feature;
        }
    }

    private static modeForContext(contextType: CopilotFullContext['type'] | 'general'): SourceKind {
        switch (contextType) {
            case 'openapi': return 'openapi';
            case 'postman': return 'postman';
            case 'confluence': return 'confluence';
            default: return 'combined';
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

    private static buildInlineEvidence(fullContext?: CopilotFullContext): Evidence[] {
        if (!fullContext) return [];
        const evidence: Evidence[] = [];
        if (fullContext.openApiSpec) evidence.push({ label: 'openapi', text: InputSanitizer.sanitizeSpec(fullContext.openApiSpec) });
        if (fullContext.postmanCollection) evidence.push({ label: 'postman', text: InputSanitizer.sanitizeSpec(fullContext.postmanCollection) });
        if (fullContext.confluencePage) evidence.push({ label: 'requirements', text: InputSanitizer.sanitizeConfluence(fullContext.confluencePage) });
        if (fullContext.requirements?.length) evidence.push({ label: 'requirement-list', text: fullContext.requirements.map(item => `- ${InputSanitizer.sanitizeUserInstruction(item)}`).join('\n') });
        return evidence;
    }

    private static extractScenarios(text: string): string[] {
        const starts: number[] = [];
        const pattern = /^\s*(?:@[\w-]+(?:\s+@[\w-]+)*\s*\n\s*)*(?:Scenario|Scenario Outline)\s*:/gmi;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) starts.push(match.index);
        return starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length).trim()).filter(Boolean);
    }
}
