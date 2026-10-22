const assert = require('assert');
const fs = require('fs');
const yaml = require('js-yaml');
const { fixture } = require('./support/golden.cjs');

const out = rel => require('../../out/' + rel);
const load = () => yaml.load(fs.readFileSync(fixture('openapi', 'petstore-secured.yaml'), 'utf8'));
const build = (api, name = 'x') => out('generation/adapters/openapi').buildOpenApiModel(api, name);
const op = (model, id) => {
    const o = model.operations.find(x => x.id === id);
    assert.ok(o, `operation ${id} missing`);
    return o;
};

module.exports = [
    {
        name: 'openapi-model: bearer scheme, baseUrl, name, source',
        run() {
            const m = build(load(), 'petstore');
            assert.strictEqual(m.source, 'openapi');
            assert.strictEqual(m.name, 'petstore');
            assert.strictEqual(m.baseUrl, 'http://localhost:8080/api/v1');
            const bearer = m.schemes.find(s => s.name === 'bearerAuth');
            assert.strictEqual(bearer.kind, 'bearer');
            const key = m.schemes.find(s => s.name === 'apiKeyAuth');
            assert.strictEqual(key.kind, 'apiKey');
            assert.strictEqual(key.in, 'header');
            assert.strictEqual(key.paramName, 'X-API-Key');
        }
    },
    {
        name: 'openapi-model: operation security none / inherit / override',
        run() {
            const m = build(load());
            assert.strictEqual(op(m, 'getHealth').security, 'none');
            assert.deepStrictEqual(op(m, 'listPets').security, ['bearerAuth']);
            assert.deepStrictEqual(op(m, 'deletePet').security, ['apiKeyAuth']);
            assert.strictEqual(op(m, 'getHealth').sourceRef, 'GET /health');
            assert.deepStrictEqual(op(m, 'getHealth').tags, ['system']);
        }
    },
    {
        name: 'openapi-model: no global security yields inherit',
        run() {
            const m = build({ openapi: '3.0.0', paths: { '/a': { get: { responses: { '200': { description: 'ok' } } } } } });
            assert.strictEqual(m.operations[0].security, 'inherit');
            assert.strictEqual(m.operations[0].id, 'get_a');
        }
    },
    {
        name: 'openapi-model: path-item parameters merged and overridable',
        run() {
            const m = build({
                openapi: '3.0.0',
                paths: {
                    '/items/{id}': {
                        parameters: [
                            { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
                            { name: 'X-Trace', in: 'header', schema: { type: 'string' } }
                        ],
                        get: { operationId: 'getItem', responses: { '200': { description: 'ok' } } },
                        delete: {
                            operationId: 'delItem',
                            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
                            responses: { '204': { description: 'gone' } }
                        }
                    }
                }
            });
            const g = op(m, 'getItem');
            assert.strictEqual(g.pathParams[0].name, 'id');
            assert.strictEqual(g.pathParams[0].schema.type, 'integer');
            assert.strictEqual(g.headerParams[0].name, 'X-Trace');
            const d = op(m, 'delItem');
            assert.strictEqual(d.pathParams.length, 1);
            assert.strictEqual(d.pathParams[0].schema.type, 'string');
            assert.strictEqual(d.headerParams[0].name, 'X-Trace');
        }
    },
    {
        name: 'openapi-model: default-only response',
        run() {
            const m = build({
                openapi: '3.0.0',
                paths: { '/d': { get: { operationId: 'd', responses: { default: { description: 'x', content: { 'application/problem+json': { schema: { type: 'object' } } } } } } } }
            });
            const r = op(m, 'd').responses;
            assert.strictEqual(r.length, 1);
            assert.strictEqual(r[0].status, 'default');
            assert.strictEqual(r[0].schema.type, 'object');
            assert.strictEqual(r[0].contentType, 'application/problem+json');
        }
    },
    {
        name: 'openapi-model: multipart body goes to unsupported',
        run() {
            const m = build(load());
            const u = m.unsupported.find(x => x.sourceRef === 'POST /pets/{petId}/photo');
            assert.ok(u, 'unsupported entry missing');
            assert.ok(u.reason.includes('multipart/form-data'), u.reason);
            assert.ok(/multipart/.test(u.reason));
            const o = op(m, 'uploadPetPhoto');
            assert.strictEqual(o.body, undefined);
            assert.strictEqual(o.pathParams[0].name, 'petId');
        }
    },
    {
        name: 'openapi-model: json body and refs resolved',
        run() {
            const m = build(load());
            const o = op(m, 'createPet');
            assert.strictEqual(o.body.contentType, 'application/json');
            assert.deepStrictEqual(Object.keys(o.body.schema.properties).sort(), ['name', 'status', 'tag']);
            assert.deepStrictEqual(o.body.schema.required, ['name']);
            const list = op(m, 'listPets');
            assert.strictEqual(list.queryParams[0].name, 'limit');
            assert.strictEqual(list.queryParams[0].required, false);
            assert.strictEqual(list.responses[0].schema.items.properties.id.type, 'integer');
            assert.deepStrictEqual(op(m, 'getPetById').responses.map(r => r.status), ['200', '404']);
        }
    },
    {
        name: 'openapi-model: allOf merged with union of required',
        run() {
            const m = build(load());
            const s = op(m, 'updatePet').responses[0].schema;
            assert.strictEqual(s.type, 'object');
            assert.strictEqual(s.allOf, undefined);
            for (const p of ['id', 'name', 'tag', 'status', 'ownerName', 'ownerEmail']) assert.ok(s.properties[p], `missing ${p}`);
            assert.deepStrictEqual([...s.required].sort(), ['id', 'name', 'ownerName']);
        }
    },
    {
        name: 'openapi-model: oneOf takes first branch with note',
        run() {
            const m = build({
                openapi: '3.0.0',
                paths: { '/o': { get: { operationId: 'o', responses: { '200': { description: 'x', content: { 'application/json': { schema: { oneOf: [{ type: 'string' }, { type: 'integer' }] } } } } } } } }
            });
            const s = op(m, 'o').responses[0].schema;
            assert.strictEqual(s.type, 'string');
            assert.strictEqual(s['x-note'], 'oneOf: first branch used');
        }
    },
    {
        name: 'openapi-model: cyclic $ref (raw) does not hang',
        run() {
            const api = {
                openapi: '3.0.0',
                paths: { '/n': { get: { operationId: 'n', responses: { '200': { description: 'x', content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } } } } } },
                components: { schemas: { Node: { type: 'object', properties: { value: { type: 'string' }, next: { $ref: '#/components/schemas/Node' } } } } }
            };
            const s = op(build(api), 'n').responses[0].schema;
            assert.strictEqual(s.properties.value.type, 'string');
            assert.ok(JSON.stringify(s).includes('"x-truncated":true'));
        }
    },
    {
        name: 'openapi-model: cyclic dereferenced object does not hang',
        run() {
            const node = { type: 'object', properties: { value: { type: 'string' } } };
            node.properties.next = node;
            const api = {
                openapi: '3.0.0',
                paths: { '/n': { get: { operationId: 'n', responses: { '200': { description: 'x', content: { 'application/json': { schema: node } } } } } } }
            };
            const s = op(build(api), 'n').responses[0].schema;
            assert.ok(JSON.stringify(s).includes('"x-truncated":true'));
        }
    },
    {
        name: 'openapi-model: servers variable substitution',
        run() {
            const m = build({
                openapi: '3.0.0',
                servers: [{ url: 'https://{env}.example.com/{base}', variables: { env: { default: 'staging' }, base: { default: 'v2' } } }],
                paths: {}
            });
            assert.strictEqual(m.baseUrl, 'https://staging.example.com/v2');
        }
    },
    {
        name: 'openapi-model: global vs operation security, oauth2 and basic',
        run() {
            const m = build({
                openapi: '3.0.0',
                security: [{ basicAuth: [] }, { oauth: ['r'] }],
                components: {
                    securitySchemes: {
                        basicAuth: { type: 'http', scheme: 'basic' },
                        oauth: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://t.example.com/token', scopes: {} } } },
                        oidc: { type: 'openIdConnect', openIdConnectUrl: 'https://x/.well-known' }
                    }
                },
                paths: {
                    '/a': { get: { operationId: 'a', responses: {} } },
                    '/b': { get: { operationId: 'b', security: [{ oidc: [] }], responses: {} } }
                }
            });
            assert.deepStrictEqual(op(m, 'a').security, ['basicAuth', 'oauth']);
            assert.deepStrictEqual(op(m, 'b').security, ['oidc']);
            assert.strictEqual(m.schemes.find(s => s.name === 'basicAuth').kind, 'basic');
            const o = m.schemes.find(s => s.name === 'oauth');
            assert.strictEqual(o.kind, 'oauth2');
            assert.strictEqual(o.tokenUrl, 'https://t.example.com/token');
            assert.strictEqual(m.schemes.find(s => s.name === 'oidc').kind, 'openIdConnect');
        }
    },
    {
        name: 'openapi-model: OAS2 mini spec',
        run() {
            const m = build({
                swagger: '2.0',
                schemes: ['https'],
                host: 'api.example.com',
                basePath: '/v1',
                securityDefinitions: {
                    key: { type: 'apiKey', in: 'query', name: 'k' },
                    oa: { type: 'oauth2', flow: 'application', tokenUrl: 'https://t/token', scopes: {} },
                    b: { type: 'basic' }
                },
                definitions: { Thing: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } },
                paths: {
                    '/things': {
                        post: {
                            operationId: 'mk',
                            consumes: ['application/json'],
                            parameters: [{ name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/Thing' } }],
                            responses: { '201': { description: 'ok', schema: { $ref: '#/definitions/Thing' } } }
                        },
                        put: {
                            operationId: 'form',
                            consumes: ['application/x-www-form-urlencoded'],
                            parameters: [{ name: 'f', in: 'formData', type: 'string' }],
                            responses: { '200': { description: 'ok' } }
                        }
                    }
                }
            });
            assert.strictEqual(m.baseUrl, 'https://api.example.com/v1');
            const key = m.schemes.find(s => s.name === 'key');
            assert.strictEqual(key.kind, 'apiKey');
            assert.strictEqual(key.in, 'query');
            assert.strictEqual(key.paramName, 'k');
            assert.strictEqual(m.schemes.find(s => s.name === 'oa').tokenUrl, 'https://t/token');
            assert.strictEqual(m.schemes.find(s => s.name === 'b').kind, 'basic');
            const mk = op(m, 'mk');
            assert.strictEqual(mk.body.contentType, 'application/json');
            assert.deepStrictEqual(mk.body.schema.required, ['id']);
            assert.strictEqual(mk.responses[0].schema.properties.id.type, 'integer');
            assert.strictEqual(op(m, 'form').body, undefined);
            assert.ok(m.unsupported.some(u => u.sourceRef === 'PUT /things' && u.reason.includes('application/x-www-form-urlencoded')));
        }
    },
    {
        name: 'openapi-model: OpenAPIParser.parseModel end-to-end (dereferenced)',
        async run() {
            const { OpenAPIParser } = out('services/openApiParser');
            const m = await new OpenAPIParser().parseModel(fixture('openapi', 'petstore-secured.yaml'));
            assert.strictEqual(m.name, 'petstore-secured');
            assert.strictEqual(m.operations.length, 7);
            assert.strictEqual(m.schemes.find(s => s.name === 'bearerAuth').kind, 'bearer');
            assert.strictEqual(op(m, 'getHealth').security, 'none');
            assert.deepStrictEqual([...op(m, 'updatePet').responses[0].schema.required].sort(), ['id', 'name', 'ownerName']);
            assert.ok(m.unsupported.length >= 1);
        }
    },
    {
        name: 'openapi-model: shared DAG does not explode',
        run() {
            let child = { type: 'object', properties: { leaf: { type: 'string' } } };
            for (let d = 0; d < 9; d++) {
                const props = {};
                for (let k = 0; k < 6; k++) props['p' + k] = child;
                child = { type: 'object', properties: props };
            }
            const api = { openapi: '3.0.0', paths: { '/d': { get: { operationId: 'd', responses: { '200': { description: 'x', content: { 'application/json': { schema: child } } } } } } } };
            const t = Date.now();
            const m = build(api);
            assert.ok(Date.now() - t < 1000, 'too slow');
            assert.ok(JSON.stringify(m).length < 5 * 1024 * 1024);
        }
    },
    {
        name: 'openapi-model: node budget exceeded yields truncation marker',
        run() {
            const props = {};
            for (let i = 0; i < 3000; i++) props['f' + i] = { type: 'object', properties: { a: { type: 'string' } } };
            const api = { openapi: '3.0.0', paths: { '/b': { get: { operationId: 'b', responses: { '200': { description: 'x', content: { 'application/json': { schema: { type: 'object', properties: props } } } } } } } } };
            const s = op(build(api), 'b').responses[0].schema;
            assert.ok(JSON.stringify(s).includes('"x-truncated":true'));
        }
    },
    {
        name: 'openapi-model: examples captured (OAS3 param/response, OAS2 body/response)',
        run() {
            const m3 = build({
                openapi: '3.0.0',
                paths: { '/e/{id}': { get: { operationId: 'e', parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, example: 42 },
                    { name: 'q', in: 'query', schema: { type: 'string' }, examples: { a: { value: 'hello' } } }
                ], responses: {
                    '200': { description: 'x', content: { 'application/json': { schema: { type: 'object' }, example: { ok: true } } } },
                    '201': { description: 'x', content: { 'application/json': { schema: { type: 'object' }, examples: { a: { value: { n: 1 } } } } } },
                    'x-ext': { foo: 1 }
                } } } }
            });
            const e = op(m3, 'e');
            assert.strictEqual(e.pathParams[0].example, 42);
            assert.strictEqual(e.queryParams[0].example, 'hello');
            assert.deepStrictEqual(e.responses[0].example, { ok: true });
            assert.deepStrictEqual(e.responses[1].example, { n: 1 });
            assert.strictEqual(e.responses.length, 2);
            const m2 = build({
                swagger: '2.0',
                paths: { '/x': { post: { operationId: 'x',
                    parameters: [{ name: 'b', in: 'body', 'x-example': { a: 1 }, schema: { type: 'object' } }],
                    responses: { '200': { description: 'x', schema: { type: 'object' }, examples: { 'application/json': { r: 2 } } } } } } }
            });
            assert.deepStrictEqual(op(m2, 'x').body.example, { a: 1 });
            assert.deepStrictEqual(op(m2, 'x').responses[0].example, { r: 2 });
        }
    },
    {
        name: 'openapi-model: optional security, duplicate ids, 3.1 type arrays, bad ref',
        run() {
            const m = build({
                openapi: '3.1.0',
                components: { securitySchemes: { b: { type: 'http', scheme: 'bearer' } } },
                paths: {
                    '/a-b': { get: { security: [{}], responses: {} } },
                    '/a/b': { get: { security: [{}, { b: [] }], responses: { '200': { description: 'x', content: { 'application/json': { schema: {
                        type: 'object', properties: { n: { type: ['string', 'null'] }, bad: { $ref: '#/components/%E0%A4%A' } } } } } } } } },
                    '/a_b': { get: { responses: {} } }
                }
            });
            assert.deepStrictEqual(m.operations.map(o => o.id), ['get_a_b', 'get_a_b_2', 'get_a_b_3']);
            assert.strictEqual(m.operations[0].security, 'none');
            assert.deepStrictEqual(m.operations[1].security, ['b']);
            const s = m.operations[1].responses[0].schema;
            assert.strictEqual(s.properties.n.type, 'string');
            assert.strictEqual(s.properties.n.nullable, true);
            assert.strictEqual(s.properties.bad['x-truncated'], true);
        }
    },
];
