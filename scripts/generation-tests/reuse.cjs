const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const engine = () => require('../../out/services/ReusabilityEngine').ReusabilityEngine;
const gate = () => require('../../out/generation/quality/QualityGate');
const join = (...l) => l.join('\n');

const SCEN = ['', 'Scenario: list', "  Given path 'orders'", '  When method get', '  Then status 200', '  And match response == []'];
const AUTH_FEATURE = join(
    'Feature: Orders', '', 'Background:', '  * url baseUrl', "  * def token = karate.sysenv('API_TOKEN', '')",
    "  * header Authorization = 'Bearer ' + token", ...SCEN);

const keys = r => r.commonFiles.map(f => f.path);

module.exports = [
    {
        name: 'reuse: a whole auth Background block moves to common/auth.feature with @ignore and a classpath callonce',
        run() {
            const r = engine().extract(AUTH_FEATURE);
            assert.deepEqual(keys(r), ['common/auth.feature']);
            const helper = r.commonFiles[0].content;
            assert.match(helper, /^@ignore\nFeature:/);
            assert.ok(helper.includes("* def token = karate.sysenv('API_TOKEN', '')"));
            assert.ok(helper.includes("* header Authorization = 'Bearer ' + token"));
            assert.ok(r.modifiedContent.includes("  * callonce read('classpath:common/auth.feature')"));
            assert.ok(!r.modifiedContent.includes('header Authorization'));
            assert.ok(r.modifiedContent.includes('  * url baseUrl'));
            assert.deepEqual(r.skipped.map(s => s.lines), ['* url baseUrl']);
        }
    },
    {
        name: 'reuse: scenario steps are never rewritten (Authorization mid-scenario untouched)',
        run() {
            const t = join('Feature: Orders', '', 'Background:', '  * url baseUrl', ...SCEN.slice(0, 2),
                "  * header Authorization = 'Bearer ' + token", "  * def token = 'x'", ...SCEN.slice(2),
                'Scenario: other', "  * header Authorization = 'Bearer ' + token", '  When method get');
            const r = engine().extract(t);
            assert.equal(r.modifiedContent, t);
            assert.deepEqual(r.commonFiles, []);
        }
    },
    {
        name: 'reuse: url / baseUrl / configure url lines stay in place and are reported',
        run() {
            const t = join('Feature: x', '', 'Background:', "  * def baseUrl = karate.sysprop('baseUrl', '')", '  * url baseUrl', '  * configure url = baseUrl', ...SCEN);
            const r = engine().extract(t);
            assert.equal(r.modifiedContent, t);
            assert.deepEqual(r.commonFiles, []);
            assert.equal(r.skipped.length, 3);
            assert.ok(r.skipped.every(s => /karate-config/.test(s.reason)));
        }
    },
    {
        name: 'reuse: a block with a literal bearer token is not extracted and is reported',
        run() {
            const t = join('Feature: x', '', 'Background:', '  * url baseUrl',
                "  * header Authorization = 'Bearer abcdef0123456789abcdef'", ...SCEN);
            const r = engine().extract(t);
            assert.equal(r.modifiedContent, t);
            assert.deepEqual(r.commonFiles, []);
            const s = r.skipped.find(x => x.lines.includes('Bearer abcdef'));
            assert.ok(s && /credential/i.test(s.reason));
            const t2 = join('Feature: x', '', 'Background:', "  * def token = 'plain-literal-secret'", ...SCEN);
            const r2 = engine().extract(t2);
            assert.deepEqual(r2.commonFiles, []);
            assert.ok(r2.skipped.some(x => /credential/i.test(x.reason)));
        }
    },
    {
        name: 'reuse: output never contains invented literals',
        run() {
            for (const t of [AUTH_FEATURE, join('Feature: x', '', 'Background:', '  * header Accept = "application/json"', ...SCEN)]) {
                const r = engine().extract(t);
                const all = [r.modifiedContent, ...r.commonFiles.map(f => f.content)].join('\n');
                assert.ok(!all.includes('mock-token') && !all.includes('localhost:8080'));
            }
        }
    },
    {
        name: 'reuse: a step depending on a def that stays behind is kept',
        run() {
            const t = join('Feature: x', '', 'Background:', "  * def userId = read('data.json')", '  * def authToken = userId.token', ...SCEN);
            const r = engine().extract(t);
            assert.equal(r.modifiedContent, t);
            assert.ok(r.skipped.some(s => s.lines.includes('authToken') && /defined by/.test(s.reason)));
        }
    },
    {
        name: 'reuse: extraction is idempotent',
        run() {
            const once = engine().extract(AUTH_FEATURE);
            const twice = engine().extract(once.modifiedContent);
            assert.equal(twice.modifiedContent, once.modifiedContent);
            assert.deepEqual(twice.commonFiles, []);
        }
    },
    {
        name: 'reuse: modified feature and helpers pass the quality gate',
        run() {
            const r = engine().extract(AUTH_FEATURE);
            const known = new Set(keys(r));
            const main = gate().runGate(r.modifiedContent, { knownFiles: known });
            assert.deepEqual(main.findings, []);
            for (const f of r.commonFiles) assert.deepEqual(gate().runGate(f.content, { knownFiles: known }).findings, [], f.path);
            // a missing helper is a gate matter, never fabricated
            assert.ok(gate().runGate(r.modifiedContent, { knownFiles: new Set() }).findings.some(f => f.ruleId === 'V2-REF-001'));
        }
    },
    {
        name: 'reuse: extraction is deterministic',
        run() {
            assert.deepEqual(engine().extract(AUTH_FEATURE), engine().extract(AUTH_FEATURE));
        }
    },
    {
        name: 'reuse: engine is pure (no vscode/logger imports) and getCommonDir computes a path',
        run() {
            const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/ReusabilityEngine.ts'), 'utf8');
            assert.ok(!/from\s+['"](vscode|.*logger)['"]/.test(src));
            assert.equal(engine().getCommonDir('/a/b/x.feature'), path.join('/a/b', 'common'));
        }
    },
    {
        name: 'reuse: no phantom-stub fabrication remains in src',
        run() {
            // Excluded: src/**/*.test.* (none today) and webview placeholder text is not matched by these literals.
            // scaffold/CI sample defaults (localhost:8080) are legitimate user-visible defaults, so only the
            // stub-specific literals are checked: the mock token, the stub function, and the stub log line.
            const bad = [];
            const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
                const p = path.join(d, e.name);
                if (e.isDirectory()) return walk(p);
                if (!/\.(ts|tsx)$/.test(e.name)) return;
                const t = fs.readFileSync(p, 'utf8');
                if (/mock-token|createStubFile|created stub for phantom/.test(t)) bad.push(path.relative(process.cwd(), p));
            });
            walk(path.resolve(__dirname, '../../src'));
            assert.deepEqual(bad, []);
        }
    }
];
