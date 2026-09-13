import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { BrowserAdapter } from './BrowserAdapter';
import { ScoutAction, ScoutCommand, ScoutConnection, ScoutJourney, ScoutRequest, ScoutSnapshot, ScoutVariant } from './types';
import { allowedUrl, MAX_CAPTURE_REQUESTS, normalizeConnection, redactText, safeRequest, safeUrl, sanitize } from './privacy';
import { assess, inferDependencies, matchesRequest, proposeVariants, validAction, validExpectation } from './JourneyModel';

export class ScoutSession extends EventEmitter {
    readonly snapshot: ScoutSnapshot = { status: 'idle' };
    private adapter?: BrowserAdapter;
    private cancelled = false;
    private activeRun = false;
    private authRequired = false;
    private evidence: ScoutRequest[] = [];
    private pendingVariantIds: string[] = [];
    private capturedBytes = 0;

    changed(message?: string): void {
        if (message) this.snapshot.message = redactText(message);
        if (this.snapshot.journey) this.snapshot.journey.updatedAt = Date.now();
        this.emit('change', this.snapshot);
    }

    async connect(connection: ScoutConnection, adapter: BrowserAdapter, name = 'My application journey', reconnect = false): Promise<void> {
        if (this.activeRun) throw new Error('Cancel the current exploration before connecting another browser.');
        const saved = reconnect ? this.requireJourney() : undefined;
        if (saved && (saved.origin !== 'browser' || saved.connection.browser !== connection.browser || new URL(saved.connection.url).origin !== new URL(connection.url).origin)) throw new Error('Reconnect using this journey’s recorded browser and application origin.');
        await this.disconnect();
        const normalized = normalizeConnection(connection);
        this.adapter = adapter;
        const now = Date.now();
        this.snapshot.journey = saved || { schemaVersion: 1, id: randomUUID(), name: name.slice(0, 150), createdAt: now, updatedAt: now,
            connection: { ...normalized, url: safeUrl(normalized.url) }, origin: 'browser', actions: [], requests: [], dependencies: [], expectations: [], variants: [],
            baselineConfirmed: false, freshDataPerRun: false, verification: { auth: 'required' } };
        this.snapshot.journey.connection = { ...normalized, url: safeUrl(normalized.url) };
        this.pendingVariantIds = []; this.authRequired = false;
        this.snapshot.canResume = false;
        this.snapshot.suitePath = undefined;
        this.snapshot.status = 'connecting'; this.changed('Connecting your selected browser…');
        adapter.on('action', value => this.captureAction(value));
        adapter.on('request', value => this.captureRequest(value));
        adapter.on('auth-required', () => {
            if (!['teaching', 'exploring'].includes(this.snapshot.status)) return;
            this.authRequired = true; this.snapshot.status = 'auth-required'; this.changed('Sign in again in the selected browser. Exploration will restart from a fresh checkpoint.');
        });
        adapter.on('disconnected', message => { this.cancelled = true; this.snapshot.status = 'disconnected'; this.snapshot.pairing = undefined; this.changed(String(message)); });
        adapter.on('limitation', message => { adapter.capabilities.limitations = [...new Set([...adapter.capabilities.limitations, String(message)])]; this.changed(String(message)); });
        adapter.on('connected', () => { this.snapshot.status = 'sign-in'; this.snapshot.pairing = undefined; this.changed('Connected to your existing tab. Select Start teaching when the application is ready.'); });
        try {
            await adapter.connect(normalized);
            this.snapshot.capabilities = adapter.capabilities;
            this.snapshot.journey.connection.browserVersion = normalized.browserVersion;
            this.snapshot.status = 'sign-in';
            this.changed('Complete SSO in the selected browser, then select Start teaching. Login steps are not recorded.');
        } catch (error) { this.snapshot.status = 'disconnected'; this.changed((error as Error).message); throw error; }
    }

    private captureAction(value: unknown): void {
        const journey = this.snapshot.journey;
        if (!journey || this.snapshot.status !== 'teaching' || !validAction(value) || !allowedUrl(value.url, journey.connection) || journey.actions.length >= 500) return;
        if (journey.actions.some(action => action.id === value.id)) return;
        const action: ScoutAction = { id: value.id, timestamp: value.timestamp, kind: value.kind, selector: value.selector,
            field: value.field, inputType: value.inputType, constraints: value.constraints,
            url: safeUrl(value.url), label: redactText(value.label), value: value.value === undefined ? undefined : String(sanitize(value.value)) };
        journey.actions.push(action); this.changed();
    }

    private captureRequest(value: unknown): void {
        const journey = this.snapshot.journey;
        if (!journey || !['teaching', 'exploring', 'auth-required'].includes(this.snapshot.status) || !value || typeof value !== 'object') return;
        const incoming = value as ScoutRequest;
        if (typeof incoming.id !== 'string' || typeof incoming.url !== 'string' || !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(incoming.method) || !Number.isFinite(incoming.timestamp) || !allowedUrl(incoming.url, journey.connection)) return;
        if (incoming.response && (!Number.isInteger(incoming.response.status) || incoming.response.status < 100 || incoming.response.status > 599)) return;
        const request = safeRequest({ ...incoming, headers: incoming.headers || {}, response: incoming.response && { ...incoming.response, headers: incoming.response.headers || {} } });
        const target = this.activeRun ? this.evidence : journey.requests;
        if (target.some(item => item.id === request.id)) return;
        if (target.length >= MAX_CAPTURE_REQUESTS || this.capturedBytes > 8 * 1024 * 1024) { this.changed('Capture limit reached. Stop and use a shorter journey.'); return; }
        this.capturedBytes += JSON.stringify(request).length;
        target.push(request); target.sort((a, b) => a.timestamp - b.timestamp);
        if (!this.activeRun) journey.dependencies = inferDependencies(target);
        this.changed();
    }

    async startTeaching(): Promise<void> {
        const journey = this.requireJourney(); const adapter = this.requireAdapter();
        if (this.activeRun || this.snapshot.status === 'teaching') throw new Error('A Scout operation is already running.');
        if (journey.requests.length || journey.actions.length) throw new Error('Connect a new journey to record again. The current recording remains available to save.');
        if (!adapter.capabilities.actions) throw new Error('This connection does not allow browser action capture. Pair the companion or import HAR.');
        const url = await adapter.currentUrl();
        if (!allowedUrl(url, journey.connection)) throw new Error('Finish signing in and return to an allowed application origin first.');
        journey.connection.url = safeUrl(url);
        this.authRequired = false; this.capturedBytes = 0;
        this.snapshot.status = 'teaching';
        await adapter.setCapture(true);
        this.changed('Teaching is live. Use the application normally; each action will appear in the journey map.');
    }

    async stopTeaching(): Promise<void> {
        if (this.activeRun) { this.cancel(); return; }
        const adapter = this.requireAdapter();
        await adapter.settle(); await adapter.setCapture(false);
        const journey = this.requireJourney();
        journey.dependencies = inferDependencies(journey.requests);
        journey.expectations = journey.requests.filter(request => request.response).map(request => ({ requestId: request.id, statuses: [request.response!.status], assertions: [], confirmed: false }));
        this.snapshot.status = 'ready';
        this.changed(`Captured ${journey.actions.length} actions and ${journey.requests.length} API calls. Review expectations before exploration.`);
    }

    update(command: ScoutCommand): void {
        const journey = this.requireJourney();
        if (this.activeRun || this.snapshot.status === 'teaching') throw new Error('Stop recording or exploration before editing the journey.');
        if (command.name) journey.name = command.name.slice(0, 150);
        if (command.resetUrl !== undefined) {
            if (command.resetUrl && !allowedUrl(command.resetUrl, journey.connection)) throw new Error('The reset URL must use an allowed application origin and must not be a login URL.');
            journey.resetUrl = command.resetUrl ? safeUrl(command.resetUrl) : undefined;
        }
        if (command.freshDataPerRun !== undefined) journey.freshDataPerRun = command.freshDataPerRun;
        if (command.expectations) {
            for (const updated of command.expectations) {
                const existing = journey.expectations.find(item => item.requestId === updated.requestId);
                if (!existing || !validExpectation(updated)) throw new Error('Unknown request or invalid expectation.');
                Object.assign(existing, updated);
            }
            journey.baselineConfirmed = journey.expectations.every(item => item.confirmed);
        }
        if (command.baselineConfirmed !== undefined) {
            journey.baselineConfirmed = command.baselineConfirmed;
            journey.expectations.forEach(expectation => { expectation.confirmed = command.baselineConfirmed!; });
        }
        if (command.dependencies) for (const changed of command.dependencies) {
            const dependency = journey.dependencies.find(item => item.id === changed.id);
            if (!dependency || !dependency.candidates.some(candidate => candidate.requestId === changed.fromRequestId && candidate.pointer === changed.fromPointer)) throw new Error('Choose one of the observed data sources.');
            Object.assign(dependency, { fromRequestId: changed.fromRequestId, fromPointer: changed.fromPointer, confirmed: changed.confirmed });
        }
        if (command.variants) for (const changed of command.variants) {
            const variant = journey.variants.find(item => item.id === changed.id);
            if (!variant || !journey.requests.some(request => request.id === changed.expectation.requestId) || !validExpectation(changed.expectation)) throw new Error('Unknown variation or invalid expectation.');
            if (variant.kind === 'repeat' && !journey.requests.some(request => request.id === changed.expectation.requestId && request.actionId === variant.actionId)) throw new Error('A repeat variation must check a request triggered by that repeated action.');
            variant.expectation = variant.kind === 'baseline' ? { ...journey.expectations[journey.expectations.length - 1], confirmed: changed.expectation.confirmed } : changed.expectation;
            variant.outcome = 'proposed'; variant.evidence = []; variant.verifiedAt = undefined;
        }
        if (command.discardVariantIds) journey.variants = journey.variants.filter(variant => !command.discardVariantIds!.includes(variant.id));
        if (command.auth) journey.verification.auth = command.auth;
        journey.verification.browser = undefined; journey.verification.karate = undefined;
        this.snapshot.suitePath = undefined;
        this.changed('Journey settings updated. Run again to verify the revised expectations.');
    }

    propose(): void {
        const journey = this.requireJourney();
        if (this.activeRun || this.snapshot.status === 'teaching') throw new Error('Stop teaching before proposing variations.');
        journey.variants = proposeVariants(journey);
        journey.verification.karate = undefined; this.snapshot.suitePath = undefined;
        this.changed('Proposed variations are not findings. Confirm the expected behavior of each variation before running it.');
    }

    async explore(ids?: string[]): Promise<void> {
        const journey = this.requireJourney(); const adapter = this.requireAdapter();
        if (this.activeRun || this.snapshot.status === 'teaching') throw new Error('Stop the active Scout operation first.');
        if (!adapter.capabilities.interaction || journey.origin === 'har') throw new Error('Browser exploration needs a connected live journey. HAR input provides an inferred API sequence only.');
        if (!journey.baselineConfirmed || !journey.expectations.every(item => item.confirmed)) throw new Error('Review and confirm the baseline expectations first.');
        if (journey.dependencies.some(item => !item.confirmed)) throw new Error('Resolve ambiguous data links before exploration.');
        if (journey.requests.some(request => !['GET','HEAD','OPTIONS'].includes(request.method)) && !journey.resetUrl && !journey.freshDataPerRun) throw new Error('Provide a reset URL or confirm that the journey creates fresh test data for each run.');
        const variants = journey.variants.filter(variant => (!ids || ids.includes(variant.id)) && variant.expectation.confirmed);
        if (!variants.length) throw new Error('Confirm at least one variation to explore.');
        if (!allowedUrl(await adapter.currentUrl(), journey.connection)) {
            this.pendingVariantIds = variants.map(variant => variant.id); this.snapshot.canResume = true; this.snapshot.status = 'auth-required'; this.changed('Sign in and return to the application, then resume.'); return;
        }
        this.activeRun = true; this.cancelled = false; this.authRequired = false;
        this.snapshot.status = 'exploring'; this.snapshot.busy = 'Exploring the confirmed variations…';
        try {
            for (let index = 0; index < variants.length; index++) {
                const variant = variants[index];
                if (this.cancelled) break;
                variant.outcome = 'running'; variant.evidence = []; variant.verifiedAt = undefined;
                this.evidence = []; this.capturedBytes = 0;
                this.changed(`Exploring ${index + 1}/${variants.length}: ${variant.name}`);
                try {
                    await adapter.setCapture(false);
                    if (journey.resetUrl) await adapter.navigate(journey.resetUrl);
                    if (this.cancelled) throw new Error('Exploration cancelled.');
                    await adapter.setCapture(true);
                    await adapter.navigate(journey.connection.url);
                    for (const original of journey.actions) {
                        if (this.cancelled || this.authRequired) break;
                        const action = { ...original };
                        if (action.id === variant.actionId && variant.value !== undefined) action.value = variant.value;
                        await adapter.perform(action);
                        if (action.id === variant.actionId && variant.kind === 'repeat' && !this.cancelled && !this.authRequired) await adapter.perform(action);
                        if (['required','boundary'].includes(variant.kind)) {
                            const target = journey.requests.find(request => request.id === variant.expectation.requestId)!;
                            if (this.evidence.some(request => matchesRequest(target, request, journey.dependencies))) break;
                        }
                    }
                    await adapter.settle();
                    const current = await adapter.currentUrl();
                    variant.evidence = [...this.evidence];
                    if (!allowedUrl(current, journey.connection) || this.authRequired) {
                        variant.outcome = 'auth-required'; variant.message = 'Session expired or navigation left the application. Sign in and resume from a fresh checkpoint.';
                    } else if (this.cancelled) { variant.outcome = 'cancelled'; variant.message = 'Cancelled. No verification claim was made.'; }
                    else this.evaluateVariant(journey, variant);
                } catch (error) {
                    variant.evidence = [...this.evidence]; variant.outcome = this.authRequired ? 'auth-required' : this.cancelled ? 'cancelled' : 'inconclusive';
                    variant.message = redactText((error as Error).message);
                } finally { await adapter.setCapture(false).catch(() => undefined); }
                if (variant.kind === 'baseline') journey.verification.browser = { at: Date.now(), passed: (variant.outcome as ScoutVariant['outcome']) === 'passed' };
                if (variant.outcome === 'auth-required') {
                    this.pendingVariantIds = variants.slice(index).map(item => item.id); this.snapshot.canResume = true; this.snapshot.status = 'auth-required'; this.changed(variant.message); break;
                }
                this.changed();
            }
        } finally {
            this.activeRun = false; this.snapshot.busy = undefined;
            if (!['auth-required','disconnected'].includes(this.snapshot.status)) this.snapshot.status = 'ready';
            if (this.snapshot.status !== 'auth-required') { this.snapshot.canResume = false; this.pendingVariantIds = []; }
            this.changed(this.snapshot.status === 'auth-required' ? 'Sign in again, then resume. The unfinished variation will restart after resetting its test data.' : this.cancelled ? 'Exploration cancelled.' : 'Exploration finished. Open a branch to review its evidence.');
        }
    }

    private evaluateVariant(journey: ScoutJourney, variant: ScoutVariant): void {
        const denied = variant.evidence.some(request => request.response && [401, 403].includes(request.response.status)
            && !journey.expectations.some(expectation => {
                const recorded = journey.requests.find(item => item.id === expectation.requestId);
                const expected = variant.expectation.requestId === expectation.requestId ? variant.expectation : expectation;
                return recorded && matchesRequest(recorded, request, journey.dependencies) && expected.statuses.includes(request.response!.status);
            }));
        if (denied) { variant.outcome = 'auth-required'; variant.message = 'An application request requires sign-in or access review. Resolve authentication before classifying this variation.'; return; }
        const expectations = variant.kind === 'baseline' ? journey.expectations : [variant.expectation];
        let cursor = 0;
        for (const expectation of expectations) {
            const recorded = journey.requests.find(request => request.id === expectation.requestId)!;
            const matches = variant.evidence.map((request, index) => ({ request, index })).filter(item => item.index >= cursor && matchesRequest(recorded, item.request, journey.dependencies));
            const match = variant.kind === 'baseline' ? matches[0] : matches[matches.length - 1];
            if (variant.kind === 'repeat' && matches.length < 2) { variant.outcome = 'inconclusive'; variant.message = 'The repeated interaction did not produce a second captured API response.'; return; }
            if (!match || !match.request.response || match.request.incomplete && expectation.assertions.length) {
                variant.outcome = 'inconclusive'; variant.message = 'A required response or body was not captured. Browser validation may have prevented the request.'; return;
            }
            cursor = match.index + 1;
            if ([401, 403].includes(match.request.response.status) && !expectation.statuses.includes(match.request.response.status)) {
                variant.outcome = 'auth-required'; variant.message = 'The application requires authentication. Reauthenticate before classifying this result.'; return;
            }
            const result = assess(match.request, expectation);
            if (!result.passed) { variant.outcome = 'failed'; variant.message = result.message; variant.verifiedAt = Date.now(); return; }
        }
        variant.outcome = 'passed'; variant.message = 'Confirmed expectations passed in this browser session.'; variant.verifiedAt = Date.now();
    }

    async resume(): Promise<void> { const ids = this.pendingVariantIds; if (!ids.length) throw new Error('No interrupted exploration is waiting to resume.'); await this.explore(ids); }
    cancel(): void { this.cancelled = true; this.changed('Cancelling after the current browser action…'); }
    async disconnect(): Promise<void> {
        this.cancelled = true;
        const adapter = this.adapter; this.adapter = undefined;
        if (adapter) { adapter.removeAllListeners(); await adapter.disconnect(); }
        this.snapshot.status = 'disconnected'; this.snapshot.pairing = undefined; this.snapshot.capabilities = undefined;
        this.snapshot.canResume = false; this.pendingVariantIds = [];
        this.changed('Browser disconnected. The captured journey is still available to save.');
    }
    requireJourney(): ScoutJourney { if (!this.snapshot.journey) throw new Error('Connect a browser or import a journey first.'); return this.snapshot.journey; }
    private requireAdapter(): BrowserAdapter { if (!this.adapter) throw new Error('Connect a live browser session first.'); return this.adapter; }
}
