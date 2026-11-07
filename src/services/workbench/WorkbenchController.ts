import type { DebugLaunch } from '../../debug/KarateDebugAdapter';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logger } from '../../utils/logger';
import { KarateCliExecutor } from '../execution/KarateCliExecutor';
import { ProjectExecutionResolver } from '../execution/ProjectExecutionResolver';
import { readExecutionSettings } from '../execution/ExecutionSettings';
import { advancedOptions, advancedStepFor, AdvancedOption, headerStep, HeaderOption } from './AdvancedAssertions';
import { defStep, jsPath, matchStep, MatchMode, PathSegment, schemaStep, suggestMode, valueAtPath, variableName } from './AssertionBuilder';
import { ClasspathResult, resolveClasspath } from './ClasspathResolver';
import { discoverEnvironments, findConfigDir } from './EnvDiscovery';
import {
    FeatureScenario, frontierIndex, insertionPointAt, isMutatingVerb, methodVerb, normalizeStepText, parseFeature, ParsedFeature,
    pathHints, planRun, responseScope, scenarioAtLine, stepAtLine
} from './GherkinSteps';
import { isSecretKey, isSecretValue, pathIsSecret } from './Redaction';
import { HostResponse } from './SessionProtocol';
import {
    emptyState, friendlyError, InsertKind, insertionText, isProductionContext, maskedResponse, maskedVariables, PanelState
} from './WorkbenchState';
import { renderWorkbenchHtml } from './WorkbenchPanelHtml';
import { getJavaMajor, WorkbenchSession } from './WorkbenchSession';

const DEFAULT_KARATE_VERSION = '2.1.4';
const IDLE_MS = 30 * 60 * 1000;

interface LastResponse {
    response: HostResponse;
    /** Index in the scenario's steps; -1 when it came from the Background. */
    stepIndex: number;
    stepText: string;
    fresh: boolean;
}

interface FeatureSession {
    session: WorkbenchSession;
    env: string;
    scenarioKey: string;
    executed: string[];
    config: Record<string, unknown>;
    variables: Record<string, unknown>;
    lastResponse?: LastResponse;
    prodConfirmed: boolean;
    lastUsed: number;
}

interface AssertionContext {
    entry: FeatureSession;
    last: LastResponse;
    document: vscode.TextDocument;
    parsed: ParsedFeature;
    scenario: FeatureScenario;
}

type WebviewMessage =
    | { type: 'ready' }
    | { type: 'restart' }
    | { type: 'stop' }
    | { type: 'cancel' }
    | { type: 'selectEnv'; env: string }
    | { type: 'assert'; root?: 'body' | 'headers'; path: PathSegment[]; action: AssertAction; option?: string; param?: string };

/** `more` opens the option picker; `advanced` applies an option directly (used by automation and tests). */
type AssertAction = 'type' | 'value' | 'present' | 'schema' | 'def' | 'status' | 'more' | 'advanced' | 'headerEquals' | 'headerContains' | 'headerPresent';

/** Runs Karate steps one at a time from the editor and shows the response beside the code. */
export class WorkbenchController implements vscode.Disposable, vscode.CodeLensProvider {
    private readonly output = vscode.window.createOutputChannel('Karate Workbench');
    private readonly sessions = new Map<string, FeatureSession>();
    private readonly envChoice = new Map<string, string>();
    private readonly classpaths = new Map<string, ClasspathResult>();
    private readonly lensChanged = new vscode.EventEmitter<void>();
    private readonly highlight = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'), isWholeLine: true });
    private panel?: vscode.WebviewPanel;
    private state: PanelState = emptyState();
    private current?: string;
    private running = false;
    private idleTimer?: NodeJS.Timeout;

    readonly onDidChangeCodeLenses = this.lensChanged.event;

    /** Read access to the view state and a way to send view messages, for end-to-end tests. */
    testing(): { getState: () => PanelState; send: (message: WebviewMessage) => Promise<void>; isRunning: () => boolean } {
        return { getState: () => this.state, send: message => this.onMessage(message), isRunning: () => this.running };
    }

    constructor(private readonly context: vscode.ExtensionContext) {}

    register(): vscode.Disposable[] {
        this.idleTimer = setInterval(() => this.stopIdleSessions(), 60_000);
        this.idleTimer.unref();
        return [
            vscode.commands.registerCommand('karate-dsl.workbench.runToCursor', (uri?: vscode.Uri, line?: number) => this.run('to', uri, line)),
            vscode.commands.registerCommand('karate-dsl.workbench.runStep', (uri?: vscode.Uri, line?: number) => this.run('this', uri, line)),
            vscode.commands.registerCommand('karate-dsl.workbench.restart', () => this.restart()),
            vscode.commands.registerCommand('karate-dsl.workbench.stop', () => this.stop()),
            vscode.commands.registerCommand('karate-dsl.workbench.selectEnvironment', () => this.pickEnvironment()),
            vscode.languages.registerCodeLensProvider({ pattern: '**/*.feature' }, this),
            vscode.workspace.onDidCloseTextDocument(doc => { void this.dispose1(doc.uri.fsPath); }),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('karateDsl.workbench')) { this.lensChanged.fire(); }
            })
        ];
    }

    dispose(): void {
        if (this.idleTimer) { clearInterval(this.idleTimer); }
        for (const entry of this.sessions.values()) { entry.session.kill(); }
        this.sessions.clear();
        this.panel?.dispose();
        this.highlight.dispose();
        this.output.dispose();
        this.lensChanged.dispose();
    }

    // CodeLens: a Send action above every method step.
    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        if (!vscode.workspace.getConfiguration('karateDsl.workbench', document.uri).get<boolean>('codeLens', true)) {
            return [];
        }
        const lenses: vscode.CodeLens[] = [];
        for (const scenario of parseFeature(document.getText()).scenarios) {
            if (scenario.outline) { continue; }
            for (const step of scenario.steps) {
                if (methodVerb(step.text) === undefined) { continue; }
                const range = new vscode.Range(step.line, 0, step.line, 0);
                lenses.push(
                    new vscode.CodeLens(range, { title: '$(play) Send', tooltip: 'Run the scenario up to this step in Karate Workbench', command: 'karate-dsl.workbench.runToCursor', arguments: [document.uri, step.line] }),
                    new vscode.CodeLens(range, { title: 'This step only', tooltip: 'Run only this step, using the variables from earlier runs', command: 'karate-dsl.workbench.runStep', arguments: [document.uri, step.line] })
                );
            }
        }
        return lenses;
    }

    // Running steps.
    private async run(mode: 'to' | 'this', uri?: vscode.Uri, line?: number): Promise<void> {
        if (this.running) {
            void vscode.window.showInformationMessage('A Workbench step is still running. Cancel it from the Workbench view first.');
            return;
        }
        const editor = vscode.window.activeTextEditor;
        const document = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
        if (!document || !document.fileName.endsWith('.feature')) {
            void vscode.window.showInformationMessage('Open a .feature file and place the cursor on a step.');
            return;
        }
        if (!vscode.workspace.isTrusted) {
            void vscode.window.showWarningMessage('Karate Workbench runs Java and your build tool. Trust this workspace to use it.');
            return;
        }
        if (document.isUntitled || document.uri.scheme !== 'file') {
            void vscode.window.showInformationMessage('Save the feature file before using Workbench.');
            return;
        }
        const cursor = line ?? editor?.selection.active.line ?? 0;
        const parsed = parseFeature(document.getText());
        const located = this.locate(parsed, cursor);
        if (!located) { return; }

        this.running = true;
        const key = document.uri.fsPath;
        this.current = key;
        this.showPanel();
        try {
            await this.execute(document, parsed, located.scenario, located.scenarioIndex, located.stepIndex, mode);
        } catch (error) {
            this.setState({ busy: '', notice: friendlyError(error) });
            logger.info(`Workbench: ${friendlyError(error)}`);
        } finally {
            this.running = false;
            this.setState({ busy: '' });
        }
    }

    private locate(parsed: ParsedFeature, line: number): { scenario: FeatureScenario; scenarioIndex: number; stepIndex: number } | undefined {
        const scenario = scenarioAtLine(parsed, line);
        if (!scenario) {
            void vscode.window.showInformationMessage('This feature has no Scenario yet.');
            return undefined;
        }
        if (scenario.outline) {
            void vscode.window.showInformationMessage('Workbench runs a Scenario, not a Scenario Outline. Copy the steps into a Scenario to try them.');
            return undefined;
        }
        const hit = stepAtLine(scenario, line);
        if (!hit) {
            void vscode.window.showInformationMessage('Place the cursor on a step of the scenario.');
            return undefined;
        }
        return { scenario, scenarioIndex: parsed.scenarios.indexOf(scenario), stepIndex: hit.index };
    }

    private async execute(document: vscode.TextDocument, parsed: ParsedFeature, scenario: FeatureScenario, scenarioIndex: number, stepIndex: number, mode: 'to' | 'this'): Promise<void> {
        const key = document.uri.fsPath;
        const env = this.envChoice.get(key) ?? this.defaultEnv(document.uri);
        const scenarioKey = `${scenarioIndex}:${scenario.name}`;
        const background = parsed.background.map(step => step.text);
        const stepTexts = scenario.steps.map(step => step.text);

        let entry = this.sessions.get(key);
        if (entry && (!entry.session.alive || entry.env !== env || entry.scenarioKey !== scenarioKey)) {
            await this.dispose1(key);
            entry = undefined;
        }
        // Running one step in a session where nothing has run yet can only fail (no url, no variables), so run up to it instead.
        const effectiveMode: 'to' | 'this' = mode === 'this' && (!entry || entry.executed.length === 0) ? 'to' : mode;
        let plan = planRun(background, stepTexts, stepIndex, effectiveMode, entry?.executed ?? []);
        if (entry && plan.restart) {
            await this.dispose1(key);
            entry = undefined;
            plan = planRun(background, stepTexts, stepIndex, effectiveMode, []);
        }
        if (!entry) {
            entry = await this.startSession(document, env, scenarioKey);
            this.sessions.set(key, entry);
        }
        if (effectiveMode === 'this') {
            // A single step breaks the "everything before it ran in order" guarantee, so the next run-to-here starts over.
            entry.executed = ['\u0000single-step'];
        }
        this.setState({
            title: `${path.basename(document.fileName)} - ${scenario.name || 'Scenario'}`,
            env, envs: discoverEnvironments(this.configDirFor(document), env),
            notice: effectiveMode !== mode ? 'This session was new, so the Background and the steps before it ran first.' : '',
            variables: maskedVariables(entry.variables)
        });

        const total = background.length + stepIndex + 1;
        const firstPosition = effectiveMode === 'this' ? background.length + stepIndex : total - plan.toRun.length;
        for (let k = 0; k < plan.toRun.length; k++) {
            const text = plan.toRun[k];
            const position = firstPosition + k;
            if (!(await this.confirmProduction(entry, env, text))) {
                this.setState({ busy: '', notice: 'Stopped before sending a request to a production-looking environment.' });
                return;
            }
            this.setState({ busy: `Running: ${text.split('\n')[0]}` });
            const result = await entry.session.step(text).catch((error: unknown) => {
                this.sessions.delete(key);
                throw error;
            });
            entry.lastUsed = Date.now();
            entry.variables = result.variables;
            const isMethod = methodVerb(text) !== undefined;
            if (result.response) {
                const fresh = isMethod && result.status === 'PASSED';
                const index = position < background.length ? -1 : position - background.length;
                entry.lastResponse = fresh
                    ? { response: result.response, stepIndex: index, stepText: text, fresh }
                    : { response: result.response, stepIndex: entry.lastResponse?.stepIndex ?? -1, stepText: entry.lastResponse?.stepText ?? '', fresh: false };
            }
            if (effectiveMode === 'to' && result.status === 'PASSED') {
                entry.executed.push(text);
            }
            this.setState({
                step: { text, status: result.status, durationMs: result.durationMs, error: result.error },
                response: entry.lastResponse ? maskedResponse(entry.lastResponse.response, entry.lastResponse.fresh, entry.lastResponse.fresh && entry.lastResponse.stepIndex >= 0) : undefined,
                variables: maskedVariables(entry.variables)
            });
            if (result.status === 'FAILED') {
                break;
            }
        }
    }

    private async confirmProduction(entry: FeatureSession, env: string, text: string): Promise<boolean> {
        const pattern = vscode.workspace.getConfiguration('karateDsl.workbench').get<string>('productionPattern', 'prod');
        if (entry.prodConfirmed || !isMutatingVerb(methodVerb(text)) || !isProductionContext(env, entry.config, pattern)) {
            return true;
        }
        const choice = await vscode.window.showWarningMessage(
            `This step sends a ${methodVerb(text)?.toUpperCase()} request and the environment "${env || 'default'}" looks like production. Send it?`,
            { modal: true },
            'Send'
        );
        entry.prodConfirmed = choice === 'Send';
        return entry.prodConfirmed;
    }

    // Starting a session.
    private defaultEnv(uri: vscode.Uri): string {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        return folder ? (readExecutionSettings(folder.uri.fsPath).systemProperties['karate.env'] || '') : '';
    }

    private configDirFor(document: vscode.TextDocument): string | undefined {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder) { return undefined; }
        try {
            const project = ProjectExecutionResolver.resolve({ type: 'feature', target: document.uri.fsPath }, folder.uri.fsPath, readExecutionSettings(folder.uri.fsPath));
            return project.configDir ?? findConfigDir(document.uri.fsPath, project.projectRoot);
        } catch {
            return undefined;
        }
    }

    /** Resolves Java, the Karate jar, the project classpath and config for the step debugger, sharing Workbench's caches. */
    async prepareDebugLaunch(featurePath: string): Promise<DebugLaunch> {
        const uri = vscode.Uri.file(featurePath);
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) {
            throw new Error('Open the feature from a workspace folder.');
        }
        if (!vscode.workspace.isTrusted) {
            throw new Error('Debugging runs project code, so it needs a trusted workspace.');
        }
        const workspaceRoot = folder.uri.fsPath;
        const settings = readExecutionSettings(workspaceRoot);
        const config = vscode.workspace.getConfiguration('karateDsl.workbench', uri);
        const project = ProjectExecutionResolver.resolve({ type: 'feature', target: featurePath }, workspaceRoot, settings);
        const javaPath = config.get<string>('javaPath', 'java') || 'java';
        const major = await getJavaMajor(javaPath);
        if (major !== undefined && major < 21) {
            throw new Error(`Karate 2 needs Java 21 or newer, but found Java ${major}. Set karateDsl.workbench.javaPath to a newer Java.`);
        }
        const hostDir = path.join(this.context.extensionPath, 'resources', 'workbench', 'host');
        if (!fs.existsSync(path.join(hostDir, 'KarateDebugHost.class'))) {
            throw new Error('The debug host is missing from this build. Run "npm run build:host" and reload.');
        }
        const wanted = (settings.karateVersion || '').trim();
        const useOwnVersion = settings.jarPath.trim() || (wanted && !/^1[.]/.test(wanted));
        const jarSettings = useOwnVersion ? settings : { ...settings, karateVersion: config.get<string>('karateVersion', DEFAULT_KARATE_VERSION) };
        const jar = await KarateCliExecutor.ensureKarateJar(this.context.extensionPath, jarSettings, project.projectRoot);
        let classpath = this.classpaths.get(project.projectRoot);
        if (!classpath) {
            classpath = await resolveClasspath({
                projectRoot: project.projectRoot,
                strategy: project.strategy,
                karateJar: jar.jarPath,
                additionalClasspath: settings.additionalClasspath,
                buildArgs: config.get<string[]>('buildArgs', [])
            });
            this.classpaths.set(project.projectRoot, classpath);
        }
        return {
            javaPath,
            hostDir,
            classpath: classpath.entries,
            feature: featurePath,
            env: this.defaultEnv(uri),
            configDir: project.configDir ?? findConfigDir(featurePath, project.projectRoot) ?? '',
            workDir: project.projectRoot
        };
    }

    private async startSession(document: vscode.TextDocument, env: string, scenarioKey: string): Promise<FeatureSession> {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder) {
            throw new Error('Open the feature from a workspace folder.');
        }
        const workspaceRoot = folder.uri.fsPath;
        const settings = readExecutionSettings(workspaceRoot);
        const config = vscode.workspace.getConfiguration('karateDsl.workbench', document.uri);
        const project = ProjectExecutionResolver.resolve({ type: 'feature', target: document.uri.fsPath }, workspaceRoot, settings);
        const javaPath = config.get<string>('javaPath', 'java') || 'java';
        const major = await getJavaMajor(javaPath);
        if (major !== undefined && major < 21) {
            throw new Error(`Karate 2 needs Java 21 or newer, but Workbench found Java ${major}. Set karateDsl.workbench.javaPath to a newer Java.`);
        }
        const hostDir = path.join(this.context.extensionPath, 'resources', 'workbench', 'host');
        if (!fs.existsSync(path.join(hostDir, 'KarateWorkbenchHost.class'))) {
            throw new Error('The Workbench session host is missing from this build. Run "npm run build:host" and reload.');
        }

        return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Karate Workbench' }, async progress => {
            progress.report({ message: 'Preparing Karate 2' });
            const wanted = (settings.karateVersion || '').trim();
            const useOwnVersion = settings.jarPath.trim() || (wanted && !/^1[.]/.test(wanted));
            const jarSettings = useOwnVersion ? settings : { ...settings, karateVersion: config.get<string>('karateVersion', DEFAULT_KARATE_VERSION) };
            const jar = await KarateCliExecutor.ensureKarateJar(this.context.extensionPath, jarSettings, project.projectRoot);

            let classpath = this.classpaths.get(project.projectRoot);
            if (!classpath) {
                progress.report({ message: project.strategy === 'cli' ? 'Reading the project' : `Compiling tests with ${project.strategy}` });
                classpath = await resolveClasspath({
                    projectRoot: project.projectRoot,
                    strategy: project.strategy,
                    karateJar: jar.jarPath,
                    additionalClasspath: settings.additionalClasspath,
                    buildArgs: config.get<string[]>('buildArgs', [])
                });
                this.classpaths.set(project.projectRoot, classpath);
            }

            progress.report({ message: 'Starting the session' });
            const { session, result } = await WorkbenchSession.start({
                javaPath,
                hostDir,
                classpath: classpath.entries,
                feature: document.uri.fsPath,
                env,
                configDir: project.configDir ?? findConfigDir(document.uri.fsPath, project.projectRoot),
                workDir: project.projectRoot,
                requestTimeoutMs: config.get<number>('requestTimeoutSeconds', 120) * 1000,
                onLog: text => this.output.append(text)
            });
            session.onDidExit(() => {
                if (this.sessions.get(document.uri.fsPath)?.session === session) {
                    this.sessions.delete(document.uri.fsPath);
                }
            });
            return {
                session, env, scenarioKey, executed: [], config: result.config, variables: result.variables, prodConfirmed: false, lastUsed: Date.now()
            };
        });
    }

    // Stopping and restarting.
    private async dispose1(key: string): Promise<void> {
        const entry = this.sessions.get(key);
        this.sessions.delete(key);
        await entry?.session.stop();
    }

    private async restart(): Promise<void> {
        if (!this.current) { return; }
        this.classpaths.clear();
        await this.dispose1(this.current);
        this.setState({ step: undefined, response: undefined, variables: {}, busy: '', notice: 'Restarted. Run a step to start a fresh session.' });
    }

    private async stop(): Promise<void> {
        if (!this.current) { return; }
        await this.dispose1(this.current);
        this.setState({ step: undefined, response: undefined, variables: {}, busy: '', notice: 'Session stopped.' });
    }

    private cancel(): void {
        const entry = this.current ? this.sessions.get(this.current) : undefined;
        if (entry && this.running) {
            entry.session.cancel();
            if (this.current) { this.sessions.delete(this.current); }
            this.setState({ busy: '', notice: 'Cancelled. The session was reset; run to here again to continue.' });
        }
    }

    private async pickEnvironment(): Promise<void> {
        const document = vscode.window.activeTextEditor?.document;
        if (!document || !document.fileName.endsWith('.feature')) {
            void vscode.window.showInformationMessage('Open a .feature file first.');
            return;
        }
        const names = discoverEnvironments(this.configDirFor(document), this.envChoice.get(document.uri.fsPath));
        const picked = await vscode.window.showQuickPick(['(default)', ...names], { placeHolder: 'Karate environment (karate.env) for Workbench' });
        if (picked !== undefined) {
            await this.selectEnvironment(document.uri.fsPath, picked === '(default)' ? '' : picked);
        }
    }

    private async selectEnvironment(key: string, env: string): Promise<void> {
        this.envChoice.set(key, env);
        await this.dispose1(key);
        this.setState({ env, step: undefined, response: undefined, variables: {}, notice: `Environment set to ${env || 'default'}. Run a step to start a session.` });
    }

    private stopIdleSessions(): void {
        for (const [key, entry] of this.sessions) {
            if (!this.running && Date.now() - entry.lastUsed > IDLE_MS) {
                void this.dispose1(key);
                if (key === this.current) {
                    this.setState({ notice: 'The session was stopped after being idle for 30 minutes.', variables: {}, step: undefined, response: undefined });
                }
            }
        }
    }

    // Click to assert.
    private async assert(message: Extract<WebviewMessage, { type: 'assert' }>): Promise<void> {
        const ctx = await this.assertionContext();
        if (!ctx) {
            return;
        }
        const { entry, last } = ctx;
        const fieldPath = message.path;
        const action = message.action;

        if (message.root === 'headers' || action === 'headerEquals' || action === 'headerContains' || action === 'headerPresent') {
            await this.assertHeader(ctx, fieldPath, action as HeaderOption);
            return;
        }

        const value = valueAtPath(last.response.body, fieldPath);
        if (action !== 'status' && fieldPath.length > 0 && value === undefined) {
            this.setState({ notice: 'That field is not in the response any more.' });
            return;
        }
        const secret = pathIsSecret(fieldPath) || isSecretValue(value);
        if ((action === 'value' || action === 'def') && secret) {
            this.setState({ notice: 'This value looks like a secret and is masked, so it is not written into your test.' });
            return;
        }

        let kind: InsertKind = 'match';
        let stepText: string | undefined;
        if (action === 'status') {
            stepText = `status ${last.response.status}`;
        } else if (action === 'schema') {
            stepText = schemaStep(fieldPath, value);
        } else if (action === 'def') {
            kind = 'def';
            stepText = defStep(fieldPath, variableName(fieldPath, Object.keys(entry.variables), pathHints(entry.executed)));
        } else if (action === 'more' || action === 'advanced') {
            stepText = await this.advancedText(message, value, secret, last.response);
        } else {
            const mode: MatchMode = action === 'type' || action === 'present' || action === 'value' ? action : suggestMode(fieldPath[fieldPath.length - 1], value);
            stepText = matchStep(fieldPath, value, mode);
        }
        if (stepText) {
            await this.insertAssertion(ctx, kind, stepText);
        }
    }

    /** The step text for an advanced option: picked from a list (with a parameter prompt when needed), or given directly. */
    private async advancedText(message: Extract<WebviewMessage, { type: 'assert' }>, value: unknown, secret: boolean, response: HostResponse): Promise<string | undefined> {
        const context = { secret, timeMs: response.timeMs, status: response.status };
        const parentIsArray = typeof message.path[message.path.length - 1] === 'number';
        const options = advancedOptions(message.path, value, context, parentIsArray);
        let chosen: AdvancedOption | undefined;
        let param = message.param ?? '';
        if (message.action === 'advanced') {
            chosen = options.find(item => item.id === message.option);
            if (!chosen) {
                this.setState({ notice: `That option is not available for this field: ${message.option ?? ''}` });
                return undefined;
            }
        } else {
            const items: Array<vscode.QuickPickItem & { option?: AdvancedOption }> = [];
            let group = '';
            for (const option of options) {
                if (option.group !== group) {
                    group = option.group;
                    items.push({ label: group, kind: vscode.QuickPickItemKind.Separator });
                }
                items.push({ label: option.label, detail: option.detail, option });
            }
            const picked = await vscode.window.showQuickPick(items, { placeHolder: `Assert on ${jsPath('response', message.path)}`, matchOnDetail: true });
            chosen = picked?.option;
            if (!chosen) {
                return undefined;
            }
            if (chosen.param) {
                const input = await vscode.window.showInputBox({ prompt: chosen.param.prompt, value: chosen.param.value });
                if (input === undefined) {
                    return undefined;
                }
                param = input;
            }
        }
        try {
            const given = message.action === 'advanced' && message.param === undefined ? chosen.param?.value ?? '' : param;
            return advancedStepFor(chosen.id, message.path, value, chosen.param ? given : '', context);
        } catch (error) {
            this.setState({ notice: error instanceof Error ? error.message : String(error) });
            return undefined;
        }
    }

    private async assertHeader(ctx: AssertionContext, fieldPath: PathSegment[], option: HeaderOption): Promise<void> {
        const name = typeof fieldPath[0] === 'string' ? fieldPath[0] : '';
        const headers = ctx.last.response.headers;
        const key = Object.keys(headers).find(item => item.toLowerCase() === name.toLowerCase());
        if (!key) {
            this.setState({ notice: 'That header is not in the response any more.' });
            return;
        }
        if (isSecretKey(key) && option !== 'headerPresent') {
            this.setState({ notice: 'This header looks like a secret and is masked, so its value is not written into your test.' });
            return;
        }
        const raw = headers[key];
        const value = Array.isArray(raw) ? String(raw[0] ?? '') : String(raw ?? '');
        try {
            await this.insertAssertion(ctx, 'match', headerStep(option, key, value));
        } catch (error) {
            this.setState({ notice: error instanceof Error ? error.message : String(error) });
        }
    }

    /** The session, last response and the scenario step it came from, or undefined with a notice when they are not usable. */
    private async assertionContext(): Promise<AssertionContext | undefined> {
        const key = this.current;
        const entry = key ? this.sessions.get(key) : undefined;
        const last = entry?.lastResponse;
        if (!key || !entry || !last || !last.fresh || last.stepIndex < 0) {
            this.setState({ notice: 'Run a method step first, then click a field of its response.' });
            return undefined;
        }
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(key));
        const parsed = parseFeature(document.getText());
        const scenario = parsed.scenarios.find((item, index) => `${index}:${item.name}` === entry.scenarioKey);
        const step = scenario?.steps[last.stepIndex];
        if (!scenario || !step || step.text !== last.stepText) {
            this.setState({ notice: 'That step changed after it ran. Run it again, then click the response.' });
            return undefined;
        }
        return { entry, last, document, parsed, scenario };
    }

    /** Inserts the step after the last step that ran, highlights it, and runs it so the session stays in step with the file. */
    /** Called after an inserted assertion or def step ran successfully; used for the optional review prompt. */
    onAssertionInserted?: () => void;

    private async insertAssertion(ctx: AssertionContext, kind: InsertKind, stepText: string): Promise<void> {
        const { entry, last, document, parsed, scenario } = ctx;
        if (responseScope(scenario.steps, last.stepIndex).some(item => item.text.replace(/^(?:\*|Given|When|Then|And|But)\s+/, '') === stepText)) {
            this.setState({ notice: 'That line is already in the scenario.' });
            return;
        }
        const singleStep = entry.executed[0] === '\u0000single-step';
        const frontier = frontierIndex(entry.executed.length, parsed.background.length, last.stepIndex, scenario.steps.length, singleStep);
        const point = insertionPointAt(scenario.steps, last.stepIndex, frontier);
        const text = insertionText(point, kind, stepText);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(point.afterLine, document.lineAt(point.afterLine).text.length), text);
        if (!(await vscode.workspace.applyEdit(edit))) {
            this.setState({ notice: 'Could not edit the file.' });
            return;
        }
        const insertedLines = text.split('\n').length - 1;
        const shown = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: true });
        const range = new vscode.Range(point.afterLine + 1, 0, point.afterLine + insertedLines, 0);
        shown.setDecorations(this.highlight, [range]);
        shown.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        setTimeout(() => shown.setDecorations(this.highlight, []), 1500);

        const synced = normalizeStepText(text.slice(1));
        const result = await entry.session.step(synced).catch(() => undefined);
        if (result) {
            if (result.status === 'PASSED') { this.onAssertionInserted?.(); }
            entry.variables = result.variables;
            if (result.status === 'PASSED' && entry.executed[0] !== '\u0000single-step') {
                entry.executed.push(synced);
            }
            this.setState({
                step: { text: synced, status: result.status, durationMs: result.durationMs, error: result.error },
                variables: maskedVariables(entry.variables),
                notice: ''
            });
        }
    }

    // View.
    private showPanel(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside, true);
            return;
        }
        this.panel = vscode.window.createWebviewPanel('karateWorkbench', 'Karate Workbench', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
            enableScripts: true,
            retainContextWhenHidden: true
        });
        const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
        this.panel.webview.html = renderWorkbenchHtml(nonce, this.panel.webview.cspSource);
        this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => { void this.onMessage(message); });
        this.panel.onDidDispose(() => { this.panel = undefined; });
    }

    private async onMessage(message: WebviewMessage): Promise<void> {
        switch (message.type) {
            case 'ready': this.post(); break;
            case 'restart': await this.restart(); break;
            case 'stop': await this.stop(); break;
            case 'cancel': this.cancel(); break;
            case 'selectEnv': if (this.current) { await this.selectEnvironment(this.current, message.env); } break;
            case 'assert': await this.assert(message); break;
        }
    }

    private setState(patch: Partial<PanelState>): void {
        this.state = { ...this.state, ...patch };
        this.post();
    }

    private post(): void {
        void this.panel?.webview.postMessage({ type: 'state', state: this.state });
    }
}
