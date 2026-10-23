const fs = require('fs');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const { fixture } = require('./support/golden.cjs');

const out = rel => require('../../out/' + rel);
const model = () => out('generation/adapters/openapi').buildOpenApiModel(yaml.load(fs.readFileSync(fixture('openapi', 'petstore-secured.yaml'), 'utf8')), 'petstore');
const cfg = () => JSON.parse(JSON.stringify(out('generation/config/GeneratorConfig').DEFAULT_GENERATOR_CONFIG));

module.exports = [
    {
        name: 'scenario-snippets: excludes no-auth security probes from an authenticated merge',
        run() {
            const m = model();
            const secured = m.operations.find(op => op.security !== 'none');
            const text = out('generation/plan/ScenarioSnippets').renderScenariosForOperations(m, [secured.sourceRef], cfg());
            assert.ok(!/without authentication|no auth/i.test(text), text);
        }
    },
    {
        name: 'scenario-snippets: renders scenarios for one operation without Feature or Background header',
        run() {
            const m = model();
            const op = m.operations[0];
            const text = out('generation/plan/ScenarioSnippets').renderScenariosForOperations(m, [op.sourceRef], cfg());
            assert.ok(text.includes('Scenario'), text);
            assert.ok(!/^\s*Feature:/m.test(text));
            assert.ok(!/^\s*Background:/m.test(text));
            assert.match(text, new RegExp(`method ${op.method.toLowerCase()}\\b`), 'snippet performs the operation method');
            assert.ok(text.includes(`source: ${op.sourceRef}`), 'snippet carries the source comment');
        }
    },
    {
        name: 'scenario-snippets: unknown operation yields an empty string so callers can fall back',
        run() {
            const text = out('generation/plan/ScenarioSnippets').renderScenariosForOperations(model(), ['GET /nope'], cfg());
            assert.equal(text, '');
        }
    },
    {
        name: 'scenario-snippets: operationSourceRef matches the adapter sourceRef format',
        run() {
            const m = model();
            const op = m.operations[0];
            assert.equal(out('generation/plan/ScenarioSnippets').operationSourceRef(op.method, op.path), op.sourceRef);
        }
    },
    {
        name: 'scenario-snippets: no data/schema file references and the snippet is gate-clean inside a standard Feature',
        run() {
            const m = model();
            const c = cfg();
            const snip = out('generation/plan/ScenarioSnippets');
            const render = out('generation/render/FeatureRenderer');
            const gate = out('generation/quality/QualityGate');
            for (const op of m.operations) {
                const text = snip.renderScenariosForOperations(m, [op.sourceRef], c);
                if (!text) continue;
                assert.ok(!/classpath:data\//.test(text) && !/classpath:schemas\//.test(text), `${op.sourceRef}: file reference in snippet\n${text}`);
                const feature = `Feature: Wrap\n\n  Background:\n    * url baseUrl\n    * call read('classpath:common/auth.feature')\n\n${text}\n`;
                const g = gate.runGate(feature, { knownFiles: new Set(['common/auth.feature', 'common/utils.feature']), config: c });
                assert.deepEqual(g.findings.filter(f => f.severity === 'error'), [], `${op.sourceRef}\n${feature}`);
            }
            void render;
        }
    }
];
