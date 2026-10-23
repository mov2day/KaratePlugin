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
        name: 'reuse: a whole auth Background block moves to common/auth.feature with @ignore and a classpath call (header step => call)',
        run() {
            const r = engine().extract(AUTH_FEATURE);
            assert.deepEqual(keys(r), ['common/auth.feature']);
            const helper = r.commonFiles[0].content;
            assert.match(helper, /^@ignore\nFeature:/);
            assert.ok(helper.includes("* def token = karate.sysenv('API_TOKEN', '')"));
            assert.ok(helper.includes("* header Authorization = 'Bearer ' + token"));
            assert.ok(r.modifiedContent.includes("  * call read('classpath:common/auth.feature')"));
            assert.equal(r.commonFiles[0].callType, 'call');
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
            // No exclusions: every .ts/.tsx under src is scanned (tests live in scripts/, outside src).
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
    },
    {
        name: 'reuse: a request chain in the Background is never split (nothing moved, request-steps reason)',
        run() {
            const t = join('Feature: x', '', 'Background:', "  Given path '/oauth/token'", "  And form field grant_type = 'client_credentials'",
                '  When method post', '  Then status 200', '  * def token = response.access_token', ...SCEN);
            const r = engine().extract(t);
            assert.equal(r.modifiedContent, t);
            assert.deepEqual(r.commonFiles, []);
            assert.ok(r.skipped.some(s => /request/i.test(s.reason) && s.lines.includes('response.access_token')));
            assert.ok(!r.skipped.some(s => /already extracted/.test(s.reason)));
        }
    },
    {
        name: 'reuse: only the leading pure-* block moves; steps after a request stay',
        run() {
            const t = join('Feature: x', '', 'Background:', "  * def token = karate.sysenv('T', '')", "  Given path 'login'", '  When method post',
                '  Then status 200', "  * header Authorization = 'Bearer ' + token", ...SCEN);
            const r = engine().extract(t);
            assert.deepEqual(keys(r), ['common/auth.feature']);
            assert.equal(r.commonFiles[0].callType, 'callonce');
            assert.ok(r.modifiedContent.includes("  * callonce read('classpath:common/auth.feature')\n  Given path 'login'\n  When method post\n  Then status 200\n  * header Authorization"));
            assert.ok(r.skipped.some(s => /request/i.test(s.reason)));
        }
    },
    {
        name: 'reuse: callType is callonce only for pure data blocks',
        run() {
            const bg = (...steps) => join('Feature: x', '', 'Background:', ...steps, ...SCEN);
            const kind = t => engine().extract(t).commonFiles.map(f => f.callType);
            assert.deepEqual(kind(bg("  * def payload = { a: 1 }")), ['callonce']);
            assert.deepEqual(kind(bg("  * def payload = karate.call('x.feature')")), ['call']);
            assert.deepEqual(kind(bg("  * configure ssl = true")), ['call']);
            assert.deepEqual(kind(bg("  * header Accept = 'application/json'")), ['call']);
            assert.deepEqual(kind(bg("  * call read('classpath:common/cleanup-all.feature')")), ['call']);
            assert.deepEqual(kind(bg("  * def cleanup = 1")), []);
        }
    },
    {
        name: 'reuse: CRLF input keeps CRLF in the modified feature and the helpers',
        run() {
            const r = engine().extract(AUTH_FEATURE.replace(/\n/g, '\r\n'));
            assert.equal(r.commonFiles.length, 1);
            for (const t of [r.modifiedContent, r.commonFiles[0].content]) assert.ok(!/(^|[^\r])\n/.test(t), 'bare LF found');
        }
    },
    {
        name: 'reuse: content preservation, expanding every helper call restores the original step list',
        run() {
            const steps = t => t.split(/\r?\n/).map(l => l.trim()).filter(l => /^(\*|Given|When|Then|And|But)\s/.test(l));
            const outline = join('Feature: o', '', 'Background:', "  * def authToken = karate.sysenv('T', '')", "  * configure ssl = true", '',
                'Scenario Outline: x', "  Given path '<p>'", '  When method get', '  Then status 200', '  And match response == []', '  Examples:', '    | p |', '    | a |');
            const inputs = [
                AUTH_FEATURE,
                AUTH_FEATURE.replace(/\n/g, '\r\n'),
                outline,
                join('Feature: x', '', 'Background:', "  * def payload = { a: 1 }", "  * header Accept = 'application/json'", "  * def tokenA = karate.uuid()", ...SCEN),
                join('Feature: x', '', 'Background:', "  * def userId = read('d.json')", '  * def authToken = userId.token', ...SCEN),
                join('Feature: x', '', 'Background:', "  * def token = 'literal-secret'", "  * configure ssl = true", ...SCEN),
                join('Feature: x', '', 'Background:', "  Given path 'a'", '  When method post', '  Then status 200', '  * def token = response.t', ...SCEN),
                join('Feature: x', ...SCEN)
            ];
            for (const input of inputs) {
                const r = engine().extract(input);
                const files = new Map(r.commonFiles.map(f => [f.path, f.content]));
                const expanded = r.modifiedContent.split(/\r?\n/).flatMap(l => {
                    const m = /^\s*\*\s+(?:call|callonce)\s+read\('classpath:(common\/[^']+)'\)/.exec(l);
                    return m && files.has(m[1]) ? steps(files.get(m[1])) : steps(l);
                });
                assert.deepEqual(expanded, steps(input));
            }
        }
    },
    {
        name: 'reuse: a request followed by a blank line, comment or docstring body never lets a later def move',
        run() {
            const chain = ["  Given path '/oauth/token'", '  When method post', '  Then status 200'];
            const variants = {
                blank: [...chain, ''],
                comment: [...chain, '  # keep'],
                docstring: ["  Given path '/oauth/token'", '  And request """', '  { "a": 1 }', '  """', '  When method post', '  Then status 200', '  And request """', '  x', '  """'],
                table: [...chain, '  | a |']
            };
            for (const [name, lines] of Object.entries(variants)) {
                const t = join('Feature: x', '', 'Background:', ...lines, "  * def token = response.access_token", ...SCEN);
                const r = engine().extract(t);
                assert.equal(r.modifiedContent, t, name);
                assert.deepEqual(r.commonFiles, [], name);
                assert.ok(r.skipped.some(s => /request|response state/i.test(s.reason)), name);
                // same shape without response state: still blocked by adjacency to the request
                const t2 = join('Feature: x', '', 'Background:', ...lines, "  * def token = karate.sysenv('T', '')", ...SCEN);
                const r2 = engine().extract(t2);
                assert.equal(r2.modifiedContent, t2, name + ' (adjacency)');
                assert.ok(r2.skipped.some(s => /Follows a request step/.test(s.reason)), name);
                assert.deepEqual(engine().extract(r.modifiedContent).modifiedContent, r.modifiedContent);
            }
        }
    },
    {
        name: 'reuse: a block referencing response state is rejected with the response-dependency reason',
        run() {
            for (const id of ['response', 'responseStatus', 'responseHeaders', 'responseCookies', 'responseTime', 'responseBytes', 'responseType']) {
                const t = join('Feature: x', '', 'Background:', '  * def token = ' + id + '.x', ...SCEN);
                const r = engine().extract(t);
                assert.deepEqual(r.commonFiles, [], id);
                assert.ok(r.skipped.some(s => /response state/.test(s.reason)), id);
            }
        }
    },
    {
        name: 'reuse: karate.uuid()/faker blocks use plain call; sysenv/sysprop/copy stay callonce',
        run() {
            const kind = step => engine().extract(join('Feature: x', '', 'Background:', step, ...SCEN)).commonFiles.map(f => f.callType);
            assert.deepEqual(kind('  * def payload = { id: karate.uuid() }'), ['call']);
            assert.deepEqual(kind('  * def payload = { n: karate.faker.name() }'), ['call']);
            assert.deepEqual(kind("  * def payload = karate.sysprop('x', '1')"), ['callonce']);
            assert.deepEqual(kind('  * def payload = karate.copy(base)'), ['callonce']);
        }
    }
];
