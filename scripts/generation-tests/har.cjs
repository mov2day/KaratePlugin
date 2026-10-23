const fs = require('fs');
const assert = require('node:assert/strict');
const { fixture } = require('./support/golden.cjs');

const out = rel => require('../../out/' + rel);
const cfgMod = () => out('generation/config/GeneratorConfig');
const adapter = () => out('generation/adapters/har');

const config = (over = {}) => {
    const base = JSON.parse(JSON.stringify(cfgMod().DEFAULT_GENERATOR_CONFIG));
    for (const [k, v] of Object.entries(over)) base[k] = { ...base[k], ...v };
    return base;
};

const TOKEN = 'tok-lit-123';
const COOKIE = 'sess-lit-456';
const APIKEY = 'key-lit-789';
const QTOKEN = 'qtok-lit-321';
const PW = 'pw-lit-654';
const BROWSER = { 'User-Agent': 'Mozilla/5.0 UA-LIT', 'Accept-Encoding': 'gzip', Host: 'shop.test', Origin: 'https://shop.test', Referer: 'https://shop.test/app', 'sec-ch-ua': 'x', Connection: 'keep-alive', 'Content-Length': '12' };

let seq = 0;
const entry = (method, url, o = {}) => {
    const u = new URL(url);
    const json = o.json !== undefined;
    const respBody = json ? JSON.stringify(o.json) : o.respBody;
    return {
        id: `r${++seq}`, timestamp: 1000 + seq, method, url, path: u.pathname + u.search, host: u.host,
        headers: { ...(o.headers ?? {}) },
        ...(o.body !== undefined ? { body: o.body } : {}),
        ...(o.noResponse ? {} : {
            response: {
                status: o.status ?? 200, headers: { 'content-type': o.type ?? (json ? 'application/json' : 'text/plain') },
                body: respBody, duration: 5
            }
        })
    };
};
const H = 'https://shop.test';

const journey = () => [
    entry('GET', `${H}/static/app.js`, { type: 'application/javascript', respBody: 'x', headers: BROWSER }),
    entry('GET', `${H}/assets/logo.png`, { type: 'image/png', respBody: 'x' }),
    entry('GET', `${H}/styles/site.css`, { type: 'text/css', respBody: 'x' }),
    entry('OPTIONS', `${H}/api/orders`, { status: 204 }),
    entry('POST', `${H}/api/orders`, {
        status: 201, headers: { ...BROWSER, 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, Cookie: `sid=${COOKIE}`, 'X-Api-Key': APIKEY, 'X-Request-Id': 'req-1' },
        body: JSON.stringify({ sku: 'ABC-1', quantity: 2, password: PW }),
        json: { id: 'ord-1001', status: 'NEW', total: 9.5, tags: ['a'], note: null }
    }),
    entry('GET', `${H}/api/orders/ord-1001?token=${QTOKEN}&page=1`, { headers: { ...BROWSER, Authorization: `Bearer ${TOKEN}`, Cookie: `sid=${COOKIE}` }, json: { id: 'ord-1001', status: 'NEW', quantity: 2 } }),
    entry('GET', `${H}/api/orders/ord-1001?token=${QTOKEN}&page=1`, { headers: { Authorization: `Bearer ${TOKEN}` }, json: { id: 'ord-1001', status: 'NEW', quantity: 2 } }),
    entry('PUT', `${H}/api/orders/ord-1001`, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ orderId: 'ord-1001', quantity: 3 }), json: { id: 'ord-1001', quantity: 3 } }),
    entry('DELETE', `${H}/api/orders/ord-1001`, { status: 204, headers: { Authorization: `Bearer ${TOKEN}` } })
];

const opts = (over = {}) => ({ config: config(), name: 'Order journey', mode: 'har', sourceRef: 'journey.har', ...over });
const build = (entries = journey(), o = opts()) => adapter().buildHarModel(entries, o);
const render = (built, cfg = config()) => built.features.map(f => ({
    path: f.relativePath,
    text: out('generation/render/FeatureRenderer').renderFeature(f.feature, { style: cfg.style })
}));
const featureText = (built, cfg) => render(built, cfg).map(f => f.text).join('\n=====\n');
const allText = built => [featureText(built), ...built.files.map(f => f.content), JSON.stringify(built.model), JSON.stringify(built.unsupported), built.warnings.join('\n')].join('\n=====\n');

const gateAll = (built, cfg = config()) => {
    const { runGate } = out('generation/quality/QualityGate');
    const known = new Set(['common/auth.feature', 'common/utils.feature', ...built.files.map(f => f.path)]);
    return render(built, cfg).map(f => ({ path: f.path, gate: runGate(f.text, { knownFiles: known, config: cfg }) }));
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
const runFull = async (built, cfg = config()) => {
    const fsApi = memFs();
    const result = await out('generation/pipeline/GenerationPipeline').runPipeline({
        model: built.model, scenarios: built.features, extraFiles: built.files.map(f => ({ ...f, path: `src/test/java/${f.path}` })),
        config: cfg, project: { classpathRoot: 'src/test/java', envConfigs: [], hasEnvJson: false, runnerStyle: 'unknown' },
        fsApi, history: history(), generatorVersion: '9.9.9', sourceRef: 'journey.har', mode: 'har'
    });
    return { fsApi, result };
};

module.exports = [
    {
        name: 'har: static assets, preflight, failed and uncaptured requests are dropped; order is preserved',
        run() {
            const b = build([
                ...journey().slice(0, 4),
                entry('GET', `${H}/fonts/a.woff2`, { type: 'font/woff2', respBody: 'x' }),
                entry('GET', `${H}/img/a.svg?v=2`, { type: 'image/svg+xml', respBody: 'x' }),
                entry('GET', `${H}/api/aborted`, { status: 200, noResponse: true }),
                entry('GET', `${H}/api/health`, { json: { ok: true } }),
                entry('GET', `${H}/api/users`, { json: [{ id: 1 }] })
            ]);
            const t = featureText(b);
            for (const gone of ['app.js', 'logo.png', 'site.css', 'woff2', 'svg', "'aborted'", 'method options']) assert.ok(!t.includes(gone), gone);
            assert.match(t, /# NOT CAPTURED: GET \/api\/aborted/);
            assert.ok(t.indexOf("'health'") < t.indexOf("'users'"));
            assert.ok(b.warnings.some(w => /dropped/i.test(w)));
        }
    },
    {
        name: 'har: Authorization, Cookie, api keys, credential query params and body fields never reach any output',
        run() {
            const b = build();
            const text = allText(b);
            for (const secret of [TOKEN, COOKIE, APIKEY, QTOKEN, PW]) assert.ok(!text.includes(secret), `leaked ${secret}`);
            for (const noise of ['UA-LIT', 'gzip', 'sec-ch-ua', 'keep-alive', 'req-1']) assert.ok(!text.includes(noise), `kept ${noise}`);
            assert.ok(!/authorization/i.test(featureText(b).replace(/common\/auth\.feature/g, '')), 'Authorization header written');
            assert.ok(!/cookie/i.test(featureText(b)), 'cookie written');
            assert.ok(b.warnings.some(w => /cookie/i.test(w)));
        }
    },
    {
        name: 'har: a Bearer Authorization header becomes a model scheme and the call auth helper; secrets use karate.sysenv',
        run() {
            const b = build();
            assert.deepEqual(b.model.schemes.map(s => s.kind), ['bearer']);
            const t = featureText(b);
            assert.match(t, /\* url baseUrl\n/);
            assert.match(t, /\* call read\('classpath:common\/auth\.feature'\)/);
            assert.match(t, /\* def xApiKey = karate\.sysenv\('X_API_KEY', ''\)/);
            assert.match(t, /\* def token = karate\.sysenv\('TOKEN', ''\)/);
            assert.match(t, /\* def password = karate\.sysenv\('PASSWORD', ''\)/);
            assert.match(t, /header x-api-key = xApiKey/i);
            assert.match(t, /param token = token/);
            assert.deepEqual(b.model.operations.map(o => o.security).slice(0, 2), [['bearer'], ['bearer']]);
        }
    },
    {
        name: 'har: origin becomes model.baseUrl and no host appears in features or data files',
        run() {
            const b = build();
            assert.equal(b.model.source, 'har');
            assert.equal(b.model.baseUrl, 'https://shop.test');
            const text = [featureText(b), ...b.files.map(f => f.content)].join('\n');
            assert.ok(!text.includes('shop.test'), 'host leaked');
        }
    },
    {
        name: 'har: an id from a POST response is captured and reused in later paths and bodies',
        run() {
            const t = featureText(build());
            assert.match(t, /\* def orderId = response\.id/);
            assert.match(t, /Given path 'api', 'orders', orderId/);
            assert.match(t, /match response\.id == orderId/);
            assert.ok(!t.includes('ord-1001'), 'recorded id left in feature');
            assert.ok(t.indexOf('* def orderId') < t.indexOf("'orders', orderId"));
        }
    },
    {
        name: 'har: ids are substituted into request bodies (set on the copied data file) and never into non-id fields',
        run() {
            const b = build();
            const t = featureText(b);
            assert.match(t, /\* set body\d+\.orderId = orderId/);
            assert.ok(!/set body\d+\.quantity/.test(t));
            const put = b.files.find(f => /-\d+\.json$/.test(f.path) && f.content.includes('"quantity": 3'));
            assert.ok(put, 'PUT body data file');
            assert.ok(!put.content.includes('ord-1001'), 'recorded id left in the data file');
        }
    },
    {
        name: 'har: request JSON bodies are data files read with karate.copy; inline when externalize is false',
        run() {
            const b = build();
            assert.ok(b.files.every(f => f.owner === 'user' && f.path.startsWith('data/order-journey-')));
            assert.ok(b.files.length >= 2);
            assert.match(featureText(b), /karate\.copy\(read\('classpath:data\/order-journey-\d+\.json'\)\)/);
            const inline = build(journey(), opts({ config: config({ data: { smart: true, externalize: false } }) }));
            assert.equal(inline.files.length, 0);
            const t = featureText(inline, config({ data: { smart: true, externalize: false } }));
            assert.match(t, /And request \{/);
            assert.ok(!t.includes(PW));
            assert.match(t, /orderId: '#\(orderId\)'|"orderId": "#\(orderId\)"/);
        }
    },
    {
        name: 'har: repeated identical GETs collapse to the first; distinct requests are kept',
        run() {
            const t = featureText(build());
            assert.equal((t.match(/method get/g) ?? []).length, 1);
            const dup = build([
                entry('GET', `${H}/api/a`, { json: { n: 1 } }), entry('GET', `${H}/api/a`, { json: { n: 1 } }),
                entry('GET', `${H}/api/b`, { json: { n: 1 } }), entry('GET', `${H}/api/a?x=1`, { json: { n: 1 } })
            ]);
            assert.equal((featureText(dup).match(/method get/g) ?? []).length, 3);
        }
    },
    {
        name: 'har: allowedHosts drops other hosts and the base URL comes from an allowed one',
        run() {
            const b = build([
                entry('GET', 'https://analytics.example/collect', { json: { ok: true } }),
                entry('GET', `${H}/api/a`, { json: { ok: true } })
            ], opts({ allowedHosts: ['shop.test'] }));
            assert.equal(b.model.baseUrl, 'https://shop.test');
            assert.equal(b.model.operations.length, 1);
            assert.ok(!allowedLeak(b));
        }
    },
    {
        name: 'har: a request to a second origin is split into a drafted scenario with a reason, and the host is never written',
        run() {
            const b = build([
                entry('GET', `${H}/api/a`, { json: { ok: true } }),
                entry('GET', 'https://other.example.com/api/b', { json: { ok: true } })
            ]);
            const t = featureText(b);
            assert.ok(!t.includes('other.example.com'));
            assert.equal(b.unsupported.length, 1);
            assert.match(b.unsupported[0].reason, /different origin/);
            const scenarios = b.features[0].feature.scenarios;
            assert.equal(scenarios.length, 2);
            assert.equal(scenarios[0].draftReason, undefined);
            assert.match(scenarios[1].draftReason, /different origin/);
            assert.ok(!scenarios[0].steps.some(s => /'b'/.test(s.text)));
        }
    },
    {
        name: 'har: response assertions use markers, never recorded values, and bodies without JSON assert status only',
        run() {
            const b = build([
                entry('POST', `${H}/api/orders`, { status: 201, json: { id: 'ord-1001', uid: '123e4567-e89b-12d3-a456-426614174000', total: 9.5, ok: true, note: null, tags: ['a'], items: [{ sku: 'A-1', qty: 2 }, { sku: 'B-2', qty: 1 }], nested: { deep: { deeper: { deepest: { gone: { x: 1 } } } } } } }),
                entry('DELETE', `${H}/api/orders/1`, { status: 204 })
            ]);
            const t = featureText(b);
            assert.match(t, /Then status 201/);
            assert.match(t, /Then status 204/);
            assert.match(t, /'#string'/);
            assert.match(t, /'#uuid'/);
            assert.match(t, /'#number'/);
            assert.match(t, /'#boolean'/);
            assert.match(t, /'##/);
            assert.match(t, /'#\[\] #object'/);
            assert.match(t, /match each response\.items == \{/);
            assert.match(t, /'#object'/);
            for (const lit of ['ord-1001', '9.5', '123e4567', 'A-1', 'B-2']) assert.ok(!t.includes(lit), `literal ${lit}`);
            const deleteBlock = t.slice(t.indexOf('Then status 204'));
            assert.ok(!/match response/.test(deleteBlock));
        }
    },
    {
        name: 'har: oversized and very deep response objects are truncated to #object',
        run() {
            const wide = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i]));
            const t = featureText(build([entry('GET', `${H}/api/wide`, { json: { wide, small: { a: 1 } } })]));
            assert.ok(!t.includes('k59'));
            assert.match(t, /"?wide"?: '#object'/);
            assert.match(t, /a: '#number'|"a": "#number"/);
        }
    },
    {
        name: 'har: large integers are never rounded: request values stay exact strings, responses use #number',
        run() {
            const b = build([entry('POST', `${H}/api/big`, { status: 201, body: '{"ref":12345678901234567890,"n":1}', headers: { 'content-type': 'application/json' }, json: { x: 1 }, respBody: '{"id":12345678901234567890,"n":1}' })]);
            const data = b.files[0].content;
            assert.ok(data.includes('"12345678901234567890"'), data);
            const t = featureText(b);
            assert.ok(!t.includes('12345678901234567890'));
            assert.ok(!/def \w+ = response\.id/.test(t));
        }
    },
    {
        name: 'har: redirects and 304 are dropped; 4xx statuses are asserted as recorded',
        run() {
            const t = featureText(build([
                entry('GET', `${H}/api/old`, { status: 302, respBody: '' }),
                entry('GET', `${H}/api/missing`, { status: 404, json: { error: 'nope' } })
            ]));
            assert.ok(!t.includes("'old'"));
            assert.match(t, /Then status 404/);
        }
    },
    {
        name: 'har: form bodies become form fields with secrets from sysenv; raw bodies with credentials are omitted and drafted',
        run() {
            const b = build([
                entry('POST', `${H}/login`, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `user=ann&password=${PW}`, json: { ok: true } }),
                entry('POST', `${H}/raw`, { headers: { 'Content-Type': 'text/plain' }, body: `a=1&access_token=${QTOKEN}`, json: { ok: true } }),
                entry('POST', `${H}/xml`, { headers: { 'Content-Type': 'text/xml' }, body: `<login><password>${PW}</password></login>`, json: { ok: true } }),
                entry('POST', `${H}/bare`, { headers: { 'Content-Type': 'text/plain' }, body: `hello Bearer ${TOKEN}-abcdef`, json: { ok: true } })
            ]);
            const text = allText(b);
            assert.ok(!text.includes(PW) && !text.includes(QTOKEN) && !text.includes(TOKEN));
            const t = featureText(b);
            assert.match(t, /form field user = 'ann'/);
            assert.match(t, /form field password = password/);
            const s = b.features[0].feature.scenarios[0];
            assert.match(s.draftReason, /credential-like/);
            assert.match(t, /@ignore/);
        }
    },
    {
        name: 'har: plain text and XML bodies without credentials stay active and intact',
        run() {
            const b = build([entry('POST', `${H}/xml`, { headers: { 'Content-Type': 'text/xml' }, body: '<a><b>1</b></a>', json: { ok: true } })]);
            const t = featureText(b);
            assert.match(t, /<a><b>1<\/b><\/a>/);
            assert.match(t, /header Content-Type = 'text\/xml'/);
            assert.equal(b.features[0].feature.scenarios[0].draftReason, undefined);
        }
    },
    {
        name: 'har: an unrecognised Authorization scheme is dropped, never written, and drafts the scenario',
        run() {
            const b = build([entry('GET', `${H}/api/a`, { headers: { Authorization: 'Digest username="u", response="deadbeef00"' }, json: { ok: true } })]);
            assert.ok(!allText(b).includes('deadbeef00'));
            assert.match(b.features[0].feature.scenarios[0].draftReason, /Authorization/);
        }
    },
    {
        name: 'har: Basic Authorization maps to a basic scheme',
        run() {
            const b = build([entry('GET', `${H}/api/a`, { headers: { Authorization: 'Basic dXNlcjpwYXNzd29yZA==' }, json: { ok: true } })]);
            assert.deepEqual(b.model.schemes.map(s => s.kind), ['basic']);
            assert.ok(!allText(b).includes('dXNlcjpwYXNzd29yZA'));
        }
    },
    {
        name: 'har: one scenario per recorded flow, named from the name option, tagged, with a source per request',
        run() {
            const b = build();
            assert.equal(b.features.length, 1);
            const f = b.features[0];
            assert.equal(f.relativePath, 'order-journey/order-journey.feature');
            assert.equal(f.feature.scenarios.length, 1);
            const s = f.feature.scenarios[0];
            assert.equal(s.name, 'Order journey');
            assert.deepEqual(s.tags, ['@positive']);
            const t = featureText(b);
            assert.match(t, /# source: POST \/api\/orders\n/);
            assert.match(t, /\n {4}# source: GET \/api\/orders\/\{orderId\}\n {4}Given path/);
            assert.ok(!t.includes('ord-1001'));
            const flat = build(journey(), opts({ config: config({ layout: { strategy: 'flat', outputRoot: 'src/test/karate', classpathRoot: 'src/test/java' } }) }));
            assert.equal(flat.features[0].relativePath, 'order-journey.feature');
        }
    },
    {
        name: 'har: the product warning says HAR imports are inferred API sequences; session mode says recorded sessions',
        run() {
            assert.ok(build().warnings.some(w => /HAR imports are inferred API sequences/.test(w)));
            const s = build(journey(), opts({ mode: 'session' }));
            assert.equal(s.model.source, 'session');
            assert.ok(s.warnings.some(w => /Recorded sessions are inferred API sequences/.test(w)));
        }
    },
    {
        name: 'har: credential-shaped values in paths, custom headers and unrelated JSON keys are replaced, including in source comments',
        run() {
            const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig-lit-999';
            const b = build([
                entry('GET', `${H}/reset/${jwt}`, { headers: { 'X-Custom': 'keep-me', 'X-Session-Blob': `Bearer ${TOKEN}-zzzz`, 'X-Request-Id': 'abc' }, json: { ok: true } }),
                entry('POST', `${H}/api/note`, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memo: jwt, nested: [{ api_key: 'k-lit-1' }] }), json: { ok: true } })
            ]);
            const text = allText(b);
            for (const lit of [jwt, 'sig-lit-999', TOKEN, 'k-lit-1']) assert.ok(!text.includes(lit), `leaked ${lit}`);
            assert.match(text, /header X-Custom = 'keep-me'/);
            assert.ok(!/x-request-id/i.test(text));
            assert.match(featureText(b), /# source: GET \/reset\/\{credential\}/);
        }
    },
    {
        name: 'har: per-request source comments render above the step group and steps without a comment render unchanged',
        run() {
            const { renderStep } = out('generation/render/FeatureRenderer');
            const style = config().style;
            assert.equal(renderStep({ keyword: 'Given', text: 'path \'a\'', comment: 'source: GET /a' }, style, 2), "    # source: GET /a\n    Given path 'a'");
            assert.equal(renderStep({ keyword: 'Given', text: 'path \'a\'' }, style, 2), "    Given path 'a'");
        }
    },
    {
        name: 'har fix: an identical GET is kept after any write and collapsed when nothing was written in between',
        run() {
            const gets = b => (featureText(b).match(/method get/g) ?? []).length;
            assert.equal(gets(build([entry('GET', `${H}/api/orders`, { json: [] }), entry('POST', `${H}/api/orders`, { status: 201, json: { ok: true } }), entry('GET', `${H}/api/orders`, { json: [] })])), 2);
            assert.equal(gets(build([entry('GET', `${H}/api/orders`, { json: [] }), entry('GET', `${H}/api/orders`, { json: [] })])), 1);
            assert.equal(gets(build([entry('GET', `${H}/api/orders`, { json: [] }), entry('DELETE', `${H}/api/other/1`, { status: 204 }), entry('GET', `${H}/api/orders`, { json: [] })])), 2);
        }
    },
    {
        name: 'har fix: small numeric ids are linked only when the resource name matches; longer ids are linked',
        run() {
            const t = featureText(build([entry('POST', `${H}/api/orders`, { status: 201, json: { id: 7 } }), entry('GET', `${H}/api/users/7`, { json: { ok: true } })]));
            assert.ok(!/def \w+ = response\.id/.test(t) && t.includes("'users', '7'"), t);
            const t2 = featureText(build([entry('POST', `${H}/api/orders`, { status: 201, json: { id: 5512 } }), entry('GET', `${H}/api/users/5512`, { json: { ok: true } })]));
            assert.match(t2, /path 'api', 'users', orderId/);
            const t3 = featureText(build([entry('POST', `${H}/api/orders`, { status: 201, json: { id: 7 } }), entry('GET', `${H}/api/orders/7`, { json: { ok: true } })]));
            assert.match(t3, /path 'api', 'orders', orderId/);
        }
    },
    {
        name: 'har fix: recorded nulls are rendered optional and warned once',
        run() {
            const b = build([entry('GET', `${H}/api/a`, { json: { n: null } }), entry('GET', `${H}/api/b`, { json: { n: null } })]);
            assert.equal(b.warnings.filter(w => /Recorded nulls/.test(w)).length, 1);
        }
    },
    {
        name: 'redactUrl: credential query values, fragments and userinfo never survive; session logs only use redacted URLs',
        run() {
            const { redactUrl } = out('generation/adapters/secrets');
            const a = redactUrl('https://x.test/a?api_key=KEYLIT&x=1#frag');
            assert.ok(!a.includes('KEYLIT') && a.includes('x=1') && a.endsWith('#frag'), a);
            const b = redactUrl('https://user:pwlit@host.test/p?q=1');
            assert.ok(!b.includes('pwlit') && !b.includes('user:'), b);
            const dir = require('path').resolve(__dirname, '..', '..', 'src', 'services', 'session');
            for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.ts'))) {
                const lines = fs.readFileSync(require('path').join(dir, f), 'utf8').split('\n');
                lines.forEach((l, i) => {
                    if (/(logger\.\w+|this\.log|appendLine)\(/.test(l) && /\.url\b|targetUrl/.test(l) && !/redactUrl\(/.test(l)) assert.fail(`${f}:${i + 1} logs a raw URL: ${l.trim()}`);
                });
            }
        }
    },
    {
        name: 'har: no evidenced requests produce no features and a warning',
        run() {
            const b = build([entry('GET', `${H}/a.js`, { type: 'application/javascript', respBody: 'x' })]);
            assert.equal(b.features.length, 0);
            assert.ok(b.warnings.some(w => /No API requests/i.test(w)));
        }
    },
    {
        name: 'har: every produced feature passes the quality gate with zero errors',
        run() {
            for (const g of gateAll(build())) assert.deepEqual(g.gate.findings.filter(f => f.severity === 'error'), [], g.path);
            const mixed = build([...journey(), entry('GET', 'https://other.example.com/x', { json: { ok: true } }), entry('POST', `${H}/raw`, { headers: { 'Content-Type': 'text/plain' }, body: 'password=abc', json: { ok: true } })]);
            for (const g of gateAll(mixed)) assert.deepEqual(g.gate.findings.filter(f => f.severity === 'error'), [], g.path);
        }
    },
    {
        name: 'har: full pipeline with in-memory fs has zero gate errors, writes data and auth helper, and no secret reaches any file',
        async run() {
            const b = build();
            const { fsApi, result } = await runFull(b);
            assert.equal(result.gateErrors ?? 0, 0, JSON.stringify(result.gate ?? result.warnings));
            const paths = [...fsApi.map.keys()];
            assert.ok(paths.some(p => p.endsWith('order-journey/order-journey.feature')), paths.join(','));
            assert.ok(paths.some(p => p.endsWith('common/auth.feature')));
            assert.ok(paths.some(p => /data\/order-journey-\d+\.json$/.test(p)));
            const all = [...fsApi.map.values()].join('\n');
            for (const secret of [TOKEN, COOKIE, APIKEY, QTOKEN, PW]) assert.ok(!all.includes(secret), `leaked ${secret}`);
            const feature = fsApi.map.get(paths.find(p => p.endsWith('order-journey/order-journey.feature')));
            assert.ok(!feature.includes('@ignore'), 'happy-path journey must not be drafted');
        }
    },
    {
        name: 'har: output is deterministic',
        run() {
            const a = build(journey());
            seq = 0;
            const b = build(journey());
            assert.equal(allText(a), allText(b));
        }
    },
    {
        name: 'har: the fixture HAR (via HarImporter) imports into a gate-clean id-chained scenario',
        async run() {
            const { HarImporter } = out('services/session/HarImporter');
            const requests = await HarImporter.importFromContent(fs.readFileSync(fixture('har', 'session.har'), 'utf8'));
            const b = adapter().buildHarModel(requests, opts({ name: 'session', sourceRef: 'session.har' }));
            const t = featureText(b);
            assert.ok(!t.includes('app.js'));
            assert.match(t, /\* def orderId = response\.id/);
            assert.match(t, /path 'api', 'orders', orderId/);
            assert.equal(b.model.baseUrl, 'https://shop.test');
            for (const g of gateAll(b)) assert.deepEqual(g.gate.findings.filter(f => f.severity === 'error'), [], g.path);
        }
    },
    {
        name: 'har: a text body over the scan limit is omitted, the scenario drafted, and an unscanned secret never appears',
        run() {
            const mid = `${'q '.repeat(150000)}SEKRET-MID-HAR${' q'.repeat(150000)}`;
            const b = build([entry('POST', `${H}/api/notes`, { headers: { 'Content-Type': 'text/xml' }, body: `<n>${mid}</n>`, json: { id: 'n1' }, status: 201 })]);
            const all = allText(b);
            assert.ok(!all.includes('SEKRET-MID-HAR'));
            assert.match(featureText(b), /@ignore/);
            assert.match(all, /Body is larger than the scan limit \(\d+ chars\); provide it via a data file after reviewing it for secrets/);
            assert.ok(b.warnings.some(w => /larger than the scan limit/.test(w)));
        }
    },
    {
        name: 'har: a JSON string leaf over the scan limit becomes null, drafted, other leaves kept',
        run() {
            const body = JSON.stringify({ sku: 'ABC-1', note: `${'x'.repeat(150000)}SEKRET-LEAF-HAR`, quantity: 2 });
            const b = build([entry('POST', `${H}/api/notes`, { headers: { 'Content-Type': 'application/json' }, body, json: { id: 'n1' }, status: 201 })]);
            const all = allText(b);
            assert.ok(!all.includes('SEKRET-LEAF-HAR'));
            assert.match(all, /ABC-1/);
            assert.match(featureText(b), /@ignore/);
            assert.match(all, /larger than the scan limit/);
            assert.ok(b.warnings.some(w => /larger than the scan limit/.test(w)));
        }
    }
];

function allowedLeak(b) {
    return allText(b).includes('analytics.example');
}
