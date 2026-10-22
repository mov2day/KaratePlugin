const assert = require('node:assert/strict');
const fs = require('fs');
const yaml = require('js-yaml');
const { golden, fixture } = require('./support/golden.cjs');

const out = rel => require('../../out/' + rel);
const planner = () => out('generation/plan/OpenApiPlanner');
const schemaMatch = () => out('generation/plan/schemaMatch');
const cfgMod = () => out('generation/config/GeneratorConfig');
const renderer = () => out('generation/render/FeatureRenderer');
const gate = () => out('generation/quality/QualityGate');
const scaffold = () => out('generation/scaffold/ProjectScaffolder');

const loadApi = () => yaml.load(fs.readFileSync(fixture('openapi', 'petstore-secured.yaml'), 'utf8'));
const buildModel = (api = loadApi(), name = 'petstore') => out('generation/adapters/openapi').buildOpenApiModel(api, name);
const config = (over = {}) => {
    const base = JSON.parse(JSON.stringify(cfgMod().DEFAULT_GENERATOR_CONFIG));
    for (const [k, v] of Object.entries(over)) base[k] = { ...base[k], ...v };
    return base;
};
const plan = (over = {}, model = buildModel()) => planner().planOpenApi(model, config(over));
const text = (planned, cfg = config()) =>
    Object.fromEntries(planned.features.map(f => [f.relativePath, renderer().renderFeature(f.feature, { style: cfg.style })]));
const all = (planned, cfg) => Object.values(text(planned, cfg)).join('\n');
const file = (planned, p) => {
    const f = planned.files.find(x => x.path === p);
    assert.ok(f, `file ${p} missing; have ${planned.files.map(x => x.path).join(', ')}`);
    return f.content;
};
const scenarios = planned => planned.features.flatMap(f => f.feature.scenarios);
const bySource = (planned, source) => scenarios(planned).filter(s => s.source === source);

const knownFilesFor = (planned, model) => {
    const scaf = scaffold().planScaffold({
        project: { classpathRoot: 'cp', envConfigs: [], hasEnvJson: false, runnerStyle: 'unknown' },
        config: config(),
        model
    });
    return new Set([...scaf.map(f => f.path.replace(/^cp\//, '')), ...planned.files.map(f => f.path)]);
};

const mini = (paths, o = {}) => buildModel({
    openapi: '3.0.0',
    ...(o.global === false ? {} : { security: [{ bearerAuth: [] }] }),
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' }, apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' } } },
    paths
}, 'mini');
const crudPaths = (base, o) => {
    const [a, b, c] = o.names || ['id', 'id', 'id'];
    const p = n => [{ name: n, in: 'path', required: true, schema: { type: 'integer' } }];
    const item = { type: 'object', required: ['id', 'name'], properties: { id: { type: 'integer' }, name: { type: 'string' } } };
    const json = { content: { 'application/json': { schema: item } } };
    const reqBody = { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } };
    const out = {};
    const add = (path, method, def) => { out[path] = { ...(out[path] || {}), [method]: def }; };
    add(base, 'post', { operationId: 'mk', tags: ['gadgets'], requestBody: reqBody, responses: { '201': { description: 'ok', ...json } } });
    add(`${base}/{${a}}`, 'get', { operationId: 'rd', tags: ['gadgets'], parameters: p(a), responses: { '200': { description: 'ok', ...json }, '404': { description: 'nf' } } });
    add(`${base}/{${b}}`, 'put', { operationId: 'up', tags: ['gadgets'], parameters: p(b), requestBody: reqBody, responses: { '200': { description: 'ok', ...json } } });
    add(o.deletePath || `${base}/{${c}}`, 'delete', { operationId: 'rm', tags: ['gadgets'], parameters: [...p(c), ...(o.deletePath ? p('other') : [])], ...(o.del ? { security: [o.del] } : {}), responses: { '204': { description: 'gone' } } });
    return out;
};

module.exports = [
    {
        name: 'planner: positive scenario takes the status from the spec and matches the schema file',
        run() {
            const planned = plan();
            assert.ok(text(planned)['pets/pets.feature'], 'pets/pets.feature missing');
            const get = bySource(planned, 'GET /pets/{petId}').find(s => s.category === 'positive');
            assert.ok(get.steps.some(x => x.text === 'status 200'));
            assert.ok(get.steps.some(x => x.text === "match response == read('classpath:schemas/pets.json')"));
            const create = bySource(planned, 'POST /pets').find(s => s.category === 'positive');
            assert.ok(create.steps.some(x => x.text === 'status 201'));
        }
    },
    {
        name: 'planner: spec status is not hard-coded (changing the declared 2xx changes the output)',
        run() {
            const api = loadApi();
            api.paths['/pets/{petId}'].get.responses = { '202': api.paths['/pets/{petId}'].get.responses['200'], '404': { description: 'nf' } };
            const t = all(plan({}, buildModel(api)));
            assert.match(t, /Then status 202/);
        }
    },
    {
        name: 'planner: several declared 2xx statuses are noted in a comment, lowest is asserted',
        run() {
            const api = loadApi();
            api.paths['/pets'].post.responses['200'] = { description: 'dup' };
            const planned = plan({}, buildModel(api));
            const s = bySource(planned, 'POST /pets').find(x => x.category === 'positive');
            assert.ok(s.comments.some(c => /declared success statuses: 200, 201/.test(c)));
            assert.ok(s.steps.some(x => x.text === 'status 200'));
        }
    },
    {
        name: 'planner: no scenario contains localhost or a literal http URL; Background is url baseUrl only',
        run() {
            const planned = plan();
            const t = all(planned);
            assert.ok(!/localhost/.test(t));
            assert.ok(!/'http/.test(t));
            for (const f of planned.features) {
                const urlSteps = f.feature.background.steps.filter(s => /^url\b/.test(s.text));
                assert.deepEqual(urlSteps.map(s => s.text), ['url baseUrl']);
            }
        }
    },
    {
        name: 'planner: auth callonce only where secured operations live; public ops have none',
        run() {
            const planned = plan();
            const byPath = Object.fromEntries(planned.features.map(f => [f.relativePath, f.feature]));
            const bg = p => byPath[p].background.steps.map(s => s.text);
            assert.deepEqual(bg('pets/pets.feature'), ['url baseUrl', "callonce read('classpath:common/auth.feature')"]);
            assert.deepEqual(bg('system/system.feature'), ['url baseUrl']);
            assert.deepEqual(bg('pets/pets-security.feature'), ['url baseUrl']);
            assert.ok(byPath['pets/pets-crud.feature']);
            assert.ok(bg('pets/pets-crud.feature').includes("callonce read('classpath:common/auth.feature')"));
        }
    },
    {
        name: 'planner: security none yields no 401/403, secured operations yield 401 (no 403 unless declared)',
        run() {
            const planned = plan();
            assert.equal(bySource(planned, 'GET /health').filter(s => /status 40[13]/.test(JSON.stringify(s.steps))).length, 0);
            const sec = text(planned)['pets/pets-security.feature'];
            assert.ok(sec, 'security feature missing');
            assert.match(sec, /GET \/pets\b/);
            assert.match(sec, /Then status 401/);
            assert.ok(!/status 403/.test(all(planned)));
            assert.ok(!/health/.test(sec));
            const s401 = bySource(planned, 'GET /pets').find(s => s.steps.some(x => x.text === 'status 401'));
            assert.ok(s401);
            assert.ok(s401.tags.includes('@security'));
        }
    },
    {
        name: 'planner: declared 403 becomes a draft with a forbidden-token step',
        run() {
            const api = loadApi();
            api.paths['/pets'].get.responses['403'] = { description: 'forbidden' };
            const planned = plan({}, buildModel(api));
            const d = bySource(planned, 'GET /pets').find(s => s.steps.some(x => x.text === 'status 403'));
            assert.ok(d, '403 scenario missing');
            assert.match(d.draftReason, /API_FORBIDDEN_TOKEN/);
            assert.ok(d.steps.some(x => x.text.includes("karate.sysenv('API_FORBIDDEN_TOKEN', '')")));
            assert.ok(d.steps.some(x => x.text === "header Authorization = 'Bearer ' + token"));
        }
    },
    {
        name: 'planner: undeclared 400 is not generated; declared 400 yields an invalid-body scenario',
        run() {
            assert.ok(!/status 400|status 422/.test(all(plan())));
            const api = loadApi();
            api.paths['/pets'].post.responses['400'] = { description: 'bad' };
            const planned = plan({}, buildModel(api));
            const neg = bySource(planned, 'POST /pets').find(s => s.steps.some(x => x.text === 'status 400'));
            assert.ok(neg);
            assert.match(neg.name, /missing required field 'name'/);
            assert.ok(neg.steps.some(x => x.text === 'remove payload.name'));
            assert.ok(neg.tags.includes('@negative'));
        }
    },
    {
        name: 'planner: declared 404 on a path-param operation uses an unknown id',
        run() {
            const planned = plan();
            const n = bySource(planned, 'GET /pets/{petId}').find(s => s.steps.some(x => x.text === 'status 404'));
            assert.ok(n);
            assert.ok(n.steps.some(x => x.text === 'def petId = 999999999'));
            assert.ok(n.tags.includes('@negative'));
        }
    },
    {
        name: 'planner: exploratory scenarios are absent by default',
        run() {
            const planned = plan();
            assert.ok(!/exploratory/i.test(all(planned)));
            assert.ok(!/responseStatus < 500/.test(all(planned)));
        }
    },
    {
        name: 'planner: exploratory scenarios appear tagged and only assert status < 500 when enabled',
        run() {
            const planned = plan({ scenarios: { exploratory: true } });
            const ex = scenarios(planned).filter(s => (s.tags || []).includes('@exploratory'));
            assert.ok(ex.length >= 3, `expected several exploratory scenarios, got ${ex.length}`);
            for (const s of ex) {
                assert.ok(s.comments.includes('Exploratory: expectation is not declared in the contract'));
                assert.ok(s.steps.some(x => x.text === 'assert responseStatus < 500'));
                assert.ok(!s.steps.some(x => /^status\b/.test(x.text)));
            }
            const t = all(planned);
            assert.match(t, /# Exploratory: expectation is not declared in the contract/);
            assert.ok(ex.some(s => /405|not accepted/i.test(s.name)));
            assert.ok(ex.some(s => /injection/i.test(s.name)));
        }
    },
    {
        name: 'schemaMatch: optional props ##, arrays #[], uuid, regex, int64, ranges',
        run() {
            const { toKarateSchema } = schemaMatch();
            const ks = toKarateSchema({
                type: 'object',
                required: ['id', 'name'],
                properties: {
                    id: { type: 'integer', format: 'int64' },
                    uid: { type: 'string', format: 'uuid' },
                    name: { type: 'string' },
                    nick: { type: 'string' },
                    tags: { type: 'array', items: { type: 'string' } },
                    code: { type: 'string', pattern: '^[A-Z]{3}$' },
                    age: { type: 'integer', minimum: 1, maximum: 9 },
                    flag: { type: 'boolean' },
                    big: { type: 'integer', maximum: 99999999999999999999 },
                    maybe: { type: 'string', nullable: true },
                    meta: { type: 'object', 'x-truncated': true }
                }
            }, { optionalAsDoubleHash: true });
            assert.equal(ks.id, '#number');
            assert.equal(ks.name, '#string');
            assert.equal(ks.nick, '##string');
            assert.equal(ks.tags, '##[] #string');
            assert.equal(ks.uid, '##uuid');
            assert.equal(ks.code, '##regex ^[A-Z]{3}$');
            assert.equal(ks.age, '##number? _ >= 1 && _ <= 9');
            assert.equal(ks.flag, '##boolean');
            assert.equal(ks.big, '##string');
            assert.equal(ks.maybe, '##string');
            assert.equal(ks.meta, '##object');
            assert.equal(toKarateSchema({ type: 'array', items: { type: 'string' } }, { optionalAsDoubleHash: true }), '#[] #string');
            assert.equal(toKarateSchema({ type: 'string', format: 'uuid' }, { optionalAsDoubleHash: true }), '#uuid');
            const strict = toKarateSchema({ type: 'object', properties: { a: { type: 'string' } } }, { optionalAsDoubleHash: false });
            assert.equal(strict.a, '#string');
        }
    },
    {
        name: 'planner: schema file marks optional props, enum and nested types',
        run() {
            const planned = plan();
            const pet = JSON.parse(file(planned, 'schemas/pets.json'));
            assert.equal(pet.id, '#number');
            assert.equal(pet.name, '#string');
            assert.equal(pet.tag, '##string');
            assert.match(pet.status, /^##string\? \['available', 'pending', 'sold'\]\.includes\(_\)$/);
        }
    },
    {
        name: 'planner: allOf response is merged into its own schema file',
        run() {
            const planned = plan();
            const names = planned.files.map(f => f.path).filter(p => p.startsWith('schemas/pets-'));
            assert.equal(names.length, 1, names.join(','));
            const merged = JSON.parse(file(planned, names[0]));
            assert.equal(merged.id, '#number');
            assert.equal(merged.ownerName, '#string');
            assert.equal(merged.ownerEmail, '##string');
            const upd = bySource(planned, 'PUT /pets/{petId}').find(s => s.category === 'positive');
            assert.ok(upd.steps.some(x => x.text === `match response == read('classpath:${names[0]}')`));
        }
    },
    {
        name: 'planner: array responses use match each against the item schema',
        run() {
            const planned = plan();
            const list = bySource(planned, 'GET /pets').find(s => s.category === 'positive');
            assert.ok(list.steps.some(x => x.text === "match each response == read('classpath:schemas/pets.json')"));
        }
    },
    {
        name: 'planner: request data lives in data files and is copied with unique fields',
        run() {
            const planned = plan();
            const data = JSON.parse(file(planned, 'data/pets.json'));
            assert.deepEqual(data.createPet, { name: 'Buddy', tag: 'dog', status: 'available' });
            const create = bySource(planned, 'POST /pets').find(s => s.category === 'positive');
            const texts = create.steps.map(x => x.text);
            assert.ok(texts.includes("def payload = karate.copy(read('classpath:data/pets.json')['createPet'])"));
            assert.ok(texts.includes("set payload.name = 'Buddy-' + karate.uuid()"));
            assert.ok(texts.includes('request payload'));
            assert.ok(!texts.some(x => /set payload\.(tag|status)/.test(x)));
        }
    },
    {
        name: 'planner: path segments, query params and 204 handling',
        run() {
            const planned = plan();
            const get = bySource(planned, 'GET /pets/{petId}').find(s => s.category === 'positive');
            const texts = get.steps.map(x => x.text);
            assert.ok(texts.includes('def petId = 1'));
            assert.ok(texts.includes("path 'pets', petId"));
            const list = bySource(planned, 'GET /pets').find(s => s.category === 'positive');
            assert.ok(list.steps.some(x => x.text === 'param limit = 10'));
            const health = bySource(planned, 'GET /health')[0];
            assert.ok(health.steps.some(x => x.text === 'status 200'));
        }
    },
    {
        name: 'planner: a 204 response asserts status only with a no-schema comment',
        run() {
            const api = loadApi();
            api.paths['/pets/{petId}'].delete.responses = { '204': { description: 'gone' } };
            const planned = plan({ scenarios: { crud: false } }, buildModel(api));
            const del = bySource(planned, 'DELETE /pets/{petId}').find(s => s.category === 'positive');
            assert.ok(del, 'standalone delete positive expected when the crud chain is off');
            assert.ok(del.steps.some(x => x.text === 'status 204'));
            assert.ok(!del.steps.some(x => /^match/.test(x.text)));
            assert.ok(del.comments.includes('no response body schema declared'));
            assert.ok(del.tags.includes('@lock=pets'));
        }
    },
    {
        name: 'planner: enum boundary becomes an outline at the threshold, individual scenarios below it',
        run() {
            const withOutline = scenarios(plan());
            const outline = withOutline.find(s => s.examples && s.source === 'POST /pets');
            assert.ok(outline, 'outline expected for 3 enum values at threshold 3');
            assert.deepEqual(outline.examples.columns, ['statusValue']);
            assert.deepEqual(outline.examples.rows, [['available'], ['pending'], ['sold']]);
            assert.ok(outline.steps.some(x => x.text === 'set payload.status = statusValue'));
            assert.ok(outline.tags.includes('@edge'));
            assert.ok(!/<statusValue>/.test(all(plan())));

            const below = plan({ scenarios: { outlineThreshold: 4 } });
            assert.ok(!scenarios(below).some(s => s.examples));
            const singles = bySource(below, 'POST /pets').filter(s => s.category === 'edge');
            assert.equal(singles.length, 3);
        }
    },
    {
        name: 'planner: numeric and string boundaries come from min/max constraints',
        run() {
            const api = loadApi();
            api.components.schemas.NewPet.properties.age = { type: 'integer', minimum: 0, maximum: 30 };
            api.components.schemas.NewPet.properties.nick = { type: 'string', minLength: 2, maxLength: 5 };
            const planned = plan({ scenarios: { outlineThreshold: 2 } }, buildModel(api));
            const outlines = bySource(planned, 'POST /pets').filter(s => s.examples);
            const age = outlines.find(s => s.examples.columns[0] === 'ageValue!');
            assert.ok(age);
            assert.deepEqual(age.examples.rows, [['0'], ['30']]);
            assert.ok(age.tags.includes('@boundary'));
            const nick = outlines.find(s => s.examples.columns[0] === 'nickValue!');
            assert.deepEqual(nick.examples.rows, [["'a'.repeat(2)"], ["'a'.repeat(5)"]]);
        }
    },
    {
        name: 'planner: crud chain feature with @crud and @lock for the pets resource',
        run() {
            const planned = plan();
            const t = text(planned)['pets/pets-crud.feature'];
            assert.ok(t, 'crud feature missing');
            assert.match(t, /@crud/);
            assert.match(t, /@lock=pets/);
            const crud = planned.features.find(f => f.relativePath === 'pets/pets-crud.feature').feature;
            assert.equal(crud.scenarios.length, 1);
            const texts = crud.scenarios[0].steps.map(x => x.text);
            const idx = k => texts.findIndex(x => x === k);
            assert.ok(idx('method post') >= 0 && idx('method post') < idx('def petId = response.id'));
            assert.ok(idx('def petId = response.id') < idx('method get'));
            assert.ok(idx('method get') < idx('method put'));
            assert.ok(idx('method put') < idx('method delete'));
            assert.ok(texts.lastIndexOf('status 404') > idx('method delete'));
            assert.ok(texts.includes('match response.name == payload.name'));
            assert.ok(!bySource(planned, 'DELETE /pets/{petId}').some(s => s.category === 'positive'), 'delete is covered by the chain');
        }
    },
    {
        name: 'planner: crud chain disabled by config, or skipped with a warning when the id is unknown',
        run() {
            assert.ok(!plan({ scenarios: { crud: false } }).features.some(f => f.relativePath.endsWith('-crud.feature')));
            const api = loadApi();
            api.components.schemas.Pet.properties = { name: { type: 'string' } };
            api.components.schemas.Pet.required = ['name'];
            const planned = plan({}, buildModel(api));
            assert.ok(!planned.features.some(f => f.relativePath.endsWith('-crud.feature')));
            assert.ok(planned.warnings.some(w => /CRUD/.test(w) && /id/.test(w)));
        }
    },
    {
        name: 'planner: multipart operation becomes a draft with a warning, never a runnable scenario',
        run() {
            const planned = plan();
            const s = bySource(planned, 'POST /pets/{petId}/photo');
            assert.equal(s.length, 1);
            assert.match(s[0].draftReason, /multipart/i);
            assert.ok(!s[0].steps.some(x => /^request\b/.test(x.text)));
            assert.ok(planned.warnings.some(w => w.includes('POST /pets/{petId}/photo') && /multipart/i.test(w)));
            assert.match(all(planned), /@ignore [^\n]*\n\s+Scenario: Upload a pet photo/);
        }
    },
    {
        name: 'planner: truncated request body yields a draft and a warning',
        run() {
            const api = loadApi();
            api.components.schemas.NewPet = { type: 'object', 'x-truncated': true };
            const planned = plan({}, buildModel(api));
            const s = bySource(planned, 'POST /pets');
            assert.ok(s.length >= 1 && s.every(x => x.draftReason !== undefined));
            assert.ok(planned.warnings.some(w => w.includes('POST /pets') && /truncated/i.test(w)));
        }
    },
    {
        name: 'planner: every scenario carries source, domain and op tags; category tags follow the taxonomy',
        run() {
            const planned = plan();
            for (const s of scenarios(planned)) {
                assert.ok(s.source, `source missing on ${s.name}`);
                assert.ok(s.tags.some(t => t.startsWith('@op=')), s.name);
                assert.ok(s.tags.some(t => t.startsWith('@domain=')), s.name);
            }
            const custom = plan({ tags: { taxonomy: { positive: '@smoke', negative: '@neg', edge: '@edge', boundary: '@boundary', security: '@sec', exploratory: '@exploratory' } } });
            const get = bySource(custom, 'GET /pets/{petId}').find(s => s.steps.some(x => x.text === 'status 200'));
            assert.ok(get.tags.includes('@smoke'));
            const noAuto = plan({ tags: { auto: false } });
            assert.ok(!scenarios(noAuto).some(s => s.tags.includes('@positive')));
        }
    },
    {
        name: 'planner: categories config filters scenario kinds',
        run() {
            const planned = plan({ scenarios: { categories: ['positive'], crud: false } });
            const cats = new Set(scenarios(planned).map(s => s.category));
            assert.deepEqual([...cats], ['positive']);
            assert.ok(!planned.features.some(f => f.relativePath.endsWith('-security.feature')));
        }
    },
    {
        name: 'planner: layout strategies decide relative paths',
        run() {
            const paths = over => plan(over).features.map(f => f.relativePath).sort();
            assert.deepEqual(paths({}), ['pets/pets-crud.feature', 'pets/pets-security.feature', 'pets/pets.feature', 'system/system.feature']);
            const flat = paths({ layout: { strategy: 'flat' } });
            assert.ok(flat.includes('petstore.feature'));
            assert.ok(flat.every(p => !p.includes('/')), flat.join(','));
            const method = paths({ layout: { strategy: 'method' } });
            assert.ok(method.includes('get/pets.feature') && method.includes('post/pets.feature'), method.join(','));
        }
    },
    {
        name: 'planner: public operations in a domain with secured ones go to a -public feature',
        run() {
            const api = loadApi();
            api.paths['/pets/ping'] = { get: { operationId: 'petPing', tags: ['pets'], security: [], responses: { '200': { description: 'ok' } } } };
            const planned = plan({}, buildModel(api));
            const pub = planned.features.find(f => f.relativePath === 'pets/pets-public.feature');
            assert.ok(pub);
            assert.deepEqual(pub.feature.background.steps.map(s => s.text), ['url baseUrl']);
            const main = planned.features.find(f => f.relativePath === 'pets/pets.feature').feature;
            assert.ok(!main.scenarios.some(s => s.source === 'GET /pets/ping'));
        }
    },
    {
        name: 'planner: domain falls back to the first static path segment, then general',
        run() {
            const api = { openapi: '3.0.0', paths: { '/orders': { get: { responses: { '200': { description: 'ok' } } } }, '/{x}': { get: { parameters: [{ name: 'x', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok' } } } } } };
            const planned = plan({}, buildModel(api, 'api'));
            assert.deepEqual(planned.features.map(f => f.relativePath).sort(), ['general/general.feature', 'orders/orders.feature']);
        }
    },
    {
        name: 'planner: every planned feature passes the quality gate with zero errors',
        run() {
            for (const over of [{}, { scenarios: { exploratory: true } }, { scenarios: { outlineThreshold: 99 } }, { layout: { strategy: 'flat' } }, { layout: { strategy: 'method' } }]) {
                const model = buildModel();
                const cfg = config(over);
                const planned = planner().planOpenApi(model, cfg);
                const known = knownFilesFor(planned, model);
                for (const f of planned.features) {
                    const rendered = renderer().renderFeature(f.feature, { style: cfg.style });
                    const r = gate().runGate(rendered, { knownFiles: known, config: cfg });
                    const errs = r.findings.filter(x => x.severity === 'error');
                    assert.deepEqual(errs, [], `${f.relativePath}\n${rendered}`);
                }
            }
        }
    },
    {
        name: 'planner: output is deterministic and independent of operation order',
        run() {
            const a = plan();
            const b = plan();
            assert.equal(JSON.stringify(a), JSON.stringify(b));
            assert.equal(all(a), all(b));
            const m = buildModel();
            m.operations.reverse();
            const c = planner().planOpenApi(m, config());
            assert.equal(all(c), all(a));
            assert.equal(JSON.stringify(c.files), JSON.stringify(a.files));
        }
    },
    {
        name: 'planner: scenario names are unique within each feature',
        run() {
            for (const f of plan({ scenarios: { exploratory: true } }).features) {
                const names = f.feature.scenarios.map(s => s.name);
                assert.equal(new Set(names).size, names.length, `${f.relativePath}: ${names.join(' | ')}`);
            }
        }
    },
    {
        name: 'planner: files are user-owned classpath-relative data and schemas',
        run() {
            const planned = plan();
            for (const f of planned.files) {
                assert.equal(f.owner, 'user');
                assert.match(f.path, /^(data|schemas)\/[a-z0-9-]+\.json$/);
                JSON.parse(f.content);
            }
            assert.ok(planned.warnings.some(w => /apiKeyAuth/.test(w) && /bearerAuth/.test(w)), 'scheme mismatch warning expected');
        }
    },
    {
        name: 'fix1: operations without any security are not secured (no auth, no 401)',
        run() {
            const planned = plan({}, mini({ '/things': { get: { operationId: 'listThings', responses: { '200': { description: 'ok' } } } } }, { global: false }));
            assert.ok(!planned.features.some(f => f.relativePath.endsWith('-security.feature')));
            for (const f of planned.features) assert.deepEqual(f.feature.background.steps.map(x => x.text), ['url baseUrl']);
        }
    },
    {
        name: 'fix2: wrong-scheme operations are drafts; chain is a draft naming the operation',
        run() {
            const planned = plan({}, mini({
                '/things': { get: { operationId: 'listThings', security: [{ apiKeyAuth: [] }], responses: { '200': { description: 'ok' } } } },
                ...crudPaths('/gadgets', { del: { apiKeyAuth: [] } })
            }));
            const list = bySource(planned, 'GET /things').filter(s => s.category === 'positive');
            assert.equal(list[0].draftReason, 'Requires apiKeyAuth; common/auth.feature configures bearerAuth');
            const chain = planned.features.find(f => f.relativePath === 'gadgets/gadgets-crud.feature').feature.scenarios[0];
            assert.match(chain.draftReason, /DELETE \/gadgets\/\{id\}.*apiKeyAuth/);
            assert.ok(planned.warnings.some(w => /apiKeyAuth/.test(w)));
            const okChain = plan({}, mini(crudPaths('/gadgets', {}))).features.find(f => f.relativePath === 'gadgets/gadgets-crud.feature').feature.scenarios[0];
            assert.equal(okChain.draftReason, undefined);
        }
    },
    {
        name: 'fix3: exclusive bounds (3.0 boolean and 3.1 numeric forms), integer and number',
        run() {
            const { toKarateSchema } = schemaMatch();
            const df = out('generation/plan/dataFactory');
            const forms = [
                { type: 'integer', minimum: 0, exclusiveMinimum: true, maximum: 10, exclusiveMaximum: true },
                { type: 'integer', exclusiveMinimum: 0, exclusiveMaximum: 10 }
            ];
            for (const f of forms) {
                assert.equal(toKarateSchema(f, { optionalAsDoubleHash: true }), '#number? _ > 0 && _ < 10');
                assert.equal(df.violation(f).expr, '0');
                assert.equal(df.valueFor(f, 'x'), 1);
                const api = { '/c': { post: { operationId: 'mk', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['n'], properties: { n: f } } } } }, responses: { '201': { description: 'ok' } } } } };
                const planned = plan({ scenarios: { outlineThreshold: 2 } }, mini(api, { global: false }));
                const o = scenarios(planned).find(s => s.examples);
                assert.deepEqual(o.examples.rows, [['1'], ['9']]);
            }
            const num = { type: 'number', exclusiveMinimum: 0, maximum: 5 };
            const api = { '/c': { post: { operationId: 'mk', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { n: num } } } } }, responses: { '201': { description: 'ok' } } } } };
            const planned = plan({ scenarios: { outlineThreshold: 1 } }, mini(api, { global: false }));
            assert.deepEqual(scenarios(planned).find(s => s.examples).examples.rows, [['5']]);
            assert.ok(df.valueFor(num, 'n') > 0);
        }
    },
    {
        name: 'fix4: readOnly never sent, writeOnly never matched, patterns generated or drafted',
        run() {
            const body = props => ({ '/c': { post: { operationId: 'mk', requestBody: { content: { 'application/json': { schema: { type: 'object', required: Object.keys(props), properties: props } } } }, responses: { '201': { description: 'ok', content: { 'application/json': { schema: { type: 'object', required: ['pw', 'name'], properties: { name: { type: 'string' }, pw: { type: 'string', writeOnly: true } } } } } } } } } });
            const a = plan({}, mini(body({ id: { type: 'integer', readOnly: true }, name: { type: 'string' }, code: { type: 'string', pattern: '^[A-Z]{3}$' } }), { global: false }));
            const data = JSON.parse(file(a, 'data/c.json'));
            assert.deepEqual(Object.keys(data.mk), ['name', 'code']);
            assert.match(data.mk.code, /^[A-Z]{3}$/);
            const schema = JSON.parse(file(a, 'schemas/c.json'));
            assert.deepEqual(Object.keys(schema), ['name']);
            assert.ok(!bySource(a, 'POST /c').some(s => s.draftReason));
            const neg = plan({}, mini(body({ id: { type: 'integer', readOnly: true }, name: { type: 'string' } }), { global: false }));
            assert.ok(!('id' in JSON.parse(file(neg, 'data/c.json')).mk));
            const d = plan({}, mini(body({ code: { type: 'string', pattern: '^(?=.*[a-z])(?=.*\\d).{8,}$' } }), { global: false }));
            const s = bySource(d, 'POST /c');
            assert.equal(s.length, 1);
            assert.match(s[0].draftReason, /Cannot generate a value matching pattern \^\(\?=.*provide a valid value in data\/c\.json/);
            assert.ok(d.warnings.some(w => /pattern/.test(w)));
        }
    },
    {
        name: 'fix5: crud chain maps each operation own id parameter name',
        run() {
            const planned = plan({}, mini(crudPaths('/gadgets', { names: ['id', 'pet_id', 'x'] })));
            const t = text(planned)['gadgets/gadgets-crud.feature'];
            assert.ok(t);
            assert.ok(!/def \w+ = 1\b/.test(t), t);
            assert.match(t, /def petId = id/);
            assert.match(t, /def x = id/);
            const multi = plan({}, mini(crudPaths('/gadgets', { names: ['id', 'id', 'id'], deletePath: '/gadgets/{id}/{other}' })));
            assert.ok(!multi.features.some(f => f.relativePath.endsWith('-crud.feature')));
        }
    },
    {
        name: 'fix6: #regex is anchored for unanchored patterns, kept for anchored ones',
        run() {
            const { toKarateSchema } = schemaMatch();
            const k = toKarateSchema({ type: 'object', required: ['a', 'b'], properties: { a: { type: 'string', pattern: '^[A-Z]{3}$' }, b: { type: 'string', pattern: 'a\\.dot' } } }, { optionalAsDoubleHash: true });
            assert.equal(k.a, '#regex ^[A-Z]{3}$');
            assert.equal(k.b, '#regex .*(?:a\\.dot).*');
            assert.equal(JSON.stringify(k.b), '"#regex .*(?:a\\\\.dot).*"');
        }
    },
    {
        name: 'minors: email uniqueness, untyped body, 405 probe ids, drafts honour categories, by-id comments',
        run() {
            const api = { '/c/{id}': { put: { operationId: 'up', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['mail', 'contact'], properties: { mail: { type: 'string', format: 'email' }, contact: { type: 'string', format: 'email' } } } } } }, responses: { '200': { description: 'ok' } } } },
                '/free': { post: { operationId: 'free', requestBody: { content: { 'application/json': {} } }, responses: { '200': { description: 'ok' } } } } };
            const planned = plan({ scenarios: { exploratory: true } }, mini(api, { global: false }));
            const up = bySource(planned, 'PUT /c/{id}').find(s => s.category === 'positive');
            assert.ok(up.steps.some(x => x.text === "set payload.mail = 'test.user-' + karate.uuid() + '@example.com'"));
            assert.deepEqual(JSON.parse(file(planned, 'data/free.json')).free, {});
            const probe = scenarios(planned).find(s => s.name.startsWith('PATCH /c/{id}') || s.name.startsWith('DELETE /c/{id}'));
            assert.ok(probe.steps.some(x => x.text === 'def id = 999999999'));
            const onlyNeg = plan({ scenarios: { categories: ['negative'] } }, mini({ '/m': { post: { operationId: 'm', requestBody: { content: { 'multipart/form-data': { schema: { type: 'object' } } } }, responses: { '200': { description: 'ok' } } } } }, { global: false }));
            assert.equal(scenarios(onlyNeg).length, 0);
            assert.ok(onlyNeg.warnings.some(w => /multipart/i.test(w)));
        }
    },
    {
        name: 'planner: golden output for the secured petstore',
        run() {
            const planned = plan();
            const t = text(planned);
            for (const [p, content] of Object.entries(t)) golden(`planner/${p.replace(/\//g, '__')}`, content);
            for (const f of planned.files) golden(`planner/${f.path.replace(/\//g, '__')}`, f.content);
            golden('planner/warnings.txt', planned.warnings.join('\n') + '\n');
            golden('planner/exploratory.feature', text(plan({ scenarios: { exploratory: true } }))['pets/pets.feature']);
        }
    }
];
