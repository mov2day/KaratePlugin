/**
 * Pure generation pipeline orchestrator: scaffold plan -> feature plan -> render -> (AI refine) -> quality gate -> write.
 * No vscode, no logger. Per-file problems become `warnings`; only missing required input throws.
 *
 * History flush: `history` is whatever HashStore the caller passes. The pipeline only calls `set`; the caller owns
 * persistence and must call `flush()` (e.g. WorkspaceHashStore) in a `finally` around `runPipeline` (Task 10b does).
 *
 * Paths: `fsApi` receives workspace-relative paths, or `root`-prefixed ones when `root` is given. Scaffold and
 * `extraFiles` paths are used as given (the scaffolder already includes `project.classpathRoot`); planner data/schema
 * paths are classpath-relative and get `project.classpathRoot` prepended; feature paths are relative to
 * `config.layout.outputRoot`.
 */
import type { KarateFeature, KarateScenario } from '../../types';
import type { GeneratorConfig } from '../config/GeneratorConfig';
import type { FsLike, ProjectInfo } from '../config/ProjectDiscovery';
import type { GenerationModel, SourceKind } from '../model/TestModel';
import { refine } from '../ai/AiRefiner';
import type { AiCall, RefineResult, SkillSource } from '../ai/AiRefiner';
import { planOpenApi } from '../plan/OpenApiPlanner';
import type { PlannedFeature } from '../plan/OpenApiPlanner';
import { parseFeature, runGate } from '../quality/QualityGate';
import type { Finding } from '../quality/QualityGate';
import { renderFeature } from '../render/FeatureRenderer';
import { planScaffold } from '../scaffold/ProjectScaffolder';
import { OutputWriter } from '../write/OutputWriter';
import type { HashStore, WriteFile, WriteReport } from '../write/OutputWriter';

export interface DryRunResult {
    status: 'passed' | 'failed' | 'skipped';
    message: string;
    findings?: Finding[];
}

export interface PipelineInput {
    model: GenerationModel;
    /** Adapter-provided features for non-OpenAPI modes; when absent the OpenAPI planner runs on `model`. */
    scenarios?: PlannedFeature[];
    config: GeneratorConfig;
    project: ProjectInfo;
    fsApi: FsLike & { write(p: string, content: string): void };
    history: HashStore;
    skills?: SkillSource;
    ai?: AiCall;
    evidence?: { label: string; text: string }[];
    generatorVersion: string;
    sourceRef: string;
    mode: SourceKind;
    progress?: (msg: string, pct: number) => void;
    /** Written as given (final paths, no prefixing). */
    extraFiles?: { path: string; content: string; owner: 'user' | 'generated' }[];
    /** Optional path prefix (e.g. the workspace root) applied to every written/read path. */
    root?: string;
    /** Injectable dry run (Task 17); called with the feature files written. Failures never escape. */
    dryRun?: (files: string[]) => Promise<DryRunResult>;
}

export interface PipelineFeatureResult {
    path: string;
    findings: Finding[];
    refinement?: RefineResult;
    draft: boolean;
}

export interface PipelineResult {
    written: WriteReport;
    features: PipelineFeatureResult[];
    draftScenarios: number;
    warnings: string[];
    gate: { errors: number; warnings: number };
    dryRun?: DryRunResult;
}

const NO_SKILLS: SkillSource = { select: () => ({ text: '' }) };

const slash = (p: string): string => p.replace(/\\/g, '/');
const joinPath = (...parts: string[]): string => slash(parts.filter(p => p !== '' && p !== '.').join('/')).replace(/\/{2,}/g, '/');
const errorsOf = (findings: Finding[]): Finding[] => findings.filter(f => f.severity === 'error');
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function require_<T>(value: T | undefined | null, name: string): T {
    if (value === undefined || value === null) {throw new Error(`runPipeline: missing required input "${name}"`);}
    return value;
}

/** Re-render `feature` with the scenarios at `indices` turned into drafts. */
function draftScenarios(feature: KarateFeature, indices: Map<number, string[]>): KarateFeature {
    return {
        ...feature,
        scenarios: feature.scenarios.map((s, i): KarateScenario => {
            const ids = indices.get(i);
            return ids ? { ...s, draftReason: `Quality gate: ${ids.join(', ')}` } : s;
        })
    };
}

interface Rendered {
    text: string;
    findings: Finding[];
    refinement?: RefineResult;
}

export async function runPipeline(i: PipelineInput): Promise<PipelineResult> {
    const model = require_(i?.model, 'model');
    const config = require_(i.config, 'config');
    const project = require_(i.project, 'project');
    const fsApi = require_(i.fsApi, 'fsApi');
    const history = require_(i.history, 'history');
    require_(i.generatorVersion, 'generatorVersion');
    require_(i.sourceRef, 'sourceRef');
    require_(i.mode, 'mode');

    let last = 0;
    const progress = (message: string, pct: number): void => {
        last = Math.max(last, Math.min(100, pct));
        try {
            i.progress?.(message, last);
        } catch {
            /* a faulty progress callback never breaks generation */
        }
    };
    const warnings: string[] = [];
    const full = (p: string): string => (i.root ? joinPath(i.root, p) : joinPath(p));
    const cpRoot = joinPath(project.classpathRoot);
    const classpathRel = (p: string): string | undefined => (p.startsWith(`${cpRoot}/`) ? p.slice(cpRoot.length + 1) : undefined);

    // (1) scaffold
    progress('Planning project scaffold', 5);
    const scaffold = planScaffold({ project, config, model });

    // (2) features
    progress('Planning scenarios', 15);
    let planned: PlannedFeature[];
    const dataFiles: { path: string; content: string; owner: 'user' | 'generated' }[] = [];
    if (i.scenarios) {
        planned = i.scenarios;
    } else if (i.mode === 'openapi' || i.mode === 'combined') {
        const plan = planOpenApi(model, config);
        planned = plan.features;
        warnings.push(...plan.warnings);
        for (const f of plan.files) {dataFiles.push({ path: joinPath(cpRoot, f.path), content: f.content, owner: f.owner });}
    } else {
        throw new Error(`runPipeline: mode "${i.mode}" requires "scenarios"`);
    }

    const supportFiles = [
        ...scaffold.map(f => ({ path: joinPath(f.path), content: f.content, owner: f.owner })),
        ...dataFiles,
        ...(i.extraFiles ?? []).map(f => ({ ...f, path: joinPath(f.path) }))
    ];
    const seen = new Set<string>();
    const uniqueSupport = supportFiles.filter(f => (seen.has(f.path) ? false : (seen.add(f.path), true)));

    // classpath files that exist in this run, plus helpers already on disk
    const knownFiles = new Set<string>();
    for (const f of uniqueSupport) {
        const rel = classpathRel(f.path);
        if (rel) {knownFiles.add(rel);}
    }
    try {
        for (const dir of ['common']) {
            const abs = full(joinPath(cpRoot, dir));
            if (fsApi.exists(abs)) {for (const n of fsApi.list(abs)) {if (n.endsWith('.feature')) {knownFiles.add(`${dir}/${n}`);}}}
        }
    } catch {
        /* unreadable helper directory: only this run's files are known */
    }

    // (3)-(5) render, refine, gate
    progress('Rendering features', 25);
    const results: PipelineFeatureResult[] = [];
    const featureFiles: WriteFile[] = [];
    let draftCount = 0;
    let gateErrors = 0;
    let gateWarnings = 0;
    const useAi = Boolean(i.ai) && config.ai.refine;
    const failOnError = config.gate.failOn === 'error';

    for (let n = 0; n < planned.length; n++) {
        const pf = planned[n];
        const path = full(joinPath(config.layout.outputRoot, pf.relativePath));
        const pct = 25 + Math.floor(((n + 1) / Math.max(1, planned.length)) * 45);
        let r: Rendered;
        let tags: string[] | undefined;
        try {
            const deterministic = renderFeature(pf.feature, { style: config.style });
            r = { text: deterministic, findings: [] };

            if (useAi && i.ai) {
                progress(`Refining ${pf.relativePath}`, 25 + Math.floor((n / Math.max(1, planned.length)) * 45));
                try {
                    const res = await refine({
                        feature: deterministic, mode: i.mode, task: 'enhance-feature', evidence: i.evidence ?? [],
                        skills: i.skills ?? NO_SKILLS, ai: i.ai, knownFiles, config
                    });
                    r.refinement = res;
                    if (res.status === 'refined') {r.text = res.text;}
                } catch (e) {
                    warnings.push(`${pf.relativePath}: AI refinement failed (${msg(e)}); kept deterministic output`);
                }
            }

            let gate = runGate(r.text, { knownFiles, config });
            if (failOnError && !gate.ok && r.text !== deterministic) {
                warnings.push(`${pf.relativePath}: refined output failed the quality gate; kept deterministic output`);
                if (r.refinement) {r.refinement = { ...r.refinement, text: deterministic, status: 'rejected', findings: [...r.refinement.findings, ...errorsOf(gate.findings)] };}
                r.text = deterministic;
                gate = runGate(r.text, { knownFiles, config });
            }
            r.findings = gate.findings;

            if (failOnError && !gate.ok) {
                // Demote the failing scenarios to @ignore drafts; fall back to a file-level @ignore.
                const parsed = parseFeature(r.text);
                const byScenario = new Map<number, string[]>();
                let attributable = parsed.scenarios.length === pf.feature.scenarios.length;
                for (const f of errorsOf(gate.findings)) {
                    const idx = parsed.scenarios.findIndex(s => f.line >= s.startLine && f.line <= s.endLine);
                    if (idx < 0 || !attributable) { attributable = false; break; }
                    byScenario.set(idx, [...new Set([...(byScenario.get(idx) ?? []), f.ruleId])]);
                }
                if (attributable) {
                    r.text = renderFeature(draftScenarios(pf.feature, byScenario), { style: config.style });
                    gate = runGate(r.text, { knownFiles, config });
                }
                if (!gate.ok) {
                    tags = ['@ignore'];
                    r.text = renderFeature(attributable ? draftScenarios(pf.feature, byScenario) : pf.feature, { style: config.style, featureTags: tags });
                    warnings.push(`${pf.relativePath}: quality gate errors could not be attributed to scenarios; whole Feature marked @ignore`);
                }
            }
        } catch (e) {
            warnings.push(`${pf.relativePath}: could not be generated (${msg(e)})`);
            continue;
        }

        const finalParsed = parseFeature(r.text);
        const featureIgnored = finalParsed.tags.some(t => t.name === '@ignore');
        const ignoredCount = featureIgnored ? finalParsed.scenarios.length : finalParsed.scenarios.filter(s => s.ignored).length;
        draftCount += ignoredCount;
        gateErrors += errorsOf(r.findings).length;
        gateWarnings += r.findings.length - errorsOf(r.findings).length;
        results.push({ path, findings: r.findings, refinement: r.refinement, draft: featureIgnored || ignoredCount > 0 });
        featureFiles.push({ path, content: r.text, owner: 'generated', source: i.sourceRef });
        progress(`Checked ${pf.relativePath}`, pct);
    }

    // (6) write
    progress('Writing files', 80);
    const files: WriteFile[] = [
        ...uniqueSupport.map(f => ({ path: full(f.path), content: f.content, owner: f.owner })),
        ...featureFiles
    ];
    let written: WriteReport = { created: [], updated: [], skippedExisting: [], sideBySide: [] };
    try {
        written = OutputWriter.write(files, fsApi, history, { generatorVersion: i.generatorVersion });
    } catch (e) {
        warnings.push(`Writing failed (${msg(e)})`);
    }
    progress('Files written', 90);

    // (7) optional dry run
    let dryRun: DryRunResult | undefined;
    if (config.gate.dryRun !== 'off' && i.dryRun) {
        progress('Dry-running generated features', 92);
        const featurePaths = new Set(featureFiles.map(f => f.path));
        const touched = [
            ...written.created.filter(p => featurePaths.has(p)),
            ...written.updated.filter(p => featurePaths.has(p)),
            ...written.sideBySide.filter(s => featurePaths.has(s.path)).map(s => s.generatedPath)
        ];
        try {
            dryRun = await i.dryRun(touched);
            for (const f of dryRun.findings ?? []) {warnings.push(`Dry run: ${f.ruleId} ${f.message}`);}
        } catch (e) {
            dryRun = { status: 'failed', message: `Dry run could not complete: ${msg(e)}` };
        }
    }

    progress('Done', 100);
    return {
        written, features: results, draftScenarios: draftCount, warnings,
        gate: { errors: gateErrors, warnings: gateWarnings }, ...(dryRun ? { dryRun } : {})
    };
}
