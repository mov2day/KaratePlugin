const fs = require('fs');
const yaml = require('js-yaml');
const assert = require('node:assert/strict');
const { fixture } = require('./support/golden.cjs');

const out = rel => require('../../out/' + rel);
const cfg = () => out('generation/config/GeneratorConfig').DEFAULT_GENERATOR_CONFIG;
const adapter = () => out('generation/adapters/requirements');
const render = () => out('generation/render/FeatureRenderer');
const gate = () => out('generation/quality/QualityGate');

const petModel = () => out('generation/adapters/openapi').buildOpenApiModel(yaml.load(fs.readFileSync(fixture('openapi', 'petstore-secured.yaml'), 'utf8')), 'petstore');
const ordersApi = {
    openapi: '3.0.0',
    paths: {
        '/orders': { post: { operationId: 'createOrder', summary: 'Create an order', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['sku', 'quantity'], properties: { sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } } } } } }, responses: { '201': { description: 'created' }, '400': { description: 'bad' } } } },
        '/orders/{id}': { get: { operationId: 'getOrder', summary: 'Get an order', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok' }, '404': { description: 'nf' } } } }
    }
};
const ordersModel = () => out('generation/adapters/openapi').buildOpenApiModel(ordersApi, 'orders');

const build = (items, model) => adapter().buildRequirementScenarios(items, { config: cfg(), name: 'shop', model });
const text = b => b.features.map(f => render().renderFeature(f.feature, { style: cfg().style })).join('\n');
const known = b => new Set(['common/auth.feature', ...b.files.map(f => f.path)]);
const errors = (t, b) => gate().runGate(t, { knownFiles: known(b), config: cfg() }).findings.filter(f => f.severity === 'error');
const scenarios = b => b.features.flatMap(f => f.feature.scenarios);
const find = (b, re) => scenarios(b).find(s => re.test(s.name));

function memFs() {
    const map = new Map();
    return {
        map,
        exists: p => map.has(p) || [...map.keys()].some(k => k.startsWith(p + '/')),
        read: p => { if (!map.has(p)) throw new Error('ENOENT ' + p); return map.get(p); },
        list: dir => [...new Set([...map.keys()].filter(k => k.startsWith(dir + '/')).map(k => k.slice(dir.length + 1).split('/')[0]))],
        write: (p, c) => { map.set(p, c); }
    };
}
const project = { classpathRoot: 'src/test/java', envConfigs: [], hasEnvJson: false, runnerStyle: 'unknown' };
const hist = () => { const h = new Map(); return { get: p => h.get(p), set: (p, v) => { h.set(p, v); } }; };
const runPipelineFor = (items, model, mode, over = {}) => {
    const b = build(items, model);
    const fsApi = memFs();
    return out('generation/pipeline/GenerationPipeline').runPipeline({
        model: model ?? { source: mode, name: 'shop', schemes: [], operations: [], unsupported: [] },
        scenarios: b.features, extraFiles: b.files.map(f => ({ path: `src/test/java/${f.path}`, content: f.content, owner: 'user' })),
        config: cfg(), project, fsApi, history: hist(), generatorVersion: '9.9.9', sourceRef: 'SHOP', mode, ...over
    }).then(r => ({ r, fsApi, b }));
};

module.exports = [
    { name: 'requirements: without a contract every criterion is an @ignore draft with the reason and no live step', run() {
        const b = build([{ id: 'SHOP-101', title: 'Orders', criteria: ['POST /orders returns 201', 'Quantity of zero is rejected'] }]);
        assert.equal(b.features.length, 1);
        assert.equal(b.features[0].relativePath, 'shop/shop-requirements.feature');
        const t = text(b);
        assert.equal((t.match(/@ignore/g) || []).length, 2);
        assert.equal((t.match(/Draft: No API contract linked; select an OpenAPI spec or enable AI refinement/g) || []).length, 2);
        assert.match(t, /@req=SHOP-101/);
        assert.match(t, /# Criterion: POST \/orders returns 201/);
        assert.match(t, /# source: SHOP-101/);
        assert.doesNotMatch(t, /^\s*(\*|Given|When|Then|And)\s+(method|status|path|param|header|request)\b/m);
        for (const s of scenarios(b)) assert.deepEqual(s.steps, []);
        assert.doesNotMatch(t, /TODO|method get/);
        assert.deepEqual(errors(t, b), []);
    } },
    { name: 'requirements: creating a pet returns 201 maps to POST /pets with status 201', run() {
        const b = build([{ id: 'PET-1', title: 'Pets', criteria: ['creating a pet returns 201'] }], petModel());
        const s = find(b, /creating a pet/);
        assert.equal(s.draftReason, undefined, s.draftReason);
        const t = text(b);
        assert.match(t, /method post/);
        assert.match(t, /status 201/);
        assert.match(t, /path 'pets'/);
        assert.match(t, /@req=PET-1/);
        assert.deepEqual(errors(t, b), []);
    } },
    { name: 'requirements: an unknown pet returns 404 maps to GET /pets/{petId} with status 404', run() {
        const b = build([{ id: 'PET-1', title: 'Pets', criteria: ['requesting an unknown pet returns 404'] }], petModel());
        const s = find(b, /unknown pet/);
        assert.equal(s.draftReason, undefined, s.draftReason);
        const t = text(b);
        assert.match(t, /method get/);
        assert.match(t, /status 404/);
        assert.match(t, /petId/);
        assert.deepEqual(errors(t, b), []);
    } },
    { name: 'requirements: an undeclared status is drafted with the reason, not asserted', run() {
        const b = build([{ id: 'PET-1', title: 'Pets', criteria: ['creating a pet returns 418'] }], petModel());
        const s = find(b, /418/);
        assert.match(s.draftReason, /Status 418 is not declared by POST \/pets/);
        assert.deepEqual(s.steps, []);
        assert.doesNotMatch(text(b), /status 418/);
        assert.deepEqual(errors(text(b), b), []);
    } },
    { name: 'requirements: ambiguous criteria are drafted and list the candidates', run() {
        const model = out('generation/adapters/openapi').buildOpenApiModel({ openapi: '3.0.0', paths: {
            '/cats': { get: { operationId: 'listCats', responses: { '200': { description: 'ok' } } } },
            '/dogs': { get: { operationId: 'listDogs', responses: { '200': { description: 'ok' } } } }
        } }, 'amb');
        const b = build([{ id: 'A-1', title: 'x', criteria: ['Cats and dogs are shown'] }], model);
        const s = scenarios(b)[0];
        assert.match(s.draftReason, /Ambiguous match; candidates: GET \/cats, GET \/dogs/);
        assert.deepEqual(s.steps, []);
        assert.deepEqual(b.unmatched, ['A-1: Cats and dogs are shown']);
    } },
    { name: 'requirements: unmatched criteria are drafts; an explicit path outside the contract never falls back to a fuzzy match', run() {
        const b = build([{ id: 'X-1', title: 't', criteria: ['The moon phase is displayed', 'POST /galaxies returns 201'] }], petModel());
        const [a, c] = scenarios(b);
        assert.match(a.draftReason, /No operation in the linked contract matches/);
        assert.match(c.draftReason, /POST \/galaxies is not in the linked contract/);
        assert.equal(b.unmatched.length, 2);
        assert.deepEqual(errors(text(b), b), []);
    } },
    { name: 'requirements: duplicate criteria names are de-duplicated and @req tags sanitised', run() {
        const b = build([{ id: 'My Key/9', title: 't', criteria: ['Same thing', 'Same thing', 'Same thing'] }]);
        assert.deepEqual(scenarios(b).map(s => s.name), ['Same thing', 'Same thing (2)', 'Same thing (3)']);
        assert.ok(scenarios(b).every(s => s.tags.includes('@req=My_Key_9')), JSON.stringify(scenarios(b)[0].tags));
        assert.deepEqual(errors(text(b), b), []);
    } },
    { name: 'requirements: category tag follows the config for matched and drafted scenarios', run() {
        const b = build([{ id: 'PET-1', title: 'Pets', criteria: ['requesting an unknown pet returns 404', 'Something unrelated entirely'] }], petModel());
        const taxonomy = cfg().tags.taxonomy;
        assert.ok(find(b, /unknown pet/).tags.includes(taxonomy.negative.startsWith('@') ? taxonomy.negative : `@${taxonomy.negative}`));
        assert.ok(find(b, /unrelated/).tags.includes(taxonomy.positive.startsWith('@') ? taxonomy.positive : `@${taxonomy.positive}`));
    } },
    { name: 'requirements: jira fixture through the parser, drafted without a contract and mapped with one', run() {
        const { JiraParser } = out('services/jira/JiraParser');
        const issues = JSON.parse(fs.readFileSync(fixture('jira', 'issues.json'), 'utf8')).issues;
        const contents = issues.map(i => new JiraParser().parse(i));
        const items = adapter().jiraRequirementItems(contents);
        assert.deepEqual(items.map(i => i.id), ['SHOP-101', 'SHOP-102']);
        assert.equal(items[0].criteria.length, 2);
        const drafted = build(items);
        assert.equal(scenarios(drafted).length, 4);
        assert.ok(scenarios(drafted).every(s => s.draftReason));
        assert.deepEqual(errors(text(drafted), drafted), []);

        const linked = build(items, ordersModel());
        const t = text(linked);
        const byName = re => find(linked, re);
        assert.equal(byName(/201 with an order id/).draftReason, undefined, byName(/201 with an order id/).draftReason);
        assert.equal(byName(/quantity of zero/).draftReason, undefined);
        assert.equal(byName(/existing order id/).draftReason, undefined);
        assert.equal(byName(/unknown order id/).draftReason, undefined);
        for (const code of ['201', '400', '200', '404']) assert.match(t, new RegExp(`status ${code}`));
        assert.match(t, /# Contract case: rejects missing required field/);
        assert.match(t, /@req=SHOP-102/);
        assert.deepEqual(errors(t, linked), []);
        assert.equal(linked.unmatched.length, 0);
    } },
    { name: 'requirements: confluence fixture keeps steps and expected results as comments only', run() {
        const { ConfluenceParser } = out('services/confluenceParser');
        const page = JSON.parse(fs.readFileSync(fixture('confluence', 'page.json'), 'utf8'));
        const data = new ConfluenceParser().parsePageContent(page);
        const items = adapter().confluenceRequirementItems(page, data);
        assert.equal(items.length, 1);
        assert.equal(items[0].id, '12345');
        const b = build(items);
        const t = text(b);
        if (data.testCases.length > 0) {
            assert.match(t, /# Step 1:/);
            assert.ok(scenarios(b).every(s => s.draftReason && s.steps.length === 0));
        }
        assert.equal(data.testCases.length, 2);
        assert.match(t, /# Step 1: POST \/orders with sku ABC-1 and quantity 2/);
        assert.match(t, /# Expected: Expect status 201/);
        const linked = build(items, ordersModel());
        const lt = text(linked);
        assert.ok(scenarios(linked).every(s => !s.draftReason), scenarios(linked).map(s => s.draftReason).join('|'));
        assert.match(lt, /status 201/);
        assert.match(lt, /status 400/);
        assert.deepEqual(errors(lt, linked), []);
        assert.doesNotMatch(t, /method get|TODO/);
        assert.match(t, /@req=12345/);
        assert.deepEqual(errors(t, b), []);
        // flow-only pages and requirement lists still become drafts
        const flow = adapter().confluenceRequirementItems({ id: '9', title: 'Flow' }, { testCases: [], flowSteps: ['Open', 'Pay'], requirements: [] });
        assert.deepEqual(flow[0].criteria, [{ text: 'Flow from Confluence', steps: ['Open', 'Pay'] }]);
        const reqs = adapter().confluenceRequirementItems({ id: '9', title: 'R' }, { testCases: [], flowSteps: [], requirements: ['Must be fast'] });
        assert.deepEqual(reqs[0].criteria, ['Must be fast']);
    } },
    { name: 'requirements: credentials in criteria never reach a feature and are warned about', run() {
        const items = [{ id: 'SEC-1', title: 'Login with password: hunter2', criteria: [
            'Login with password: hunter2 returns 200',
            'Call with Authorization: Bearer eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl succeeds',
            'Use api_key=abcd1234efgh and token: "tok-9876543210" on https://secret.internal.example.com/orders',
            { text: 'Basic auth', steps: ['Send Basic dXNlcjpwYXNzd29yZA== header'], expected: 'client_secret: s3cr3t-value accepted' }
        ] }];
        for (const model of [undefined, ordersModel()]) {
            const b = build(items, model);
            const t = text(b);
            for (const leak of ['hunter2', 'eyJhbGci', 'abcd1234efgh', 'tok-9876543210', 'dXNlcjpw', 's3cr3t-value', 'secret.internal.example.com']) assert.ok(!t.includes(leak), `leaked ${leak}`);
            assert.match(t, /\[redacted\]/);
            assert.ok(b.warnings.some(w => /SEC-1.*\[redacted\]/.test(w)), b.warnings.join(';'));
            assert.ok(!b.warnings.join('\n').includes('hunter2'));
            assert.deepEqual(errors(t, b), []);
        }
    } },
    { name: 'requirements: output is deterministic and contract-linked features pass the gate with their data files', run() {
        const items = [{ id: 'PET-1', title: 'Pets', criteria: ['creating a pet returns 201', 'requesting an unknown pet returns 404', 'listing all pets returns 200', 'deleting a pet returns 204'] }];
        const a = build(items, petModel());
        const b = build(items, petModel());
        assert.equal(text(a), text(b));
        assert.deepEqual(a.files, b.files);
        assert.ok(a.files.every(f => f.path.startsWith('data/requirements/')), a.files.map(f => f.path).join(','));
        assert.match(text(a), /callonce read\('classpath:common\/auth.feature'\)/);
        assert.deepEqual(errors(text(a), a), []);
        assert.ok(scenarios(a).length === 4);
    } },
    { name: 'requirements: an empty contract or no criteria degrade honestly', run() {
        const empty = adapter().buildRequirementScenarios([{ id: 'E-1', title: 't', criteria: ['x does y'] }], { config: cfg(), name: 'e', model: { source: 'openapi', name: 'e', schemes: [], operations: [], unsupported: [] } });
        assert.ok(scenarios(empty)[0].draftReason.startsWith('No API contract linked'));
        assert.ok(empty.warnings.some(w => /no operations/.test(w)));
        const none = build([{ id: 'E-2', title: 't', criteria: [] }]);
        assert.deepEqual(none.features, []);
        assert.ok(none.warnings.some(w => /E-2: no acceptance criteria/.test(w)));
    } },
    { name: 'requirements: the adapter stays pure (no vscode or logger)', run() {
        const src = fs.readFileSync(require('path').join(__dirname, '../../src/generation/adapters/requirements.ts'), 'utf8');
        assert.doesNotMatch(src, /from 'vscode'|utils\/logger/);
    } },
    { name: 'requirements: pipeline run without a contract writes only drafts, zero gate errors (jira and confluence modes)', async run() {
        for (const mode of ['jira', 'confluence']) {
            const { r, fsApi } = await runPipelineFor([{ id: 'SHOP-101', title: 'Orders', criteria: ['POST /orders returns 201', 'Quantity zero returns 400'] }], undefined, mode);
            assert.equal(r.gate.errors, 0, JSON.stringify(r.features.map(f => f.findings)));
            assert.equal(r.draftScenarios, 2);
            const file = [...fsApi.map.keys()].find(k => k.endsWith('shop-requirements.feature'));
            assert.ok(file, [...fsApi.map.keys()].join(','));
            assert.doesNotMatch(fsApi.map.get(file), /method |status \d/);
        }
    } },
    { name: 'requirements: pipeline run with a contract writes runnable scenarios plus their data file, zero gate errors', async run() {
        const { r, fsApi } = await runPipelineFor([{ id: 'PET-1', title: 'Pets', criteria: ['creating a pet returns 201', 'requesting an unknown pet returns 404', 'Pets glow at night'] }], petModel(), 'jira');
        assert.equal(r.gate.errors, 0, JSON.stringify(r.features.map(f => f.findings)));
        assert.equal(r.draftScenarios, 1);
        assert.ok(fsApi.map.has('src/test/java/data/requirements/pets.json'));
        assert.ok(fsApi.map.has('src/test/java/common/auth.feature'));
    } },
    { name: 'requirements: AI refinement receives criteria evidence, and ungated output is discarded for the deterministic draft', async run() {
        const prompts = [];
        const bad = "Feature: x\n  Background:\n    * url 'http://evil.example.com'\n  Scenario: x\n    Given path 'a'\n    When method get\n    Then status 200\n";
        const { r, fsApi } = await runPipelineFor([{ id: 'SHOP-101', title: 'Orders', criteria: ['Orders can be listed password: hunter2'] }], undefined, 'jira', {
            ai: async p => { prompts.push(p.user); return bad; },
            evidence: [{ label: 'jira-acceptance-criteria', text: 'SHOP-101 Orders can be listed [redacted]' }]
        });
        assert.ok(prompts.length >= 1);
        assert.ok(prompts.every(p => !p.includes('hunter2')));
        assert.match(prompts[0], /SHOP-101 Orders can be listed/);
        assert.equal(r.gate.errors, 0);
        const file = [...fsApi.map.keys()].find(k => k.endsWith('shop-requirements.feature'));
        assert.doesNotMatch(fsApi.map.get(file), /evil\.example/);
        assert.match(fsApi.map.get(file), /@ignore/);
    } },
    { name: 'requirements: multi-operation criteria are drafted naming a candidate per verb group', run() {
        const b = build([{ id: 'P-1', title: 't', criteria: ['create a pet and then delete it', 'Creating a pet returns 201', 'Deleting a pet removes it'] }], petModel());
        const [multi, create, del] = scenarios(b);
        assert.ok(/POST \/pets[,)]/.test(multi.draftReason) && /DELETE \/pets\/\{petId\}/.test(multi.draftReason));
        assert.match(multi.draftReason, /^Criterion spans several operations \(.*\); split it into one criterion per operation or enable AI refinement$/);
        assert.deepEqual(multi.steps, []);
        assert.equal(create.draftReason, undefined, create.draftReason);
        assert.equal(del.draftReason, undefined, del.draftReason);
        assert.match(text(b), /method delete/);
        assert.deepEqual(errors(text(b), b), []);
    } },
    { name: 'requirements: add/adding/adds/added map to POST /pets, never to another operation', run() {
        for (const text of ['Adding a pet with an invalid body is a bad request', 'A user adds a pet', 'The pet was added']) {
            const s = scenarios(build([{ id: 'P-1', title: 't', criteria: [text] }], petModel()))[0];
            const evidence = `${(s.comments || []).join('|')}|${s.draftReason ?? ''}`;
            assert.match(evidence, /POST \/pets/, `${text}: ${evidence}`);
            assert.doesNotMatch(evidence, /GET \/pets/, text);
            assert.doesNotMatch(s.draftReason ?? '', /Ambiguous|No operation|spans/, text);
        }
    } },
    { name: 'requirements: two different operations in one verb group are drafted in sentence order; one operation stays live', run() {
        const b = build([{ id: 'P-1', title: 't', criteria: [
            'Listing pets and fetching a pet by id', 'Listing pets and returning 200', 'create a pet and then delete it', "update the pet's status then return 200"
        ] }], petModel());
        const [a, same, cd, upd] = scenarios(b);
        assert.equal(a.draftReason, 'Criterion spans several operations (GET /pets, GET /pets/{petId}); split it into one criterion per operation or enable AI refinement');
        assert.equal(same.draftReason, undefined, same.draftReason);
        assert.match(cd.draftReason, /^Criterion spans several operations \(POST \/pets, DELETE \/pets\/\{petId\}\)/);
        assert.equal(upd.draftReason, undefined, upd.draftReason);
        assert.match((upd.comments || []).join('|'), /Operation: PUT \/pets\/\{petId\}/);
        assert.deepEqual(errors(text(b), b), []);
    } },
    { name: 'requirements: login cues redact slash pairs; weakening the cue list would fail; read/write stays', run() {
        const secrets = require('../../out/generation/adapters/secrets');
        for (const [input, leak] of [['Login as admin/hunter2', 'hunter2'], ['Sign in as bob/s3cret', 's3cret'], ['logged in as ann/pw1', 'pw1'],
            ['authenticated as carl/pw3', 'pw3'], ['signed in as dan/pw4', 'pw4'], ['log in as fay/pw5', 'pw5'], ['Log into the app as x/y1', 'y1']]) {
            const r = secrets.redactCredentialText(input);
            assert.ok(!r.text.includes(leak), `${input} -> ${r.text}`);
        }
        assert.equal(secrets.redactCredentialText('read/write access').text, 'read/write access');
    } },
    { name: 'requirements: redaction and detectors stay linear (<150 ms) on adversarial input; long text is truncated with a marker', run() {
        const secrets = require('../../out/generation/adapters/secrets');
        const inputs = { word: 'a'.repeat(20000), colon: 'a:'.repeat(10000), pw: ' password '.repeat(2000), slash: 'x/'.repeat(10000), pweq: 'password='.repeat(2000),
            at: 'a@'.repeat(10000), bearer: 'Bearer '.repeat(3000), wordeq: 'w'.repeat(20000) + '=',
            ltPw: '<password'.repeat(10000), ltTok: '<token '.repeat(20000), ltA: '<a '.repeat(30000), ltPwGt: '<password>'.repeat(10000), pwQuote: 'password"'.repeat(10000), eqQuote: '="'.repeat(20000) };
        for (const k of Object.keys(inputs)) inputs[`${k}1M`] = inputs[k].repeat(Math.ceil(1e6 / inputs[k].length)).slice(0, 1e6);
        const fns = { redactCredentialText: secrets.redactCredentialText, credentialKeys: secrets.credentialKeys, containsCredentialValue: secrets.containsCredentialValue,
            redactUrl: secrets.redactUrl, looksLikeCredentialValue: secrets.looksLikeCredentialValue, isSecretKey: secrets.isSecretKey, isSecretName: secrets.isSecretName,
            requirement: out('generation/adapters/requirements').redactRequirementText };
        for (const [fname, fn] of Object.entries(fns)) {
            for (const [iname, input] of Object.entries(inputs)) {
                const t = Date.now();
                fn(input);
                const ms = Date.now() - t;
                assert.ok(ms < 150, `${fname}(${iname}) took ${ms} ms`);
            }
        }
        assert.ok(secrets.credentialKeys(`${'x '.repeat(150000)} password: hunter2`).includes('password'), 'trailing credential beyond the head window is still found');
        assert.ok(secrets.containsCredentialValue(`${'x '.repeat(150000)} Bearer abcdefghij12345`));
        const long = secrets.redactCredentialText(`password: hunter2 ${'x '.repeat(40000)}`);
        assert.ok(long.text.endsWith('[truncated]') && long.hits.includes('truncated') && !long.text.includes('hunter2'));
        const b = build([{ id: 'L-1', title: 't', criteria: ['y '.repeat(40000)] }]);
        assert.ok(b.warnings.some(w => /L-1: text longer than 50000/.test(w)));
    } },
    { name: 'requirements: non-string and missing input never throws', run() {
        const b = build([{ id: 42, title: undefined, criteria: [null, undefined, 7, { text: undefined, steps: [1, null] }, 'ok thing'] }, null, { id: 'z' }]);
        assert.ok(scenarios(b).length >= 4);
        assert.deepEqual(errors(text(b), b), []);
    } },
    { name: 'requirements: shared redaction covers natural-language credentials, with documented false-positive limits', run() {
        const secrets = require('../../out/generation/adapters/secrets');
        const must = [
            ['Set pwd to hunter3', 'hunter3'], ['The password hunter2 is used', 'hunter2'], ['my token is sk-live-123456789', 'sk-live'],
            ['Use API key sk-abc12345678 to call', 'abc12345678'], ['logs in as admin/hunter2', 'hunter2'], ['credentials admin/hunter2', 'hunter2'],
            ['connect via user:pass@host.example.com', 'user:pass'], ['https://bob:pw9@host.example.com/x', 'pw9'],
            ['key ghp_abcdefghijklmnopqrstuv', 'ghp_abcdef'], ['id AKIAABCDEFGHIJKLMNOP', 'AKIAABCD'], ['slack xoxb-1234567890-abcdef', 'xoxb-1234'],
            ['password: hunter2', 'hunter2'], ['the secret was swordfish99', 'swordfish99']
        ];
        for (const [input, leak] of must) {
            const r = secrets.redactCredentialText(input);
            assert.ok(!r.text.includes(leak), `${input} -> ${r.text}`);
            assert.ok(r.hits.length > 0, input);
        }
        const keep = ['The token count is shown', 'Secret santa picks a name', 'keyboard input is accepted', 'password reset flow works', 'read/write access is granted', 'a/b testing', 'the token is valid', 'Users need a password'];
        for (const input of keep) assert.equal(secrets.redactCredentialText(input).text, input);
        assert.equal(secrets.redactCredentialText('Dr. a@b.com').hits.length, 0);
    } }
];
