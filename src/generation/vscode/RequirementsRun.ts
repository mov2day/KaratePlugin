import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { OpenAPIParser } from '../../services/openApiParser';
import { logger } from '../../utils/logger';
import { buildRequirementScenarios, redactRequirementText } from '../adapters/requirements';
import type { RequirementBuild, RequirementItem } from '../adapters/requirements';
import type { GenerationModel } from '../model/TestModel';
import { GeneratorConfigLoader } from './GeneratorConfigLoader';
import { runGenerationForModel } from './runGeneration';
import type { RunGenerationResult } from './runGeneration';

/** An OpenAPI contract the user linked to the requirements (optional). */
export interface LinkedContract {
    model: GenerationModel;
    /** Spec text, offered to AI refinement as evidence. */
    text: string;
    fileName: string;
}

const MAX_EVIDENCE = 20000;

/**
 * Optional QuickPick: link an OpenAPI spec found in the workspace so criteria map to real operations.
 * Returns undefined for "Skip" (criteria become drafts), when nothing is found, or when the pick is cancelled.
 */
export async function pickContract(): Promise<LinkedContract | undefined> {
    const found = await vscode.workspace.findFiles('**/*{openapi,swagger}*.{json,yaml,yml}', '**/node_modules/**', 20);
    if (found.length === 0) {return undefined;}
    const items = [
        { label: 'Skip', description: 'Draft the criteria without a contract', uri: undefined as vscode.Uri | undefined },
        ...found.map(uri => ({ label: vscode.workspace.asRelativePath(uri), description: '', uri }))
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Link an OpenAPI spec (optional)' });
    if (!pick?.uri) {return undefined;}
    try {
        const model = await new OpenAPIParser().parseModel(pick.uri.fsPath);
        return { model, text: fs.readFileSync(pick.uri.fsPath, 'utf8'), fileName: path.basename(pick.uri.fsPath) };
    } catch (error) {
        logger.warn(`Could not parse the selected OpenAPI spec; continuing without a contract: ${safeMessage(error)}`);
        void vscode.window.showWarningMessage('The selected OpenAPI spec could not be parsed; criteria will be drafted without a contract.');
        return undefined;
    }
}

/** An error message that never carries a host, token, or credential (also masks the exact secrets passed in). */
export function safeMessage(error: unknown, secrets: (string | undefined)[] = []): string {
    let message = String((error as { message?: unknown } | undefined)?.message ?? error);
    for (const secret of secrets) {
        if (secret && secret.length >= 4) {message = message.split(secret).join('[redacted]');}
    }
    return redactRequirementText(message).text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** Evidence for AI refinement: the (redacted) source text plus the linked spec; nothing else. */
export function requirementEvidence(label: string, sourceText: string, contract?: LinkedContract): { label: string; text: string }[] {
    const evidence: { label: string; text: string }[] = [];
    const source = redactRequirementText(sourceText).text.trim();
    if (source) {evidence.push({ label, text: source.slice(0, MAX_EVIDENCE) });}
    if (contract) {evidence.push({ label: `OpenAPI: ${contract.fileName}`, text: redactRequirementText(contract.text).text.slice(0, MAX_EVIDENCE) });}
    return evidence;
}

export function evidenceFromItems(items: RequirementItem[]): string {
    return items.map(i => `${i.id} - ${i.title}\n${i.criteria.map(c => (typeof c === 'string' ? c : [c.text, ...(c.steps ?? []), c.expected ?? ''].filter(Boolean).join(' | '))).join('\n')}`).join('\n\n');
}

export interface RequirementsRunInput {
    context: vscode.ExtensionContext;
    workspaceRoot: string;
    items: RequirementItem[];
    /** Names the feature file (`<name>/<name>-requirements.feature`). */
    name: string;
    mode: 'jira' | 'confluence';
    sourceRef: string;
    contract?: LinkedContract;
    useAi: boolean;
    /** Source text for AI evidence; defaults to the criteria. */
    evidenceText?: string;
    evidenceLabel: string;
    progress: (msg: string, pct: number) => void;
}

/** Build the requirement scenarios and run them through the shared pipeline. `run` is undefined when there was nothing to generate. */
export async function runRequirementsGeneration(i: RequirementsRunInput): Promise<{ build: RequirementBuild; run?: RunGenerationResult }> {
    const loaded = await GeneratorConfigLoader.load(i.workspaceRoot);
    for (const w of loaded.warnings) {logger.warn(`Generator config: ${w}`);}
    const build = buildRequirementScenarios(i.items, { config: loaded.config, name: i.name, model: i.contract?.model });
    for (const w of build.warnings) {logger.warn(`Requirements: ${w}`);}
    if (build.features.length === 0) {return { build };}
    const model: GenerationModel = i.contract?.model ?? { source: i.mode, name: i.name, schemes: [], operations: [], unsupported: [] };
    const run = await runGenerationForModel({
        context: i.context, workspaceRoot: i.workspaceRoot, model, sourceRef: i.sourceRef, mode: i.mode, useAi: i.useAi,
        scenarios: build.features, classpathFiles: build.files, config: loaded.config, notes: build.warnings,
        evidence: requirementEvidence(i.evidenceLabel, i.evidenceText ?? evidenceFromItems(i.items), i.contract),
        progress: i.progress
    });
    return { build, run };
}
