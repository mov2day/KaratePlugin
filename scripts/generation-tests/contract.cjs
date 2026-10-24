const fs = require('fs');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const { golden, fixture } = require('./support/golden.cjs');

const out = rel => require('../../out/' + rel);
const cfgMod = () => out('generation/config/GeneratorConfig');
const planner = () => out('generation/plan/OpenApiPlanner');
const renderer = () => out('generation/render/FeatureRenderer');
const checks = () => out('generation/plan/ResponseChecks');

const config = (scenarios = {}) => {
    const base = JSON.parse(JSON.stringify(cfgMod().DEFAULT_GENERATOR_CONFIG));
    base.scenarios = { ...base.scenarios, ...scenarios };
    return base;
};
const loadApi = () => yaml.load(fs.readFileSync(fixture('openapi', 'petstore-contract.yaml'), 'utf8'));
const model = (api = loadApi()) => out('generation/adapters/openapi').buildOpenApiModel(api, 'petstore');
const render = (planned, cfg) => Object.fromEntries(planned.features.map(f => [f.relativePath, renderer().renderFeature(f.feature, { style: cfg.style })]));
const dump = (planned, cfg) => [
    ...Object.entries(render(planned, cfg)).map(([p, t]) => `### ${p}\n${t}`),
    ...planned.files.map(f => `### ${f.path}\n${f.content}`)
].join('\n');
const op = (m, id) => m.operations.find(o => o.id === id);
const res = (o, status) => o.responses.find(r => r.status === status);

const swagger2 = () => ({
    swagger: '2.0',
    info: { title: 's2', version: '1' },
    produces: ['application/json'],
    paths: {
        '/things': {
            get: {
                operationId: 'listThings',
                description: 'List things',
                responses: {
                    '200': {
                        description: 'ok',
                        headers: { 'X-Total-Count': { type: 'integer', description: 'count' }, 'Retry-After': { type: 'string' } },
                        schema: { type: 'array', minItems: 1, items: { type: 'string', format: 'email' } },
                        examples: { 'application/json': ['a@b.co'] }
                    }
                }
            }
        }
    }
});
const oas31 = () => ({
    openapi: '3.1.0',
    info: { title: 'o31', version: '1' },
    paths: {
        '/things': {
            get: {
                operationId: 'listThings',
                responses: {
                    '200': {
                        description: 'ok',
                        headers: { Link: { schema: { type: 'string' }, example: '<x>; rel="next"' } },
                        content: { 'application/json': { schema: { type: 'array', uniqueItems: true, items: { type: ['string', 'null'], format: 'date' } }, examples: { one: { value: ['2024-01-01'] } } } }
                    }
                }
            }
        }
    }
});

module.exports = [
    { name: 'contract: config defaults are basic/0 and validate', run() {
        const d = cfgMod().DEFAULT_GENERATOR_CONFIG.scenarios;
        assert.equal(d.responseChecks, 'basic'); assert.equal(d.responseTimeMs, 0);
        const r = cfgMod().resolveGeneratorConfig({ scenarios: { responseChecks: 'loud', responseTimeMs: -5 } }, {});
        assert.equal(r.config.scenarios.responseChecks, 'basic'); assert.equal(r.config.scenarios.responseTimeMs, 0);
        assert.equal(r.warnings.length, 2, r.warnings.join('|'));
        const ok = cfgMod().resolveGeneratorConfig({ scenarios: { responseChecks: 'contract', responseTimeMs: 800 } }, {});
        assert.equal(ok.warnings.length, 0); assert.equal(ok.config.scenarios.responseChecks, 'contract'); assert.equal(ok.config.scenarios.responseTimeMs, 800);
    } },
    { name: 'contract model: OAS 3.0 headers, description, examples, formats and array bounds', run() {
        const m = model();
        const create = res(op(m, 'createPet'), '201');
        assert.equal(create.description, 'Created');
        assert.deepEqual(create.headers.map(h => [h.name, h.required, h.schema.format]), [['Location', true, 'uri']]);
        assert.equal(create.contentType, 'application/json');
        assert.equal(create.example.name, 'Rex');
        assert.equal(create.examples['application/json'].id, 1);
        const list = res(op(m, 'listPets'), '200');
        assert.deepEqual(list.headers.map(h => [h.name, h.required]), [['X-Total-Count', false], ['ETag', true]]);
        assert.equal(list.headers[0].schema.type, 'integer');
        assert.equal(list.schema.maxItems, 100); assert.equal(list.schema.uniqueItems, true);
        assert.equal(list.schema.items.properties.tags.minItems, 1);
        assert.equal(list.schema.items.properties.owner.format, 'email');
        assert.equal(op(m, 'listPets').description, 'Returns a page of pets.');
    } },
    { name: 'contract model: Swagger 2 and OAS 3.1 headers/examples/bounds', run() {
        const s2 = res(op(model(swagger2()), 'listThings'), '200');
        assert.deepEqual(s2.headers.map(h => [h.name, h.schema.type]), [['X-Total-Count', 'integer'], ['Retry-After', 'string']]);
        assert.deepEqual(s2.examples, { 'application/json': ['a@b.co'] });
        assert.equal(s2.schema.minItems, 1); assert.equal(s2.schema.items.format, 'email');
        assert.equal(op(model(swagger2()), 'listThings').description, 'List things');
        const o31 = res(op(model(oas31()), 'listThings'), '200');
        assert.equal(o31.headers[0].example, '<x>; rel="next"');
        assert.deepEqual(o31.examples['application/json'], ['2024-01-01']);
        assert.equal(o31.schema.uniqueItems, true); assert.equal(o31.schema.items.nullable, true);
    } },
    { name: 'contract: basic mode output is identical to a config without the new keys', run() {
        const cfg = config();
        const legacy = JSON.parse(JSON.stringify(cfg));
        delete legacy.scenarios.responseChecks; delete legacy.scenarios.responseTimeMs;
        const a = dump(planner().planOpenApi(model(), cfg), cfg);
        const b = dump(planner().planOpenApi(model(), legacy), legacy);
        assert.equal(a, b);
        assert.ok(!/match header|responseTime|#regex|#\[_/.test(a), 'basic mode must not emit contract checks');
    } },
    { name: 'contract: golden for contract mode', run() {
        const cfg = config({ responseChecks: 'contract' });
        const planned = planner().planOpenApi(model(), cfg);
        const text = dump(planned, cfg);
        golden('contract/petstore-contract.txt', text);
        assert.ok(text.includes("match header Content-Type contains 'application/json'"));
        assert.ok(text.includes("match header Location == '#string'"));
        assert.ok(text.includes("match header X-Total-Count == '##regex [0-9]+'"));
        assert.ok(text.includes("match header ETag == '#string'"));
        assert.ok(text.includes('assert response.length <= 10'), 'limit param bounds the list');
        assert.ok(text.includes('assert response.length <= 100'));
        assert.ok(text.includes('new Set(response.map'));
        assert.ok(text.includes('#regex [^@]+@[^@]+[.][^@]+'));
        assert.ok(text.includes('#[_ >= 1 && _ <= 5] #string'));
        assert.ok(text.includes("match response.kind == 'pet'"));
        // order: status, then content type, then headers, then the schema match
        const block = text.slice(text.indexOf('Create a pet - returns 201'));
        assert.ok(/status 201\n\s+And match header Content-Type[^\n]*\n\s+And match header Location[^\n]*\n\s+And match response\.kind[^\n]*\n\s+And match response ==/.test(block), block.slice(0, 500));
    } },
    { name: 'contract: error responses get the Content-Type check and keep the schema match', run() {
        const cfg = config({ responseChecks: 'contract' });
        const text = dump(planner().planOpenApi(model(), cfg), cfg);
        const block = text.slice(text.indexOf('returns 404'));
        assert.ok(/status 404\n\s+And match header Content-Type contains 'application\/json'\n\s+And match response ==/.test(block), block.slice(0, 400));
    } },
    { name: 'contract: responseTimeMs adds a budget in both modes and is off by default', run() {
        for (const mode of ['basic', 'contract']) {
            const cfg = config({ responseChecks: mode, responseTimeMs: 750 });
            const text = dump(planner().planOpenApi(model(), cfg), cfg);
            assert.ok(text.includes('assert responseTime < 750'), mode);
        }
        const cfg = config();
        assert.ok(!dump(planner().planOpenApi(model(), cfg), cfg).includes('responseTime'));
    } },
    { name: 'contract: responseChecksFor is pure, ordered and conservative', run() {
        const o = { id: 'x', method: 'GET', path: '/x', tags: [], pathParams: [], queryParams: [], headerParams: [], responses: [], security: 'none', sourceRef: 'GET /x' };
        const r = { status: '201', contentType: 'application/json; charset=utf-8', schema: { type: 'object' }, headers: [{ name: 'Location', required: false }, { name: 'Date', required: true }] };
        assert.deepEqual(checks().responseChecksFor(o, r, { mode: 'contract', responseTimeMs: 5 }), [
            "match header Content-Type contains 'application/json'", "match header Location == '#string'", 'assert responseTime < 5'
        ]);
        assert.deepEqual(checks().responseChecksFor(o, { ...r, status: '200' }, { mode: 'contract', responseTimeMs: 0 }), ["match header Content-Type contains 'application/json'"]);
        assert.deepEqual(checks().responseChecksFor(o, r, { mode: 'basic', responseTimeMs: 0 }), []);
        assert.deepEqual(checks().responseChecksFor({ ...o, method: 'HEAD' }, r, { mode: 'contract', responseTimeMs: 0 }), ["match header Location == '#string'"]);
        const list = { status: '200', schema: { type: 'object', required: ['items'], properties: { items: { type: 'array' } } } };
        assert.deepEqual(checks().responseChecksFor(o, list, { mode: 'contract', responseTimeMs: 0, requestParams: { limit: 3, page: 2 } }), ['assert response.items.length <= 3']);
        assert.deepEqual(checks().responseChecksFor(o, list, { mode: 'contract', responseTimeMs: 0, requestParams: { limit: 'x' } }), []);
        // example values are never asserted, only const/single-value enums
        const ex = { status: '200', schema: { type: 'object', properties: { id: { type: 'integer' }, kind: { const: 'pet' } } }, example: { id: 7, kind: 'pet' } };
        assert.deepEqual(checks().responseChecksFor(o, ex, { mode: 'contract', responseTimeMs: 0 }), ["match response.kind == 'pet'"]);
    } },
    { name: 'contract: format markers apply only in contract mode', run() {
        const sm = out('generation/plan/schemaMatch');
        const schema = { type: 'object', properties: { a: { type: 'string', format: 'email' }, b: { type: 'string', format: 'date' }, c: { type: 'array', minItems: 2, items: { type: 'integer' } } } };
        assert.deepEqual(sm.toKarateSchema(schema, { optionalAsDoubleHash: false }), { a: '#string', b: '#string', c: '#[] #number' });
        const c = sm.toKarateSchema(schema, { optionalAsDoubleHash: false, contract: true });
        assert.ok(c.a.startsWith('#regex ') && c.b.startsWith('#regex ')); assert.equal(c.c, '#[_ >= 2] #number');
    } },
    { name: 'contract: Postman saved examples are captured and checked in contract mode only', run() {
        const collection = {
            info: { name: 'Saved API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
            variable: [{ key: 'baseUrl', value: 'https://api.example.test' }],
            item: [{
                name: 'Create pet',
                event: [{ listen: 'test', script: { exec: ['pm.test("created", function () { pm.response.to.have.status(201); });'] } }],
                request: { method: 'POST', header: [], url: { raw: '{{baseUrl}}/pets', host: ['{{baseUrl}}'], path: ['pets'] }, body: { mode: 'raw', raw: '{"name":"Rex"}' } },
                response: [{ name: 'created', code: 201, status: 'Created', header: [{ key: 'Content-Type', value: 'application/json' }, { key: 'Location', value: '/pets/1' }, { key: 'Set-Cookie', value: 'a=b' }], body: '{"id":1,"name":"Rex","token":"abc"}' }]
            }]
        };
        const build = cfg => out('generation/adapters/postman').buildPostmanModel(collection, null, { config: cfg, collectionName: 'Saved API' });
        const basic = build(config());
        const r = basic.model.operations[0].responses[0];
        assert.equal(r.status, '201'); assert.equal(r.contentType, 'application/json');
        assert.deepEqual(r.headers.map(h => h.name), ['Location']);
        assert.equal(r.example.id, 1); assert.equal(r.example.token, '[REDACTED]');
        const text = b => b.features.map(f => renderer().renderFeature(f.feature, { style: config().style })).join('\n');
        assert.ok(!/match header/.test(text(basic)));
        const contract = build(config({ responseChecks: 'contract' }));
        assert.ok(/status 201\n\s+And match header Content-Type contains 'application\/json'\n\s+And match header Location == '#string'/.test(text(contract)), text(contract));
    } },
    { name: 'contract: HAR observed headers and body are captured; checks only in contract mode', run() {
        const entries = [{
            id: '1', method: 'POST', url: 'https://api.example.test/pets', headers: { 'content-type': 'application/json' }, body: '{"name":"Rex"}',
            response: { status: 201, headers: { 'Content-Type': 'application/json; charset=utf-8', Location: '/pets/9', ETag: '"x"', Date: 'now' }, body: '{"id":9,"name":"Rex"}' }
        }];
        const build = cfg => out('generation/adapters/har').buildHarModel(entries, { config: cfg, name: 'flow', mode: 'har', sourceRef: 'flow.har' });
        const basic = build(config());
        const r = basic.model.operations[0].responses[0];
        assert.equal(r.contentType, 'application/json; charset=utf-8');
        assert.deepEqual(r.headers.map(h => h.name).sort(), ['ETag', 'Location']);
        assert.equal(r.example.id, 9);
        const text = b => b.features.map(f => renderer().renderFeature(f.feature, { style: config().style })).join('\n');
        assert.ok(!/match header/.test(text(basic)));
        const t = text(build(config({ responseChecks: 'contract' })));
        assert.ok(t.includes("match header Content-Type contains 'application/json'") && t.includes("match header Location == '#string'"), t);
    } }
];
