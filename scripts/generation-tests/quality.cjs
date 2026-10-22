const assert = require('node:assert/strict');

const q = () => require('../../out/generation/quality/QualityGate');
const rules = () => require('../../out/generation/quality/rules');
const parser = () => require('../../out/generation/quality/FeatureParser');
const cfg = () => require('../../out/generation/config/GeneratorConfig');

const join = (...lines) => lines.join('\n');
const found = (text, ctx) => q().runGate(text, ctx).findings.map(f => `${f.ruleId}@${f.line}`);

const HEAD = ['Feature: Orders', '', 'Background:', '  * url baseUrl', ''];

const cases = [
    ['V2-GHERKIN-001', join('Feature: x', '  * def a = 1', 'Scenario: s', '  * def b = 2'), ['V2-GHERKIN-001@2']],
    ['V2-LOCK-001', join(...HEAD, '@parallel=false', 'Scenario: s', '  * def b = 2'), ['V2-LOCK-001@6']],
    ['V2-CFG-001', join('Feature: x', 'Background:', "  * url 'http://localhost:8080'", 'Scenario: s', '  * def b = 2'), ['V2-CFG-001@3']],
    ['V2-CFG-002', join('Feature: x', 'Scenario: s', "  Given path 'a'", '  When method get', '  Then status 200', '  And match response == {}'), ['V2-CFG-002@4']],
    ['V2-SEC-001', join(...HEAD, 'Scenario: s', "  * header Authorization = 'Bearer abcdef0123456789abcdef'", '  When method get', '  Then status 200', '  And match response == {}'), ['V2-SEC-001@7']],
    ['V2-ASSERT-001', join(...HEAD, 'Scenario: s', '  When method get'), ['V2-ASSERT-001@7']],
    ['V2-ASSERT-002', join(...HEAD, 'Scenario: s', '  When method get', '  Then status 200'), ['V2-ASSERT-002@7']],
    ['V2-DRAFT-001', join(...HEAD, 'Scenario: s', '  * def a = 1', '  # TODO fill in', '  When method get', '  Then status 404'), ['V2-DRAFT-001@8']],
    ['V2-DUP-001', join(...HEAD, 'Scenario: same', '  * def a = 1', 'Scenario: same', '  * def b = 2'), ['V2-DUP-001@8']],
    ['V2-API-001', join(...HEAD, 'Scenario: s', '  * karate.stop(9000)'), ['V2-API-001@7']],
    ['V2-API-002', join(...HEAD, 'Scenario: s', '  * def j = karate.toJava(x)'), ['V2-API-002@7']],
    ['V2-NUM-001', join(...HEAD, 'Scenario: s', '  * def n = 9007199254740993'), ['V2-NUM-001@7']]
];

const tests = cases.map(([id, text, expected]) => ({
    name: `quality: ${id} triggers exactly itself at the right line`,
    run() { assert.deepEqual(found(text), expected); }
}));

tests.push(
    {
        name: 'quality: V2-REF-001 only with knownFiles',
        run() {
            const t = join(...HEAD, 'Scenario: s', "  * def a = read('classpath:common/missing.feature')", "  * def b = read(\"classpath:common/auth.feature\")");
            assert.deepEqual(found(t), []);
            assert.deepEqual(found(t, { knownFiles: new Set(['common/auth.feature']) }), ['V2-REF-001@7']);
        }
    },
    {
        name: 'quality: V2-TAG-001 flags non-taxonomy category tag',
        run() {
            const config = JSON.parse(JSON.stringify(cfg().DEFAULT_GENERATOR_CONFIG));
            config.tags.taxonomy.security = '@sec';
            const t = join(...HEAD, '@security', 'Scenario: s', '  * def a = 1');
            assert.deepEqual(found(t, { config }), ['V2-TAG-001@6']);
            assert.deepEqual(found(t), []);
            assert.deepEqual(found(join(...HEAD, '@sec @smoke', 'Scenario: s', '  * def a = 1'), { config }), []);
        }
    },
    {
        name: 'quality: clean fixture has no findings (valid v2 idioms)',
        run() {
            const t = join(
                '@lock=orders',
                'Feature: Orders', '',
                'Background:', '  * url baseUrl', '',
                'Scenario: ok',
                "  Given path 'orders'",
                '  When method get',
                '  Then assert [200].indexOf(responseStatus) !== -1',
                "  And match response == { id: '#present', name: '##string', gone: '#notpresent' }",
                "  * header Authorization = 'Bearer ' + authToken",
                "  * def password = karate.sysenv('PW')",
                "  * match response == { token: '#string' }",
                '',
                '@ignore',
                'Scenario: draft',
                '  # TODO write this',
                '  * def x = 1',
                '  * method get',
                '',
                '# TODO later',
                '@ignore',
                'Scenario: draft2',
                '  * def y = 2');
            assert.deepEqual(found(t), []);
        }
    },
    {
        name: 'quality: @ignore skips rules except DUP and GHERKIN; feature-level @ignore applies to all',
        run() {
            const t = join('@ignore', 'Feature: x', 'Scenario: s', '  * method get', 'Scenario: s', '  * method get');
            assert.deepEqual(found(t), ['V2-DUP-001@5']);
        }
    },
    {
        name: 'quality: Scenario Outline treated like a scenario; scenario without method not flagged',
        run() {
            const t = join(...HEAD, 'Scenario Outline: o', '  When method get', 'Examples:', '  | a |', '  | 1 |', 'Scenario: none', '  * def a = 1');
            assert.deepEqual(found(t), ['V2-ASSERT-001@7']);
        }
    },
    {
        name: 'quality: url set in scenario or Background satisfies CFG-002; status via responseStatus ok',
        run() {
            const t = join('Feature: x', 'Scenario: s', '  Given url baseUrl', '  When method get', '  Then match responseStatus == 404');
            assert.deepEqual(found(t), []);
            assert.deepEqual(found(join('Feature: x', 'Scenario: s', '  * configure url baseUrl', '  When method get', '  Then status 400')), []);
        }
    },
    {
        name: 'quality: SEC-001 false positives and true positives',
        run() {
            const body = (step) => join(...HEAD, 'Scenario: s', `  * ${step}`);
            for (const ok of ["header Authorization = 'Bearer ' + authToken", "header Authorization = 'Bearer #(token)'", "def body = { password: '#(pw)' }", "def token = karate.sysenv('T')", "match response == { token: '#string' }", "def password = ''"]) {
                assert.deepEqual(found(body(ok)), [], ok);
            }
            for (const bad of ["header Authorization = 'Basic dXNlcjpwYXNzd29yZA=='", "def body = { password: 'hunter2' }", "def apiKey = 'abc123'", "header X-API-Key = 'abcdef123456'"]) {
                assert.deepEqual(found(body(bad)), ['V2-SEC-001@7'], bad);
            }
        }
    },
    {
        name: 'quality: NUM-001 ignores quoted and safe numbers',
        run() {
            const body = (step) => join(...HEAD, 'Scenario: s', `  * ${step}`);
            assert.deepEqual(found(body("def n = '9007199254740993'")), []);
            assert.deepEqual(found(body('def n = 9007199254740991')), []);
        }
    },
    {
        name: 'quality: CRLF tolerated with accurate lines; ok flag',
        run() {
            const t = join(...HEAD, 'Scenario: s', '  When method get').split('\n').join('\r\n');
            assert.deepEqual(found(t), ['V2-ASSERT-001@7']);
            assert.equal(q().runGate(t).ok, false);
            assert.equal(q().runGate(join(...HEAD, 'Scenario: s', '  * def j = karate.toJava(x)')).ok, true);
        }
    },
    {
        name: 'quality: parseFeature shape and RULES export',
        run() {
            const p = parser().parseFeature(join('@a', 'Feature: F', 'Background:', '  * url x', '@b', 'Scenario: s', '  * def a = 1'));
            assert.equal(p.scenarios.length, 1);
            assert.equal(p.scenarios[0].startLine, 6);
            assert.equal(p.scenarios[0].steps[0].line, 7);
            assert.equal(p.background.steps[0].text, 'url x');
            const ids = rules().RULES.map(r => r.id).sort();
            assert.equal(ids.length, 14);
            assert.ok(ids.includes('V2-REF-001') && ids.includes('V2-TAG-001'));
        }
    },
    {
        name: 'quality: trailing comment belongs to its own scenario, not the next',
        run() {
            const t = join(...HEAD, '@ignore', 'Scenario: draft', '  * def x = 1', '  # TODO finish', '', 'Scenario: real', '  * def y = 2');
            assert.deepEqual(found(t), []);
            const t2 = join(...HEAD, 'Scenario: real', '  * def y = 2', '  # TODO finish');
            assert.deepEqual(found(t2), ['V2-DRAFT-001@8']);
            assert.deepEqual(found(join(...HEAD, 'Scenario: s', '  * def y = 2 # TODOS later')), []);
            assert.deepEqual(found(join(...HEAD, 'Scenario: s', '  * def TODOS = 2')), []);
        }
    },
    {
        name: 'quality: Background steps scanned by NUM/API; @ignore feature skips them',
        run() {
            const bg = (step) => join('Feature: f', 'Background:', '  * url baseUrl', `  * ${step}`, 'Scenario: s', '  * def a = 1');
            assert.deepEqual(found(bg('def n = 9007199254740993')), ['V2-NUM-001@4']);
            assert.deepEqual(found(bg('karate.stop(9000)')), ['V2-API-001@4']);
            assert.deepEqual(found(bg('def j = karate.toJava(x)')), ['V2-API-002@4']);
            assert.equal(q().runGate(bg('def j = karate.toJava(x)')).findings[0].severity, 'warning');
            assert.deepEqual(found('@ignore\n' + bg('karate.stop(9000)')), []);
        }
    },
    {
        name: 'quality: docstring bodies scanned for secrets/numbers/API but are not steps',
        run() {
            const t = join(...HEAD, 'Scenario: s', '  Given request', '  """', '  {', '    "name": "Fido",', '    "password": "hunter2",', '    "ref": "#(token)",', '    "t": "<access_token>",', '    "id": 9007199254740993', '  }', '  """', '  When method post', '  Then status 400');
            assert.deepEqual(found(t), ['V2-SEC-001@11', 'V2-NUM-001@14']);
            const t2 = join(...HEAD, 'Scenario: s', '  Given request', '  """', '  * def a = 1', '  # TODO later', '  Given url x', '  """', '  When method post', '  Then status 400');
            assert.deepEqual(found(t2), []);
        }
    },
    {
        name: 'quality: KarateValidator delegates and no longer flags valid idioms',
        run() {
            const { KarateValidator } = require('../../out/utils/karateValidator');
            const ok = join(...HEAD, 'Scenario: s', '  When method get', "  Then status 200", "  And match response == { a: '#present' }");
            assert.deepEqual(KarateValidator.validateFeatureContent(ok), []);
            const bad = KarateValidator.validateFeatureContent(join(...HEAD, 'Scenario: s', '  When method get'));
            assert.deepEqual(bad.length, 1);
            assert.match(bad[0], /^Line 7: \[V2-ASSERT-001\] /);
        }
    }
);

module.exports = tests;
