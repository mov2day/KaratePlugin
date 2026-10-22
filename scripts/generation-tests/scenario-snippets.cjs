const fs = require('fs');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const { fixture } = require('./support/golden.cjs');

const out = rel => require('../../out/' + rel);
const model = () => out('generation/adapters/openapi').buildOpenApiModel(yaml.load(fs.readFileSync(fixture('openapi', 'petstore-secured.yaml'), 'utf8')), 'petstore');
const cfg = () => JSON.parse(JSON.stringify(out('generation/config/GeneratorConfig').DEFAULT_GENERATOR_CONFIG));

module.exports = [
    {
        name: 'scenario-snippets: renders scenarios for one operation without Feature or Background header',
        run() {
            const m = model();
            const op = m.operations[0];
            const text = out('generation/plan/ScenarioSnippets').renderScenariosForOperations(m, [op.sourceRef], cfg());
            assert.ok(text.includes('Scenario'), text);
            assert.ok(!/^\s*Feature:/m.test(text));
            assert.ok(!/^\s*Background:/m.test(text));
            assert.ok(text.includes(op.method.toLowerCase()) || /method /.test(text));
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
    }
];
