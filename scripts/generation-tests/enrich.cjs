const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const SKILLS_DIR = path.resolve(__dirname, '..', '..', 'skills');
const fsApi = { exists: p => fs.existsSync(p), read: p => fs.readFileSync(p, 'utf8'), list: d => fs.readdirSync(d) };

const out = rel => require('../../out/' + rel);
const ctx = () => out('generation/ai/BusinessContext');
const builder = () => out('generation/ai/PromptBuilder');
const refiner = () => out('generation/ai/AiRefiner');
const cfgMod = () => out('generation/config/GeneratorConfig');
const skills = () => out('generation/ai/SkillPack').loadSkillPack(SKILLS_DIR, fsApi);
const cfg = (over = {}) => {
    const c = JSON.parse(JSON.stringify(cfgMod().DEFAULT_GENERATOR_CONFIG));
    for (const [k, v] of Object.entries(over)) c[k] = { ...c[k], ...v };
    return c;
};

const op = (method, p, over = {}) => ({
    id: `${method}${p}`, method, path: p, tags: [], pathParams: [], queryParams: [], headerParams: [],
    responses: [{ status: '200', description: 'ok' }], security: 'none', sourceRef: `${method} ${p}`, ...over
});
const orderSchema = { type: 'object', properties: { id: { type: 'integer' }, status: { enum: ['pending', 'paid', 'shipped'] }, customerId: { type: 'integer' }, apiKey: { type: 'string' } } };
const model = (extra = []) => ({
    source: 'openapi', name: 'shop', schemes: [], unsupported: [],
    operations: [
        op('POST', '/orders', { summary: 'Create an order', description: 'A shipped order can no longer be cancelled.', body: { contentType: 'application/json', schema: orderSchema, example: { status: 'pending', apiKey: 'sk-123', token: 'abc' } }, responses: [{ status: '201', description: 'created', schema: orderSchema }, { status: '409', description: 'order already shipped' }] }),
        op('GET', '/orders/{id}', { pathParams: [{ name: 'id', required: true, schema: { type: 'integer' } }], responses: [{ status: '200', description: 'the order', schema: orderSchema, example: { id: 1, status: 'paid' } }, { status: '404', description: 'unknown order' }] }),
        op('GET', '/customers', { responses: [{ status: '200', description: 'customers' }] }),
        ...extra
    ]
});

const join = (...lines) => lines.join('\n');
const HEAD = ['Feature: Orders', '', 'Background:', '  * url baseUrl', ''];
const scenario = (name, extra = [], tags = []) => [...tags, `Scenario: ${name}`, `  # source: GET /orders#${name}`, "  Given path 'orders'", '  When method get', '  Then status 200', '  And match response == []', ...extra, ''];
const FEATURE = join(...HEAD, ...scenario('list orders'), ...scenario('list again'));
const EVIDENCE = [{ label: 'openapi', text: 'paths:\n  /orders:\n    get:\n      summary: list orders' }];
const PROPOSAL = ['', '# AI-proposed: description says a shipped order cannot be cancelled', 'Scenario: shipped order cannot be cancelled', '  Given path \'orders\'', '  When method get', '  Then status 200', '  And match response == []'];

const input = (ai, over = {}) => ({
    feature: FEATURE, mode: 'openapi', task: 'enrich-business', evidence: EVIDENCE,
    skills: skills(), ai, knownFiles: new Set(), config: cfg(), ...over
});
const recorder = outputs => {
    const calls = [];
    const ai = async p => { calls.push(p); return outputs[Math.min(calls.length - 1, outputs.length - 1)]; };
    return { ai, calls };
};
const ids = r => [...new Set(r.findings.map(f => f.ruleId))].sort();

module.exports = [
    // business context
    { name: 'enrich: context is deterministic and independent of operation order', run() {
        const m = model();
        const a = ctx().buildBusinessContext(m);
        const b = ctx().buildBusinessContext({ ...m, operations: [...m.operations].reverse() });
        assert.deepEqual(a, b);
        assert.deepEqual(a, ctx().buildBusinessContext(m));
        assert.equal(a.length, 1);
        assert.equal(a[0].label, 'business-context');
    } },
    { name: 'enrich: context carries descriptions, enums, state fields, declared errors, examples and links', run() {
        const text = ctx().buildBusinessContext(model())[0].text;
        assert.match(text, /A shipped order can no longer be cancelled/);
        assert.match(text, /enum response status: pending, paid, shipped|state field response status: pending, paid, shipped/);
        assert.match(text, /409 order already shipped/);
        assert.match(text, /404 unknown order/);
        assert.match(text, /response 200 example: \{"id":1,"status":"paid"\}/);
        assert.match(text, /customerId -> \/customers/);
    } },
    { name: 'enrich: context redacts credential-looking example fields', run() {
        const text = ctx().buildBusinessContext(model())[0].text;
        assert.doesNotMatch(text, /sk-123|"abc"/);
        assert.match(text, /\[REDACTED\]/);
    } },
    { name: 'enrich: context is capped, truncates a prefix of the sorted operations and says so', run() {
        const many = Array.from({ length: 80 }, (_, n) => op('GET', `/things${String(n).padStart(3, '0')}`, { description: 'Long description. '.repeat(10) }));
        const [c] = ctx().buildBusinessContext(model(many));
        assert.ok(c.text.length <= ctx().BUSINESS_CONTEXT_MAX_CHARS, String(c.text.length));
        assert.match(c.text, /\(\d+ more operation\(s\) omitted\)/);
        assert.ok(c.text.indexOf('/customers') > 0 && !c.text.includes('/things079'));
        assert.deepEqual(ctx().buildBusinessContext(model(many)), [c]);
        assert.deepEqual(ctx().buildBusinessContext({ ...model(), operations: [] }), []);
        assert.ok(ctx().buildBusinessContext(model(many), 500)[0].text.length <= 500);
    } },
    // config
    { name: 'enrich: ai.enrich defaults to off and validates the enum', run() {
        assert.equal(cfgMod().DEFAULT_GENERATOR_CONFIG.ai.enrich, 'off');
        const ok = cfgMod().resolveGeneratorConfig({ ai: { enrich: 'business' } }, {});
        assert.equal(ok.config.ai.enrich, 'business');
        assert.deepEqual(ok.warnings, []);
        const bad = cfgMod().resolveGeneratorConfig({ ai: { enrich: 'everything' } }, {});
        assert.equal(bad.config.ai.enrich, 'off');
        assert.ok(bad.warnings.some(w => w.includes('ai.enrich')), bad.warnings.join('|'));
    } },
    // prompt and skills
    { name: 'enrich: prompt has the enrich focus, the AI-proposed contract and the business skill; other tasks do not', run() {
        const { ai, calls } = recorder([FEATURE]);
        return refiner().refine(input(ai)).then(() => {
            assert.match(calls[0].system, /business context directly justifies/);
            assert.match(calls[0].system, /# AI-proposed: <reason>/);
            assert.match(calls[0].system, /Never assert exact message text or volatile values/);
            assert.match(calls[0].user, /karate-business-invariants/);
            const plain = builder().buildPrompt({ task: 'enhance-feature', mode: 'openapi', skills: '', evidence: [], feature: FEATURE });
            assert.ok(!plain.system.includes('AI-proposed') && !plain.user.includes('AI-proposed'));
            for (const task of Object.keys(builder().TASK_FOCUS).filter(t => t !== 'enrich-business')) {
                assert.ok(!builder().outputContract(task).includes('AI-proposed'), task);
            }
        });
    } },
    // guards
    { name: 'enrich: a justified, marked new scenario is accepted', async run() {
        const proposed = FEATURE + PROPOSAL.join('\n') + '\n';
        const r = await refiner().refine(input(async () => proposed));
        assert.equal(r.status, 'refined', JSON.stringify(r.findings));
        assert.ok(r.text.includes('# AI-proposed:'));
        assert.equal(r.attempts, 1);
    } },
    { name: 'enrich: an added assertion inside an existing scenario is accepted', async run() {
        const proposed = FEATURE.replace('  And match response == []\n', '  # AI-proposed: list endpoint documents an array\n  And match response == []\n  And match response == "#[]"\n');
        const r = await refiner().refine(input(async () => proposed));
        assert.equal(r.status, 'refined', JSON.stringify(r.findings));
    } },
    { name: 'enrich: a new scenario without an AI-proposed comment is rejected (V2-AI-007) after one retry', async run() {
        const unmarked = FEATURE + PROPOSAL.filter(l => !l.startsWith('# AI-proposed')).join('\n') + '\n';
        const { ai, calls } = recorder([unmarked]);
        const r = await refiner().refine(input(ai));
        assert.equal(r.status, 'rejected');
        assert.equal(r.text, FEATURE);
        assert.deepEqual(ids(r), ['V2-AI-007']);
        assert.equal(calls.length, 2);
        assert.match(calls[1].user, /V2-AI-007/);
    } },
    { name: 'enrich: an empty AI-proposed reason does not count', async run() {
        const r = await refiner().refine(input(async () => FEATURE + PROPOSAL.map(l => l.startsWith('# AI-proposed') ? '# AI-proposed:' : l).join('\n') + '\n'));
        assert.equal(r.status, 'rejected');
        assert.deepEqual(ids(r), ['V2-AI-007']);
    } },
    { name: 'enrich: a marked new scenario with a gate error is rejected (V2-AI-007)', async run() {
        const bad = FEATURE + PROPOSAL.map(l => l.includes("'orders'") ? "  Given url 'http://prod.example.com'" : l).join('\n') + '\n';
        const r = await refiner().refine(input(async () => bad));
        assert.equal(r.status, 'rejected');
        assert.ok(ids(r).includes('V2-AI-007'), JSON.stringify(r.findings));
    } },
    { name: 'enrich: a dropped scenario is still rejected (V2-AI-002)', async run() {
        const dropped = join(...HEAD, ...scenario('list orders')) + PROPOSAL.join('\n') + '\n';
        const r = await refiner().refine(input(async () => dropped));
        assert.equal(r.status, 'rejected');
        assert.ok(ids(r).includes('V2-AI-002'), JSON.stringify(r.findings));
    } },
    { name: 'enrich: an invented path is still rejected (V2-AI-003)', async run() {
        const invented = FEATURE + PROPOSAL.map(l => l.includes("path 'orders'") ? "  Given path 'warehouses'" : l).join('\n') + '\n';
        const r = await refiner().refine(input(async () => invented));
        assert.equal(r.status, 'rejected');
        assert.ok(ids(r).includes('V2-AI-003'), JSON.stringify(r.findings));
    } },
    { name: 'enrich: the business context counts as evidence for paths', async run() {
        const evidence = [...EVIDENCE, ...ctx().buildBusinessContext(model())];
        const customers = FEATURE + PROPOSAL.map(l => l.includes("path 'orders'") ? "  Given path 'customers'" : l).join('\n') + '\n';
        const r = await refiner().refine(input(async () => customers, { evidence }));
        assert.equal(r.status, 'refined', JSON.stringify(r.findings));
    } },
    { name: 'enrich: un-ignoring a draft is still rejected (V2-AI-006)', async run() {
        const draft = FEATURE.replace('Scenario: list orders', '@ignore\nScenario: list orders');
        const r = await refiner().refine(input(async () => FEATURE, { feature: draft }));
        assert.equal(r.status, 'rejected');
        assert.ok(ids(r).includes('V2-AI-006'), JSON.stringify(r.findings));
    } },
    // off stays identical
    { name: 'enrich: other tasks do not apply V2-AI-007 (an unmarked new scenario is accepted as before)', async run() {
        const unmarked = FEATURE + PROPOSAL.filter(l => !l.startsWith('# AI-proposed')).join('\n') + '\n';
        const r = await refiner().refine(input(async () => unmarked, { task: 'enhance-feature' }));
        assert.equal(r.status, 'refined', JSON.stringify(r.findings));
    } },
    // pipeline wiring
    ...(() => {
        const yaml = require('js-yaml');
        const pipeline = () => out('generation/pipeline/GenerationPipeline');
        const mem = () => {
            const map = new Map();
            return { map, exists: p => map.has(p) || [...map.keys()].some(k => k.startsWith(p + '/')), read: p => { if (!map.has(p)) throw new Error('ENOENT ' + p); return map.get(p); }, list: d => [...new Set([...map.keys()].filter(k => k.startsWith(d + '/')).map(k => k.slice(d.length + 1).split('/')[0]))], write: (p, c) => { map.set(p, c); } };
        };
        const hist = () => { const h = new Map(); return { get: p => h.get(p), set: (p, v) => { h.set(p, v); } }; };
        const spec = yaml.load('openapi: 3.0.0\ninfo: { title: Shop, version: "1" }\npaths:\n  /orders:\n    get:\n      summary: List orders\n      description: Lists every order, newest first.\n      responses:\n        "200":\n          description: ok\n          content:\n            application/json:\n              schema: { type: array, items: { type: object, properties: { status: { type: string, enum: [pending, paid] } } } }\n');
        const run = async (aiCfg, withAi = true) => {
            const calls = [];
            const fs2 = mem();
            const c = cfg({ ai: aiCfg });
            await pipeline().runPipeline({
                model: out('generation/adapters/openapi').buildOpenApiModel(spec, 'shop'), config: c,
                project: { classpathRoot: 'src/test/java', envConfigs: [], hasEnvJson: false, runnerStyle: 'unknown' },
                fsApi: fs2, history: hist(), generatorVersion: '9.9.9', sourceRef: 'shop.yaml', mode: 'openapi',
                evidence: [{ label: 'openapi', text: 'GET /orders' }], skills: skills(),
                ai: withAi ? async p => { calls.push(p); return /<feature>\n([\s\S]*?)\n<\/feature>/.exec(p.user)[1]; } : undefined
            });
            return { calls, files: [...fs2.map.entries()].filter(([k]) => k.endsWith('.feature')).sort() };
        };
        return [
            { name: 'enrich: pipeline with enrich off sends the plain enhance prompt (identical to the default)', async run() {
                const a = await run({});
                const b = await run({ enrich: 'off' });
                assert.ok(a.calls.length > 0);
                assert.deepEqual(a.calls, b.calls);
                assert.ok(a.calls.every(p => !p.system.includes('AI-proposed') && !p.user.includes('business-context')));
                assert.deepEqual(a.files, b.files);
            } },
            { name: 'enrich: pipeline with enrich business sends the enrich task, business context and skill', async run() {
                const r = await run({ enrich: 'business' });
                assert.ok(r.calls.length > 0);
                for (const p of r.calls) {
                    assert.match(p.system, /business context directly justifies/);
                    assert.match(p.user, /<evidence label="business-context">/);
                    assert.match(p.user, /newest first/);
                    assert.match(p.user, /karate-business-invariants/);
                    assert.match(p.user, /<evidence label="openapi">/);
                }
            } },
            { name: 'enrich: enrich needs ai.refine and an AI; otherwise nothing is sent and output matches off', async run() {
                const off = await run({ refine: false, enrich: 'business' });
                assert.equal(off.calls.length, 0);
                const none = await run({ enrich: 'business' }, false);
                const plain = await run({ enrich: 'off' }, false);
                assert.deepEqual(none.files, plain.files);
            } }
        ];
    })()
];
