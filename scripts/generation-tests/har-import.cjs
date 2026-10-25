const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { fixture } = require('./support/golden.cjs');
const { stub } = require('./support/vscode-stub.cjs');

const out = rel => require('../../out/' + rel);
const repo = path.resolve(__dirname, '..', '..');

const context = () => {
    const state = {};
    return {
        extensionPath: repo,
        extension: { packageJSON: { version: '9.9.9' } },
        workspaceState: { get: (k, d) => state[k] ?? d, update: async (k, v) => { state[k] = v; } },
        globalState: { get: (_k, d) => d, update: async () => {} },
        subscriptions: []
    };
};
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

const harRequests = async () => out('services/session/HarImporter').HarImporter.importFromContent(fs.readFileSync(fixture('har', 'session.har'), 'utf8'));
const secretRequests = () => [{
    id: 'a', timestamp: 1, method: 'POST', url: 'http://localhost:9000/api/login', path: '/api/login', host: 'localhost:9000',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-lit-123', Cookie: 'sid=sess-lit-456' },
    body: '{"user":"ann","password":"pw-lit-654"}',
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"id":"u-1","token":"tok-lit-123"}', duration: 3 }
}, {
    id: 'b', timestamp: 2, method: 'GET', url: 'http://localhost:9000/api/users/u-1?api_key=key-lit-789', path: '/api/users/u-1', host: 'localhost:9000',
    headers: { Authorization: 'Bearer tok-lit-123' },
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"id":"u-1"}', duration: 3 }
}];

async function synth(requests, options, tokenOrNull) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'karate-har-'));
    stub.workspace.workspaceFolders = [{ uri: { fsPath: ws } }];
    try {
        const { SessionSynthesisService } = out('services/session/SessionSynthesisService');
        const result = await new SessionSynthesisService(context()).synthesize(
            requests, { name: 'checkout', mode: 'har', useCopilot: false, sourceRef: 'checkout.har', outputDir: path.join(ws, 'src/test/karate'), ...options }, tokenOrNull);
        return { ws, result, files: walk(ws).map(f => path.relative(ws, f).split(path.sep).join('/')) };
    } finally {
        stub.workspace.workspaceFolders = undefined;
    }
}

module.exports = [
    {
        name: 'har import: synthesis runs the pipeline, writes the feature, config and data, with no literal host',
        async run() {
            const r = await synth(await harRequests());
            assert.equal(r.result.success, true, r.result.warnings.join('; '));
            assert.equal(r.result.featuresCreated, 1);
            assert.ok(r.files.includes('src/test/karate/checkout/checkout.feature'), r.files.join(','));
            assert.ok(r.files.includes('src/test/java/karate-config.js'));
            assert.ok(r.files.some(f => /^src\/test\/java\/data\/checkout-\d+\.json$/.test(f)));
            const feature = fs.readFileSync(path.join(r.ws, 'src/test/karate/checkout/checkout.feature'), 'utf8');
            assert.match(feature, /\* def orderId = response\.id/);
            assert.ok(!feature.includes('shop.test'));
            assert.ok(r.result.warnings.some(w => /HAR imports are inferred API sequences/.test(w)));
        }
    },
    {
        name: 'har import: session mode and an output directory elsewhere in the workspace are honoured',
        async run() {
            const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'karate-har-'));
            stub.workspace.workspaceFolders = [{ uri: { fsPath: ws } }];
            try {
                const { SessionSynthesisService } = out('services/session/SessionSynthesisService');
                const result = await new SessionSynthesisService(context()).synthesize(await harRequests(), { name: 'Recorded session 1', mode: 'session', useCopilot: false, sourceRef: 'recorded-session', outputDir: path.join(ws, 'tests/api') });
                assert.equal(result.success, true, result.warnings.join('; '));
                const files = walk(ws).map(f => path.relative(ws, f).split(path.sep).join('/'));
                assert.ok(files.includes('tests/api/recorded-session-1/recorded-session-1.feature'), files.join(','));
                assert.ok(result.warnings.some(w => /Recorded sessions are inferred API sequences/.test(w)));
            } finally {
                stub.workspace.workspaceFolders = undefined;
            }
        }
    },
    {
        name: 'har import: no secret from a credential-laden capture reaches any written file',
        async run() {
            const r = await synth(secretRequests());
            assert.equal(r.result.success, true, r.result.warnings.join('; '));
            for (const f of r.files) {
                const text = fs.readFileSync(path.join(r.ws, f), 'utf8');
                for (const secret of ['tok-lit-123', 'sess-lit-456', 'pw-lit-654', 'key-lit-789']) assert.ok(!text.includes(secret), `${secret} leaked into ${f}`);
            }
            assert.ok(r.files.includes('src/test/java/common/auth.feature'));
        }
    },
    {
        name: 'har import: a capture without API requests writes nothing and reports why',
        async run() {
            const r = await synth([]);
            assert.equal(r.result.success, false);
            assert.deepEqual(r.files, []);
            assert.ok(r.result.warnings.some(w => /No feature files were generated/.test(w)));
        }
    },
    {
        name: 'har import: cancellation before generation throws CancellationError and writes nothing',
        async run() {
            const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'karate-har-'));
            stub.workspace.workspaceFolders = [{ uri: { fsPath: ws } }];
            try {
                const { SessionSynthesisService } = out('services/session/SessionSynthesisService');
                await assert.rejects(
                    new SessionSynthesisService(context()).synthesize(await harRequests(), { name: 'x', mode: 'har', useCopilot: false, sourceRef: 'x.har', outputDir: path.join(ws, 'k') }, { isCancellationRequested: true }),
                    e => e instanceof stub.CancellationError
                );
                assert.deepEqual(walk(ws), []);
            } finally {
                stub.workspace.workspaceFolders = undefined;
            }
        }
    },
    {
        name: 'har import: re-import succeeds and reports unchanged files',
        async run() {
            const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'karate-har-'));
            stub.workspace.workspaceFolders = [{ uri: { fsPath: ws } }];
            try {
                const { SessionSynthesisService } = out('services/session/SessionSynthesisService');
                const ctx = context();
                const run = async () => new SessionSynthesisService(ctx).synthesize(await harRequests(), { name: 'checkout', mode: 'har', useCopilot: false, sourceRef: 'checkout.har', outputDir: path.join(ws, 'src/test/karate') });
                assert.equal((await run()).success, true);
                const second = await run();
                assert.equal(second.success, true, second.warnings.join('; '));
                assert.ok(second.warnings.some(w => /already existed and were refreshed or left unchanged/.test(w)));
            } finally {
                stub.workspace.workspaceFolders = undefined;
            }
        }
    },
    {
        name: 'har import: AI evidence is credential-free and carries no headers',
        run() {
            const text = out('generation/adapters/har').redactedCaptureText(secretRequests());
            for (const secret of ['tok-lit-123', 'sess-lit-456', 'pw-lit-654', 'key-lit-789', 'Authorization', 'Cookie']) assert.ok(!text.includes(secret), secret);
            assert.match(text, /POST \/api\/login -> 200/);
            assert.match(text, /\[REDACTED\]/);
        }
    }
];
