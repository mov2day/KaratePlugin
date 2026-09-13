const assert = require('node:assert/strict');
const { BrowserAdapter } = require('../out/services/scout/BrowserAdapter');
const { CompanionBrowserAdapter } = require('../out/services/scout/CompanionBrowserAdapter');
const { ScoutSession } = require('../out/services/scout/ScoutSession');
const { generateScoutSuite } = require('../out/services/scout/ScoutGenerator');
const { inferDependencies, journeyDocument, loadJourney, isScoutCommand } = require('../out/services/scout/JourneyModel');
const { safeRequest, safeUrl, allowedUrl, normalizeConnection, REDACTED } = require('../out/services/scout/privacy');
const { harEntryToCapturedRequest } = require('../out/services/session/CapturedRequest');
const connection = normalizeConnection({ browser: 'edge', mode: 'launch', url: 'https://shop.test', allowedOrigins: ['https://api.test'], excludedOrigins: ['https://idp.test'] });
const action = (id, kind = 'click') => ({ id, timestamp: 1, kind, url: connection.url, label: id, selector: '#' + id });
const request = (id, extra = {}) => ({ id, timestamp: 1, method: 'POST', url: connection.url + 'api/cart', headers: {}, response: { status: 200, headers: {}, body: { cartId: 'cart-1' }, duration: 1 }, ...extra });
class FakeAdapter extends BrowserAdapter {
    capabilities = { actions: true, responseBodies: true, interaction: true, limitations: [] };
    current = connection.url;
    status = 200;
    incomplete = false;
    async connect() {}
    async currentUrl() { return this.current; }
    async setCapture(enabled) { this.enabled = enabled; }
    async navigate(url) { this.current = url; }
    async perform(value) {
        if (this.beforeAction) await this.beforeAction();
        if (this.enabled) this.emit('request', request('run-' + value.id, { actionId: value.id, incomplete: this.incomplete ? 'Body unavailable' : undefined,
            response: { status: this.status, body: this.incomplete ? undefined : { cartId: 'fresh-2', count: 1 }, headers: {}, duration: 1 } }));
    }
    async settle() {}
    async disconnect() { this.closed = true; }
}
async function sessionTests() {
    const adapter = new FakeAdapter(); const session = new ScoutSession();
    await session.connect(connection, adapter);
    adapter.emit('action', action('pre-login')); adapter.emit('request', request('pre-login'));
    assert.equal(session.requireJourney().requests.length, 0);
    await session.startTeaching();
    adapter.emit('action', action('create')); adapter.emit('action', { ...action('password'), value: 'never-capture' });
    adapter.emit('request', request('create', { actionId: 'create', headers: { Authorization: 'Bearer secret', Cookie: 'session=secret' }, extraSecret: 'never-save' }));
    adapter.emit('request', request('idp', { url: 'https://idp.test/oauth/token', body: 'access_token=never-save' }));
    await session.stopTeaching();
    const journey = session.requireJourney();
    assert.equal(journey.actions.length, 1); assert.equal(journey.requests.length, 1);
    assert.ok(!JSON.stringify(journey).includes('never-save'));
    assert.deepEqual(journey.requests[0].headers, {});
    session.propose(); journey.variants = journey.variants.filter(item => item.kind === 'baseline');
    journey.variants[0].expectation.confirmed = true;
    await assert.rejects(session.explore(), /baseline expectations/);
    session.update({ operation: 'update', baselineConfirmed: true });
    await assert.rejects(session.explore(), /reset URL/);
    session.update({ operation: 'update', freshDataPerRun: true });
    adapter.status = 401; await session.explore();
    assert.equal(journey.variants[0].outcome, 'auth-required'); assert.equal(session.snapshot.status, 'auth-required');
    adapter.status = 200; await session.resume();
    assert.equal(journey.variants[0].outcome, 'passed'); assert.equal(journey.verification.karate, undefined);
    session.update({ operation: 'update', expectations: [{ ...journey.expectations[0], assertions: [{ pointer: '/count', operator: 'at-most', value: 1 }] }] });
    adapter.incomplete = true; await session.explore(); assert.equal(journey.variants[0].outcome, 'inconclusive');
    adapter.incomplete = false; adapter.beforeAction = () => session.cancel();
    await session.explore(); assert.equal(journey.variants[0].outcome, 'cancelled');
    delete adapter.beforeAction;
    const loaded = loadJourney(JSON.stringify(journeyDocument(journey)));
    assert.deepEqual(loaded.expectations[0].assertions, [{pointer:'/count',operator:'at-most',value:1}], 'business assertions survive sanitized save and load');
    assert.equal(loaded.verification.browser, undefined); assert.equal(loaded.baselineConfirmed, false);
    assert.equal(loaded.variants.length, 1); assert.equal(loaded.variants[0].expectation.confirmed, false);
    const next = new FakeAdapter(); await session.disconnect(); await session.connect(connection, next, journey.name, true);
    assert.equal(session.requireJourney(), journey, 'reconnecting retains actions and dependencies');
    session.snapshot.suitePath = '/old.feature'; session.update({ operation: 'update', name: 'Updated journey' }); assert.equal(session.snapshot.suitePath, undefined);
    session.update({ operation: 'update', discardVariantIds: journey.variants.map(item => item.id) }); assert.equal(journey.variants.length, 0);
    await session.disconnect();
    console.log('PASS Scout session: capture gate, privacy, reset/expectation gates, expiry/resume, missing bodies, cancel, reconnect');
}
async function companionTests() {
    const adapter = new CompanionBrowserAdapter(); await adapter.connect({ ...connection, mode: 'companion' });
    try {
        const { endpoint, token } = adapter.pairing; const origin = 'chrome-extension://' + 'a'.repeat(32);
        const post = async (route, body, key = token, sender = origin) => {
            const response = await fetch(endpoint + route, { method: 'POST', headers: { Origin: sender, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            return { status: response.status, body: await response.json() };
        };
        assert.equal((await post('/pair', {}, token, 'https://evil.test')).status, 403);
        assert.equal((await post('/pair', {}, 'wrong')).status, 401);
        const pair = { browser: 'edge', url: connection.url, version: 'Edge-test', capabilities: { actions: true, responseBodies: false, interaction: true, limitations: ['Response bodies unavailable'] } };
        assert.equal((await post('/pair', { ...pair, url: 'https://outside.test' })).status, 400);
        assert.equal((await post('/pair', { ...pair, browser: 'chrome' })).status, 400);
        const paired = await post('/pair', pair); assert.equal(paired.status, 200);
        assert.equal(adapter.capabilities.responseBodies, false);
        assert.equal((await post('/events', {})).status, 401, 'one-time key no longer works');
        const key = paired.body.token;
        assert.equal((await post('/events', {}, key, 'chrome-extension://' + 'b'.repeat(32))).status, 403);
        await assert.rejects(adapter.navigate('https://outside.test'), /outside/);
        const current = adapter.currentUrl();
        const commands = (await post('/poll', {}, key)).body.commands;
        assert.equal(commands[0].operation, 'url');
        await post('/result', { id: commands[0].id, value: connection.url }, key);
        assert.equal(await current, connection.url);
        assert.equal((await post('/evaluate', { expression: 'evil()' }, key)).status, 404);
        const pending = adapter.settle(); const rejected = assert.rejects(pending, /closed/); await adapter.disconnect(); await rejected;
        console.log('PASS companion bridge: one-time pairing, origin/browser scope, capabilities, typed commands, disconnect');
    } finally { await adapter.disconnect(); }
}
function modelTests() {
    const har = { startedDateTime: '2026-09-12T10:00:00Z', time: 3, request: {url:'https://shop.test/api/cart',method:'get',headers:[]}, response:{status:200,headers:[],content:{mimeType:'application/json',encoding:'base64',text:Buffer.from('{"cartId":"har-123"}').toString('base64')}} };
    const imported = harEntryToCapturedRequest(har); assert.equal(imported.response.body,'{"cartId":"har-123"}'); assert.equal(imported.response.headers['content-type'],'application/json');
    assert.equal(harEntryToCapturedRequest({...har,response:{...har.response,status:0}}).response,undefined);
    assert.throws(()=>harEntryToCapturedRequest({...har,startedDateTime:'invalid'}), /Invalid HAR/);
    assert.equal(allowedUrl('https://shop.test/login', connection), false);
    assert.equal(allowedUrl('https://api.test/v1?code=secret', connection), false);
    assert.equal(allowedUrl('https://outside.test', connection), false);
    assert.throws(() => normalizeConnection({ ...connection, browser: 'safari' }));
    assert.equal(isScoutCommand({ operation: 'connect', connection: { ...connection, allowedOrigins: 'bad' } }), false);
    assert.equal(isScoutCommand({ operation: 'update', baselineConfirmed: 'yes' }), false);
    const secret = safeRequest(request('safe', { body: JSON.stringify({ password: 'x', nested: { access_token: 'y' }, quantity: 2 }), headers: { authorization: 'Bearer x', 'content-type': 'application/json' } }));
    assert.equal(secret.body.password, REDACTED); assert.equal(secret.body.nested.access_token, REDACTED); assert.equal(secret.body.quantity, 2);
    assert.ok(!safeUrl('https://shop.test?email=a@example.com&token=secret#access_token=secret').includes('secret'));
    assert.deepEqual(new URL(safeUrl('https://shop.test?item=1&item=2')).searchParams.getAll('item'), ['1','2']);
    const requests = [request('cart'), request('checkout', { timestamp: 2, url: 'https://shop.test/cart/cart-1?cartId=cart-1', body: { cartId: 'cart-1' } })];
    const links = inferDependencies(requests); assert.deepEqual(links.map(item => item.target).sort(), ['body','path','query']);
    const ambiguous = inferDependencies([request('first'), request('second'), requests[1]]);
    assert.ok(ambiguous.some(item => !item.confirmed));
    const journey = { schemaVersion: 1, name: 'Fixture', connection, origin: 'har', actions: [], requests, expectations: requests.map(item => ({ requestId: item.id, statuses: [200], assertions: [], confirmed: false })), variants: [], dependencies: links, baselineConfirmed: false, freshDataPerRun: false, verification: { auth: 'required' } };
    const suite = generateScoutSuite(journey); assert.equal(suite.runnableScenarios, 0); assert.match(suite.files['journey.feature'], /@ignore/);
    assert.match(suite.files['scout-setup.feature'], /Authentication setup required/);
    assert.match(suite.files['journey.feature'], /response_1\["cartId"\]/);
    assert.throws(() => loadJourney('null'), /invalid/);
    console.log('PASS Scout model: allowlists, secret removal, dynamic/ambiguous links, HAR draft, auth fixture references');
}
(async () => { modelTests(); await sessionTests(); await companionTests(); })().catch(error => { console.error(error); process.exitCode = 1; });
