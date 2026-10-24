const assert = require('node:assert/strict');

const q = () => require('../../out/generation/quality/QualityGate');

const join = (...lines) => lines.join('\n');
const HEAD = ['Feature: Orders', '', 'Background:', '  * url baseUrl', ''];
const ids = text => q().runGate(text).findings.map(f => f.ruleId);
const has = (text, id) => ids(text).includes(id);
const scenario = (steps, tags = []) => join(...HEAD, ...tags, 'Scenario: s', "  Given path 'orders'", ...steps);

module.exports = [
    // ASSERT-003: a successful call that checks only status and non-content signals
    { name: 'rules-assert: ASSERT-003 fires for status plus response time only', run() {
        const t = scenario(['  When method get', '  Then status 200', '  And assert responseTime < 500']);
        assert.ok(has(t, 'V2-ASSERT-003'), ids(t).join());
        assert.ok(!has(t, 'V2-ASSERT-002'));
    } },
    { name: 'rules-assert: ASSERT-003 stays quiet when ASSERT-002 already reports the scenario', run() {
        const t = scenario(['  When method get', '  Then status 200']);
        assert.deepEqual(ids(t), ['V2-ASSERT-002']);
    } },
    { name: 'rules-assert: ASSERT-003 accepts a header or body match', run() {
        assert.ok(!has(scenario(['  When method get', '  Then status 200', '  And match header Content-Type contains "json"']), 'V2-ASSERT-003'));
        assert.ok(!has(scenario(['  When method get', '  Then status 200', '  And match response.total == 1']), 'V2-ASSERT-003'));
    } },
    { name: 'rules-assert: ASSERT-003 ignores non-2xx scenarios', run() {
        assert.ok(!has(scenario(['  When method get', '  Then status 404', '  And assert responseTime < 500']), 'V2-ASSERT-003'));
    } },
    // ASSERT-004
    { name: 'rules-assert: ASSERT-004 fires for a bare #object, #[] or #array marker', run() {
        for (const marker of ["'#object'", "'#[]'", "'#array'", '"#object"']) {
            const t = scenario(['  When method get', '  Then status 200', `  And match response == ${marker}`]);
            assert.deepEqual(ids(t), ['V2-ASSERT-004'], marker);
        }
    } },
    { name: 'rules-assert: ASSERT-004 accepts a real assertion next to the marker or a typed schema', run() {
        assert.ok(!has(scenario(['  When method get', '  Then status 200', "  And match response == '#object'", '  And match response.id == 1']), 'V2-ASSERT-004'));
        assert.ok(!has(scenario(['  When method get', '  Then status 200', "  And match response == '#object'", '  And match header Content-Type contains "json"']), 'V2-ASSERT-004'));
        assert.ok(!has(scenario(['  When method get', '  Then status 200', "  And match response == { id: '#number' }"]), 'V2-ASSERT-004'));
        assert.ok(!has(scenario(['  When method get', '  Then status 200', "  And match each response == { id: '#number' }"]), 'V2-ASSERT-004'));
        assert.ok(!has(scenario(['  When method get', '  Then status 404', "  And match response == '#object'"]), 'V2-ASSERT-004'));
    } },
    // ASSERT-005
    { name: 'rules-assert: ASSERT-005 fires for a 4xx scenario that asserts only the status', run() {
        const t = scenario(['  When method get', '  Then status 400']);
        assert.deepEqual(ids(t), ['V2-ASSERT-005']);
        assert.deepEqual(ids(scenario(['  When method post', '  Then match responseStatus == 422'])), ['V2-ASSERT-005']);
    } },
    { name: 'rules-assert: ASSERT-005 accepts a body or header assertion', run() {
        assert.ok(!has(scenario(['  When method get', '  Then status 400', '  And match response.message == "#string"']), 'V2-ASSERT-005'));
        assert.ok(!has(scenario(['  When method get', '  Then status 400', '  And match header Content-Type contains "json"']), 'V2-ASSERT-005'));
    } },
    { name: 'rules-assert: ASSERT-005 skips 401/403, @security scenarios and 2xx', run() {
        assert.ok(!has(scenario(['  When method get', '  Then status 401']), 'V2-ASSERT-005'));
        assert.ok(!has(scenario(['  When method get', '  Then status 403']), 'V2-ASSERT-005'));
        assert.ok(!has(scenario(['  When method get', '  Then status 400'], ['@security']), 'V2-ASSERT-005'));
        assert.ok(!has(scenario(['  When method get', '  Then status 200', '  And match response.a == 1']), 'V2-ASSERT-005'));
    } },
    // ASSERT-006
    { name: 'rules-assert: ASSERT-006 fires for a 2xx POST that never looks at the created resource', run() {
        const t = scenario(['  And request { name: "a" }', '  When method post', '  Then status 201', '  And assert responseTime < 500']);
        assert.ok(has(t, 'V2-ASSERT-006'));
    } },
    { name: 'rules-assert: ASSERT-006 accepts an id capture, echo match or Location header', run() {
        for (const step of ['  And def newId = response.id', '  And match response == { id: "#string" }', '  And match response.name == "a"', '  And match header Location == "#string"']) {
            const t = scenario(['  And request { name: "a" }', '  When method post', '  Then status 201', step]);
            assert.ok(!has(t, 'V2-ASSERT-006'), step);
        }
    } },
    { name: 'rules-assert: ASSERT-006 only applies to POST with 2xx', run() {
        assert.ok(!has(scenario(['  When method put', '  Then status 200', '  And assert responseTime < 500']), 'V2-ASSERT-006'));
        assert.ok(!has(scenario(['  When method post', '  Then status 400', '  And assert responseTime < 500']), 'V2-ASSERT-006'));
        assert.ok(!has(scenario(['  When method POST', '  Then status 201', '  And match response.id == 1']), 'V2-ASSERT-006'));
    } },
    // skips and severity
    { name: 'rules-assert: @ignore, @draft and @exploratory scenarios are skipped', run() {
        const body = ['  When method post', '  Then status 400'];
        for (const tag of ['@ignore', '@draft', '@exploratory']) {
            const t = scenario(body, [tag]);
            assert.deepEqual(ids(t).filter(id => /ASSERT-00[3-6]/.test(id)), [], tag);
        }
        const ignoredFeature = join('@ignore', ...HEAD, 'Scenario: s', "  Given path 'orders'", ...body);
        assert.deepEqual(ids(ignoredFeature).filter(id => /ASSERT-00[3-6]/.test(id)), []);
    } },
    { name: 'rules-assert: gate warnings alone keep the summary level at info', run() {
        const { formatSummary } = require('../../out/generation/pipeline/Summary');
        const findings = q().runGate(scenario(['  When method get', '  Then status 400'])).findings;
        assert.ok(findings.length > 0);
        const r = {
            written: { created: ['a.feature'], updated: [], skippedExisting: [], sideBySide: [] },
            features: [{ path: 'a.feature', findings, draft: false }], draftScenarios: 0, warnings: [],
            gate: { errors: 0, warnings: findings.length }
        };
        assert.equal(formatSummary(r).level, 'info');
    } },
    { name: 'rules-assert: new rules are warnings, registered in RULES, and never fail the gate', run() {
        const { RULES } = require('../../out/generation/quality/rules');
        for (const id of ['V2-ASSERT-003', 'V2-ASSERT-004', 'V2-ASSERT-005', 'V2-ASSERT-006']) {
            const rule = RULES.find(r => r.id === id);
            assert.ok(rule, id);
            assert.equal(rule.severity, 'warning');
        }
        const t = scenario(['  When method get', '  Then status 400']);
        const r = q().runGate(t);
        assert.equal(r.ok, true);
        assert.ok(r.findings.every(f => f.severity === 'warning'));
    } }
,
    // generated output: the new rules stay quiet on the planner's own scenarios (counts for petstore fixtures)
    { name: 'rules-assert: planner output under basic, contract and business modes draws at most the known warnings', run() {
        const fs = require('fs');
        const yaml = require('js-yaml');
        const { fixture } = require('./support/golden.cjs');
        const out = rel => require('../../out/' + rel);
        const base = out('generation/config/GeneratorConfig').DEFAULT_GENERATOR_CONFIG;
        const expected = {
            'petstore-business.yaml': { basic: {}, contract: {}, business: {} },
            'petstore-contract.yaml': { basic: {}, contract: {}, business: {} },
            'petstore-secured.yaml': { basic: { 'V2-ASSERT-005': 1 }, contract: { 'V2-ASSERT-005': 1 }, business: { 'V2-ASSERT-005': 2 } }
        };
        const modes = { basic: {}, contract: { responseChecks: 'contract' }, business: { responseChecks: 'contract', business: 'on' } };
        for (const [file, perMode] of Object.entries(expected)) {
            const model = out('generation/adapters/openapi').buildOpenApiModel(yaml.load(fs.readFileSync(fixture('openapi', file), 'utf8')), 'p');
            for (const [mode, scenarios] of Object.entries(modes)) {
                const cfg = JSON.parse(JSON.stringify(base));
                cfg.scenarios = { ...cfg.scenarios, ...scenarios };
                const counts = {};
                for (const pf of out('generation/plan/OpenApiPlanner').planOpenApi(model, cfg).features) {
                    const text = out('generation/render/FeatureRenderer').renderFeature(pf.feature, { style: cfg.style });
                    for (const f of q().runGate(text, { config: cfg }).findings.filter(x => /ASSERT-00[3-6]/.test(x.ruleId))) {
                        assert.equal(f.severity, 'warning');
                        counts[f.ruleId] = (counts[f.ruleId] || 0) + 1;
                    }
                }
                assert.deepEqual(counts, perMode[mode], `${file} ${mode}`);
            }
        }
    } }
];
