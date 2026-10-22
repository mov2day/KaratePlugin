const assert = require('node:assert/strict');

const scaffold = () => require('../../out/generation/scaffold/ProjectScaffolder');
const writer = () => require('../../out/generation/write/OutputWriter');
const cfg = () => require('../../out/generation/config/GeneratorConfig');
const gate = () => require('../../out/generation/quality/QualityGate');

const project = (over = {}) => ({ classpathRoot: 'src/test/java', envConfigs: [], hasEnvJson: false, runnerStyle: 'unknown', ...over });
const model = (over = {}) => ({ source: 'openapi', name: 'Pets', schemes: [], operations: [], unsupported: [], ...over });
const plan = (p, c, m) => scaffold().planScaffold({ project: project(p), config: { ...cfg().DEFAULT_GENERATOR_CONFIG, ...(c || {}) }, model: model(m) });
const byPath = files => Object.fromEntries(files.map(f => [f.path, f]));

const memFs = (init = {}) => {
    const map = new Map(Object.entries(init));
    return {
        map,
        exists: p => map.has(p),
        read: p => { if (!map.has(p)) throw new Error('ENOENT'); return map.get(p); },
        list: d => [...map.keys()].filter(k => k.startsWith(d + '/')).map(k => k.slice(d.length + 1)),
        write: (p, c) => { map.set(p, c); }
    };
};
const memHistory = () => { const m = new Map(); return { m, get: p => m.get(p), set: (p, h) => m.set(p, h) }; };
const OPTS = { generatorVersion: '9.9.9' };
const feat = body => ({ path: 'f/a.feature', content: body, owner: 'generated', source: 'spec#a' });
const BODY = 'Feature: A\n\nScenario: s\n  * def a = 1\n';

module.exports = [
    {
        name: 'scaffold: fresh project yields base config, dev and staging configs, utils',
        run() {
            const m = byPath(plan());
            assert.ok(m['src/test/java/karate-config.js']);
            assert.ok(m['src/test/java/karate-config-dev.js']);
            assert.ok(m['src/test/java/karate-config-staging.js']);
            assert.ok(m['src/test/java/common/utils.feature']);
            assert.equal(m['src/test/java/common/auth.feature'], undefined);
            assert.match(m['src/test/java/karate-config.js'].content, /karate\.sysprop\('baseUrl', 'http:\/\/localhost:8080'\)/);
            assert.match(m['src/test/java/karate-config.js'].content, /karate\.env \|\| 'dev'/);
            assert.match(m['src/test/java/karate-config.js'].content, /karate\.configure\('connectTimeout', 5000\)/);
        }
    },
    {
        name: 'scaffold: spec server url and custom url variable are used',
        run() {
            const m = byPath(plan({}, { config: { mode: 'standard', urlVariable: 'apiUrl', envs: ['dev'] } }, { baseUrl: 'https://api.x.io' }));
            const c = m['src/test/java/karate-config.js'].content;
            assert.match(c, /config\.apiUrl = karate\.sysprop\('baseUrl', 'https:\/\/api\.x\.io'\)/);
        }
    },
    {
        name: 'scaffold: adopting a base config emits no config or env files, only helpers',
        run() {
            const p = project({ baseConfig: { path: 'src/test/java/karate-config.js', variables: ['apiUrl'] }, envConfigs: ['dev'] });
            const before = JSON.stringify(p);
            const files = scaffold().planScaffold({ project: p, config: cfg().DEFAULT_GENERATOR_CONFIG, model: model({ schemes: [{ name: 'b', kind: 'bearer' }] }) });
            assert.deepEqual(files.map(f => f.path).sort(), ['src/test/java/common/auth.feature', 'src/test/java/common/utils.feature']);
            assert.equal(JSON.stringify(p), before);
        }
    },
    {
        name: 'scaffold: env already listed is never emitted without base config',
        run() {
            const m = byPath(plan({ envConfigs: ['dev'] }));
            assert.equal(m['src/test/java/karate-config-dev.js'], undefined);
            assert.ok(m['src/test/java/karate-config-staging.js']);
        }
    },
    {
        name: 'scaffold: env files only override url when env var set, no fake host',
        run() {
            const m = byPath(plan());
            const c = m['src/test/java/karate-config-staging.js'].content;
            assert.match(c, /karate\.sysenv\('STAGING_BASE_URL'\)/);
            assert.match(c, /if \(url\) \{\s+config\.baseUrl = url;/);
            assert.doesNotMatch(c, /example\.com/);
        }
    },
    {
        name: 'scaffold: secret checks match what auth.feature reads, per scheme',
        run() {
            const cases = [
                [{ name: 'b', kind: 'bearer' }, ['API_TOKEN']],
                [{ name: 'b', kind: 'basic' }, ['API_USER', 'API_PASSWORD']],
                [{ name: 'o', kind: 'oauth2', tokenUrl: 'https://a/t' }, ['API_CLIENT_ID', 'API_CLIENT_SECRET']],
                [{ name: 'k', kind: 'apiKey', in: 'header', paramName: 'X' }, ['API_KEY']]
            ];
            for (const [scheme, vars] of cases) {
                const m = byPath(plan({}, {}, { schemes: [scheme] }));
                const staging = m['src/test/java/karate-config-staging.js'].content;
                assert.ok(staging.includes(`var required = [${vars.map(v => `'${v}'`).join(', ')}];`), scheme.kind);
                assert.match(staging, /throw new Error\(missing\.join/);
                assert.doesNotMatch(m['src/test/java/karate-config-dev.js'].content, /throw/);
                const auth = m['src/test/java/common/auth.feature'].content;
                for (const v of vars) assert.ok(auth.includes(`karate.sysenv('${v}'`), v);
            }
        }
    },
    {
        name: 'scaffold: multiple schemes add a note naming the ignored ones',
        run() {
            const a = byPath(plan({}, {}, { schemes: [{ name: 'one', kind: 'bearer' }, { name: 'two', kind: 'basic' }, { name: 'three', kind: 'apiKey' }] }))['src/test/java/common/auth.feature'].content;
            assert.match(a, /# Note: .*other schemes ignored: two, three/);
            assert.equal(gate().runGate(a).ok, true);
        }
    },
    {
        name: 'scaffold: bearer scheme wires configure auth with sysenv token',
        run() {
            const m = byPath(plan({}, {}, { schemes: [{ name: 'b', kind: 'bearer' }] }));
            const a = m['src/test/java/common/auth.feature'].content;
            assert.match(a, /\* def token = karate\.sysenv\('API_TOKEN', ''\)/);
            assert.match(a, /\* configure auth = \{ type: 'bearer', token: '#\(token\)' \}/);
            assert.match(a, /@ignore/);
        }
    },
    {
        name: 'scaffold: no scheme means no throw in env config',
        run() {
            const m = byPath(plan());
            assert.doesNotMatch(m['src/test/java/karate-config-staging.js'].content, /throw/);
        }
    },
    {
        name: 'scaffold: basic and oauth2 schemes',
        run() {
            let a = byPath(plan({}, {}, { schemes: [{ name: 'b', kind: 'basic' }] }))['src/test/java/common/auth.feature'].content;
            assert.match(a, /type: 'basic'/);
            assert.match(a, /API_USER/);
            assert.match(a, /API_PASSWORD/);
            a = byPath(plan({}, {}, { schemes: [{ name: 'o', kind: 'oauth2', tokenUrl: 'https://auth.x/token' }] }))['src/test/java/common/auth.feature'].content;
            assert.match(a, /type: 'oauth2'/);
            assert.match(a, /https:\/\/auth\.x\/token/);
            assert.match(a, /API_CLIENT_ID/);
            assert.match(a, /API_CLIENT_SECRET/);
        }
    },
    {
        name: 'scaffold: apiKey in header configures headers, in query only exposes variable',
        run() {
            let a = byPath(plan({}, {}, { schemes: [{ name: 'k', kind: 'apiKey', in: 'header', paramName: 'X-Api-Key' }] }))['src/test/java/common/auth.feature'].content;
            assert.match(a, /\* def apiKey = karate\.sysenv\('API_KEY', ''\)/);
            assert.match(a, /\* configure headers = \{ 'X-Api-Key': '#\(apiKey\)' \}/);
            a = byPath(plan({}, {}, { schemes: [{ name: 'k', kind: 'apiKey', in: 'query', paramName: 'key' }] }))['src/test/java/common/auth.feature'].content;
            assert.doesNotMatch(a, /configure headers/);
            assert.match(a, /# .*param key = apiKey/);
        }
    },
    {
        name: 'scaffold: env-json mode emits config json per env and reading karate-config',
        run() {
            const m = byPath(plan({}, { config: { mode: 'env-json', urlVariable: 'baseUrl', envs: ['dev', 'staging'] } }));
            const j = JSON.parse(m['src/test/java/config/dev.json'].content);
            assert.equal(j.baseUrl, 'http://localhost:8080');
            assert.equal(JSON.parse(m['src/test/java/config/staging.json'].content).baseUrl, 'http://localhost:8080');
            assert.equal(j.connectTimeout, 5000);
            assert.equal(j.readTimeout, 30000);
            assert.ok(m['src/test/java/config/staging.json']);
            assert.equal(m['src/test/java/karate-config-dev.js'], undefined);
            assert.match(m['src/test/java/karate-config.js'].content, /karate\.read\('classpath:config\/' \+ env \+ '\.json'\)/);
        }
    },
    {
        name: 'scaffold: feature files pass the gate; js files parse; no literal secrets',
        run() {
            const files = plan({}, {}, { schemes: [{ name: 'b', kind: 'bearer' }] })
                .concat(plan({}, {}, { schemes: [{ name: 'k', kind: 'apiKey', in: 'header', paramName: 'X' }] }))
                .concat(plan({}, {}, { schemes: [{ name: 'o', kind: 'oauth2', tokenUrl: 'https://a/t' }] }))
                .concat(plan({}, {}, { schemes: [{ name: 'b', kind: 'basic' }] }))
                .concat(plan({}, { config: { mode: 'env-json', urlVariable: 'baseUrl', envs: ['dev'] } }));
            for (const f of files) {
                if (f.path.endsWith('.feature')) {
                    const r = gate().runGate(f.content);
                    assert.deepEqual(r.findings.filter(x => x.severity === 'error'), [], f.path);
                    assert.equal(r.ok, true, f.path);
                } else if (f.path.endsWith('.js')) {
                    assert.doesNotThrow(() => new Function(f.content), f.path);
                }
                assert.doesNotMatch(f.content, /(token|password|secret)\s*[:=]\s*'[^'#]+'/i, f.path);
                assert.ok(f.path.startsWith('src/test/java/'));
                assert.equal(f.owner, 'user');
            }
        }
    },
    {
        name: 'writer: existing user file is skipped and unchanged',
        run() {
            const fsApi = memFs({ 'a/karate-config.js': 'mine' });
            const r = writer().OutputWriter.write([{ path: 'a/karate-config.js', content: 'new', owner: 'user' }, { path: 'a/new.js', content: 'x', owner: 'user' }], fsApi, memHistory(), OPTS);
            assert.deepEqual(r.skippedExisting, ['a/karate-config.js']);
            assert.deepEqual(r.created, ['a/new.js']);
            assert.equal(fsApi.map.get('a/karate-config.js'), 'mine');
        }
    },
    {
        name: 'writer: created file gets header with body hash; regenerating unchanged is updated',
        run() {
            const fsApi = memFs();
            const h = memHistory();
            const r1 = writer().OutputWriter.write([feat(BODY)], fsApi, h, OPTS);
            assert.deepEqual(r1.created, ['f/a.feature']);
            const text = fsApi.map.get('f/a.feature');
            assert.match(text.split('\n')[0], /^# Generated by Karate Test Management 9.9.9 \| source: spec#a \| hash: [0-9a-f]{64}$/);
            assert.ok(text.endsWith(BODY));
            const r2 = writer().OutputWriter.write([feat(BODY)], fsApi, h, OPTS);
            assert.deepEqual(r2.updated, ['f/a.feature']);
            assert.deepEqual(r2.sideBySide, []);
        }
    },
    {
        name: 'writer: edited generated file goes side by side, edit intact',
        run() {
            const fsApi = memFs();
            const h = memHistory();
            writer().OutputWriter.write([feat(BODY)], fsApi, h, OPTS);
            const edited = fsApi.map.get('f/a.feature') + '  * def b = 2\n';
            fsApi.map.set('f/a.feature', edited);
            const r = writer().OutputWriter.write([feat(BODY.replace('1', '3'))], fsApi, h, OPTS);
            assert.deepEqual(r.sideBySide, [{ path: 'f/a.feature', generatedPath: 'f/a.generated.feature' }]);
            assert.equal(fsApi.map.get('f/a.feature'), edited);
            assert.ok(fsApi.map.get('f/a.generated.feature').includes('* def a = 3'));
        }
    },
    {
        name: 'writer: header hash alone allows overwrite without history; non-feature naming',
        run() {
            const fsApi = memFs();
            writer().OutputWriter.write([feat(BODY)], fsApi, memHistory(), OPTS);
            const r = writer().OutputWriter.write([feat(BODY + '  * def z = 1\n')], fsApi, memHistory(), OPTS);
            assert.deepEqual(r.updated, ['f/a.feature']);
            const fs2 = memFs({ 'd/x.json': '{"edited":1}' });
            const r2 = writer().OutputWriter.write([{ path: 'd/x.json', content: '{}', owner: 'generated' }], fs2, memHistory(), OPTS);
            assert.deepEqual(r2.sideBySide, [{ path: 'd/x.json', generatedPath: 'd/x.generated.json' }]);
        }
    },
    {
        name: 'writer: CRLF files are treated like LF',
        run() {
            const fsApi = memFs();
            const h = memHistory();
            writer().OutputWriter.write([feat(BODY)], fsApi, h, OPTS);
            fsApi.map.set('f/a.feature', fsApi.map.get('f/a.feature').replace(/\n/g, '\r\n'));
            const r = writer().OutputWriter.write([feat(BODY)], fsApi, h, OPTS);
            assert.deepEqual(r.updated, ['f/a.feature']);
            assert.deepEqual(r.sideBySide, []);
        }
    },
    {
        name: 'writer: source with pipes and newlines is sanitised and round-trips',
        run() {
            const fsApi = memFs();
            const h = memHistory();
            const f = { ...feat(BODY), source: 'a | b\nc\r\nd' };
            writer().OutputWriter.write([f], fsApi, h, OPTS);
            const first = fsApi.map.get('f/a.feature').split('\n')[0];
            assert.match(first, /^# Generated by Karate Test Management 9.9.9 \| source: a b c d \| hash: [0-9a-f]{64}$/);
            const r = writer().OutputWriter.write([{ ...f, content: BODY + '  * def q = 1\n' }], fsApi, memHistory(), OPTS);
            assert.deepEqual(r.updated, ['f/a.feature']);
        }
    }
];
