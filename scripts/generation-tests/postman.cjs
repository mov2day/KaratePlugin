const fs = require('fs');
const assert = require('node:assert/strict');
const { fixture } = require('./support/golden.cjs');

const out = rel => require('../../out/' + rel);
const cfgMod = () => out('generation/config/GeneratorConfig');
const adapter = () => out('generation/adapters/postman');

const config = (over = {}) => {
    const base = JSON.parse(JSON.stringify(cfgMod().DEFAULT_GENERATOR_CONFIG));
    for (const [k, v] of Object.entries(over)) base[k] = { ...base[k], ...v };
    return base;
};
const readJson = (...p) => JSON.parse(fs.readFileSync(fixture('postman', ...p), 'utf8'));
const build = (collection = readJson('collection.json'), env = readJson('environment.json'), cfg = config()) =>
    adapter().buildPostmanModel(collection, env, { config: cfg, collectionName: collection.info.name });
const render = (built, cfg = config()) => built.features.map(f => ({
    path: f.relativePath,
    text: out('generation/render/FeatureRenderer').renderFeature(f.feature, { style: cfg.style })
}));
const allText = built => [...render(built).map(f => f.text), ...built.files.map(f => f.content)].join('\n=====\n');

const SECRET = 'SECRET-TOKEN-VALUE-123';
const testEvent = lines => ({ listen: 'test', script: { type: 'text/javascript', exec: lines } });
const req = (name, method, path, extra = {}, event) => ({
    name,
    ...(event ? { event: [event] } : {}),
    request: { method, header: [], url: { raw: `{{baseUrl}}${path}`, host: ['{{baseUrl}}'], path: path.split('/').filter(Boolean) }, ...extra }
});
const richCollection = (items, extra = {}) => ({
    info: { name: 'Rich API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    variable: [
        { key: 'baseUrl', value: 'https://api.internal.example/v2' },
        { key: 'authToken', value: SECRET },
        { key: 'userId', value: '42' },
        { key: 'region', value: 'eu' }
    ],
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{authToken}}' }] },
    item: items,
    ...extra
});

const gateAll = (built, cfg = config()) => {
    const { runGate } = out('generation/quality/QualityGate');
    const known = new Set(['common/auth.feature', 'common/utils.feature', ...built.files.map(f => f.path)]);
    return render(built, cfg).map(f => ({ path: f.path, gate: runGate(f.text, { knownFiles: known, config: cfg }) }));
};

const memFs = () => {
    const map = new Map();
    return {
        map,
        exists: p => map.has(p) || [...map.keys()].some(k => k.startsWith(p + '/')),
        read: p => { if (!map.has(p)) throw new Error('ENOENT ' + p); return map.get(p); },
        list: dir => [...new Set([...map.keys()].filter(k => k.startsWith(dir + '/')).map(k => k.slice(dir.length + 1).split('/')[0]))],
        write: (p, c) => { map.set(p, c); }
    };
};
const history = () => { const h = new Map(); return { get: p => h.get(p), set: (p, v) => { h.set(p, v); } }; };
const runFull = async (built, cfg = config()) => {
    const fsApi = memFs();
    const result = await out('generation/pipeline/GenerationPipeline').runPipeline({
        model: built.model, scenarios: built.features, extraFiles: built.files.map(f => ({ ...f, path: `src/test/java/${f.path}` })),
        config: cfg, project: { classpathRoot: 'src/test/java', envConfigs: [], hasEnvJson: false, runnerStyle: 'unknown' },
        fsApi, history: history(), generatorVersion: '9.9.9', sourceRef: 'collection.json', mode: 'postman'
    });
    return { fsApi, result };
};

module.exports = [
    {
        name: 'postman: {{baseUrl}} becomes model.baseUrl and never appears in features or data files',
        run() {
            const b = build();
            assert.equal(b.model.source, 'postman');
            assert.equal(b.model.baseUrl, 'http://localhost:8080/api/v1');
            const text = allText(b);
            assert.ok(!text.includes('localhost'), 'host leaked into features/data');
            assert.ok(!text.includes('8080'));
            for (const f of render(b)) assert.match(f.text, /\* url baseUrl\n/);
        }
    },
    {
        name: 'postman: collection variable is the base URL fallback when the environment lacks it',
        run() {
            const b = build(richCollection([req('Ping', 'GET', '/ping', {}, testEvent(['pm.response.to.have.status(200);']))]), null);
            assert.equal(b.model.baseUrl, 'https://api.internal.example/v2');
            assert.ok(!allText(b).includes('internal.example'));
        }
    },
    {
        name: 'postman: bearer auth maps to a model scheme, callonce auth helper, and no literal token',
        async run() {
            const b = build();
            assert.deepEqual(b.model.schemes.map(s => s.kind), ['bearer']);
            for (const f of render(b)) assert.match(f.text, /\* callonce read\('classpath:common\/auth\.feature'\)/);
            assert.ok(!allText(b).includes('test-token'));
            const { fsApi } = await runFull(b);
            const auth = fsApi.read('src/test/java/common/auth.feature');
            assert.match(auth, /configure auth = \{ type: 'bearer'/);
            const everything = [...fsApi.map.values()].join('\n');
            assert.ok(!everything.includes('test-token'));
        }
    },
    {
        name: 'postman: secret-looking variables become karate.sysenv defs and the value is never written',
        async run() {
            const coll = richCollection([
                req('Whoami', 'GET', '/me', { header: [{ key: 'X-Session', value: 'Bearer {{authToken}}' }] }, testEvent(['pm.response.to.have.status(200);'])),
                req('Login', 'POST', '/login', {
                    body: { mode: 'raw', raw: '{"user":"bob","password":"hunter2-literal","region":"{{region}}"}', options: { raw: { language: 'json' } } }
                }, testEvent(['pm.response.to.have.status(200);']))
            ]);
            const b = build(coll, null);
            const text = allText(b);
            assert.ok(!text.includes(SECRET));
            assert.ok(!text.includes('hunter2-literal'));
            assert.match(text, /\* def authToken = karate\.sysenv\('AUTH_TOKEN', ''\)/);
            assert.match(text, /'Bearer ' \+ authToken/);
            assert.match(text, /\* def vars = read\('classpath:data\/rich-api-variables\.json'\)/);
            const vars = JSON.parse(b.files.find(f => f.path === 'data/rich-api-variables.json').content);
            assert.deepEqual(Object.keys(vars), ['region']);
            assert.equal(vars.region, 'eu');
            assert.match(text, /#\(vars\.region\)/);
            const { fsApi } = await runFull(b);
            assert.ok(![...fsApi.map.values()].some(c => c.includes(SECRET) || c.includes('hunter2-literal')));
        }
    },
    {
        name: 'postman: non-secret variables go to the variables data file and are read via vars',
        run() {
            const coll = richCollection([req('Get user', 'GET', '/users/{{userId}}', {}, testEvent(['pm.response.to.have.status(200);']))]);
            const b = build(coll, null);
            const text = allText(b);
            assert.match(text, /path 'users', vars\.userId/);
            const vars = JSON.parse(b.files.find(f => f.path === 'data/rich-api-variables.json').content);
            assert.equal(vars.userId, '42');
            assert.ok(!('authToken' in vars) && !('baseUrl' in vars));
        }
    },
    {
        name: 'postman: folders become domain features and request order is preserved',
        run() {
            const coll = richCollection([
                { name: 'Pets', item: ['Zebra', 'Alpha', 'Mid'].map(n => req(n, 'GET', `/${n.toLowerCase()}`, {}, testEvent(['pm.response.to.have.status(200);']))) },
                { name: 'User Admin', item: [req('List', 'GET', '/admin', {}, testEvent(['pm.response.to.have.status(200);']))] }
            ]);
            const b = build(coll, null);
            assert.deepEqual(b.features.map(f => f.relativePath), ['pets/pets.feature', 'user-admin/user-admin.feature']);
            assert.deepEqual(b.features[0].feature.scenarios.map(s => s.name), ['Zebra', 'Alpha', 'Mid']);
            const flat = build(coll, null, config({ layout: { strategy: 'flat' } }));
            assert.deepEqual(flat.features.map(f => f.relativePath), ['rich-api.feature']);
            assert.deepEqual(flat.features[0].feature.scenarios.map(s => s.name), ['Pets > Zebra', 'Pets > Alpha', 'Pets > Mid', 'User Admin > List']);
        }
    },
    {
        name: 'postman: fixture test scripts convert to status, eql and type matches',
        run() {
            const b = build();
            const text = render(b).map(f => f.text).join('\n');
            assert.match(text, /Scenario: List pets[\s\S]*Then status 200\n\s+And match response == '#\[\]'/);
            assert.match(text, /Scenario: Create pet[\s\S]*Then status 201\n\s+And match response\.name == 'Buddy'/);
            assert.match(text, /# source: GET \/pets\n/);
            assert.match(text, /# source: POST \/pets\n/);
            assert.match(text, /And param limit = 5/);
            assert.match(text, /And header Accept = 'application\/json'/);
            const [list, create] = b.features[0].feature.scenarios;
            assert.deepEqual(list.tags, ['@positive']);
            assert.deepEqual(create.tags, ['@positive']);
            assert.deepEqual(b.unsupported, []);
        }
    },
    {
        name: 'postman: exists, collectionVariables.set and 4xx status are converted; 4xx is tagged negative',
        run() {
            const coll = richCollection([
                req('Create', 'POST', '/things', {}, testEvent([
                    'var data = pm.response.json();',
                    'pm.response.to.have.status(201);',
                    'pm.expect(data.id).to.exist;',
                    "pm.collectionVariables.set('thingId', data.id);"
                ])),
                req('Missing', 'GET', '/things/nope', {}, testEvent(['pm.response.to.have.status(404);']))
            ]);
            const b = build(coll, null);
            const text = render(b).map(f => f.text).join('\n');
            assert.match(text, /Then status 201\n\s+And match response\.id == '#present'\n\s+\* def thingId = response\.id/);
            const [create, missing] = b.features[0].feature.scenarios;
            assert.deepEqual(create.tags, ['@positive']);
            assert.deepEqual(missing.tags, ['@negative']);
        }
    },
    {
        name: 'postman: unsupported pm.sendRequest gives an unsupported entry and a visible comment, @ignore only when an assertion is lost',
        run() {
            const coll = richCollection([
                req('Keeps assertions', 'GET', '/a', {}, testEvent([
                    'pm.response.to.have.status(200);',
                    "pm.sendRequest('https://x.example/ping', function () {});"
                ])),
                req('Loses assertion', 'GET', '/b', {}, testEvent([
                    'pm.response.to.have.status(200);',
                    "pm.sendRequest('https://x.example/ping', function () {});",
                    'pm.expect(pm.response.json().items.length).to.be.above(0);'
                ]))
            ]);
            const b = build(coll, null);
            const [keeps, loses] = b.features[0].feature.scenarios;
            assert.ok((keeps.comments ?? []).some(c => c.startsWith('UNSUPPORTED (pm script): ')));
            assert.equal(keeps.draftReason, undefined);
            assert.ok(!(keeps.tags ?? []).includes('@ignore'));
            assert.ok(loses.draftReason !== undefined, 'lost assertion must draft the scenario');
            assert.ok((loses.comments ?? []).some(c => c.startsWith('UNSUPPORTED (pm script): ')));
            assert.equal(b.unsupported.length, 2);
            assert.ok(b.unsupported.every(u => /pm script/.test(u.reason) && u.sourceRef.startsWith('GET /')));
            const text = render(b).map(f => f.text).join('\n');
            assert.match(text, /# UNSUPPORTED \(pm script\): pm\.sendRequest/);
            assert.match(text, /@ignore @positive\n\s+Scenario: Loses assertion/);
            assert.ok(!/@ignore[^\n]*\n\s+Scenario: Keeps assertions/.test(text));
            assert.ok(!/\bTODO\b/.test(text));
        }
    },
    {
        name: 'postman: a request without a test script gets the honest status-range assertion',
        run() {
            const b = build(richCollection([req('Plain', 'GET', '/plain'), req('Scripted', 'GET', '/s', {}, testEvent(['pm.response.to.have.status(200);']))]), null);
            const [plain, scripted] = b.features[0].feature.scenarios;
            assert.ok(plain.steps.some(s => s.text === 'assert responseStatus < 400'));
            assert.ok(!plain.steps.some(s => /^status 200$/.test(s.text)));
            assert.ok(!scripted.steps.some(s => /assert responseStatus/.test(s.text)));
        }
    },
    {
        name: 'postman: noauth requests are marked security none and kept out of the authenticated feature',
        run() {
            const coll = richCollection([
                { name: 'Mixed', item: [
                    req('Secured', 'GET', '/s', {}, testEvent(['pm.response.to.have.status(200);'])),
                    req('Open', 'GET', '/o', { auth: { type: 'noauth' } }, testEvent(['pm.response.to.have.status(200);']))
                ] }
            ]);
            const b = build(coll, null);
            const op = n => b.model.operations.find(o => o.summary === n);
            assert.equal(op('Open').security, 'none');
            assert.deepEqual(op('Secured').security, ['bearer']);
            const text = Object.fromEntries(render(b).map(f => [f.path, f.text]));
            assert.match(text['mixed/mixed.feature'], /callonce read\('classpath:common\/auth\.feature'\)/);
            assert.ok(!text['mixed/mixed.feature'].includes('Scenario: Open'));
            assert.ok(!text['mixed/mixed-public.feature'].includes('callonce'));
            assert.match(text['mixed/mixed-public.feature'], /Scenario: Open/);
        }
    },
    {
        name: 'postman: basic, apikey and oauth2 client-credentials auth map to schemes',
        run() {
            const mk = auth => build(richCollection([req('A', 'GET', '/a', {}, testEvent(['pm.response.to.have.status(200);']))], { auth }), null);
            assert.deepEqual(mk({ type: 'basic', basic: [{ key: 'username', value: 'u' }, { key: 'password', value: 'p' }] }).model.schemes.map(s => s.kind), ['basic']);
            const key = mk({ type: 'apikey', apikey: [{ key: 'key', value: 'X-Key' }, { key: 'value', value: 'abcdef123456' }, { key: 'in', value: 'header' }] });
            assert.deepEqual(key.model.schemes.map(s => [s.kind, s.in, s.paramName]), [['apiKey', 'header', 'X-Key']]);
            assert.ok(!allText(key).includes('abcdef123456'));
            const oa = mk({ type: 'oauth2', oauth2: [{ key: 'grant_type', value: 'client_credentials' }, { key: 'accessTokenUrl', value: 'https://auth.example/token' }, { key: 'clientSecret', value: 'topsecret99' }] });
            assert.deepEqual(oa.model.schemes.map(s => [s.kind, s.flow, s.tokenUrl]), [['oauth2', 'clientCredentials', 'https://auth.example/token']]);
            assert.ok(!allText(oa).includes('topsecret99'));
        }
    },
    {
        name: 'postman: requests that consume a script-set variable are chained into the producer scenario',
        run() {
            const coll = richCollection([
                { name: 'Flow', item: [
                    req('Create', 'POST', '/things', {}, testEvent(['pm.response.to.have.status(201);', "pm.collectionVariables.set('thingId', pm.response.json().id);"])),
                    req('Fetch', 'GET', '/things/{{thingId}}', {}, testEvent(['pm.response.to.have.status(200);']))
                ] }
            ]);
            const b = build(coll, null);
            const scenarios = b.features[0].feature.scenarios;
            assert.equal(scenarios.length, 1);
            const text = render(b)[0].text;
            assert.match(text, /\* def thingId = response\.id[\s\S]*path 'things', thingId[\s\S]*Then status 200/);
            assert.ok(!('thingId' in JSON.parse((b.files[0] || { content: '{}' }).content)));
        }
    },
    {
        name: 'postman: a request to another host is drafted and the host is never written',
        run() {
            const other = { name: 'Other', request: { method: 'GET', url: { raw: 'https://other.example.com/x' } }, event: [testEvent(['pm.response.to.have.status(200);'])] };
            const b = build(richCollection([req('Main', 'GET', '/m', {}, testEvent(['pm.response.to.have.status(200);'])), other]), null);
            const s = b.features[0].feature.scenarios.find(x => x.name === 'Other');
            assert.ok(s.draftReason);
            assert.ok(!allText(b).includes('other.example.com'));
            assert.ok(b.unsupported.some(u => /host/.test(u.reason)));
        }
    },
    {
        name: 'postman: every produced feature passes the quality gate',
        run() {
            const rich = build(richCollection([
                { name: 'Pets', item: [
                    req('Get', 'GET', '/pets/{{userId}}', { header: [{ key: 'Authorization', value: 'Bearer {{authToken}}' }] }, testEvent(['pm.response.to.have.status(200);', "pm.expect(pm.response.json().name).to.eql('Rex');"])),
                    req('Plain', 'GET', '/plain'),
                    req('Sends', 'GET', '/send', {}, testEvent(['pm.response.to.have.status(200);', "pm.sendRequest('https://x.example', function () {});"]))
                ] }
            ]), null);
            for (const built of [build(), rich]) {
                for (const g of gateAll(built)) {
                    assert.deepEqual(g.gate.findings.filter(f => f.severity === 'error'), [], g.path);
                }
            }
        }
    },
    {
        name: 'postman: full pipeline with in-memory fs has zero gate errors and writes scaffold, data and features',
        async run() {
            const { fsApi, result } = await runFull(build());
            assert.equal(result.gate.errors, 0, JSON.stringify(result.features.map(f => f.findings)));
            assert.ok(fsApi.exists('src/test/karate/pets/pets.feature'));
            assert.ok(fsApi.exists('src/test/java/karate-config.js'));
            assert.ok(fsApi.exists('src/test/java/common/auth.feature'));
            assert.match(fsApi.read('src/test/java/karate-config.js'), /karate\.sysprop\('baseUrl', 'http:\/\/localhost:8080\/api\/v1'\)/);
            assert.ok(!fsApi.read('src/test/karate/pets/pets.feature').includes('localhost'));
            assert.equal(result.draftScenarios, 0);
        }
    },
    {
        name: 'postman: output is deterministic',
        run() {
            const a = build();
            const b = build();
            assert.equal(JSON.stringify(a), JSON.stringify(b));
        }
    },
    {
        name: 'postman fix: credential literals in pre-request and test scripts never reach output',
        run() {
            const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcDEF123_-xyz';
            const coll = richCollection([req('Scripts', 'GET', '/s', {}, null)]);
            coll.item[0].event = [
                { listen: 'prerequest', script: { exec: [
                    "pm.environment.set('apiKey', 'abc-LITERAL-123');",
                    "var password = 'pw-LITERAL-456';",
                    `pm.environment.set('session', '${JWT}');`,
                    "pm.environment.set('hdr', 'Bearer zzz-LITERAL-789');"
                ] } },
                testEvent(['pm.response.to.have.status(200);', "pm.collectionVariables.set('authToken', 'tok-LITERAL-000');"])
            ];
            const b = build(coll, null);
            const text = allText(b);
            for (const lit of ['abc-LITERAL-123', 'pw-LITERAL-456', JWT, 'zzz-LITERAL-789', 'tok-LITERAL-000']) assert.ok(!text.includes(lit), lit);
            assert.match(text, /\* def apiKey = karate\.sysenv\('API_KEY', ''\)/);
            assert.match(text, /\* def password = karate\.sysenv\('PASSWORD', ''\)/);
            assert.match(text, /\* def session = karate\.sysenv\('SESSION', ''\)/);
            assert.ok(b.warnings.some(w => /credential/.test(w)));
            assert.ok(!b.warnings.join('\n').includes('LITERAL'));
        }
    },
    {
        name: 'postman fix: raw JSON body with an unquoted variable is typed, parsed and secret-guarded',
        run() {
            const body = raw => ({ body: { mode: 'raw', raw, options: { raw: { language: 'json' } } } });
            const b = build(richCollection([req('Leak', 'POST', '/l', body('{"password":"hunter2","id":{{userId}},"tag":"a-{{region}}"}'), testEvent(['pm.response.to.have.status(200);']))]), null);
            const text = allText(b);
            assert.ok(!text.includes('hunter2'));
            assert.match(text, /"id": "#\(vars\.userId\)"/);
            assert.match(text, /"tag": "#\('a-' \+ vars\.region\)"/);
            assert.match(text, /"password": "#\(password\)"/);
            assert.match(text, /\* def password = karate\.sysenv\('PASSWORD', ''\)/);
            assert.ok(!/request '/.test(text));
        }
    },
    {
        name: 'postman fix: non-JSON raw body with a literal credential is drafted and the value is not written',
        run() {
            const b = build(richCollection([req('Text', 'POST', '/t', { body: { mode: 'raw', raw: 'user=bob\npassword: hunter3\nid={{userId}}' } }, testEvent(['pm.response.to.have.status(200);']))]), null);
            const text = allText(b);
            assert.ok(!text.includes('hunter3'));
            const s = b.features[0].feature.scenarios[0];
            assert.ok(s.draftReason && /credential/.test(s.draftReason));
            assert.ok(!/request '.*#\(/.test(text));
            assert.match(text, /# Body omitted: contains credential-like fields/);
        }
    },
    {
        name: 'postman fix: Postman/console API calls in script values are unsupported, not active steps',
        run() {
            const coll = richCollection([req('Pre', 'GET', '/p', {}, null)]);
            coll.item[0].event = [
                { listen: 'prerequest', script: { exec: ["pm.environment.set('ts', pm.variables.get('a') + 1);"] } },
                testEvent(['pm.response.to.have.status(200);'])
            ];
            const b = build(coll, null);
            const s = b.features[0].feature.scenarios[0];
            assert.ok(!s.steps.some(x => /\bpm\./.test(x.text)));
            assert.ok((s.comments ?? []).some(c => c.startsWith('UNSUPPORTED (pm script): ')));
            assert.equal(b.unsupported.length, 1);
        }
    },
    {
        name: 'postman fix: only a lost assertion drafts; converted-but-statusless and producer-only scripts stay active',
        run() {
            const coll = richCollection([
                req('Body only', 'GET', '/a', {}, testEvent(["pm.expect(pm.response.json().id).to.be.a('number');"])),
                req('Producer', 'POST', '/b', {}, testEvent(["pm.environment.set('x', '1');"])),
                req('Lost', 'GET', '/c', {}, testEvent(['pm.expect(pm.response.json().n).to.be.above(1);']))
            ]);
            const [bodyOnly, producer, lost] = build(coll, null).features[0].feature.scenarios;
            for (const s of [bodyOnly, producer]) {
                assert.equal(s.draftReason, undefined, s.name);
                assert.ok(s.steps.some(x => x.text === 'assert responseStatus < 400'), s.name);
            }
            assert.ok(bodyOnly.steps.some(x => x.text === "match response.id == '#number'"));
            assert.ok(lost.draftReason);
        }
    },
    {
        name: 'postman fix: in a merged chain only a lost assertion drafts the scenario, and the merge is reported',
        run() {
            const mk = test2 => build(richCollection([{ name: 'F', item: [
                req('Create', 'POST', '/t', {}, testEvent(['pm.response.to.have.status(201);', "pm.collectionVariables.set('tid', pm.response.json().id);"])),
                req('Fetch', 'GET', '/t/{{tid}}', {}, testEvent(test2))
            ] }]), null);
            const ok = mk(["pm.expect(pm.response.json().id).to.exist;"]);
            assert.equal(ok.features[0].feature.scenarios[0].draftReason, undefined);
            assert.ok(ok.warnings.some(w => /Merged into one scenario/.test(w) && /Create, Fetch/.test(w)));
            const bad = mk(['pm.expect(pm.response.json().n).to.be.above(1);']);
            assert.ok(bad.features[0].feature.scenarios[0].draftReason);
        }
    },
    {
        name: 'postman fix: accented and non-Latin folders get distinct features and stable names',
        run() {
            const { slug } = out('generation/plan/slug');
            assert.equal(slug('Édge API'), 'edge-api');
            assert.equal(slug('---'), '');
            assert.match(slug('日本'), /^folder-[0-9a-f]{6}$/);
            assert.notEqual(slug('日本'), slug('中国'));
            assert.equal(slug('日本'), slug('日本'));
            const coll = richCollection([
                { name: '日本', item: [req('A', 'GET', '/a', {}, testEvent(['pm.response.to.have.status(200);']))] },
                { name: '中国', item: [req('A', 'GET', '/b', {}, testEvent(['pm.response.to.have.status(200);']))] },
                { name: 'Fld one', item: [req('A', 'GET', '/c', {}, testEvent(['pm.response.to.have.status(200);']))] },
                { name: 'fld-one', item: [req('A', 'GET', '/d', {}, testEvent(['pm.response.to.have.status(200);']))] }
            ]);
            coll.info.name = 'Édge API';
            const b = adapter().buildPostmanModel(coll, null, { config: config(), collectionName: 'Édge API' });
            assert.equal(b.features.length, 4);
            assert.equal(new Set(b.features.map(f => f.relativePath)).size, 4);
            assert.ok(b.features.some(f => f.relativePath === 'fld-one/fld-one.feature') && b.features.some(f => f.relativePath === 'fld-one/fld-one-2.feature'));
            const withVars = adapter().buildPostmanModel(richCollection([{ name: 'X', item: [req('G', 'GET', '/u/{{userId}}', {}, testEvent(['pm.response.to.have.status(200);']))] }]), null, { config: config(), collectionName: 'Édge API' });
            assert.equal(withVars.files[0].path, 'data/edge-api-variables.json');
        }
    },
    {
        name: 'postman fix: dependency on two chains warns; an unvalued second host variable drafts instead of using the base URL; cheap warnings',
        run() {
            const coll = richCollection([{ name: 'F', item: [
                req('P1', 'POST', '/1', {}, testEvent(['pm.response.to.have.status(201);', "pm.environment.set('a', pm.response.json().a);"])),
                req('Mid', 'GET', '/m', {}, testEvent(['pm.response.to.have.status(200);'])),
                req('P2', 'POST', '/2', {}, testEvent(['pm.response.to.have.status(201);', "pm.environment.set('b', pm.response.json().b);"])),
                req('Both', 'GET', '/x/{{a}}/{{b}}', {}, testEvent(["pm.test('t', function () {", 'pm.response.to.have.status(200);', '});'])),
                { name: 'Other host', request: { method: 'GET', url: { raw: '{{otherHost}}/q' } }, event: [testEvent(['pm.response.to.have.status(200);'])] }
            ] }]);
            const b = build(coll, null);
            assert.ok(b.warnings.some(w => /more than one earlier request/.test(w)));
            assert.ok(b.warnings.some(w => /1 pm\.test block\(s\) were flattened/.test(w)));
            const other = b.features[0].feature.scenarios.find(s => s.name === 'Other host');
            assert.ok(other.draftReason && /otherHost/.test(other.draftReason));
            assert.ok(!other.steps.some(s => /^url /.test(s.text)));
        }
    },
    {
        name: 'postman fix: pre-request uuid detection is word-bounded',
        run() {
            const { convertPreRequestScript } = out('generation/adapters/postmanScript');
            assert.match(convertPreRequestScript('var id = uuid();'), /randomUUID|\* def id/);
            assert.ok(!/randomId/.test(convertPreRequestScript("var x = 'Duuidx';") ?? ''));
        }
    },
    {
        name: 'postman fail-safe: raw bodies with credential-like fields are omitted and drafted, never rewritten',
        run() {
            const { renderFeature } = out('generation/render/FeatureRenderer');
            const LITS = ['hunter2', 'k-lit-5', 'tt-lit-1', 's3cr3t-lit'];
            const cases = [
                ['<x><password>hunter2</password></x>', 'password'],
                ['<apiKey>k-lit-5</apiKey>', 'apikey'],
                ['{"password":"hunter2", // c\n "a":1}', 'password'],
                ['{"user":"x","token":"tt-lit-1"', 'token'],
                ['{"password":"hunter2","id":{{userId}}', 'password'],
                ['password=hunter2&a=1', 'password'],
                ['client_secret: "s3cr3t-lit"\nid=1', 'secret'],
                ['<a apiKey="k-lit-5"/>', 'apikey']
            ];
            for (const [raw, key] of cases) {
                const b = build(richCollection([req('Body', 'POST', '/b', { body: { mode: 'raw', raw } }, testEvent(['pm.response.to.have.status(200);']))]), null);
                const everything = [allText(b), b.warnings.join('\n'), JSON.stringify(b.unsupported), JSON.stringify(b.model)].join('\n');
                for (const lit of LITS) assert.ok(!everything.includes(lit), `${lit} leaked for ${JSON.stringify(raw)}`);
                const s = b.features[0].feature.scenarios[0];
                assert.ok(s.draftReason && s.draftReason.includes(key), `not drafted with key for ${JSON.stringify(raw)}: ${s.draftReason}`);
                assert.ok(!s.steps.some(x => x.text.startsWith('request')), 'body step must be omitted');
                assert.ok((s.comments ?? []).includes('Body omitted: contains credential-like fields'));
                const text = render(b)[0].text;
                assert.match(text, /# Body omitted: contains credential-like fields/);
                for (const g of gateAll(b)) assert.deepEqual(g.gate.findings.filter(f => f.severity === 'error'), [], g.path);
                void renderFeature;
            }
        }
    },
    {
        name: 'postman fail-safe: plain text and XML bodies without credential keys stay active and intact',
        run() {
            const mk = raw => build(richCollection([req('Text', 'POST', '/t', { body: { mode: 'raw', raw } }, testEvent(['pm.response.to.have.status(200);']))]), null);
            const xml = mk('<order><id>{{userId}}</id><qty>2</qty></order>');
            const s = xml.features[0].feature.scenarios[0];
            assert.equal(s.draftReason, undefined);
            const step = s.steps.find(x => x.text === 'request');
            assert.equal(step.docString, '<order><id>#(vars.userId)</id><qty>2</qty></order>');
            const broken = mk('{"a":1,"id":{{userId}}');
            assert.equal(broken.features[0].feature.scenarios[0].draftReason, undefined);
            assert.equal(broken.features[0].feature.scenarios[0].steps.find(x => x.text === 'request').docString, '{"a":1,"id":#(vars.userId)');
            const refOnly = mk('{"password":"{{userId}}","a":1');
            assert.equal(refOnly.features[0].feature.scenarios[0].draftReason, undefined);
        }
    }
];
