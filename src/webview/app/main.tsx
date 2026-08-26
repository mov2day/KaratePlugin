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
    runs?: Array<{ id: string; timestamp: number; status: string; summary?: { totalScenarios: number; passed: number; failed: number; passPercentage: number } }>;
    findings?: Array<{ id: string; title?: string; state?: string; severity?: string }>;
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

    useEffect(() => {
        const onMessage = (event: MessageEvent<{ type?: string; data?: Snapshot }>) => {
            if (event.data.type === 'managementSnapshot') setSnapshot(event.data.data || {});
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
            {activeArea === 'library' && <Library featureCount={snapshot.featureCount || 0} query={query} />}
            {activeArea === 'runs' && <Runs runs={filteredRuns} />}
            {activeArea === 'quality' && <Quality findings={snapshot.findings || []} />}
            {activeArea === 'create' && <Create />}
            {activeArea === 'operations' && <Operations />}
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
function Library({ featureCount, query }: { featureCount: number; query: string }) { return <section class="area"><div class="area-heading"><div><span class="eyebrow">INVENTORY</span><h1>Test Library</h1><p>Searchable feature and scenario inventory with traceability.</p></div></div><div class="panel data-panel"><div class="panel-heading"><h2>{featureCount} feature files discovered</h2><button onClick={() => send('executeExtensionCommand', { commandId: 'karate-dsl.runFolder' })}>Run library</button></div><Empty title={query ? 'No indexed test matches yet' : 'Library indexing is ready'} detail={query ? 'Clear the search or refresh after adding features.' : 'Open a feature from Explorer or generate tests to populate traceability.'} /></div></section>; }
function Runs({ runs }: { runs: Snapshot['runs'] }) { return <section class="area"><div class="area-heading"><div><span class="eyebrow">EXECUTION</span><h1>Runs</h1><p>History, outcomes, and failure triage in one place.</p></div><button class="primary-action" onClick={() => send('executeExtensionCommand', { commandId: 'karate-dsl.runFolder' })}>Run all tests</button></div><div class="panel data-panel">{runs?.length ? <table><thead><tr><th>Run</th><th>When</th><th>Outcome</th><th>Pass rate</th></tr></thead><tbody>{runs.map(run => <tr><td>{run.id}</td><td>{new Date(run.timestamp).toLocaleString()}</td><td><span class={`status ${run.status === 'success' ? 'success' : 'failed'}`}>{run.status}</span></td><td>{run.summary?.passPercentage ?? '—'}%</td></tr>)}</tbody></table> : <Empty title="No runs recorded" detail="Run a feature, folder, or tagged selection to build your execution history." action="Run all tests" onAction={() => send('executeExtensionCommand', { commandId: 'karate-dsl.runFolder' })} />}</div></section>; }
function Quality({ findings }: { findings: NonNullable<Snapshot['findings']> }) { return <section class="area"><div class="area-heading"><div><span class="eyebrow">ASSURANCE</span><h1>Quality</h1><p>Coverage, health, flakiness, and specification change impact.</p></div><button onClick={() => send('executeExtensionCommand', { commandId: 'karate-dsl.showCoverageDashboard' })}>Analyse coverage</button></div><div class="panel data-panel">{findings.length ? <table><thead><tr><th>Finding</th><th>State</th><th>Severity</th></tr></thead><tbody>{findings.map(item => <tr><td>{item.title || item.id}</td><td>{item.state || 'New'}</td><td>{item.severity || 'Normal'}</td></tr>)}</tbody></table> : <Empty title="No quality findings yet" detail="Analyse coverage or project health to start a managed quality queue." action="Analyse health" onAction={() => send('executeExtensionCommand', { commandId: 'karate-dsl.analyzeProjectHealth' })} />}</div></section>; }
function Create() { const commands = [['OpenAPI specification', 'karate-dsl.generateFromOpenAPI'], ['Postman collection', 'karate-dsl.importPostmanCollection'], ['HAR recording', 'karate-dsl.importHar'], ['GraphQL schema', 'karate-dsl.generateFromGraphQL'], ['Jira issue', 'karate-dsl.generateFromJira'], ['Confluence page', 'karate-dsl.generateFromConfluence']]; return <section class="area"><div class="area-heading"><div><span class="eyebrow">AUTHORING</span><h1>Create & Import</h1><p>Bring a source in and produce maintainable Karate tests.</p></div></div><div class="source-list">{commands.map(([label, command]) => <button class="source-row" onClick={() => send('executeExtensionCommand', { commandId: command })}><span class="codicon codicon-add" /><span>{label}</span><span class="codicon codicon-chevron-right" /></button>)}</div></section>; }
function Operations() { return <section class="area"><div class="area-heading"><div><span class="eyebrow">OPERATIONS</span><h1>Operations</h1><p>Investigate live APIs, repair CI failures, and manage integrations.</p></div></div><div class="operations-grid"><Operation title="API Bug Hunter" detail="Run bounded, allowlisted probes against an API specification." action="Start Bug Hunter" command="karate-dsl.huntApiBugs" /><Operation title="CI repair" detail="Review failures and apply AI suggestions only after confirmation." action="Open CI guide" command="karate-dsl.showCIBridgeGuide" /><Operation title="Integrations" detail="Configure AI, Zephyr, MCP, and workspace settings." action="Open settings" command="workbench.action.openSettings" /></div></section>; }
function Operation({ title, detail, action, command }: { title: string; detail: string; action: string; command: string }) { return <article class="operation"><h2>{title}</h2><p>{detail}</p><button onClick={() => send('executeExtensionCommand', { commandId: command })}>{action} <span class="codicon codicon-arrow-right" /></button></article>; }
function Empty({ title, detail, action, onAction }: { title: string; detail: string; action?: string; onAction?: () => void }) { return <div class="empty"><span class="codicon codicon-checklist" aria-hidden="true" /><h3>{title}</h3><p>{detail}</p>{action && <button onClick={onAction}>{action}</button>}</div>; }

render(<App />, document.getElementById('root')!);
