const assert = require('node:assert/strict');

const r = () => require('../../out/generation/render/FeatureRenderer');
const parser = () => require('../../out/generation/quality/FeatureParser');

const style = (over = {}) => ({ indentation: '  ', variableCase: 'camelCase', commentStyle: 'hash', lineSpacing: 1, ...over });
const step = (keyword, text, extra = {}) => ({ keyword, text, ...extra });

const feature = () => ({
    name: 'Orders',
    description: 'Order API',
    background: { steps: [step('*', 'url baseUrl')] },
    scenarios: [
        {
            name: 'Create order',
            tags: ['positive'],
            steps: [
                step('Given', "path 'orders'"),
                step('And', 'request', { docString: '{ "a": 1 }' }),
                step('When', 'method post'),
                step('Then', 'status 201')
            ]
        },
        { name: 'Get order', steps: [step('When', 'method get'), step('Then', 'status 200')] }
    ]
});

module.exports = [
    {
        name: 'render: 2-space indentation applied consistently',
        run() {
            const out = r().renderFeature(feature(), { style: style() });
            assert.equal(out, [
                'Feature: Orders',
                '  Order API',
                '',
                '  Background:',
                '    * url baseUrl',
                '',
                '  @positive',
                '  Scenario: Create order',
                "    Given path 'orders'",
                '    And request',
                '    """',
                '      { "a": 1 }',
                '    """',
                '    When method post',
                '    Then status 201',
                '',
                '  Scenario: Get order',
                '    When method get',
                '    Then status 200',
                ''
            ].join('\n'));
        }
    },
    {
        name: 'render: 4-space indentation applied consistently',
        run() {
            const out = r().renderFeature(feature(), { style: style({ indentation: '    ' }) });
            const lines = out.split('\n');
            assert.ok(lines.includes('    Background:'));
            assert.ok(lines.includes('        * url baseUrl'));
            assert.ok(lines.includes('        """'));
            assert.ok(lines.includes('            { "a": 1 }'));
            assert.ok(lines.includes('    Scenario: Get order'));
        }
    },
    {
        name: 'render: lineSpacing controls blank lines between blocks',
        run() {
            const zero = r().renderFeature(feature(), { style: style({ lineSpacing: 0 }) });
            assert.ok(!zero.includes('\n\n'));
            const two = r().renderFeature(feature(), { style: style({ lineSpacing: 2 }) });
            assert.ok(two.includes('    Then status 201\n\n\n  Scenario: Get order'));
            assert.ok(two.endsWith('Then status 200\n') && !two.endsWith('\n\n'));
        }
    },
    {
        name: 'render: doubleSlash commentStyle still renders # comments',
        run() {
            const f = feature();
            f.scenarios[0].source = 'GET /orders';
            const out = r().renderFeature(f, { style: style({ commentStyle: 'doubleSlash' }), header: ['generated'] });
            assert.ok(out.startsWith('# generated\nFeature: Orders'));
            assert.ok(out.includes('  # source: GET /orders'));
            assert.ok(!out.includes('//'));
        }
    },
    {
        name: 'render: examples produce Scenario Outline with aligned table and col! headers',
        run() {
            const out = r().renderScenario({
                name: 'Validate <id>',
                steps: [step('When', 'method get')],
                examples: { columns: ['id!', 'status'], rows: [['1', '200'], ['long-id', '404']] }
            }, style());
            assert.equal(out, [
                '  Scenario Outline: Validate <id>',
                '    When method get',
                '',
                '    Examples:',
                '      | id!     | status |',
                '      | 1       | 200    |',
                '      | long-id | 404    |'
            ].join('\n'));
        }
    },
    {
        name: 'render: tags on one line, draftReason adds @ignore once and Draft comment',
        run() {
            const out = r().renderScenario({
                name: 's', tags: ['@a', 'ignore', 'b'], draftReason: 'needs data',
                steps: [step('*', 'def x = 1')], comments: ['note one'], source: 'POST /x'
            }, style());
            assert.equal(out, [
                '  @ignore @a @b',
                '  Scenario: s',
                '    # Draft: needs data',
                '    # source: POST /x',
                '    # note one',
                '    * def x = 1'
            ].join('\n'));
        }
    },
    {
        name: 'render: step tables and feature tags/header',
        run() {
            const f = { name: 'T', scenarios: [{ name: 's', steps: [step('Given', 'table t', { table: [['a', 'b'], ['1', '2']] })] }] };
            const out = r().renderFeature(f, { style: style(), featureTags: ['@api', 'smoke'], header: ['h1', 'h2'] });
            assert.equal(out, [
                '# h1', '# h2', '@api @smoke', 'Feature: T', '',
                '  Scenario: s', '    Given table t', '      | a | b |', '      | 1 | 2 |', ''
            ].join('\n'));
        }
    },
    {
        name: 'render: round trip keeps scenario names in order',
        run() {
            const f = feature();
            f.scenarios.push({ name: 'Outline one', steps: [step('When', 'method get')], examples: { columns: ['a'], rows: [['1']] }, draftReason: 'x' });
            const parsed = r().renderFeature(f, { style: style() });
            assert.deepEqual(parser().parseFeature(parsed).scenarios.map(s => s.name), ['Create order', 'Get order', 'Outline one']);
        }
    },
    {
        name: 'render: legacy KarateGenerator.featureToString delegates to renderer',
        run() {
            const { KarateGenerator } = require('../../out/services/karateGenerator');
            const out = new KarateGenerator().featureToString(feature());
            assert.ok(out.endsWith('Then status 200\n') && !out.endsWith('\n\n'));
            assert.ok(out.includes('      { "a": 1 }'));
        }
    },
    {
        name: 'render: multi-line comments emit one # line each',
        run() {
            const f = { name: 'F', scenarios: [{ name: 'S', draftReason: 'line one\r\nline two\nline three', steps: [step('*', 'print 1')] }] };
            const text = r().renderFeature(f, { style: style(), header: ['h1\nh2'] });
            assert.ok(text.startsWith('# h1\n# h2\nFeature: F'));
            assert.ok(text.includes('    # Draft: line one\n    # line two\n    # line three\n'));
            const parsed = parser().parseFeature(text);
            assert.equal(parsed.scenarios.length, 1);
        }
    }
];
