const assert = require('node:assert/strict');
const { generateScoutSuite } = require('../../out/services/scout/ScoutGenerator');
const { normalizeConnection } = require('../../out/services/scout/privacy');
const gate = () => require('../../out/generation/adapters/scoutGate');
const { OutputWriter } = require('../../out/generation/write/OutputWriter');

const connection = normalizeConnection({ browser: 'edge', mode: 'launch', url: 'https://shop.test', allowedOrigins: ['https://api.test'], excludedOrigins: [] });
const request = (id, extra = {}) => ({ id, timestamp: 1, method: 'POST', url: connection.url + 'api/cart', headers: {}, response: { status: 200, headers: {}, body: { cartId: 'cart-1' }, duration: 1 }, ...extra });
const confirmedJourney = (over = {}) => {
    const requests = [request('cart'), request('checkout', { timestamp: 2, url: 'https://shop.test/cart/cart-1?cartId=cart-1', body: { cartId: 'cart-1' } })];
    return { schemaVersion: 1, name: 'Fixture', connection, origin: 'har', actions: [], requests,
        expectations: requests.map(r => ({ requestId: r.id, statuses: [200], assertions: [{ pointer: '/cartId', operator: 'present' }], confirmed: true })),
        variants: [], dependencies: [], baselineConfirmed: true, freshDataPerRun: true, verification: { auth: 'none' }, ...over };
};
const memFs = (initial = {}) => {
    const files = new Map(Object.entries(initial));
    return { files, exists: p => files.has(p), read: p => files.get(p), list: () => [], write: (p, c) => files.set(p, c) };
};
const history = () => { const m = new Map(); return { get: p => m.get(p), set: (p, h) => m.set(p, h) }; };
const toWrite = (suite, dir, name = 'Fixture') => Object.entries(suite.files).map(([n, content]) => ({
    path: `${dir}/${n}`, content,
    owner: ['scout-data.json', 'scout-setup.feature', 'scout-reset.feature'].includes(n) ? 'user' : 'generated',
    source: n === 'journey.feature' ? `scout:${name}` : undefined
}));

module.exports = [
    {
        name: 'scout shared: generated suite passes the gate with zero errors and uses the sysprop idiom',
        run() {
            for (const journey of [confirmedJourney(), confirmedJourney({ verification: { auth: 'required' }, baselineConfirmed: false })]) {
                const suite = generateScoutSuite(journey);
                const r = gate().gateScoutSuite(suite);
                assert.deepEqual(r.findings.filter(f => f.finding.severity === 'error'), [], JSON.stringify(r.findings));
                assert.equal(r.ok, true);
                for (const text of Object.values(suite.files)) assert.ok(!text.includes('karate.properties['));
                assert.match(suite.files['scout-setup.feature'], /karate\.sysprop\('scout\.baseUrl', ''\)/);
                assert.match(suite.files['scout-setup.feature'], /karate\.sysprop\('scout\.authFixture', ''\)/);
                assert.match(suite.files['scout-reset.feature'], /karate\.sysprop\('scout\.resetFixture', ''\)/);
            }
        }
    },
    {
        name: 'scout shared: literal url in a scenario yields V2-CFG-001 and demotion makes it a passing @ignore draft',
        run() {
            const suite = generateScoutSuite(confirmedJourney());
            const bad = { ...suite, files: { ...suite.files, 'journey.feature': suite.files['journey.feature'].replace(/^(\s*)\* def response_1.*$/m, "$&\n  Given url 'http://x'\n  When method get") } };
            const r = gate().gateScoutSuite(bad);
            assert.equal(r.ok, false);
            assert.ok(r.findings.some(f => f.file === 'journey.feature' && f.finding.ruleId === 'V2-CFG-001'), JSON.stringify(r.findings));
            const { suite: fixed, demoted } = gate().demoteGateFailures(bad);
            assert.equal(demoted.length, 1);
            assert.match(fixed.files['journey.feature'], /@ignore\n\s*# Draft: Quality gate: V2-CFG-001\nScenario:/);
            assert.equal(fixed.runnableScenarios, 0);
            assert.ok(fixed.draftReasons.some(x => /Quality gate/.test(x)));
            assert.equal(gate().gateScoutSuite(fixed).ok, true);
        }
    },
    {
        name: 'scout shared: demotion leaves clean suites untouched and never throws on garbage',
        run() {
            const suite = generateScoutSuite(confirmedJourney());
            const r = gate().demoteGateFailures(suite);
            assert.equal(r.suite, suite); assert.deepEqual(r.demoted, []);
            assert.doesNotThrow(() => gate().demoteGateFailures({ files: { 'journey.feature': "Feature: x\n  Given url 'http://x'\n" }, runnableScenarios: 0, draftReasons: [] }));
            assert.doesNotThrow(() => gate().gateScoutSuite({ files: { 'journey.feature': null } }));
        }
    },
    {
        name: 'scout shared: writer protects user-owned scaffolds and journey edits',
        run() {
            const fsApi = memFs(); const hist = history(); const dir = '/w/scout-fixture';
            const v = { generatorVersion: '2.0.3' };
            const suite = generateScoutSuite(confirmedJourney());
            const first = OutputWriter.write(toWrite(suite, dir), fsApi, hist, v);
            assert.equal(first.created.length, 6);
            assert.match(fsApi.files.get(`${dir}/journey.feature`), /^# Generated by Karate Test Management 2\.0\.3 \| source: scout:Fixture \|/);
            // unchanged regeneration
            const again = OutputWriter.write(toWrite(suite, dir), fsApi, hist, v);
            assert.deepEqual(again.sideBySide, []);
            assert.ok(again.updated.includes(`${dir}/journey.feature`));
            assert.equal(again.skippedExisting.length, 3);
            // user edits setup + journey
            fsApi.files.set(`${dir}/scout-setup.feature`, '@ignore\nFeature: mine\n');
            fsApi.files.set(`${dir}/journey.feature`, fsApi.files.get(`${dir}/journey.feature`) + '# my edit\n');
            const third = OutputWriter.write(toWrite(generateScoutSuite(confirmedJourney({ name: 'Fixture' })), dir), fsApi, hist, v);
            assert.equal(fsApi.files.get(`${dir}/scout-setup.feature`), '@ignore\nFeature: mine\n');
            assert.equal(third.sideBySide.length, 1);
            assert.equal(third.sideBySide[0].generatedPath, `${dir}/journey.generated.feature`);
            assert.match(fsApi.files.get(`${dir}/journey.feature`), /# my edit/);
        }
    },
    {
        name: 'scout shared: saveScoutSuite gates, demotes, writes protected and reports',
        run() {
            const { saveScoutSuite } = require('../../out/services/scout/saveSuite');
            const fsApi = memFs(); const hist = history(); const dir = '/w/s1';
            const clean = saveScoutSuite(generateScoutSuite(confirmedJourney()), dir, 'Fixture', fsApi, hist, '2.0.3');
            assert.equal(clean.errors, 0); assert.equal(clean.report.created.length, 6);
            assert.match(clean.summary.headline, /Quality gate: 0 errors \/ 0 warnings/);
            assert.equal(clean.summary.level, 'info');
            const base = generateScoutSuite(confirmedJourney());
            const bad = { ...base, files: { ...base.files, 'journey.feature': base.files['journey.feature'].replace(/^(\s*)\* def response_1.*$/m, "$&\n  Given url 'http://x'\n  When method get") } };
            const dir2 = '/w/s2';
            const r = saveScoutSuite(bad, dir2, 'Fixture', fsApi, hist, '2.0.3');
            assert.equal(r.demoted.length, 1); assert.equal(r.errors, 0); assert.equal(r.summary.level, 'warning');
            assert.match(fsApi.files.get(`${dir2}/journey.feature`), /# Draft: Quality gate: V2-CFG-001/);
            assert.ok(r.summary.details.some(d => /Demoted to draft/.test(d)));
            // resave over an edited journey: side-by-side reported
            fsApi.files.set(`${dir}/journey.feature`, fsApi.files.get(`${dir}/journey.feature`) + '# edit\n');
            const again = saveScoutSuite(generateScoutSuite(confirmedJourney()), dir, 'Fixture', fsApi, hist, '2.0.3');
            assert.equal(again.report.sideBySide.length, 1); assert.equal(again.summary.level, 'warning');
        }
    },
    {
        name: 'scout shared: V2-ASSERT-002 is allowed for Scout (raw gate warns, scout gate and save do not)',
        run() {
            const { runGate } = require('../../out/generation/quality/QualityGate');
            const { saveScoutSuite } = require('../../out/services/scout/saveSuite');
            const suite = generateScoutSuite(confirmedJourney({ expectations: confirmedJourney().requests.map(r => ({ requestId: r.id, statuses: [200], assertions: [], confirmed: true })) }));
            const raw = runGate(suite.files['journey.feature'], { knownFiles: new Set(Object.keys(suite.files)) });
            assert.ok(raw.findings.some(f => f.ruleId === 'V2-ASSERT-002' && f.severity === 'warning'), JSON.stringify(raw.findings));
            assert.deepEqual(gate().gateScoutSuite(suite).findings, []);
            const r = saveScoutSuite(suite, '/w/a2', 'Fixture', memFs(), history(), '2.0.3');
            assert.match(r.summary.headline, /Quality gate: 0 errors \/ 0 warnings/);
        }
    },
    {
        name: 'scout shared: whole-Feature demotion recounts runnable as 0; stuck errors terminate without stacked tags',
        run() {
            const mk = text => ({ files: { 'journey.feature': text }, runnableScenarios: 2, draftReasons: [] });
            const bg = mk("Feature: x\n  Background:\n    Given url 'http://x'\n  Scenario: a\n    * def r = 1\n  Scenario: b\n    * def r = 2\n");
            const out = gate().demoteGateFailures(bg);
            assert.equal(out.suite.runnableScenarios, 0);
            assert.equal((out.suite.files['journey.feature'].match(/@ignore/g) || []).length, 1);
            // already-ignored scenario that still errors: no tag stacking, loop terminates
            const stuck = mk("Feature: x\n  @ignore\n  Scenario: a\n    * def r = karate.properties['p']\n  Scenario: b\n    Given url 'http://x'\n    When method get\n");
            const o2 = gate().demoteGateFailures(stuck);
            assert.ok(!/@ignore\n\s*(# [^\n]*\n\s*)?@ignore/.test(o2.suite.files['journey.feature']));
            assert.ok((o2.suite.files['journey.feature'].match(/@ignore/g) || []).length <= 2);
            assert.equal(o2.suite.runnableScenarios, 0);
        }
    },
    {
        name: 'scout shared: demotedMessage names the demoted scenarios',
        run() {
            const { demotedMessage } = require('../../out/services/scout/saveSuite');
            assert.match(demotedMessage(['Scenario: a (V2-CFG-001)']), /^Quality gate demoted Scenario: a \(V2-CFG-001\); fix or remove and re-save before verifying\.$/);
        }
    }
];
