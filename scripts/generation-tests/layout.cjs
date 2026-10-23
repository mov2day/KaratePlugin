const fs = require('fs');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const { golden, fixture } = require('./support/golden.cjs');

const out = rel => require('../../out/' + rel);
const cfgMod = () => out('generation/config/GeneratorConfig');
const stage = () => out('generation/layout/LayoutStage');
const renderer = () => out('generation/render/FeatureRenderer');

const config = (layout = {}) => {
    const base = JSON.parse(JSON.stringify(cfgMod().DEFAULT_GENERATOR_CONFIG));
    base.layout = { ...base.layout, ...layout };
    return base;
};
const step = (keyword, text) => ({ keyword, text });
const sc = (name, category, extra = {}) => ({
    name, category, tags: [`@${category}`], steps: [step('Given', "path 'x'"), step('When', 'method get'), step('Then', 'status 200')], ...extra
});
const outline = name => sc(name, 'positive', { examples: { columns: ['a'], rows: [['1'], ['2'], ['3']] } });
const pf = (relativePath, scenarios, extra = {}) => ({
    relativePath,
    feature: { name: 'Pets API', description: 'Generated', background: { steps: [step('*', 'url baseUrl'), step('*', "call read('classpath:common/auth.feature')")] }, scenarios },
    ...extra
});
const mixed = () => [pf('pets/pets.feature', [
    sc('list', 'positive'), sc('get', 'positive'), sc('bad id', 'negative'), sc('no body', 'negative'), sc('max', 'boundary'), sc('edge1', 'edge')
])];
const paths = fs => fs.map(f => f.relativePath);
const render = (features, cfg = config()) => Object.fromEntries(features.map(f => [f.relativePath, renderer().renderFeature(f.feature, { style: cfg.style })]));

const loadApi = () => yaml.load(fs.readFileSync(fixture('openapi', 'petstore-secured.yaml'), 'utf8'));
const planned = layout => {
    const cfg = config(layout);
    const model = out('generation/adapters/openapi').buildOpenApiModel(loadApi(), 'petstore');
    return out('generation/plan/OpenApiPlanner').planOpenApi(model, cfg);
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
const runAdapter = async layout => {
    const fsApi = memFs();
    const model = { source: 'postman', name: 'x', baseUrl: 'https://example.test', schemes: [], operations: [], unsupported: [] };
    const result = await out('generation/pipeline/GenerationPipeline').runPipeline({
        model, scenarios: mixed(), config: config(layout),
        project: { classpathRoot: 'src/test/java', envConfigs: [], hasEnvJson: false, runnerStyle: 'unknown' },
        fsApi, history: history(), generatorVersion: '9.9.9', sourceRef: 'c.json', mode: 'postman'
    });
    const files = [...fsApi.map.keys()].filter(k => k.endsWith('.feature') && k.startsWith('src/test/karate/')).sort();
    return { result, files, fsApi };
};

module.exports = [
    { name: 'layout: defaults are none/0/false and the stage is the identity', run() {
        const l = cfgMod().DEFAULT_GENERATOR_CONFIG.layout;
        assert.equal(l.splitBy, 'none'); assert.equal(l.maxScenariosPerFile, 0); assert.equal(l.sections, false);
        const input = mixed();
        assert.equal(stage().applyLayout(input, l), input);
    } },
    { name: 'layout: config validates splitBy and maxScenariosPerFile', run() {
        const r = cfgMod().resolveGeneratorConfig({ layout: { splitBy: 'weird', maxScenariosPerFile: -2 } }, {});
        assert.equal(r.config.layout.splitBy, 'none'); assert.equal(r.config.layout.maxScenariosPerFile, 0);
        assert.equal(r.warnings.length, 2, r.warnings.join('|'));
        assert.equal(cfgMod().resolveGeneratorConfig({ layout: { splitBy: 'category' } }, {}).config.layout.splitBy, 'category');
    } },
    { name: 'layout: category split keeps positive in the original file and reuses Background', run() {
        const r = stage().applyLayout(mixed(), config({ splitBy: 'category' }).layout);
        assert.deepEqual(paths(r), ['pets/pets.feature', 'pets/pets-boundary.feature', 'pets/pets-edge.feature', 'pets/pets-negative.feature']);
        assert.deepEqual(r[0].feature.scenarios.map(s => s.name), ['list', 'get']);
        assert.equal(r[3].feature.name, 'Pets API - Negative');
        for (const f of r) assert.deepEqual(f.feature.background, mixed()[0].feature.background);
        assert.equal(r.reduce((n, f) => n + f.feature.scenarios.length, 0), 6);
    } },
    { name: 'layout: single-category files and -crud/-security/-public files are untouched', run() {
        const input = [
            pf('pets/pets.feature', [sc('a', 'positive'), sc('b', 'positive')]),
            pf('pets/pets-crud.feature', [sc('a', 'positive'), sc('b', 'negative')], { featureKind: 'crud' }),
            pf('pets/pets-security.feature', [sc('a', 'security'), sc('b', 'negative')], { featureKind: 'security' }),
            pf('pets/pets-public.feature', [sc('a', 'positive'), sc('b', 'negative')], { featureKind: 'main' })
        ];
        const r = stage().applyLayout(input, config({ splitBy: 'category' }).layout);
        assert.deepEqual(paths(r), paths(input));
        assert.deepEqual(r, input);
    } },
    { name: 'layout: maxScenariosPerFile chunks, never splits an outline, keeps Background', run() {
        const input = [pf('pets/pets.feature', [sc('a', 'positive'), outline('o'), sc('b', 'positive'), sc('c', 'positive'), sc('d', 'positive')])];
        const r = stage().applyLayout(input, config({ maxScenariosPerFile: 2 }).layout);
        assert.deepEqual(paths(r), ['pets/pets-1.feature', 'pets/pets-2.feature', 'pets/pets-3.feature']);
        assert.deepEqual(r.map(f => f.feature.scenarios.length), [2, 2, 1]);
        assert.equal(r[0].feature.scenarios[1].examples.rows.length, 3);
        assert.equal(r[1].feature.name, 'Pets API - Part 2');
        assert.ok(r.every(f => f.feature.background.steps.length === 2));
        assert.deepEqual(stage().applyLayout(input, config({ maxScenariosPerFile: 5 }).layout), input);
    } },
    { name: 'layout: chunk paths avoid collisions with existing files', run() {
        const input = [pf('p/p.feature', [sc('a', 'positive'), sc('b', 'positive')]), pf('p/p-1.feature', [sc('c', 'positive')])];
        const r = stage().applyLayout(input, config({ maxScenariosPerFile: 1 }).layout);
        assert.equal(new Set(paths(r)).size, r.length, paths(r).join(','));
    } },
    { name: 'layout: sections add a comment before each run of same-category scenarios', run() {
        const cfg = config({ sections: true });
        const r = stage().applyLayout(mixed(), cfg.layout);
        const text = render(r, cfg)['pets/pets.feature'];
        assert.deepEqual([...text.matchAll(/# ---- (\w+) ----/g)].map(m => m[1]), ['positive', 'negative', 'boundary', 'edge']);
        assert.ok(text.indexOf('# ---- negative ----') < text.indexOf('Scenario: bad id'));
        assert.ok(!render(mixed())['pets/pets.feature'].includes('----'));
        const split = stage().applyLayout(mixed(), config({ sections: true, splitBy: 'category' }).layout);
        assert.equal((render(split, cfg)['pets/pets-negative.feature'].match(/# ---- /g) || []).length, 1);
    } },
    { name: 'layout: output is deterministic and does not mutate its input', run() {
        const l = config({ splitBy: 'category', maxScenariosPerFile: 1, sections: true }).layout;
        const input = mixed();
        const before = JSON.stringify(input);
        assert.equal(JSON.stringify(stage().applyLayout(input, l)), JSON.stringify(stage().applyLayout(mixed(), l)));
        assert.equal(JSON.stringify(input), before);
    } },
    { name: 'layout: unimplemented splitBy values warn and leave files unsplit', run() {
        assert.equal(stage().layoutWarnings({ splitBy: 'tag', maxScenariosPerFile: 0, sections: false }).length, 1);
        assert.equal(stage().layoutWarnings(config().layout).length, 0);
        const input = mixed();
        assert.equal(stage().applyLayout(input, config({ splitBy: 'path' }).layout), input);
    } },
    { name: 'layout: planner path default output is unchanged and split keeps every scenario', run() {
        const base = planned({});
        const same = stage().applyLayout(base.features, config().layout);
        assert.equal(same, base.features);
        const split = stage().applyLayout(base.features, config({ splitBy: 'category' }).layout);
        const count = fs => fs.reduce((n, f) => n + f.feature.scenarios.length, 0);
        assert.equal(count(split), count(base.features));
        assert.ok(split.length > base.features.length, 'expected extra files');
        assert.equal(new Set(paths(split)).size, split.length);
        for (const f of base.features.filter(x => x.featureKind !== 'main' || x.relativePath.endsWith('-public.feature'))) {
            assert.ok(split.some(x => x === f), `${f.relativePath} must be untouched`);
        }
        const names = split.map(f => f.feature.name);
        assert.ok(names.some(n => /- Negative$/.test(n)), names.join('|'));
    } },
    { name: 'layout: planner path golden for split + sections', run() {
        const cfg = config({ splitBy: 'category', sections: true });
        const split = stage().applyLayout(planned({}).features, cfg.layout);
        golden('layout/petstore-secured-category.txt', Object.entries(render(split, cfg)).map(([p, t]) => `=== ${p}\n${t}`).join('\n'));
    } },
    { name: 'layout: adapter-provided scenarios go through the stage in runPipeline', async run() {
        const plain = await runAdapter({});
        assert.deepEqual(plain.files, ['src/test/karate/pets/pets.feature']);
        const split = await runAdapter({ splitBy: 'category', sections: true });
        assert.deepEqual(split.files, [
            'src/test/karate/pets/pets-boundary.feature', 'src/test/karate/pets/pets-edge.feature',
            'src/test/karate/pets/pets-negative.feature', 'src/test/karate/pets/pets.feature'
        ]);
        assert.ok(split.fsApi.map.get('src/test/karate/pets/pets-negative.feature').includes('# ---- negative ----'));
        const tag = await runAdapter({ splitBy: 'tag' });
        assert.deepEqual(tag.files, plain.files);
        assert.ok(tag.result.warnings.some(w => /splitBy "tag"/.test(w)), tag.result.warnings.join('|'));
    } }
];
