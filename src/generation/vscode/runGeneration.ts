import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentSkillsService } from '../../services/agentSkillsService';
import { AIProviderRegistry } from '../../services/ai/AIProviderRegistry';
import { CopilotService } from '../../services/copilotService';
import type { KarateStyle } from '../../types';
import { logger } from '../../utils/logger';
import type { AiCall } from '../ai/AiRefiner';
import { loadSkillPack } from '../ai/SkillPack';
import type { SkillPack } from '../ai/SkillPack';
import { discoverProject } from '../config/ProjectDiscovery';
import type { GeneratorConfig } from '../config/GeneratorConfig';
import type { GenerationModel, SourceKind } from '../model/TestModel';
import { runPipeline } from '../pipeline/GenerationPipeline';
import type { PipelineInput, PipelineResult } from '../pipeline/GenerationPipeline';
import { formatSummary } from '../pipeline/Summary';
import type { GenerationSummary } from '../pipeline/Summary';
import type { PlanOptions, PlannedFeature } from '../plan/OpenApiPlanner';
import { GeneratorConfigLoader } from './GeneratorConfigLoader';
import { nodeFs } from './NodeFs';
import { WorkspaceHashStore } from './WorkspaceHashStore';

export interface RunGenerationInput {
    context: vscode.ExtensionContext;
    workspaceRoot: string;
    model: GenerationModel;
    sourceRef: string;
    mode: SourceKind;
    useAi: boolean;
    extraFiles?: PipelineInput['extraFiles'];
    scenarios?: PlannedFeature[];
    /** Forwarded to the planner (batch runs namespace data/schema files per spec). */
    planOptions?: PlanOptions;
    /** Appended to the planned OpenAPI features (combined mode). */
    extraFeatures?: PlannedFeature[];
    evidence?: PipelineInput['evidence'];
    progress: (msg: string, pct: number) => void;
    customInstruction?: string;
    /** Learned style: used only when neither a shared-style file nor .karate-generator.json sets a style. */
    learnedStyle?: KarateStyle | null;
    /** Extra warnings to surface in the summary (e.g. an ignored template). */
    notes?: string[];
    /** Adjust the loaded config (e.g. restrict scenario categories) before the pipeline runs. */
    configure?: (config: GeneratorConfig) => GeneratorConfig;
    /** Pre-loaded config for batch runs (skips reloading and re-warning). */
    config?: GeneratorConfig;
}

export interface RunGenerationResult extends PipelineResult {
    createdPaths: string[];
    firstContent: string;
    summary: GenerationSummary;
}

function loadSkills(context: vscode.ExtensionContext): SkillPack | undefined {
    try {
        return AgentSkillsService.getPack() ?? loadSkillPack(path.join(context.extensionPath, 'skills'), nodeFs);
    } catch (error) {
        logger.warn('Skill pack unavailable; generating without skills', error as Error);
        return undefined;
    }
}

/** AI is optional: returns undefined unless the user asked for it and a provider is available. */
async function buildAi(useAi: boolean): Promise<AiCall | undefined> {
    if (!useAi) {return undefined;}
    let available = false;
    try {
        available = await CopilotService.isCopilotAvailable();
    } catch {
        available = false;
    }
    if (!available) {
        logger.info('AI refinement requested but no provider is available; using deterministic output');
        return undefined;
    }
    return async p => AIProviderRegistry.getInstance().complete(p.user, {
        systemPrompt: p.system,
        task: 'enhance-feature',
        maxTokens: 4096,
        temperature: 0.2
    });
}

/** The path a feature ended up at: the `.generated` sibling when the original was user-edited. */
function actualFeaturePath(r: PipelineResult, featurePath: string): string | undefined {
    const side = r.written.sideBySide.find(s => s.path === featurePath);
    if (side) {return side.generatedPath;}
    const w = r.written;
    return [...w.created, ...w.updated, ...w.skippedExisting].includes(featurePath) ? featurePath : undefined;
}

export async function runGenerationForModel(i: RunGenerationInput): Promise<RunGenerationResult> {
    let config = i.config;
    if (!config) {
        const loaded = await GeneratorConfigLoader.load(i.workspaceRoot, { fallbackStyle: i.learnedStyle });
        for (const w of loaded.warnings) {logger.warn(`Generator config: ${w}`);}
        config = loaded.config;
    }
    if (i.configure) {config = i.configure(config);}

    const project = discoverProject(i.workspaceRoot, nodeFs);
    const skills = loadSkills(i.context);
    const ai = await buildAi(i.useAi);
    const history = new WorkspaceHashStore(i.context);
    const version = (i.context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '0.0.0';

    let result: PipelineResult;
    try {
        result = await runPipeline({
            model: i.model, scenarios: i.scenarios, extraFeatures: i.extraFeatures, planOptions: i.planOptions, config, project, fsApi: nodeFs, history, skills, ai,
            evidence: i.evidence, request: i.customInstruction?.trim() || undefined,
            generatorVersion: version, sourceRef: i.sourceRef, mode: i.mode, progress: i.progress,
            extraFiles: i.extraFiles, root: i.workspaceRoot
        });
    } finally {
        try {
            await history.flush();
        } catch (error) {
            logger.warn('Could not persist generation hashes', error as Error);
        }
    }

    // Keep the legacy diagnostic in sync: prefer a rejected refinement, else the first one.
    const refinements = result.features.map(f => f.refinement).filter((r): r is NonNullable<typeof r> => r !== undefined);
    CopilotService.lastRefinement = refinements.find(r => r.status === 'rejected') ?? refinements[0];

    const createdPaths = result.features
        .map(f => actualFeaturePath(result, f.path))
        .filter((p): p is string => p !== undefined);
    let firstContent = '';
    if (createdPaths.length > 0) {
        try {
            firstContent = fs.readFileSync(createdPaths[0], 'utf8');
        } catch {
            firstContent = '';
        }
    }
    result.warnings.push(...(i.notes ?? []));
    return { ...result, createdPaths, firstContent, summary: formatSummary(result, { expectedDraftFeature: i.mode === 'combined' ? p => p.endsWith('-requirements.feature') : undefined }) };
}

/** Adapt a `withProgress` reporter (incremental) to the pipeline's absolute 0-100 callback, optionally scaled into a slice. */
export function toIncrementalProgress(
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    slice: { from: number; to: number } = { from: 0, to: 100 }
): (msg: string, pct: number) => void {
    let last = 0;
    return (message, pct) => {
        const scaled = slice.from + (Math.max(0, Math.min(100, pct)) / 100) * (slice.to - slice.from);
        progress.report({ message, increment: Math.max(0, scaled - last) });
        last = Math.max(last, scaled);
    };
}
