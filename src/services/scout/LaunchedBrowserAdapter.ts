import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { BrowserContext, Page, Request } from 'playwright-core';
import { BrowserAdapter } from './BrowserAdapter';
import { ScoutAction, ScoutCapabilities, ScoutConnection, ScoutRequest } from './types';
import { allowedUrl, isAuthUrl, MAX_BODY_BYTES, safeUrl } from './privacy';
import { actionExpression, captureExpression } from './browserScripts';

export class LaunchedBrowserAdapter extends BrowserAdapter {
    readonly capabilities: ScoutCapabilities = { actions: true, responseBodies: true, interaction: true, limitations: ['Actions inside frames are not replayed in this release.'] };
    private context?: BrowserContext;
    private page?: Page;
    private connection!: ScoutConnection;
    private enabled = false;
    private epoch = 0;
    private actionId?: string;
    private lastNetwork = 0;
    private inFlight = new Set<Request>();
    private requests = new WeakMap<Request, { id: string; at: number; epoch: number; actionId?: string }>();

    constructor(private profileDirectory: string, private runtimePath?: string, private headless = false) { super(); }

    async connect(connection: ScoutConnection): Promise<void> {
        this.connection = connection;
        fs.mkdirSync(this.profileDirectory, { recursive: true, mode: 0o700 });
        const playwright = require(this.runtimePath || 'playwright-core') as typeof import('playwright-core');
        try {
            this.context = await playwright.chromium.launchPersistentContext(path.resolve(this.profileDirectory), {
                channel: connection.browser === 'edge' ? 'msedge' : 'chrome',
                executablePath: connection.executablePath || undefined,
                headless: this.headless, viewport: null,
                acceptDownloads: false
            });
            connection.browserVersion = this.context.browser()?.version();
            await this.context.exposeBinding('__scoutReport', ({ page, frame }, payload: string) => {
                if (!this.enabled || page !== this.page || frame !== page.mainFrame() || !allowedUrl(frame.url(), connection)) return;
                const action = JSON.parse(payload) as ScoutAction;
                this.actionId = action.id;
                this.emit('action', action);
            });
            await this.context.addInitScript({ content: captureExpression({ ...connection, enabled: true }) });
            this.context.on('page', page => { void this.instrument(page); });
            this.context.on('close', () => { this.enabled = false; this.emit('disconnected', 'Scout browser was closed. Reconnect to continue.'); });
            for (const page of this.context.pages()) await this.instrument(page);
            this.page = this.context.pages()[0] || await this.context.newPage();
            await this.page.goto(connection.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            this.page.on('close', () => this.emit('disconnected', 'The selected tab was closed.'));
        } catch (error) {
            await this.disconnect();
            throw new Error(`Could not open ${connection.browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome'}. Check that it is installed and company policy permits automation. Use Connect existing tab or HAR import if required. ${String((error as Error).message).split('\n')[0]}`);
        }
    }

    private async instrument(page: Page): Promise<void> {
        page.on('framenavigated', frame => {
            if (frame !== page.mainFrame()) return;
            // Adopt an app popup only after it returns from sign-in; identity-provider popups stay unobserved.
            if ((!this.page || this.page.isClosed() || !allowedUrl(this.page.url(), this.connection)) && allowedUrl(frame.url(), this.connection)) this.page = page;
            if (page === this.page && this.enabled && isAuthUrl(frame.url())) this.emit('auth-required', 'Sign-in is required in the selected browser.');
        });
        page.on('request', request => {
            if (this.enabled && page === this.page && ['xhr', 'fetch'].includes(request.resourceType()) && allowedUrl(request.url(), this.connection)) {
                this.lastNetwork = Date.now(); this.inFlight.add(request);
                this.requests.set(request, { id: randomUUID(), at: Date.now(), epoch: this.epoch, actionId: this.actionId });
            }
        });
        page.on('requestfinished', request => { void this.finishRequest(request).catch(() => this.emit('limitation', 'A response body could not be captured.')).finally(() => { if (this.inFlight.delete(request)) this.lastNetwork = Date.now(); }); });
        page.on('requestfailed', request => {
            if (this.inFlight.delete(request)) this.lastNetwork = Date.now();
            const capture = this.requests.get(request);
            if (capture && this.enabled && capture.epoch === this.epoch) this.emit('request', {
                id: capture.id, timestamp: capture.at, actionId: capture.actionId, method: request.method(), url: request.url(), headers: {}, incomplete: 'Network request did not complete.'
            } satisfies ScoutRequest);
        });
    }

    private async finishRequest(request: Request): Promise<void> {
        const capture = this.requests.get(request);
        if (!capture || !this.enabled || capture.epoch !== this.epoch) return;
        const response = await request.response();
        if (!response) return;
        const headers = await response.allHeaders();
        let body: string | undefined;
        let incomplete: string | undefined;
        if (!/json|text\//i.test(headers['content-type'] || '')) incomplete = 'Only JSON and text response bodies are captured.';
        else if (Number(headers['content-length']) > MAX_BODY_BYTES) incomplete = 'Response body exceeds the capture limit.';
        else {
            try {
                const buffer = await response.body();
                if (buffer.length <= MAX_BODY_BYTES) body = buffer.toString('utf8');
                else incomplete = 'Response body exceeds the capture limit.';
            } catch { incomplete = 'The browser did not expose this response body.'; }
        }
        if (!this.enabled || capture.epoch !== this.epoch) return;
        const data = request.postData();
        this.emit('request', {
            id: capture.id, timestamp: capture.at, actionId: capture.actionId, method: request.method(), url: request.url(),
            headers: await request.allHeaders(), body: data && Buffer.byteLength(data) <= MAX_BODY_BYTES ? data : undefined,
            incomplete: data && Buffer.byteLength(data) > MAX_BODY_BYTES ? 'Request body exceeds the capture limit.' : incomplete,
            response: { status: response.status(), headers, body, duration: Date.now() - capture.at }
        } satisfies ScoutRequest);
    }

    async setCapture(enabled: boolean): Promise<void> {
        this.enabled = enabled;
        this.epoch++;
        this.actionId = undefined;
        if (!this.context) return;
        // One init script handles new documents. The host's enabled flag gates every event.
        for (const page of this.context.pages()) {
            await page.evaluate(captureExpression({ ...this.connection, enabled: true })).catch(() => undefined);
        }
    }

    async currentUrl(): Promise<string> {
        if (!this.page || this.page.isClosed()) throw new Error('The selected browser tab is no longer connected.');
        return safeUrl(this.page.url());
    }

    async navigate(url: string): Promise<void> {
        if (!allowedUrl(url, this.connection)) throw new Error('Navigation is outside the permitted application origins.');
        if (!this.page || this.page.isClosed()) throw new Error('The selected tab is closed.');
        this.actionId = undefined;
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await this.settle();
    }

    async perform(action: ScoutAction): Promise<void> {
        if (!this.page || !allowedUrl(this.page.url(), this.connection)) throw new Error('Return to the signed-in application before exploring.');
        this.actionId = action.id;
        await this.page.locator(action.selector).waitFor({ state: 'visible', timeout: 5000 });
        await this.page.evaluate(actionExpression(action));
        await this.settle();
    }

    async settle(): Promise<void> {
        if (!this.page) return;
        // A previous document's networkidle event may already have fired before a click.
        // Wait for this action's requests AND response-body reads to finish.
        const started = Date.now();
        do { await new Promise(resolve => setTimeout(resolve, 100)); }
        while (Date.now() - started < 5000 && (Date.now() - started < 500 || this.inFlight.size > 0 || Date.now() - this.lastNetwork < 500));
    }

    async disconnect(): Promise<void> {
        this.enabled = false; this.epoch++;
        this.inFlight.clear();
        const context = this.context;
        this.context = undefined; this.page = undefined;
        await context?.close().catch(() => undefined);
    }
}
