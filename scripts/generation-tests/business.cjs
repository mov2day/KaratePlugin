const fs = require('fs');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const { golden, fixture } = require('./support/golden.cjs');

const out = rel => require('../../out/' + rel);
const cfgMod = () => out('generation/config/GeneratorConfig');
const planner = () => out('generation/plan/OpenApiPlanner');
const renderer = () => out('generation/render/FeatureRenderer');

const config = (scenarios = {}) => {
    const base = JSON.parse(JSON.stringify(cfgMod().DEFAULT_GENERATOR_CONFIG));
    base.scenarios = { ...base.scenarios, ...scenarios };
    return base;
};
const load = (name = 'petstore-business.yaml') => yaml.load(fs.readFileSync(fixture('openapi', name), 'utf8'));
const model = (api = load()) => out('generation/adapters/openapi').buildOpenApiModel(api, 'petstore');
const plan = (cfg, api) => planner().planOpenApi(model(api), cfg);
const render = (planned, cfg) => Object.fromEntries(planned.features.map(f => [f.relativePath, renderer().renderFeature(f.feature, { style: cfg.style })]));
const dump = (planned, cfg) => [
    ...Object.entries(render(planned, cfg)).map(([p, t]) => `### ${p}\n${t}`),
    ...planned.files.map(f => `### ${f.path}\n${f.content}`)
].join('\n');
const on = (extra = {}) => config({ business: 'on', ...extra });
const scenarios = planned => planned.features.flatMap(f => f.feature.scenarios);
const find = (planned, re) => scenarios(planned).find(s => re.test(s.name));
const text = (s, cfg) => renderer().renderFeature({ name: 'x', scenarios: [s] }, { style: cfg.style });
const clone = o => JSON.parse(JSON.stringify(o));

module.exports = [
    { name: 'business: config default is off and validates', run() {
        assert.equal(cfgMod().DEFAULT_GENERATOR_CONFIG.scenarios.business, 'off');
        const bad = cfgMod().resolveGeneratorConfig({ scenarios: { business: 'maybe' } }, {});
        assert.equal(bad.config.scenarios.business, 'off'); assert.equal(bad.warnings.length, 1, bad.warnings.join('|'));
        const ok = cfgMod().resolveGeneratorConfig({ scenarios: { business: 'on' } }, {});
        assert.equal(ok.warnings.length, 0); assert.equal(ok.config.scenarios.business, 'on');
    } },
    { name: 'business: off output is identical to a config without the key, for both response-check modes', run() {
        for (const responseChecks of ['basic', 'contract']) {
            const cfg = config({ responseChecks });
            const legacy = clone(cfg); delete legacy.scenarios.business;
            const a = dump(plan(cfg), cfg);
            assert.equal(a, dump(plan(legacy), legacy));
            assert.ok(!/@business/.test(a));
            assert.ok(/def petId = 1/.test(a), 'off keeps the hardcoded id');
        }
    } },
    { name: 'business: golden for on', run() {
        const cfg = on();
        golden('business/petstore-business.txt', dump(plan(cfg), cfg));
        const c2 = on({ responseChecks: 'contract' });
        golden('business/petstore-business-contract.txt', dump(plan(c2), c2));
    } },
    { name: 'business 3c: chain echoes every non-readOnly, non-writeOnly, non-generated field after create, read and update', run() {
        const cfg = on();
        const chain = find(plan(cfg), /lifecycle/);
        const t = text(chain, cfg);
        for (const f of ['name', 'status', 'tag']) {
            assert.ok(t.includes(`match response.${f} == payload.${f}`), `create/read echo ${f}`);
            assert.ok(t.includes(`match response.${f} == updatePayload.${f}`), `update echo ${f}`);
        }
        assert.ok(!/response\.(secret|createdAt|id) ==/.test(t), 'secret/createdAt/id never echoed');
        // create, read, update each echo; plus the read after update
        assert.equal((t.match(/match response\.name == payload\.name/g) || []).length, 2);
        assert.equal((t.match(/match response\.name == updatePayload\.name/g) || []).length, 2);
        assert.ok(t.indexOf('updatePayload.name') > t.indexOf('payload.name'));
    } },
    { name: 'business 3c: fields absent from the response schema are skipped', run() {
        const api = load();
        delete api.components.schemas.Pet.properties.tag;
        const cfg = on();
        const t = text(find(plan(cfg, api), /lifecycle/), cfg);
        assert.ok(!/response\.tag ==/.test(t));
        assert.ok(/response\.name == payload\.name/.test(t));
    } },
    { name: 'business 3c: fields named like secrets are not echoed', run() {
        const api = load();
        api.components.schemas.Pet.properties.password = { type: 'string' };
        api.components.schemas.NewPet.properties.password = { type: 'string' };
        const cfg = on();
        const t = text(find(plan(cfg, api), /lifecycle/), cfg);
        assert.ok(!/password ==/.test(t));
    } },
    { name: 'business 3c: contract mode adds Content-Type and Location checks to the chain', run() {
        const api = load();
        api.paths['/pets'].post.responses['201'].headers = { Location: { required: true, schema: { type: 'string', format: 'uri' } } };
        const cfg = on({ responseChecks: 'contract' });
        const t = text(find(plan(cfg, api), /lifecycle/), cfg);
        assert.ok(/status 201\n\s+And match header Content-Type contains 'application\/json'\n\s+And match header Location == '#string'/.test(t), t.slice(0, 900));
        const basic = on();
        assert.ok(!/match header/.test(text(find(plan(basic, api), /lifecycle/), basic)));
    } },
    { name: 'business 3d: create then list contains the created id, with cleanup', run() {
        const cfg = on();
        const s = find(plan(cfg), /created item appears in the list/);
        assert.ok(s, 'present'); assert.equal(s.category, 'positive');
        const t = text(s, cfg);
        assert.ok(/def petId = response\.id/.test(t));
        assert.ok(/match karate\.jsonPath\(response, '\$\[\*\]\.id'\) contains petId/.test(t), t);
        assert.ok(/method delete[\s\S]*status 204/.test(t), 'cleanup');
        assert.ok(t.includes('@business'));
        assert.ok(/@lock=pets/.test(t));
        assert.ok(t.indexOf('method get') > t.indexOf('method post'));
    } },
    { name: 'business 3d: list wrapped in an object uses the array property; no list or no create means no scenario', run() {
        const cfg = on();
        const p = plan(cfg);
        const toy = find(p, /Toys - created item appears in the list/);
        assert.ok(toy, 'toys scenario');
        assert.ok(/match karate\.jsonPath\(response\.items, '\$\[\*\]\.toyId'\) contains toyId/.test(text(toy, cfg)));
        assert.ok(!/method delete/.test(text(toy, cfg)), 'no DELETE declared, so no cleanup');
        assert.ok(!find(p, /Owner/ ) || !/appears in the list/.test(find(p, /Owner/).name));
        const api = load(); delete api.paths['/pets'].get;
        assert.ok(!find(plan(cfg, api), /Pets - created item appears/));
        const api2 = load(); delete api2.paths['/pets'].post;
        assert.ok(!scenarios(plan(cfg, api2)).some(s => s.domain === 'pets' && (s.tags || []).includes('@business')));
    } },
    { name: 'business 3d: list items without the id are matched by a unique payload field', run() {
        const api = load();
        api.paths['/pets'].get.responses['200'].content['application/json'].schema = { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } };
        const cfg = on();
        const t = text(find(plan(cfg, api), /created item appears in the list/), cfg);
        assert.ok(/match karate\.jsonPath\(response, '\$\[\*\]\.name'\) contains payload\.name/.test(t), t);
        const gone = text(find(plan(cfg, api), /delete - item leaves the list/), cfg);
        assert.ok(/'\$\[\*\]\.name'\) !contains payload\.name/.test(gone), gone);
        api.paths['/pets'].get.responses['200'].content['application/json'].schema.items.properties = { color: { type: 'string' } };
        assert.ok(!find(plan(cfg, api), /Pets - created item appears in the list/), 'nothing identifies the item');
    } },
    { name: 'business 3d: delete then list no longer contains it and a repeat delete returns 404', run() {
        const cfg = on();
        const s = find(plan(cfg), /delete - item leaves the list/);
        assert.ok(s);
        const t = text(s, cfg);
        assert.ok(/status 204[\s\S]*match karate\.jsonPath\(response, '\$\[\*\]\.id'\) !contains petId/.test(t), t);
        assert.ok(/status 404/.test(t.slice(t.indexOf('!contains'))));
        // the list is optional, the 404 is optional, but one of them is needed
        const api = load(); delete api.paths['/pets/{petId}'].delete.responses['404'];
        const noRepeat = find(plan(cfg, api), /delete - item leaves the list/);
        assert.ok(noRepeat && !/repeat delete/.test(noRepeat.name));
        const api2 = load(); delete api2.paths['/pets'].get; 
        const noList = find(plan(cfg, api2), /repeat delete returns 404/);
        assert.ok(noList && !/!contains/.test(text(noList, cfg)));
        const api3 = load(); delete api3.paths['/pets'].get; delete api3.paths['/pets/{petId}'].delete.responses['404'];
        assert.ok(!scenarios(plan(cfg, api3)).some(x => /delete - /.test(x.name)));
    } },
    { name: 'business 3d: duplicate create returns 409 only when declared, with the same payload and cleanup', run() {
        const cfg = on();
        const s = find(plan(cfg), /duplicate create returns 409/);
        assert.ok(s); assert.equal(s.category, 'negative');
        const t = text(s, cfg);
        assert.equal((t.match(/method post/g) || []).length, 2);
        assert.equal((t.match(/def payload =/g) || []).length, 1, 'payload built once and sent twice');
        assert.equal((t.match(/request payload/g) || []).length, 2);
        assert.ok(/status 409/.test(t)); assert.ok(/match response\.message == '#string'/.test(t));
        assert.ok(/@negative/.test(t));
        const api = load(); delete api.paths['/pets'].post.responses['409'];
        assert.ok(!find(plan(cfg, api), /duplicate create/));
    } },
    { name: 'business 3d: PUT retry yields the same status and echoed body; only with a PUT and a chain', run() {
        const cfg = on();
        const s = find(plan(cfg), /repeating PUT/);
        assert.ok(s);
        const t = text(s, cfg);
        assert.equal((t.match(/method put/g) || []).length, 2);
        assert.equal((t.match(/status 200/g) || []).length, 2);
        assert.equal((t.match(/def updatePayload =/g) || []).length, 1);
        assert.ok((t.match(/match response\.name == updatePayload\.name/g) || []).length === 2);
        const api = load(); api.paths['/pets/{petId}'].patch = api.paths['/pets/{petId}'].put; delete api.paths['/pets/{petId}'].put;
        assert.ok(!find(plan(cfg, api), /repeating PUT/), 'PATCH is not retried');
        const api2 = load(); delete api2.paths['/pets/{petId}'].delete;
        assert.ok(!find(plan(cfg, api2), /repeating PUT/), 'no chain without a DELETE');
    } },
    { name: 'business 3d: DELETE retry is only emitted when 204 is declared and 404 is not', run() {
        const cfg = on();
        assert.ok(!find(plan(cfg), /repeating DELETE/), 'covered by the repeat-404 scenario');
        const api = load(); delete api.paths['/pets/{petId}'].delete.responses['404'];
        const s = find(plan(cfg, api), /repeating DELETE/);
        assert.ok(s);
        assert.equal((text(s, cfg).match(/status 204/g) || []).length, 2);
    } },
    { name: 'business 3d: negative bodies assert only the structure of string error fields', run() {
        const cfg = on();
        const p = plan(cfg);
        const bad = find(p, /rejects missing required field 'name' with 400/);
        const t = text(bad, cfg);
        assert.ok(/match response\.message == '#string'/.test(t));
        assert.ok(/match response\.code == '#string'/.test(t));
        assert.ok(!/response\.error ==/.test(t), 'integer field is not asserted as a string');
        assert.ok(!/Invalid pet/.test(t), 'no exact message text');
        const offCfg = config();
        assert.ok(!/response\.message == '#string'/.test(text(find(plan(offCfg), /rejects missing required field 'name' with 400/), offCfg)));
        // no error fields in the schema: nothing added
        const api = load(); api.components.schemas.Error = { type: 'object', properties: { detail: { type: 'object' } } };
        assert.ok(!/response\.(message|code|error) ==/.test(text(find(plan(cfg, api), /rejects missing required field 'name' with 400/), cfg)));
    } },
    { name: 'business 3d: standalone by-id scenarios create their resource instead of using id 1', run() {
        const cfg = on();
        const p = plan(cfg);
        for (const re of [/Get a pet - returns 200/, /Replace a pet - returns 200/]) {
            const s = find(p, re); assert.ok(s, String(re));
            const t = text(s, cfg);
            assert.ok(!/def petId = 1\b/.test(t), `${s.name} must not hardcode 1`);
            assert.ok(/def createPayload =/.test(t) && /def petId = response\.id/.test(t), s.name);
            assert.ok(!/Assumes a resource with this id exists/.test(t), s.name);
            assert.ok(/path 'pets', petId/.test(t));
            assert.equal(/method delete/.test(t), true);
        }
        // the delete op is the subject (standalone only without a full chain), so there is exactly one delete; get/put clean up with one
        const noPut = load(); delete noPut.paths['/pets/{petId}'].put;
        const del = text(find(plan(cfg, noPut), /Delete a pet - returns 204/), cfg);
        assert.equal((del.match(/method delete/g) || []).length, 1);
        assert.ok(/def petId = response\.id/.test(del) && !/def petId = 1\b/.test(del));
        assert.equal((text(find(p, /Get a pet - returns 200/), cfg).match(/method delete/g) || []).length, 1);
        // no create op for owners: id 1 and the existing comment stay
        const owner = text(find(p, /Get an owner - returns 200/), cfg);
        assert.ok(/def ownerId = 1/.test(owner) && /Assumes a resource with this id exists/.test(owner));
        // the 404 scenario keeps its unknown id
        assert.ok(/def petId = 999999999/.test(text(find(p, /Get a pet - returns 404 for an unknown id/), cfg)));
        // the action sub-path has a different path shape and keeps the sample id
        assert.ok(/def petId = 1\b/.test(text(find(p, /Approve a pet - returns 200/), cfg)));
    } },
    { name: 'business 3d: state transition draft for a >= 3 value status with an action path', run() {
        const cfg = on();
        const s = find(plan(cfg), /status transition/);
        assert.ok(s, 'present'); assert.ok(s.draftReason && !/TODO/.test(s.draftReason));
        const t = text(s, cfg);
        assert.ok(t.includes('@ignore')); assert.ok(!/TODO/.test(t));
        assert.ok(/available, pending, sold/.test(t)); assert.ok(/approve/.test(t));
        const api = load(); api.components.schemas.Pet.properties.status.enum = ['available', 'sold'];
        api.components.schemas.NewPet.properties.status.enum = ['available', 'sold'];
        assert.ok(!find(plan(cfg, api), /status transition/), 'two values is not enough');
        const api2 = load(); delete api2.paths['/pets/{petId}/approve'];
        const viaPut = scenarios(plan(cfg, api2)).filter(x => /status transition/.test(x.name));
        assert.equal(viaPut.length, 1, 'PUT carrying the state field is the only other trigger');
        assert.ok(/PUT \/pets\/\{petId\}/.test(viaPut[0].draftReason));
        delete api2.components.schemas.NewPet.properties.status;
        assert.ok(!find(plan(cfg, api2), /status transition/), 'no action path and no state in the PUT body');
    } },
    { name: 'business: scenario names are unique, deterministic and live in the crud file', run() {
        const cfg = on();
        const a = plan(cfg), b = plan(cfg);
        assert.equal(dump(a, cfg), dump(b, cfg));
        const names = scenarios(a).map(s => s.name);
        assert.equal(new Set(names).size, names.length);
        const crud = a.features.find(f => f.relativePath === 'pets/pets-crud.feature');
        assert.ok(crud && crud.featureKind === 'crud');
        const biz = scenarios(a).filter(s => (s.tags || []).includes('@business'));
        assert.ok(biz.length >= 5);
        for (const s of biz) {assert.ok(crud.feature.scenarios.includes(s) || a.features.some(f => f.featureKind === 'crud' && f.feature.scenarios.includes(s)), s.name);}
    } },
    { name: 'business: categories are respected', run() {
        const cfg = on({ categories: ['positive'] });
        const p = plan(cfg);
        assert.ok(!find(p, /duplicate create/));
        assert.ok(find(p, /appears in the list/));
        const cfg2 = on({ categories: ['negative'] });
        assert.ok(find(plan(cfg2), /duplicate create/));
        assert.ok(!find(plan(cfg2), /appears in the list/));
    } },
    { name: 'business: generated output passes the quality gate without errors', run() {
        const { runGate } = out('generation/quality/QualityGate');
        for (const responseChecks of ['basic', 'contract']) {
            const cfg = on({ responseChecks });
            const planned = plan(cfg);
            const known = new Set(planned.files.map(f => f.path));
            for (const [path, t] of Object.entries(render(planned, cfg))) {
                const { findings } = runGate(t, { knownFiles: known, config: cfg });
                const errors = findings.filter(f => f.severity === 'error');
                assert.deepEqual(errors, [], `${path}: ${JSON.stringify(errors)}`);
            }
        }
    } }
];
