import { Fragment, h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ScoutAssertion, ScoutBrowser, ScoutCommand, ScoutExpectation, ScoutRequest, ScoutSnapshot, ScoutVariant } from '../../services/scout/types';
import './scout.css';

type Send = (command: ScoutCommand) => void;
const statusLabels: Record<string, string> = { idle: 'Choose your browser', connecting: 'Connecting', 'sign-in': 'Sign in, then teach', ready: 'Ready to explore', teaching: 'Teaching live', exploring: 'Exploring', 'auth-required': 'Sign-in needed', disconnected: 'Disconnected' };
const outcomeLabels: Record<string, string> = { proposed: 'Needs confirmation', running: 'Running', passed: 'Passed in browser', failed: 'Expectation failed', inconclusive: 'Inconclusive', 'auth-required': 'Sign-in needed', cancelled: 'Cancelled' };

export function Scout({ send }: { send: Send }) {
    const [snapshot, setSnapshot] = useState<ScoutSnapshot>({ status: 'idle' });
    const [browser, setBrowser] = useState<ScoutBrowser>('chrome');
    const [mode, setMode] = useState<'launch' | 'companion'>('launch');
    const [url, setUrl] = useState('');
    const [name, setName] = useState('My application journey');
    const [origins, setOrigins] = useState('');
    const [excluded, setExcluded] = useState('');
    const [useAI, setUseAI] = useState(false);
    const [selected, setSelected] = useState<string>();
    useEffect(() => {
        const receive = (event: MessageEvent) => { if (event.data?.type === 'scoutSnapshot') setSnapshot(event.data.data); };
        window.addEventListener('message', receive); send({ operation: 'snapshot' });
        return () => window.removeEventListener('message', receive);
    }, []);
    const journey = snapshot.journey;
    const busy = !!snapshot.busy;
    const recording = snapshot.status === 'teaching';
    const exploring = snapshot.status === 'exploring';
    const editable = !busy && !recording;
    const selectedVariant = journey?.variants.find(variant => variant.id === selected);
    const requestName = (id: string) => { const request = journey?.requests.find(item => item.id === id); return request ? shortRequest(request) : 'Select an observed request'; };
    const connect = () => send({ operation: 'connect', name, connection: { browser, mode, url, allowedOrigins: origins.split(/[\n,]+/).map(item => item.trim()).filter(Boolean), excludedOrigins: excluded.split(/[\n,]+/).map(item => item.trim()).filter(Boolean) } });

    return <section class="area scout-area" aria-labelledby="scout-title">
        <div class="area-heading"><div><span class="eyebrow">KARATE SCOUT</span><h1 id="scout-title">Show it once. Explore what follows.</h1><p>Teach a journey in the browser your application requires.</p></div><div class="scout-toolbar"><button disabled={busy || recording} onClick={() => send({ operation: 'load' })}>Open journey</button><button disabled={busy || recording} onClick={() => send({ operation: 'import-har' })}>Import HAR</button></div></div>
        <div class="scout-stagebar" role="status" aria-live="polite"><span class={`scout-indicator ${recording || exploring ? 'live' : ''}`} /><strong>{statusLabels[snapshot.status]}</strong><span>{snapshot.message || 'Use a local browser session or connect a signed-in tab.'}</span></div>
        <div class="scout-steps" aria-label="Journey stages"><span class={!journey?.actions.length ? 'current' : ''}><b>01</b> Connect & sign in</span><span class={recording ? 'current' : ''}><b>02</b> Teach a journey</span><span class={journey?.requests.length && !recording ? 'current' : ''}><b>03</b> Explore & verify</span></div>

        {!recording && !exploring && <details class="panel scout-connection" open={!journey || snapshot.status === 'disconnected'}><summary>Browser connection <span>{journey ? `${journey.connection.browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome'} · ${journey.connection.mode}` : 'Chrome, Edge, or your existing SSO session'}</span></summary>
            <div class="scout-form-grid"><label>Journey name<input value={name} onInput={event => setName(event.currentTarget.value)} /></label><label>Application URL<input type="url" placeholder="https://your-test-app.example" value={url} onInput={event => setUrl(event.currentTarget.value)} /></label>
                <label>Required browser<select value={browser} onChange={event => setBrowser(event.currentTarget.value as ScoutBrowser)}><option value="chrome">Google Chrome</option><option value="edge">Microsoft Edge</option></select></label>
                <label>Connection<select aria-label="Connection" value={mode} onChange={event => setMode(event.currentTarget.value as 'launch' | 'companion')}><option value="launch">Open a dedicated Scout browser</option><option value="companion">Connect my signed-in tab</option></select></label></div>
            <details class="scout-advanced"><summary>Additional API origins and sign-in exclusions</summary><div class="scout-form-grid"><label>Additional application origins<textarea rows={3} value={origins} onInput={event => setOrigins(event.currentTarget.value)} placeholder="https://api.example.test" /><small>One origin per line. The application origin is included automatically.</small></label><label>Identity provider origins to exclude<textarea rows={3} value={excluded} onInput={event => setExcluded(event.currentTarget.value)} placeholder="https://your-company.okta.com" /><small>Sign-in, token exchanges, passwords, and MFA inputs are excluded.</small></label></div></details>
            <div class="scout-toolbar"><button class="primary-action" disabled={busy || !url.trim()} onClick={connect}>{mode === 'launch' ? 'Open browser' : 'Get pairing details'}</button>{mode === 'companion' && <button disabled={busy} onClick={() => send({ operation: 'companion-files' })}>Get companion files</button>}<button disabled={busy} onClick={() => send({ operation: 'demo' })}>Try the sample shop</button></div>
            <p class="scout-hint">Sign in normally, including SSO and MFA. Scout observes application activity after you select Start teaching. A managed browser may require administrator approval for the companion.</p>
        </details>}

        {snapshot.pairing && <div class="panel scout-pairing"><h2>Connect your existing tab</h2><p>Open the optional Scout companion in your signed-in application tab and paste these values. This key expires in five minutes.</p><label>Local endpoint<input readOnly value={snapshot.pairing.endpoint} onFocus={event => event.currentTarget.select()} /></label><label>Temporary pairing key<input type="password" readOnly value={snapshot.pairing.token} onFocus={event => event.currentTarget.select()} /></label><small>Pairing is local to this computer. Company browser policy still applies.</small></div>}
        {snapshot.capabilities && <p class="scout-hint" role="status">Action capture: {snapshot.capabilities.actions ? 'available' : 'unavailable'} · Response bodies: {snapshot.capabilities.responseBodies ? 'available' : 'unavailable'} · Browser interaction: {snapshot.capabilities.interaction ? 'available' : 'unavailable'}</p>}
        {snapshot.capabilities?.limitations.length ? <div class="scout-limitations" role="note">{snapshot.capabilities.limitations.map(item => <p key={item}>{item}</p>)}</div> : null}

        {journey && <FragmentContent>
            <div class="scout-toolbar scout-runbar">
                {snapshot.status === 'disconnected' && journey.origin === 'browser' && <button class="primary-action" disabled={busy} onClick={() => send({ operation: 'connect', connection: journey.connection, name: journey.name, reconnect: true })}>Reconnect this journey</button>}
                {!recording && !journey.actions.length && !journey.requests.length && journey.origin === 'browser' && <button class="primary-action" disabled={busy || !!snapshot.pairing || snapshot.status === 'disconnected'} onClick={() => send({ operation: 'start' })}><span class="codicon codicon-record" /> Start teaching</button>}
                {recording && <button class="primary-action" disabled={busy} onClick={() => send({ operation: 'stop' })}><span class="codicon codicon-debug-stop" /> Stop teaching</button>}
                {(busy || exploring) && <button onClick={() => send({ operation: 'cancel' })}>Cancel operation</button>}
                {snapshot.status === 'auth-required' && <button class="primary-action" disabled={busy} onClick={() => send({ operation: snapshot.canResume ? 'resume' : 'stop' })}>{snapshot.canResume ? 'I’m signed in — resume' : 'Finish interrupted recording'}</button>}
                {!['idle','disconnected'].includes(snapshot.status) && journey.origin === 'browser' && <button onClick={() => send({ operation: 'disconnect' })}>Disconnect browser</button>}
                <button disabled={!editable} onClick={() => send({ operation: 'save' })}>Save journey</button>
            </div>
            <div class="scout-verdicts"><div><span>Browser journey</span><strong>{journey.verification.browser?.passed ? 'Verified in browser' : journey.verification.browser ? 'Review browser result' : 'Not yet verified'}</strong></div><div><span>Independent API suite</span><strong>{journey.verification.karate?.passed ? 'Verified in Karate' : journey.verification.auth !== 'none' ? 'Authentication setup required' : 'Not yet verified in Karate'}</strong></div><div><span>Observed</span><strong>{journey.actions.length} actions · {journey.requests.length} API calls</strong></div></div>
            <div class="panel scout-map-panel"><div class="panel-heading"><div><h2>{journey.name}</h2><p>{journey.origin === 'har' ? 'Inferred API sequence from HAR. Browser actions and authentication are not established.' : 'Browser actions connected to the API calls they triggered.'}</p></div><span class="status-pill">{journey.dependencies.length} data links</span></div>
                {!journey.actions.length && !journey.requests.length && <div class="scout-empty"><span class="codicon codicon-debug-disconnect" /><h3>Your journey will appear here</h3><p>Start teaching, then use the application. Capture one focused flow, such as creating an order.</p></div>}
                <ol class="scout-timeline">{journey.actions.map((action, index) => <li key={action.id}><span class="scout-node">{String(index + 1).padStart(2, '0')}</span><div class="scout-node-content"><strong>{action.label}</strong><small>{action.kind}{action.value !== undefined ? ` · ${action.value}` : ''}</small><div class="scout-request-chips">{journey.requests.filter(request => request.actionId === action.id).map(request => <span key={request.id} class={request.response && request.response.status >= 400 ? 'has-error' : ''}><b>{request.method}</b> {pathOnly(request.url)} <em>{request.response?.status || '—'}</em></span>)}</div></div></li>)}</ol>
                {journey.requests.some(request => !request.actionId || !journey.actions.some(action => action.id === request.actionId)) && <details class="scout-unlinked"><summary>{journey.origin === 'har' ? 'Captured API sequence' : 'Requests without a captured action'}</summary>{journey.requests.filter(request => !request.actionId || !journey.actions.some(action => action.id === request.actionId)).map(request => <p key={request.id}>{shortRequest(request)} <strong>{request.response?.status || 'No response'}</strong></p>)}</details>}
            </div>

            {!recording && !!journey.requests.length && <FragmentContent>
                <details class="panel scout-review" open={!journey.baselineConfirmed}><summary>Confirm expected behavior <span>{journey.expectations.length} API expectations</span></summary><p>Recorded responses are observations. Confirm what the application should do before Scout treats a difference as a failure.</p>
                    {journey.expectations.map(expectation => <details key={expectation.requestId} class="scout-expectation-row"><summary>{requestName(expectation.requestId)} <span>HTTP {expectation.statuses.join(', ')}</span></summary><ExpectationEditor expectation={expectation} disabled={!editable} onChange={value => send({ operation: 'update', expectations: [value] })} /></details>)}
                    <label class="scout-check"><input type="checkbox" checked={journey.baselineConfirmed} disabled={!editable} onChange={event => send({ operation: 'update', baselineConfirmed: event.currentTarget.checked })} /> I confirm these baseline expectations</label>
                </details>
                {!!journey.dependencies.length && <details class="panel scout-review" open={journey.dependencies.some(dep => !dep.confirmed)}><summary>Linked data <span>{journey.dependencies.filter(dep => !dep.confirmed).length} need review</span></summary>{journey.dependencies.map(dep => <div class="scout-link-row" key={dep.id}><span>{requestName(dep.toRequestId)} · {dep.target} {dep.toPointer}</span><select aria-label={`Source for ${dep.toPointer}`} disabled={!editable} value={`${dep.fromRequestId}|${dep.fromPointer}`} onChange={event => { const [fromRequestId, fromPointer] = event.currentTarget.value.split('|'); send({ operation: 'update', dependencies: [{ ...dep, fromRequestId, fromPointer, confirmed: true }] }); }}>{dep.candidates.map(candidate => <option value={`${candidate.requestId}|${candidate.pointer}`}>{requestName(candidate.requestId)} → {candidate.pointer}</option>)}</select><label class="scout-check"><input type="checkbox" disabled={!editable} checked={dep.confirmed} onChange={event => send({ operation: 'update', dependencies: [{ ...dep, confirmed: event.currentTarget.checked }] })} /> Confirmed</label></div>)}</details>}

                <div class="panel scout-exploration"><div class="panel-heading"><div><h2>Explore the branches</h2><p>Proposals become findings only when confirmed expectations fail during execution.</p></div></div>
                    <div class="scout-form-grid"><label>Reset page URL<input type="url" key={journey.resetUrl || 'reset'} defaultValue={journey.resetUrl || ''} disabled={!editable} placeholder="https://test-app.example/reset" onBlur={event => { if (event.currentTarget.value !== (journey.resetUrl || '')) send({ operation: 'update', resetUrl: event.currentTarget.value }); }} /><small>Scout visits this before each variation. Use a dedicated test environment.</small></label><label class="scout-check"><input type="checkbox" checked={journey.freshDataPerRun} disabled={!editable} onChange={event => send({ operation: 'update', freshDataPerRun: event.currentTarget.checked })} /> This journey creates fresh test data on every run</label></div>
                    <label class="scout-check"><input type="checkbox" checked={useAI} disabled={!editable} onChange={event => setUseAI(event.currentTarget.checked)} /> Ask my selected AI provider for additional variations</label>{useAI && <p class="scout-hint">Sanitized application context is sent to the AI provider configured in this workspace.</p>}
                    <div class="scout-toolbar"><button disabled={!editable || journey.origin === 'har' || !journey.actions.length} onClick={() => send({ operation: 'propose', useAI })}>Propose variations</button><button class="primary-action" disabled={!editable || !journey.baselineConfirmed || !journey.variants.some(variant => variant.expectation.confirmed) || !snapshot.capabilities?.interaction} onClick={() => send({ operation: 'explore', variantIds: journey.variants.filter(variant => variant.expectation.confirmed).map(variant => variant.id) })}>Explore confirmed variations</button></div>
                    <div class="scout-branches">{journey.variants.map(variant => <article class={`scout-branch outcome-${variant.outcome}`} key={variant.id}><div class="scout-branch-heading"><span class={`scout-outcome ${variant.outcome}`}>{outcomeLabels[variant.outcome]}</span><small>{variant.source === 'ai' ? 'AI proposal' : 'From your journey'}</small></div><h3>{variant.name}</h3><p>{variant.message || 'Review the expected response, then confirm this variation.'}</p><details><summary>Expected behavior</summary>{variant.kind === 'baseline' ? <p>Uses the confirmed expectations in “Confirm expected behavior” above.</p> : <><label>Observed request<select disabled={!editable} value={variant.expectation.requestId} onChange={event => send({ operation: 'update', variants: [{ ...variant, expectation: { ...variant.expectation, requestId: event.currentTarget.value, confirmed: false } }] })}>{journey.requests.map(request => <option value={request.id}>{shortRequest(request)}</option>)}</select></label><ExpectationEditor expectation={variant.expectation} disabled={!editable} onChange={value => send({ operation: 'update', variants: [{ ...variant, expectation: value }] })} /></>}</details><label class="scout-check"><input disabled={!editable} type="checkbox" checked={variant.expectation.confirmed} onChange={event => send({ operation: 'update', variants: [{ ...variant, expectation: { ...variant.expectation, confirmed: event.currentTarget.checked } }] })} /> Confirm expected behavior</label>{!!variant.evidence.length && <button class="text-action" onClick={() => setSelected(selected === variant.id ? undefined : variant.id)}>View evidence · {variant.evidence.length} requests</button>}{variant.kind !== 'baseline' && <button class="text-action" disabled={!editable} onClick={() => send({ operation: 'update', discardVariantIds: [variant.id] })}>Discard variation</button>}</article>)}</div>
                    {!journey.variants.length && <p class="scout-hint">Start with the observed journey. Scout can propose required-field, boundary, and repeat-operation variations.</p>}
                </div>
                {selectedVariant && <Evidence variant={selectedVariant} />}
                <div class="panel scout-export"><div><h2>Keep the regression suite</h2><p>Generate readable Karate tests with linked IDs and a reusable authentication fixture.</p></div><label>Independent API authentication<select value={journey.verification.auth} disabled={!editable} onChange={event => send({ operation: 'update', auth: event.currentTarget.value as 'required' | 'fixture' | 'none' })}><option value="required">Authentication setup required</option><option value="fixture">Use my configured authentication fixture</option><option value="none">Public API — no authentication required</option></select></label><div class="scout-toolbar"><button class="primary-action" disabled={!editable} onClick={() => send({ operation: 'export' })}>Save Karate suite</button><button disabled={!editable || !snapshot.suitePath} onClick={() => send({ operation: 'verify-karate' })}>Verify in Karate</button></div><small>Set karateDsl.scout.authFixture for your app’s supported API authentication. A browser pass does not establish CI readiness.</small></div>
            </FragmentContent>}
        </FragmentContent>}
    </section>;
}

function FragmentContent({ children }: { children: import('preact').ComponentChildren }) { return <>{children}</>; }
function pathOnly(url: string): string { try { return new URL(url).pathname; } catch { return url; } }
function shortRequest(request: ScoutRequest): string { return `${request.method} ${pathOnly(request.url)}`; }

function ExpectationEditor({ expectation, disabled, onChange }: { expectation: ScoutExpectation; disabled: boolean; onChange: (value: ScoutExpectation) => void }) {
    const [statuses, setStatuses] = useState(expectation.statuses.join(', '));
    const [pointer, setPointer] = useState('');
    const [operator, setOperator] = useState<ScoutAssertion['operator']>('equals');
    const [expected, setExpected] = useState('');
    const [error, setError] = useState('');
    useEffect(() => setStatuses(expectation.statuses.join(', ')), [expectation.statuses.join(',')]);
    const saveStatuses = () => {
        const values = statuses.split(',').map(value => Number(value.trim()));
        if (!values.length || values.some(value => !Number.isInteger(value) || value < 100 || value > 599)) { setError('Enter HTTP status codes between 100 and 599, separated by commas.'); return; }
        setError(''); if (values.join(',') !== expectation.statuses.join(',')) onChange({ ...expectation, statuses: values, confirmed: false });
    };
    const addCheck = () => {
        if (pointer && !pointer.startsWith('/')) { setError('Use a JSON pointer such as /orderCount or /items/0/id.'); return; }
        let value: unknown = expected; try { value = JSON.parse(expected); } catch { /* Plain strings are also valid comparisons. */ }
        if (['at-most','at-least'].includes(operator) && typeof value !== 'number') { setError('This comparison needs a number.'); return; }
        setError(''); onChange({ ...expectation, confirmed: false, assertions: [...expectation.assertions, { pointer, operator, value: operator === 'present' ? undefined : value }] }); setPointer(''); setExpected('');
    };
    return <div class="scout-expectation-editor"><label>Expected HTTP status<input disabled={disabled} value={statuses} onInput={event => setStatuses(event.currentTarget.value)} onBlur={saveStatuses} placeholder="200, 201" /></label>
        {expectation.assertions.map((assertion, index) => <div class="scout-assertion" key={index}><code>{assertion.pointer || 'Response'} {assertion.operator} {JSON.stringify(assertion.value)}</code><button disabled={disabled} aria-label="Remove response check" onClick={() => onChange({ ...expectation, confirmed: false, assertions: expectation.assertions.filter((_, at) => at !== index) })}>×</button></div>)}
        <div class="scout-check-builder"><label>Response field<input disabled={disabled} value={pointer} onInput={event => setPointer(event.currentTarget.value)} placeholder="/orderCount" /></label><label>Must be<select disabled={disabled} value={operator} onChange={event => setOperator(event.currentTarget.value as ScoutAssertion['operator'])}><option value="equals">Equal to</option><option value="at-most">At most</option><option value="at-least">At least</option><option value="present">Present</option></select></label>{operator !== 'present' && <label>Expected value<input disabled={disabled} value={expected} onInput={event => setExpected(event.currentTarget.value)} placeholder="1" /></label>}<button disabled={disabled || operator !== 'present' && !expected} onClick={addCheck}>Add check</button></div>{error && <p class="scout-validation" role="alert">{error}</p>}</div>;
}

function Evidence({ variant }: { variant: ScoutVariant }) { return <section class="panel scout-evidence" aria-label="Variation evidence"><div class="panel-heading"><div><h2>{variant.name}</h2><p>{variant.message}</p></div><span class={`scout-outcome ${variant.outcome}`}>{outcomeLabels[variant.outcome]}</span></div>{variant.evidence.map(request => <details key={request.id}><summary><b>{request.response?.status || '—'}</b> {shortRequest(request)} <small>{request.response?.duration || 0} ms</small></summary>{request.incomplete && <p>{request.incomplete}</p>}<div class="scout-evidence-columns"><div><h3>Request</h3><pre>{JSON.stringify(request.body ?? {}, null, 2)}</pre></div><div><h3>Response</h3><pre>{JSON.stringify(request.response?.body ?? {}, null, 2)}</pre></div></div></details>)}</section>; }
