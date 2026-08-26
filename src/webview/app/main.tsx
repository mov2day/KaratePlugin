import { Fragment, h, render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import './style.css';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

type Area = 'overview' | 'library' | 'runs' | 'quality' | 'create' | 'operations';

interface Snapshot {
    folderName?: string;
    folderPath?: string;
    folders?: Array<{ name: string; path: string }>;
    featureCount?: number;
    features?: Array<{ path: string; scenarios: Array<{ name: string; tags: string[]; line: number }> }>;
    runs?: Array<{ id: string; timestamp: number; status: string; error?: string; summary?: { totalScenarios: number; passed: number; failed: number; skipped?: number; passPercentage: number; executionTime?: string }; features?: Array<{ name: string; relativePath?: string; failed?: number; scenarios?: Array<{ name: string; status: string; error?: string }> }> }>;
    findings?: Array<{ id: string; title?: string; state?: string; severity?: string }>;
    runProfiles?: Array<{ id: string; name?: string; environment?: string }>;
    environments?: Array<{ id: string; name?: string }>;
}

const vscode = acquireVsCodeApi();
const areas: Array<{ id: Area; label: string; icon: string }> = [
    { id: 'overview', label: 'Overview', icon: 'home' },
    { id: 'library', label: 'Test Library', icon: 'library' },
    { id: 'runs', label: 'Runs', icon: 'run-all' },
    { id: 'quality', label: 'Quality', icon: 'shield' },
    { id: 'create', label: 'Create & Import', icon: 'new-file' },
    { id: 'operations', label: 'Operations', icon: 'settings-gear' }
];

function send(command: string, payload: Record<string, unknown> = {}): void {
    vscode.postMessage({ command, ...payload });
}

function App() {
    const [activeArea, setActiveArea] = useState<Area>('overview');
    const [snapshot, setSnapshot] = useState<Snapshot>({ runs: [], findings: [] });
    const [query, setQuery] = useState('');
    const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string }>();

    useEffect(() => {
        const onMessage = (event: MessageEvent<{ type?: string; data?: Snapshot; message?: string }>) => {
            if (event.data.type === 'managementSnapshot') setSnapshot(event.data.data || {});
            if ((event.data.type === 'error' || event.data.type === 'success') && event.data.message) setNotice({ kind: event.data.type, text: event.data.message });
        };
        window.addEventListener('message', onMessage);
        send('getManagementSnapshot');
        return () => window.removeEventListener('message', onMessage);
    }, []);

    const filteredRuns = useMemo(() => (snapshot.runs || []).filter(run => run.id.toLowerCase().includes(query.toLowerCase())), [snapshot.runs, query]);
    const failedRuns = (snapshot.runs || []).filter(run => run.status !== 'success');

    return <main class="management-shell">
        <aside class="rail" aria-label="Karate test management navigation">
            <div class="rail-brand" aria-label="Karate Test Management"><span class="codicon codicon-beaker" aria-hidden="true" /> <span>Karate</span></div>
            <nav>
                {areas.map(area => <button class={`rail-item ${activeArea === area.id ? 'is-active' : ''}`} aria-current={activeArea === area.id ? 'page' : undefined} onClick={() => setActiveArea(area.id)}>
                    <span class={`codicon codicon-${area.icon}`} aria-hidden="true" /> <span>{area.label}</span>
                </button>)}
            </nav>
            <button class="rail-item rail-report" onClick={() => send('executeExtensionCommand', { commandId: 'karate-dsl.reportBug' })}>
                <span class="codicon codicon-comment-discussion" aria-hidden="true" /> <span>Report a bug</span>
            </button>
        </aside>
        <section class="workspace">
            <header class="topbar">
                <label class="workspace-picker"><span class="eyebrow">WORKSPACE</span><select value={snapshot.folderPath || ''} onChange={event => send('getManagementSnapshot', { folderPath: (event.target as HTMLSelectElement).value })}>{(snapshot.folders || [{ name: snapshot.folderName || 'Karate project', path: snapshot.folderPath || '' }]).map(folder => <option value={folder.path}>{folder.name}</option>)}</select></label>
                <label class="search"><span class="codicon codicon-search" aria-hidden="true" /><span class="sr-only">Search runs</span><input value={query} onInput={event => setQuery((event.target as HTMLInputElement).value)} placeholder="Search tests, runs, findings" /></label>
                <button class="primary-action" onClick={() => send('executeExtensionCommand', { commandId: 'karate-dsl.runFolder' })}><span class="codicon codicon-play" aria-hidden="true" /> Run tests</button>
            </header>
            {activeArea === 'overview' && <Overview snapshot={snapshot} failedRuns={failedRuns} onNavigate={setActiveArea} />}
            {activeArea === 'library' && <Library featureCount={snapshot.featureCount || 0} features={snapshot.features || []} query={query} />}
            {activeArea === 'runs' && <Runs runs={filteredRuns} profiles={snapshot.runProfiles || []} environments={snapshot.environments || []} folderPath={snapshot.folderPath} />}
            {activeArea === 'quality' && <Quality findings={snapshot.findings || []} folderPath={snapshot.folderPath} />}
            {activeArea === 'create' && <Create />}
            {activeArea === 'operations' && <Operations />}
            {notice && <div class={`notice ${notice.kind}`} role="status"><span>{notice.text}</span><button aria-label="Dismiss message" onClick={() => setNotice(undefined)}><span class="codicon codicon-close" aria-hidden="true" /></button></div>}
        </section>
    </main>;
}

function Overview({ snapshot, failedRuns, onNavigate }: { snapshot: Snapshot; failedRuns: Snapshot['runs']; onNavigate: (area: Area) => void }) {
    const total = snapshot.runs?.[0]?.summary?.totalScenarios || 0;
    const passed = snapshot.runs?.[0]?.summary?.passed || 0;
    return <section class="area" aria-labelledby="overview-title">
        <div class="area-heading"><div><span class="eyebrow">CONTROL CENTRE</span><h1 id="overview-title">Test health at a glance</h1><p>Prioritised work across your Karate project.</p></div><button class="text-action" onClick={() => onNavigate('quality')}>View quality queue <span class="codicon codicon-arrow-right" /></button></div>
        <div class="metric-row">
            <Metric label="Latest pass rate" value={total ? `${Math.round((passed / total) * 100)}%` : '—'} note={total ? `${passed} of ${total} scenarios passed` : 'Run a test suite to establish a baseline'} />
            <Metric label="Runs needing attention" value={String(failedRuns?.length || 0)} note="Failed or errored recent runs" emphasis={(failedRuns?.length || 0) > 0} />
            <Metric label="Feature files" value={String(snapshot.featureCount || 0)} note="Discovered in this workspace" />
            <Metric label="Open findings" value={String(snapshot.findings?.filter(item => item.state !== 'Verified').length || 0)} note="Coverage, health, and stability work" />
        </div>
        <div class="panel"><div class="panel-heading"><div><h2>Priority queue</h2><p>Start with work that affects confidence in the suite.</p></div><span class="status-pill">Live workspace</span></div>
            {(failedRuns?.length || snapshot.findings?.length) ? <ul class="queue">{failedRuns?.slice(0, 4).map(run => <li><span class="queue-marker danger" /><div><strong>Investigate failed run</strong><small>{new Date(run.timestamp).toLocaleString()}</small></div><button onClick={() => onNavigate('runs')}>Open runs</button></li>)}{snapshot.findings?.slice(0, 4).map(finding => <li><span class="queue-marker" /><div><strong>{finding.title || 'Quality finding'}</strong><small>{finding.state || 'New'} · {finding.severity || 'Normal'}</small></div><button onClick={() => onNavigate('quality')}>Review</button></li>)}</ul> : <Empty title="Your queue is clear" detail="Run tests, analyse coverage, or import a spec to create actionable work." action="Create or import" onAction={() => onNavigate('create')} />}</div>
    </section>;
}

function Metric({ label, value, note, emphasis = false }: { label: string; value: string; note: string; emphasis?: boolean }) { return <article class={`metric ${emphasis ? 'metric-warning' : ''}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>; }
function Library({ featureCount, features, query }: { featureCount: number; features: NonNullable<Snapshot['features']>; query: string }) { const normalized = query.trim().toLowerCase(); const entries = features.flatMap(feature => feature.scenarios.map(scenario => ({ ...scenario, path: feature.path }))).filter(entry => !normalized || `${entry.path} ${entry.name} ${entry.tags.join(' ')}`.toLowerCase().includes(normalized)); return <section class="area"><div class="area-heading"><div><span class="eyebrow">INVENTORY</span><h1>Test Library</h1><p>Searchable feature and scenario inventory with traceability.</p></div></div><div class="panel data-panel"><div class="panel-heading"><h2>{featureCount} feature files · {entries.length} scenarios</h2><button onClick={() => send('executeExtensionCommand', { commandId: 'karate-dsl.runFolder' })}>Run library</button></div>{entries.length ? <table><thead><tr><th>Scenario</th><th>Feature</th><th>Tags</th></tr></thead><tbody>{entries.slice(0, 500).map(entry => <tr><td>{entry.name}</td><td><code>{entry.path}</code></td><td>{entry.tags.join(' ') || '—'}</td></tr>)}</tbody></table> : <Empty title={query ? 'No indexed test matches' : 'No scenarios discovered'} detail={query ? 'Clear the search or change your search phrase.' : 'Create or import a feature to populate the library.'} />}</div></section>; }
function Runs({ runs, profiles, environments, folderPath }: { runs: Snapshot['runs']; profiles: NonNullable<Snapshot['runProfiles']>; environments: NonNullable<Snapshot['environments']>; folderPath?: string }) { const [name, setName] = useState(''); const [environment, setEnvironment] = useState(''); const [selected, setSelected] = useState<NonNullable<Snapshot['runs']>[number]>(); return <section class="area"><div class="area-heading"><div><span class="eyebrow">EXECUTION</span><h1>Runs</h1><p>History, profiles, and failure triage in one place.</p></div><button class="primary-action" onClick={() => send('executeExtensionCommand', { commandId: 'karate-dsl.runFolder' })}>Run all tests</button></div><div class="profile-bar"><div><strong>Run profiles</strong><small>{profiles.length ? profiles.map(profile => `${profile.name || 'Unnamed'}${profile.environment ? ` · ${profile.environment}` : ''}`).join('  /  ') : 'Save repeatable target and environment choices.'}</small></div><label><span class="sr-only">Profile name</span><input value={name} onInput={event => setName((event.target as HTMLInputElement).value)} placeholder="Profile name" /></label><label><span class="sr-only">Environment</span><input value={environment} onInput={event => setEnvironment((event.target as HTMLInputElement).value)} placeholder={environments.length ? `Environment (e.g. ${environments[0].name || ''})` : 'Environment (optional)'} /></label><button onClick={() => { if (name.trim()) { send('createRunProfile', { name, environment, folderPath }); setName(''); setEnvironment(''); } }}>Save profile</button></div><div class="panel data-panel">{runs?.length ? <table><thead><tr><th>Run</th><th>When</th><th>Outcome</th><th>Pass rate</th></tr></thead><tbody>{runs.map(run => <tr class="clickable-row" tabIndex={0} onClick={() => setSelected(run)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') setSelected(run); }}><td>{run.id.slice(0, 8)}</td><td>{new Date(run.timestamp).toLocaleString()}</td><td><span class={`status ${run.status === 'success' ? 'success' : 'failed'}`}>{run.status}</span></td><td>{run.summary?.passPercentage ?? '—'}%</td></tr>)}</tbody></table> : <Empty title="No runs recorded" detail="Run a feature, folder, or tagged selection to build your execution history." action="Run all tests" onAction={() => send('executeExtensionCommand', { commandId: 'karate-dsl.runFolder' })} />}</div>{selected && <RunDetail run={selected} onClose={() => setSelected(undefined)} />}</section>; }
function RunDetail({ run, onClose }: { run: NonNullable<Snapshot['runs']>[number]; onClose: () => void }) { const failed = run.features?.flatMap(feature => (feature.scenarios || []).filter(scenario => scenario.status !== 'passed').map(scenario => ({ feature, scenario }))) || []; return <aside class="run-detail" aria-label="Run details"><div class="panel-heading"><div><h2>Run {run.id.slice(0, 8)}</h2><p>{run.summary?.executionTime || 'Execution details'} · {run.summary?.passed || 0} passed, {run.summary?.failed || 0} failed</p></div><button aria-label="Close run details" onClick={onClose}><span class="codicon codicon-close" /></button></div>{run.error && <p class="run-error">{run.error}</p>}{failed.length ? <ul>{failed.slice(0, 30).map(({ feature, scenario }) => <li><strong>{scenario.name}</strong><small>{feature.relativePath || feature.name}{scenario.error ? ` · ${scenario.error}` : ''}</small></li>)}</ul> : <div class="empty"><h3>No failed scenarios recorded</h3><p>This run completed without scenario-level failure details.</p></div>}</aside>; }
function Quality({ findings, folderPath }: { findings: NonNullable<Snapshot['findings']>; folderPath?: string }) { return <section class="area"><div class="area-heading"><div><span class="eyebrow">ASSURANCE</span><h1>Quality</h1><p>Coverage, health, flakiness, and specification change impact.</p></div><button onClick={() => send('executeExtensionCommand', { commandId: 'karate-dsl.showCoverageDashboard' })}>Analyse coverage</button></div><div class="panel data-panel">{findings.length ? <table><thead><tr><th>Finding</th><th>State</th><th>Severity</th><th /></tr></thead><tbody>{findings.map(item => { const next = nextQualityState(item.state || 'New'); return <tr><td>{item.title || item.id}</td><td>{item.state || 'New'}</td><td>{item.severity || 'Normal'}</td><td>{next && <button class="text-action" onClick={() => send('advanceQualityFinding', { id: item.id, nextState: next, folderPath })}>Mark {next}</button>}</td></tr>; })}</tbody></table> : <Empty title="No quality findings yet" detail="Analyse coverage or project health to start a managed quality queue." action="Analyse health" onAction={() => send('executeExtensionCommand', { commandId: 'karate-dsl.analyzeProjectHealth' })} />}</div></section>; }
function nextQualityState(state: string): string | undefined { return ({ New: 'Investigating', Investigating: 'Fixed', Fixed: 'Verified' } as Record<string, string>)[state]; }
function Create() { const commands = [['OpenAPI specification', 'karate-dsl.generateFromOpenAPI'], ['Combined OpenAPI + Confluence', 'karate-dsl.generateCombined'], ['Specification directory', 'karate-dsl.generateFromDirectory'], ['Postman collection', 'karate-dsl.importPostmanCollection'], ['HAR recording', 'karate-dsl.importHar'], ['Start browser recording', 'karate-dsl.startRecording'], ['GraphQL schema', 'karate-dsl.generateFromGraphQL'], ['Jira issue', 'karate-dsl.generateFromJira'], ['Confluence page', 'karate-dsl.generateFromConfluence']]; return <section class="area"><div class="area-heading"><div><span class="eyebrow">AUTHORING</span><h1>Create & Import</h1><p>Bring a source in and produce maintainable Karate tests.</p></div></div><div class="source-list">{commands.map(([label, command]) => <button class="source-row" onClick={() => send('executeExtensionCommand', { commandId: command })}><span class="codicon codicon-add" /><span>{label}</span><span class="codicon codicon-chevron-right" /></button>)}</div></section>; }
function Operations() { return <section class="area"><div class="area-heading"><div><span class="eyebrow">OPERATIONS</span><h1>Operations</h1><p>Investigate live APIs, repair CI failures, and manage integrations.</p></div></div><div class="operations-grid"><Operation title="API Bug Hunter" detail="Run bounded, allowlisted probes against an API specification." action="Start Bug Hunter" command="karate-dsl.huntApiBugs" /><Operation title="CI repair" detail="Review failures and apply AI suggestions only after confirmation." action="Open CI guide" command="karate-dsl.showCIBridgeGuide" /><Operation title="Zephyr publishing" detail="Set the Zephyr credential used for publishing traceability and results." action="Set Zephyr token" command="karate-dsl.setZephyrToken" /><Operation title="AI credentials" detail="Set the AI provider or GitHub credential used by generation and repair." action="Set AI key" command="karate-dsl.setClaudeApiKey" /><Operation title="MCP connection" detail="View the MCP connection details for supported automation clients." action="View connection" command="karate-dsl.showMcpConnectionInfo" /><Operation title="Workspace settings" detail="Manage execution, telemetry, and integration preferences." action="Open settings" command="workbench.action.openSettings" /></div></section>; }
function Operation({ title, detail, action, command }: { title: string; detail: string; action: string; command: string }) { return <article class="operation"><h2>{title}</h2><p>{detail}</p><button onClick={() => send('executeExtensionCommand', { commandId: command })}>{action} <span class="codicon codicon-arrow-right" /></button></article>; }
function Empty({ title, detail, action, onAction }: { title: string; detail: string; action?: string; onAction?: () => void }) { return <div class="empty"><span class="codicon codicon-checklist" aria-hidden="true" /><h3>{title}</h3><p>{detail}</p>{action && <button onClick={onAction}>{action}</button>}</div>; }

render(<App />, document.getElementById('root')!);
