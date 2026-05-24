import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { OpenAPIParser } from '../openApiParser';
import { KarateGenerator } from '../karateGenerator';
import { CoverageAnalyzer } from '../coverageAnalyzer';
import { TestExecutor } from '../execution/TestExecutor';
import { TestHistoryService } from '../execution/TestHistoryService';
import { FlakinessAnalyzer, ScenarioFlakiness } from '../flakiness/FlakinessAnalyzer';
import { FlakinessFixService } from '../flakiness/FlakinessFixService';
import { SharedStyleService } from '../SharedStyleService';
import { AIProviderRegistry } from '../ai/AIProviderRegistry';
import { CIFailurePayload } from '../ci/CIFailureIngestor';
import { TestExecutionResult } from '../../types';

export interface KarateMcpToolOutcome {
    ok: boolean;
    text: string;
    data: Record<string, unknown>;
}

/**
 * Implements Karate MCP tool handlers with workspace path confinement.
 */
export class KarateMcpToolService {
    private readonly coverageAnalyzer = new CoverageAnalyzer();
    private readonly flakinessAnalyzer = new FlakinessAnalyzer();
    private readonly flakinessFixService = new FlakinessFixService();
    private readonly testExecutor: TestExecutor;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly extensionPath: string
    ) {
        this.testExecutor = new TestExecutor(extensionPath);
    }

    async generateTests(args: Record<string, unknown>): Promise<KarateMcpToolOutcome> {
        const specPathValue = this.readStringArg(args, 'spec_path');
        if (!specPathValue) {
            return this.invalidArgs('Missing required argument: spec_path');
        }

        const specPath = this.resolveWorkspacePath(specPathValue, 'file');
        if (!specPath) {
            return this.invalidArgs('spec_path must resolve inside the workspace');
        }

        const options = (args.options && typeof args.options === 'object')
            ? (args.options as Record<string, unknown>)
            : {};
        const strategy = this.readStringArg(options, 'structuring_strategy') || 'flat';
        const includeBackground = this.readBooleanArg(options, 'include_background', true);
        const scenarioTypes = this.readStringArrayArg(options, 'scenario_types');
        const httpMethods = this.readStringArrayArg(options, 'http_methods')?.map(m => m.toLowerCase());

        const parser = new OpenAPIParser();
        let endpoints = await parser.parseSpec(specPath);
        if (httpMethods && httpMethods.length > 0) {
            const methodSet = new Set(httpMethods);
            endpoints = endpoints.filter(e => methodSet.has(e.method.toLowerCase()));
        }

        const generator = new KarateGenerator();
        const sharedStyle = SharedStyleService.loadSharedStyle();
        if (sharedStyle) {
            generator.setStyle(sharedStyle);
        }

        const specBaseName = path.basename(specPath, path.extname(specPath));
        const generatedFiles: Array<{ fileName: string; content: string }> = [];

        if (strategy === 'domain' || strategy === 'method') {
            const structured = generator.generateStructured(endpoints, {
                strategy,
                autoTag: true,
                outputRoot: this.getWorkspaceRoot()
            }, scenarioTypes);

            for (const file of structured.files) {
                generatedFiles.push({
                    fileName: file.relativePath,
                    content: file.content
                });
            }
        } else {
            const feature = generator.generateFromOpenAPI(endpoints, specBaseName, scenarioTypes);
            if (includeBackground) {
                feature.background = generator.generateBackground();
            }
            generatedFiles.push({
                fileName: `${specBaseName}.feature`,
                content: generator.featureToString(feature)
            });
        }

        return {
            ok: true,
            text: `Generated ${generatedFiles.length} feature file suggestion(s) from ${path.basename(specPath)}.`,
            data: {
                specPath: this.workspaceRelative(specPath),
                totalEndpoints: endpoints.length,
                files: generatedFiles
            }
        };
    }

    async checkCoverage(args: Record<string, unknown>): Promise<KarateMcpToolOutcome> {
        const specPathValue = this.readStringArg(args, 'spec_path');
        const featureDirValue = this.readStringArg(args, 'feature_dir');
        if (!specPathValue || !featureDirValue) {
            return this.invalidArgs('Missing required arguments: spec_path, feature_dir');
        }

        const specPath = this.resolveWorkspacePath(specPathValue, 'file');
        const featureDir = this.resolveWorkspacePath(featureDirValue, 'directory');
        if (!specPath || !featureDir) {
            return this.invalidArgs('spec_path and feature_dir must resolve inside the workspace');
        }

        const featureFiles = this.scanFeatureFiles(featureDir);
        const report = await this.coverageAnalyzer.analyzeCoverageWithFiles(specPath, featureFiles, false);

        const tested = report.endpoints
            .filter(e => e.covered)
            .map(e => `${e.method} ${e.path}`);
        const untested = report.endpoints
            .filter(e => !e.covered)
            .map(e => `${e.method} ${e.path}`);

        return {
            ok: true,
            text: `Coverage ${report.percentage.toFixed(1)}% (${report.coveredEndpoints}/${report.totalEndpoints}).`,
            data: {
                specPath: this.workspaceRelative(specPath),
                featureDir: this.workspaceRelative(featureDir),
                tested,
                untested,
                percent: Math.round(report.percentage * 10) / 10,
                totalEndpoints: report.totalEndpoints,
                coveredEndpoints: report.coveredEndpoints
            }
        };
    }

    async repairTest(args: Record<string, unknown>): Promise<KarateMcpToolOutcome> {
        const featurePathValue = this.readStringArg(args, 'feature_path');
        const scenarioName = this.readStringArg(args, 'scenario_name');
        const errorMessage = this.readStringArg(args, 'error_message');
        const apply = this.readBooleanArg(args, 'apply', false);
        const runId = this.readStringArg(args, 'ci_run_id');

        if (!featurePathValue || !scenarioName || !errorMessage) {
            return this.invalidArgs('Missing required arguments: feature_path, scenario_name, error_message');
        }

        const featurePath = this.resolveWorkspacePath(featurePathValue, 'file');
        if (!featurePath) {
            return this.invalidArgs('feature_path must resolve inside the workspace');
        }
        if (!fs.existsSync(featurePath)) {
            return this.invalidArgs(`Feature file not found: ${featurePathValue}`);
        }

        const originalContent = fs.readFileSync(featurePath, 'utf-8');
        const payload: CIFailurePayload = {
            source: 'generic',
            featurePath: this.workspaceRelative(featurePath),
            scenarioName,
            failedStep: 'Unknown failed step',
            errorMessage,
            timestamp: Date.now(),
            runId
        };

        const prompt = this.buildRepairPrompt(payload, originalContent);
        const registry = AIProviderRegistry.getInstance();
        const rawRepair = await registry.complete(prompt, {
            maxTokens: 4096,
            temperature: 0.2,
            systemPrompt: 'You are a Karate DSL test repair expert. Fix ONLY the broken scenario. Return the complete fixed Scenario block. Pure Karate DSL only. No markdown, no explanations.'
        });

        if (!rawRepair.trim()) {
            return {
                ok: false,
                text: 'Repair generation returned empty output.',
                data: {
                    featurePath: this.workspaceRelative(featurePath),
                    scenarioName
                }
            };
        }

        const cleanedRepair = this.cleanResponse(rawRepair);
        const updatedContent = this.replaceScenario(originalContent, scenarioName, cleanedRepair);
        if (updatedContent === originalContent) {
            return {
                ok: false,
                text: `Could not apply repair because scenario "${scenarioName}" was not matched in ${path.basename(featurePath)}.`,
                data: {
                    featurePath: this.workspaceRelative(featurePath),
                    scenarioName,
                    patch: cleanedRepair,
                    applied: false
                }
            };
        }

        const diff = this.buildScenarioDiff(originalContent, updatedContent, featurePath);
        const confidence = this.estimateConfidence(cleanedRepair, scenarioName);

        let applied = false;
        if (apply) {
            fs.writeFileSync(featurePath, updatedContent, 'utf-8');
            applied = true;
        }

        return {
            ok: true,
            text: apply
                ? `Repair generated and applied to ${path.basename(featurePath)}.`
                : `Repair generated for ${path.basename(featurePath)} (dry-run).`,
            data: {
                featurePath: this.workspaceRelative(featurePath),
                scenarioName,
                patch: cleanedRepair,
                diff,
                confidence,
                applied
            }
        };
    }

    async listFlaky(args: Record<string, unknown>): Promise<KarateMcpToolOutcome> {
        const featureDirValue = this.readStringArg(args, 'feature_dir');
        const minRuns = this.readNumberArg(args, 'min_runs');
        if (!featureDirValue) {
            return this.invalidArgs('Missing required argument: feature_dir');
        }

        const featureDir = this.resolveWorkspacePath(featureDirValue, 'directory');
        if (!featureDir) {
            return this.invalidArgs('feature_dir must resolve inside the workspace');
        }

        const workspaceRoot = this.getWorkspaceRoot();
        const historyService = new TestHistoryService(workspaceRoot);
        const history = await historyService.getHistory(200);

        const config = vscode.workspace.getConfiguration('karateDsl');
        const windowSize = config.get<number>('flakiness.windowSize', 20);
        const threshold = config.get<number>('flakiness.threshold', 0.15);
        const report = this.flakinessAnalyzer.analyze(history, windowSize, threshold);

        const relativeDir = this.workspaceRelative(featureDir).replace(/\\/g, '/');
        let scenarios = report.scenarios.filter(s => this.isScenarioInsideFeatureDir(s, relativeDir));
        if (typeof minRuns === 'number' && Number.isFinite(minRuns) && minRuns > 0) {
            scenarios = scenarios.filter(s => s.runCount >= minRuns);
        }

        const withSuggestions: Array<Record<string, unknown>> = [];
        for (const scenario of scenarios.slice(0, 50)) {
            let suggestedFix: string | undefined;
            if (scenario.tier === 'flaky' || scenario.tier === 'broken') {
                suggestedFix = await this.flakinessFixService.suggestFix(scenario);
            }
            withSuggestions.push({
                featurePath: scenario.featurePath,
                scenarioName: scenario.scenarioName,
                score: scenario.flakiness,
                passRate: scenario.passRate,
                runCount: scenario.runCount,
                tier: scenario.tier,
                trend: scenario.trend,
                suggestedFix: suggestedFix || ''
            });
        }

        return {
            ok: true,
            text: `Found ${withSuggestions.length} flaky scenario candidate(s).`,
            data: {
                thresholds: report.thresholds,
                threshold: report.threshold,
                totalScenarios: report.totalScenarios,
                flakyCount: report.flakyCount,
                scenarios: withSuggestions
            }
        };
    }

    async runFeature(args: Record<string, unknown>): Promise<KarateMcpToolOutcome> {
        const featurePathValue = this.readStringArg(args, 'feature_path');
        const featureDirValue = this.readStringArg(args, 'feature_dir');
        const tags = this.readStringArrayArg(args, 'tags');

        if (!featurePathValue && !featureDirValue && (!tags || tags.length === 0)) {
            return this.invalidArgs('Provide one of feature_path, feature_dir, or tags');
        }

        const workspaceRoot = this.getWorkspaceRoot();
        let executionType: 'feature' | 'folder' | 'tags' = 'feature';
        let target = '';

        if (featurePathValue) {
            const resolved = this.resolveWorkspacePath(featurePathValue, 'file');
            if (!resolved) {
                return this.invalidArgs('feature_path must resolve inside the workspace');
            }
            executionType = 'feature';
            target = resolved;
        } else if (featureDirValue) {
            const resolved = this.resolveWorkspacePath(featureDirValue, 'directory');
            if (!resolved) {
                return this.invalidArgs('feature_dir must resolve inside the workspace');
            }
            executionType = 'folder';
            target = resolved;
        } else {
            executionType = 'tags';
            target = workspaceRoot;
        }

        const result = await this.testExecutor.execute({
            type: executionType,
            target,
            tags: tags || undefined,
            buildTool: 'cli',
            workingDirectory: workspaceRoot
        });

        return {
            ok: result.status !== 'error',
            text: `Execution ${result.status}: ${result.summary.passed}/${result.summary.totalScenarios} passed.`,
            data: this.serializeExecutionResult(result)
        };
    }

    private serializeExecutionResult(result: TestExecutionResult): Record<string, unknown> {
        return {
            id: result.id,
            status: result.status,
            summary: result.summary,
            features: result.features.map(f => ({
                name: f.name,
                relativePath: f.relativePath,
                status: f.status,
                passed: f.passed,
                failed: f.failed,
                skipped: f.skipped,
                scenarios: f.scenarios.map(s => ({
                    name: s.name,
                    status: s.status,
                    duration: s.duration,
                    error: s.error
                }))
            })),
            error: result.error
        };
    }

    private isScenarioInsideFeatureDir(scenario: ScenarioFlakiness, relativeDir: string): boolean {
        const normalized = scenario.featurePath.replace(/\\/g, '/');
        const dir = relativeDir.replace(/\\/g, '/').replace(/\/+$/, '');
        if (!dir || dir === '.') {
            return true;
        }
        return normalized === dir || normalized.startsWith(`${dir}/`);
    }

    private getWorkspaceRoot(): string {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            throw new Error('No workspace folder open');
        }
        return path.resolve(workspaceRoot);
    }

    private resolveWorkspacePath(rawPath: string, expected: 'file' | 'directory' | 'either'): string | null {
        const workspaceRoot = this.getWorkspaceRoot();
        const resolved = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(workspaceRoot, rawPath));
        if (!this.isInsideWorkspace(resolved, workspaceRoot)) {
            return null;
        }

        if (expected !== 'either') {
            if (fs.existsSync(resolved)) {
                const stat = fs.statSync(resolved);
                if (expected === 'file' && !stat.isFile()) {
                    return null;
                }
                if (expected === 'directory' && !stat.isDirectory()) {
                    return null;
                }
            } else if (expected === 'file') {
                return resolved;
            } else {
                return null;
            }
        }

        return resolved;
    }

    private isInsideWorkspace(resolvedPath: string, workspaceRoot: string): boolean {
        const normalizedRoot = path.resolve(workspaceRoot);
        const normalizedPath = path.resolve(resolvedPath);
        return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${path.sep}`);
    }

    private workspaceRelative(absolutePath: string): string {
        const workspaceRoot = this.getWorkspaceRoot();
        return path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/');
    }

    private scanFeatureFiles(rootDir: string): string[] {
        const featureFiles: string[] = [];
        const queue: string[] = [rootDir];

        while (queue.length > 0) {
            const current = queue.shift()!;
            const entries = fs.readdirSync(current, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name.startsWith('.')) {
                    continue;
                }
                const fullPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    queue.push(fullPath);
                } else if (entry.isFile() && fullPath.toLowerCase().endsWith('.feature')) {
                    featureFiles.push(fullPath);
                }
            }
        }

        return featureFiles;
    }

    private buildRepairPrompt(payload: CIFailurePayload, featureContent: string): string {
        let prompt = `REPAIR CONTEXT
Feature file:  ${payload.featurePath}
Scenario:      ${payload.scenarioName}
Failed step:   ${payload.failedStep}
Error:         ${payload.errorMessage}
`;

        if (payload.httpRequest) {
            prompt += `
HTTP EVIDENCE (from CI run)
Request:   ${payload.httpRequest.method} ${payload.httpRequest.url}`;
            if (payload.httpRequest.body) {
                prompt += `\nBody:      ${payload.httpRequest.body.substring(0, 500)}`;
            }
        }

        if (payload.httpResponse) {
            prompt += `\nResponse:  ${payload.httpResponse.status}`;
            if (payload.httpResponse.body) {
                prompt += ` — ${payload.httpResponse.body.substring(0, 500)}`;
            }
        }

        prompt += `

CURRENT FEATURE FILE:
${featureContent}

CONSTRAINT
Fix ONLY the failed step and its immediate dependencies.
Do NOT change any other scenario.
Do NOT invent endpoints or fields not visible in the evidence.

OUTPUT
Return the complete fixed Scenario block. Pure Karate DSL only.`;

        return prompt;
    }

    private cleanResponse(response: string): string {
        return response
            .replace(/```gherkin\n?/gi, '')
            .replace(/```\n?/g, '')
            .trim();
    }

    private replaceScenario(content: string, scenarioName: string, fixedScenario: string): string {
        const lines = content.split('\n');
        const startIdx = lines.findIndex(l =>
            this.matchesScenarioHeader(l, scenarioName)
        );

        if (startIdx === -1) {
            return content;
        }

        let endIdx = lines.length;
        for (let i = startIdx + 1; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (trimmed.startsWith('Scenario:') || trimmed.startsWith('Scenario Outline:')) {
                endIdx = i;
                break;
            }
        }

        let tagStartIdx = startIdx;
        for (let i = startIdx - 1; i >= 0; i--) {
            const trimmed = lines[i].trim();
            if (trimmed.startsWith('@')) {
                tagStartIdx = i;
            } else if (trimmed === '') {
                continue;
            } else {
                break;
            }
        }

        const before = lines.slice(0, tagStartIdx);
        const after = lines.slice(endIdx);
        return [...before, fixedScenario, '', ...after].join('\n');
    }

    private matchesScenarioHeader(line: string, scenarioName: string): boolean {
        const trimmed = line.trim();
        return (
            trimmed.startsWith('Scenario:') ||
            trimmed.startsWith('Scenario Outline:')
        ) && trimmed.includes(scenarioName);
    }

    private buildScenarioDiff(before: string, after: string, filePath: string): string {
        if (before === after) {
            return '';
        }
        const beforeLines = before.split('\n');
        const afterLines = after.split('\n');
        const max = Math.max(beforeLines.length, afterLines.length);
        const diffLines: string[] = [];
        diffLines.push(`--- a/${path.basename(filePath)}`);
        diffLines.push(`+++ b/${path.basename(filePath)}`);
        for (let i = 0; i < max; i++) {
            const b = beforeLines[i];
            const a = afterLines[i];
            if (b === a) {
                continue;
            }
            if (typeof b === 'string') {
                diffLines.push(`-${b}`);
            }
            if (typeof a === 'string') {
                diffLines.push(`+${a}`);
            }
        }
        return diffLines.join('\n');
    }

    private estimateConfidence(patch: string, scenarioName: string): number {
        let score = 0.5;
        if (patch.includes(`Scenario: ${scenarioName}`) || patch.includes(`Scenario Outline: ${scenarioName}`)) {
            score += 0.2;
        }
        if (/\bWhen\b/.test(patch) && /\bThen\b/.test(patch)) {
            score += 0.15;
        }
        if (patch.length > 80) {
            score += 0.1;
        }
        if (/status\s+\d{3}/.test(patch)) {
            score += 0.05;
        }
        return Math.min(0.99, Math.round(score * 100) / 100);
    }

    private invalidArgs(message: string): KarateMcpToolOutcome {
        return {
            ok: false,
            text: message,
            data: { error: message }
        };
    }

    private readStringArg(source: Record<string, unknown>, key: string): string | undefined {
        const value = source[key];
        return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    }

    private readStringArrayArg(source: Record<string, unknown>, key: string): string[] | undefined {
        const value = source[key];
        if (!Array.isArray(value)) {
            return undefined;
        }
        const strings = value.filter(v => typeof v === 'string').map(v => String(v).trim()).filter(Boolean);
        return strings.length > 0 ? strings : undefined;
    }

    private readBooleanArg(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
        const value = source[key];
        return typeof value === 'boolean' ? value : fallback;
    }

    private readNumberArg(source: Record<string, unknown>, key: string): number | undefined {
        const value = source[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
        return undefined;
    }
}
