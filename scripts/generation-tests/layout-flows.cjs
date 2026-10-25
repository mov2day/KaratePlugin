const fs = require('fs');
const assert = require('node:assert/strict');
const { fixture } = require('./support/golden.cjs');

const out = rel => require('../../out/' + rel);
const cfgMod = () => out('generation/config/GeneratorConfig');
const stage = () => out('generation/layout/LayoutStage');
const renderer = () => out('generation/render/FeatureRenderer');

const config = (layout = {}) => {
    const base = JSON.parse(JSON.stringify(cfgMod().DEFAULT_GENERATOR_CONFIG));
    base.layout = { ...base.layout, ...layout };
    return base;
};
const renderAll = (features, cfg = config()) => features.map(f => renderer().renderFeature(f.feature, { style: cfg.style })).join('\n=====\n');

// ---- HAR
let seq = 0;
const H = 'https://shop.test';
const entry = (method, url, o = {}) => {
    const u = new URL(url);
    return {
        id: `r${++seq}`, timestamp: 1000 + seq, method, url, path: u.pathname + u.search, host: u.host,
        headers: { ...(o.headers ?? {}) },
        ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
        response: { status: o.status ?? 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(o.json ?? { ok: true }), duration: 5 }
    };
};
const harBuild = entries => out('generation/adapters/har').buildHarModel(entries, { config: config(), name: 'Shop session', mode: 'har', sourceRef: 's.har' });
const longSession = () => [
    entry('GET', `${H}/api/users`, { json: [{ id: 'u-1' }] }),
    entry('GET', `${H}/api/users/u-1`, { json: { id: 'u-1', name: 'a' } }),
    entry('PUT', `${H}/api/users/u-1`, { body: { name: 'b' }, json: { id: 'u-1', name: 'b' } }),
    entry('POST', `${H}/api/orders`, { status: 201, body: { sku: 'X' }, json: { id: 'ord-77', status: 'NEW' } }),
    entry('GET', `${H}/api/products`, { json: [{ id: 'p-1' }] }),
    entry('GET', `${H}/api/orders/ord-77`, { json: { id: 'ord-77', status: 'NEW' } }),
    entry('DELETE', `${H}/api/orders/ord-77`, { status: 204 }),
    entry('GET', `${H}/api/health`, { json: { status: 'up' } }),
    entry('GET', `${H}/api/health?verbose=1`, { json: { status: 'up' } })
];

// ---- tiny planned-feature fixtures for tag/path
const step = (keyword, text) => ({ keyword, text });
const sc = (name, extra = {}) => ({ name, steps: [step('Given', "path 'x'"), step('When', 'method get'), step('Then', 'status 200')], ...extra });
const pf = scenarios => [{ relativePath: 'api/api.feature', feature: { name: 'Api', background: { steps: [step('*', 'url baseUrl')] }, scenarios } }];

module.exports = [
    { name: 'layout flows: a short HAR session stays one scenario', run() {
        const b = harBuild(longSession().slice(0, 8));
        assert.equal(b.features[0].feature.scenarios.length, 1);
        assert.equal(b.features[0].feature.scenarios[0].name, 'Shop session');
    } },
    { name: 'layout flows: a long HAR session is split per resource and every request is kept', run() {
        const b = harBuild(longSession());
        const scenarios = b.features[0].feature.scenarios;
        assert.deepEqual(scenarios.map(s => s.name), ['Shop session: users flow', 'Shop session: orders flow', 'Shop session: health flow']);
        assert.deepEqual(scenarios.map(s => s.domain), ['users', 'orders', 'health']);
        const calls = scenarios.map(s => s.steps.filter(x => /^method /.test(x.text)).length);
        assert.deepEqual(calls, [3, 4, 2]);
    } },
    { name: 'layout flows: an id captured by a producer keeps its consumers (and the requests between) in one scenario', run() {
        const b = harBuild(longSession());
        const orders = b.features[0].feature.scenarios.find(s => /orders flow/.test(s.name));
        const text = renderAll([{ feature: { ...b.features[0].feature, scenarios: [orders] } }]);
        assert.match(text, /source: GET \/api\/products/);
        assert.match(text, /def orderId = response\.id/);
        assert.match(text, /path 'api', 'orders', orderId/);
        assert.ok(/method post/.test(text) && /method delete/.test(text));
        // the products request sits between producer and consumer, so there is no separate products scenario
        assert.ok(!b.features[0].feature.scenarios.some(s => /products flow/.test(s.name)));
    } },
    { name: 'layout flows: HAR flows are splittable by path through the layout stage', run() {
        const b = harBuild(longSession());
        const planned = stage().applyLayout(b.features, config({ splitBy: 'path' }).layout);
        assert.deepEqual(planned.map(f => f.relativePath), [
            'shop-session/shop-session.feature', 'shop-session/shop-session-orders.feature', 'shop-session/shop-session-health.feature'
        ]);
        assert.equal(planned.reduce((n, f) => n + f.feature.scenarios.length, 0), b.features[0].feature.scenarios.length);
    } },

    { name: 'layout flows: postman scenarios carry category and domain, and 401/403 become security', run() {
        const col = JSON.parse(fs.readFileSync(fixture('postman', 'collection.json'), 'utf8'));
        const guard = (name, code) => ({ name, request: { method: 'GET', header: [], url: { raw: `{{baseUrl}}/${name}`, host: ['{{baseUrl}}'], path: [name] } }, event: [{ listen: 'test', script: { type: 'text/javascript', exec: [`pm.response.to.have.status(${code});`] } }] });
        col.item.push({ name: 'Guards', item: [guard('missing', 404), guard('forbidden', 403), guard('anon', 401)] });
        const b = out('generation/adapters/postman').buildPostmanModel(col, null, { config: config(), collectionName: col.info.name });
        const all = b.features.flatMap(f => f.feature.scenarios);
        assert.deepEqual(all.filter(s => s.domain === 'guards').map(s => s.category), ['negative', 'security', 'security']);
        assert.ok(all.every(s => s.category && s.domain));
        assert.ok(all.some(s => s.category === 'positive'));
    } },
    { name: 'layout flows: flat postman output splits by category and by domain in the layout stage', run() {
        const col = JSON.parse(fs.readFileSync(fixture('postman', 'collection.json'), 'utf8'));
        const guard = { name: 'Guards', item: [{ name: 'forbidden', request: { method: 'GET', header: [], url: { raw: '{{baseUrl}}/forbidden', host: ['{{baseUrl}}'], path: ['forbidden'] } }, event: [{ listen: 'test', script: { type: 'text/javascript', exec: ['pm.response.to.have.status(403);'] } }] }] };
        col.item.push(guard);
        const flat = config(); flat.layout.strategy = 'flat';
        const b = out('generation/adapters/postman').buildPostmanModel(col, null, { config: flat, collectionName: col.info.name });
        assert.equal(b.features.length, 1);
        const byCat = stage().applyLayout(b.features, config({ splitBy: 'category' }).layout);
        assert.ok(byCat.some(f => f.relativePath.endsWith('-security.feature')));
        const byPath = stage().applyLayout(b.features, config({ splitBy: 'path' }).layout);
        assert.ok(byPath.length > 1);
        assert.equal(byPath.reduce((n, f) => n + f.feature.scenarios.length, 0), b.features[0].feature.scenarios.length);
    } },

    { name: 'layout flows: graphql scenarios carry positive, negative and exploratory categories', run() {
        const sdl = fs.readFileSync(fixture('graphql', 'schema.graphql'), 'utf8');
        const schema = new (out('services/graphql/GraphQLParser').GraphQLParser)().parseSDL(sdl);
        const cfg = config(); cfg.scenarios.exploratory = true;
        const p = out('generation/adapters/graphql').buildGraphQLPlan(schema, { config: cfg, name: 'Lib' });
        const cats = new Set(p.features.flatMap(f => f.feature.scenarios.map(s => s.category ?? 'exploratory')));
        assert.deepEqual([...cats].sort(), ['exploratory', 'negative', 'positive']);
        const split = stage().applyLayout(p.features, { ...cfg.layout, splitBy: 'category' });
        assert.ok(split.some(f => f.relativePath.endsWith('-exploratory.feature')));
        assert.equal(split.reduce((n, f) => n + f.feature.scenarios.length, 0), p.features.reduce((n, f) => n + f.feature.scenarios.length, 0));
    } },

    { name: 'layout flows: requirements spanning several domains get one file per domain; one domain stays one file', run() {
        const api = {
            openapi: '3.0.0',
            paths: {
                '/orders': { get: { operationId: 'listOrders', tags: ['orders'], summary: 'List orders', responses: { '200': { description: 'ok' } } } },
                '/customers': { get: { operationId: 'listCustomers', tags: ['customers'], summary: 'List customers', responses: { '200': { description: 'ok' } } } }
            }
        };
        const model = out('generation/adapters/openapi').buildOpenApiModel(api, 'shop');
        const build = (items, m) => out('generation/adapters/requirements').buildRequirementScenarios(items, { config: config(), name: 'shop', model: m });
        const multi = build([{ id: 'S-1', title: 't', criteria: ['GET /orders lists orders', 'GET /customers lists customers', 'Something with no contract match xyz'] }], model);
        assert.deepEqual(multi.features.map(f => f.relativePath), [
            'shop/shop-requirements.feature', 'shop/shop-customers-requirements.feature', 'shop/shop-orders-requirements.feature'
        ]);
        assert.equal(multi.features.reduce((n, f) => n + f.feature.scenarios.length, 0), 3);
        const single = build([{ id: 'S-1', title: 't', criteria: ['GET /orders lists orders'] }], model);
        assert.deepEqual(single.features.map(f => f.relativePath), ['shop/shop-requirements.feature']);
    } },

    { name: 'layout flows: splitBy tag groups by the first non-taxonomy tag; splitBy path groups by domain', run() {
        const input = pf([
            sc('a', { tags: ['@positive', '@op=a', '@smoke'], domain: 'pets' }),
            sc('b', { tags: ['@negative', '@regression'], domain: 'pets' }),
            sc('c', { tags: ['@positive', '@smoke'], domain: 'owners' }),
            sc('d', { tags: ['@positive'] })
        ]);
        const byTag = stage().applyLayout(input, config({ splitBy: 'tag' }).layout);
        assert.deepEqual(byTag.map(f => f.relativePath), ['api/api.feature', 'api/api-regression.feature', 'api/api-untagged.feature']);
        assert.deepEqual(byTag[0].feature.scenarios.map(s => s.name), ['a', 'c']);
        assert.equal(byTag[1].feature.name, 'Api - Regression');
        const byPath = stage().applyLayout(input, config({ splitBy: 'path' }).layout);
        assert.deepEqual(byPath.map(f => f.relativePath), ['api/api.feature', 'api/api-owners.feature', 'api/api-general.feature']);
        assert.deepEqual(byPath[0].feature.scenarios.map(s => s.name), ['a', 'b']);
        // a file whose scenarios share one key is left alone
        const same = pf([sc('x', { domain: 'pets' }), sc('y', { domain: 'pets' })]);
        assert.equal(stage().applyLayout(same, config({ splitBy: 'path' }).layout)[0], same[0]);
    } }
];
