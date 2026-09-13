import * as http from 'http';
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { BrowserAdapter } from './BrowserAdapter';
import { ScoutAction, ScoutCapabilities, ScoutConnection } from './types';
import { allowedUrl, httpUrl, safeUrl } from './privacy';

interface CompanionCommand { id: string; operation: string; payload?: unknown }

/** A separate, mandatory-authentication loopback bridge. It exposes no MCP or arbitrary evaluation endpoint. */
export class CompanionBrowserAdapter extends BrowserAdapter {
    readonly capabilities: ScoutCapabilities = { actions: false, responseBodies: false, interaction: false, limitations: [] };
    private server?: http.Server;
    private connection!: ScoutConnection;
    private pairToken = randomBytes(32).toString('hex');
    private sessionToken?: string;
    private origin?: string;
    private selectedUrl = '';
    private queue: CompanionCommand[] = [];
    private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    private poll?: http.ServerResponse;
    private lastContact = 0;
    private heartbeat?: NodeJS.Timeout;
    pairing?: { endpoint: string; token: string; expiresAt: number };

    async connect(connection: ScoutConnection): Promise<void> {
        this.connection = connection;
        this.server = http.createServer((request, response) => { void this.handle(request, response); });
        await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', resolve); });
        const address = this.server.address() as import('net').AddressInfo;
        this.pairing = { endpoint: `http://127.0.0.1:${address.port}`, token: this.pairToken, expiresAt: Date.now() + 5 * 60_000 };
        this.heartbeat = setInterval(() => {
            if (this.sessionToken && Date.now() - this.lastContact > 45_000) {
                this.emit('disconnected', 'The browser companion stopped responding. Reconnect the selected tab.');
                void this.disconnect();
            }
        }, 10_000);
        this.heartbeat.unref();
    }

    private authorized(request: http.IncomingMessage, token?: string): boolean {
        const actual = request.headers.authorization || '';
        const expected = `Bearer ${token || ''}`;
        return !!token && actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
    }

    private reply(response: http.ServerResponse, status: number, data: unknown): void {
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        response.end(JSON.stringify(data));
    }

    private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        const origin = request.headers.origin || '';
        const host = request.headers.host || '';
        if (!/^127\.0\.0\.1:\d+$/.test(host) || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) || (this.origin && this.origin !== origin)) {
            this.reply(response, 403, { error: 'Only the paired browser companion can use this connection.' }); return;
        }
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
        if (request.method === 'OPTIONS') {
            response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
            response.setHeader('Access-Control-Allow-Methods', 'POST');
            this.reply(response, 200, {}); return;
        }
        if (request.method !== 'POST') { this.reply(response, 405, {}); return; }
        const pairing = request.url === '/pair';
        if (!this.authorized(request, pairing && !this.sessionToken && Date.now() < (this.pairing?.expiresAt || 0) ? this.pairToken : this.sessionToken)) {
            this.reply(response, 401, { error: 'Pairing expired or the session credential is invalid. Start a new connection in Scout.' }); return;
        }
        let raw = '';
        try {
            for await (const chunk of request) {
                raw += chunk.toString();
                if (Buffer.byteLength(raw) > 1024 * 1024) { this.reply(response, 413, { error: 'Capture exceeds the message limit.' }); return; }
            }
            const body = JSON.parse(raw || '{}') as Record<string, unknown>;
            this.lastContact = Date.now();
            if (pairing) {
                if (this.sessionToken || body.browser !== this.connection.browser || typeof body.url !== 'string' || !allowedUrl(body.url, this.connection)) {
                    this.reply(response, 400, { error: 'Select a signed-in application tab in the browser chosen in Scout.' }); return;
                }
                this.origin = origin;
                this.selectedUrl = safeUrl(body.url);
                this.sessionToken = randomBytes(32).toString('hex');
                this.pairToken = '';
                this.pairing = undefined;
                const capabilities = body.capabilities as Partial<ScoutCapabilities> | undefined;
                this.capabilities.actions = capabilities?.actions === true;
                this.capabilities.responseBodies = capabilities?.responseBodies === true;
                this.capabilities.interaction = capabilities?.interaction === true;
                this.capabilities.limitations = Array.isArray(capabilities?.limitations) ? capabilities!.limitations!.filter(item => typeof item === 'string').slice(0, 10) : [];
                this.connection.browserVersion = typeof body.version === 'string' ? body.version.slice(0, 100) : undefined;
                this.reply(response, 200, { token: this.sessionToken, connection: this.connection });
                this.emit('connected'); return;
            }
            if (request.url === '/poll') {
                if (this.queue.length) this.reply(response, 200, { commands: this.queue.splice(0) });
                else {
                    if (this.poll) this.reply(this.poll, 200, { commands: [] });
                    this.poll = response;
                    const timer = setTimeout(() => { if (this.poll === response) this.poll = undefined; this.reply(response, 200, { commands: [] }); }, 20_000);
                    response.on('close', () => { clearTimeout(timer); if (this.poll === response) this.poll = undefined; });
                }
            } else if (request.url === '/events') {
                const events = Array.isArray(body.events) ? body.events.slice(0, 20) : [];
                for (const item of events) {
                    if (!item || typeof item !== 'object') continue;
                    const event = item as { type: string; data: unknown };
                    if (['action', 'request', 'auth-required', 'limitation', 'disconnected'].includes(event.type)) this.emit(event.type, event.data);
                }
                this.reply(response, 200, {});
            } else if (request.url === '/result') {
                const pending = this.pending.get(String(body.id));
                if (pending) {
                    this.pending.delete(String(body.id)); clearTimeout(pending.timer);
                    if (typeof body.error === 'string') pending.reject(new Error(body.error)); else pending.resolve(body.value);
                }
                this.reply(response, 200, {});
            } else this.reply(response, 404, {});
        } catch { this.reply(response, 400, { error: 'Invalid companion message.' }); }
    }

    private command(operation: string, payload?: unknown): Promise<unknown> {
        if (!this.sessionToken) return Promise.reject(new Error('Pair the browser companion with your signed-in tab first.'));
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); this.queue = this.queue.filter(item => item.id !== id); reject(new Error('The browser did not finish this action. Check the selected tab and reconnect if needed.')); }, 30_000);
            this.pending.set(id, { resolve, reject, timer });
            this.queue.push({ id, operation, payload });
            if (this.poll) { const poll = this.poll; this.poll = undefined; this.reply(poll, 200, { commands: this.queue.splice(0) }); }
        });
    }

    async setCapture(enabled: boolean): Promise<void> { await this.command('capture', { enabled }); }
    async currentUrl(): Promise<string> { const value = await this.command('url'); this.selectedUrl = safeUrl(String(value)); return this.selectedUrl; }
    async navigate(url: string): Promise<void> { httpUrl(url); if (!allowedUrl(url, this.connection)) throw new Error('Navigation is outside the permitted application origins.'); await this.command('navigate', { url }); }
    async perform(action: ScoutAction): Promise<void> { await this.command('perform', action); }
    async settle(): Promise<void> { await this.command('settle'); }
    async disconnect(): Promise<void> {
        if (this.heartbeat) clearInterval(this.heartbeat);
        // Best effort detach; closing the channel also makes the companion detach locally.
        if (this.poll) { this.reply(this.poll, 200, { commands: [{ id: randomUUID(), operation: 'disconnect' }] }); this.poll = undefined; }
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Scout connection closed.')); }
        this.pending.clear(); this.queue = []; this.sessionToken = undefined; this.pairing = undefined;
        const server = this.server; this.server = undefined;
        server?.closeAllConnections();
        await new Promise<void>(resolve => { if (server) server.close(() => resolve()); else resolve(); });
    }
}
