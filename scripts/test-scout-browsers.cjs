/* Real installed-browser integration: dedicated temporary profiles, local fixture only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ScoutSession } = require('../out/services/scout/ScoutSession');
const { LaunchedBrowserAdapter } = require('../out/services/scout/LaunchedBrowserAdapter');
const { generateScoutSuite } = require('../out/services/scout/ScoutGenerator');
const { startScoutDemo } = require('../out/services/scout/demo');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karate-scout-browser-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description) {
    for (let i = 0; i < 100; i++) { if (predicate()) return; await pause(50); }
    assert.ok(predicate(), description);
}
async function karate(journey, name, properties = {}, fixtures = {}) {
    const suite = generateScoutSuite(journey);
    assert.deepEqual(suite.draftReasons, []);
    const directory = path.join(root, name); fs.mkdirSync(directory);
    for (const [file, body] of Object.entries(suite.files)) fs.writeFileSync(path.join(directory, file), body);
    for (const [file, body] of Object.entries(fixtures)) fs.writeFileSync(path.join(directory, file), body);
    const jar = path.resolve('lib/karate-1.5.0.RC3.jar');
    const args = [...Object.entries(properties).map(([key,value])=>`-D${key}=${value}`), '-cp', [jar, directory].join(path.delimiter), 'com.intuit.karate.Main', '--output', path.join(directory, 'reports'), path.join(directory, 'journey.feature')];
    return new Promise((resolve, reject) => {
        const child = spawn('java', args, { cwd: directory }); let output = '';
        child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
        const timer = setTimeout(() => child.kill(), 60000);
        child.once('error', reject); child.once('exit', code => { clearTimeout(timer); fs.writeFileSync(path.join(directory, 'run.log'), output); resolve({ code, output, suite }); });
    });
}

async function run(browser) {
    const demo = await startScoutDemo();
    const runtime = path.resolve('lib/scout-runtime/playwright-core');
    const adapter = new LaunchedBrowserAdapter(path.join(root, browser), fs.existsSync(runtime) ? runtime : undefined, true);
    const session = new ScoutSession();
    try {
        await session.connect({ browser, mode: 'launch', url: demo.url, allowedOrigins: [demo.url], excludedOrigins: [] }, adapter, 'Checkout acceptance');
        await session.startTeaching();
        // Tests inspect the owned page, never a user's profile or browser session.
        const page = adapter.page;
        await page.locator('#quantity').fill('2'); await page.locator('#create-cart').click();
        await page.locator('#checkout').click();
        await until(() => session.requireJourney().requests.length === 2, 'both REST calls captured');
        await session.stopTeaching();
        const journey = session.requireJourney();
        assert.equal(journey.actions.filter(action => action.kind === 'fill').length, 1);
        assert.equal(journey.actions.find(action => action.kind === 'fill').value, '2');
        assert.equal(journey.dependencies.length, 1, 'cart ID links into checkout');
        assert.equal(journey.dependencies[0].fromPointer, '/cartId');
        session.update({ operation: 'update', baselineConfirmed: true, resetUrl: demo.url + '/reset', auth: 'none' });
        journey.expectations[0].assertions = [{ pointer: '/quantity', operator: 'equals', value: 2 }];
        session.propose();
        journey.variants = journey.variants.filter(item => ['baseline','repeat'].includes(item.kind));
        for (const variant of journey.variants) {
            variant.expectation.confirmed = true;
            if (variant.kind === 'repeat') { variant.expectation.statuses = [200]; variant.expectation.assertions = [{ pointer: '/orderCount', operator: 'at-most', value: 1 }]; }
        }
        await session.explore();
        fs.writeFileSync(path.join(root, browser + '-journey.json'), JSON.stringify(journey, null, 2));
        assert.equal(journey.variants[0].outcome, 'passed', journey.variants[0].message);
        assert.equal(journey.variants[1].outcome, 'failed', journey.variants[1].message);
        assert.equal(journey.verification.browser.passed, true);
        assert.equal(journey.verification.karate, undefined);
        assert.notEqual(journey.variants[0].evidence[0].response.body.cartId, journey.requests[0].response.body.cartId, 'reset replay uses a new ID');
        if (browser === 'chrome') {
            const before = await karate(journey, 'before-fix');
            assert.notEqual(before.code, 0, 'generated independent suite catches seeded defect');
            assert.match(before.output, /response\["orderCount"\] <= 1/, before.output.slice(-7000));
        }
        demo.setFixed(true);
        await session.explore();
        assert.deepEqual(journey.variants.map(item => item.outcome), ['passed', 'passed'], JSON.stringify(journey.variants.map(item => item.message)));
        if (browser === 'chrome') {
            const after = await karate(journey, 'after-fix');
            assert.equal(after.code, 0, after.output.slice(-10000));
            assert.match(after.output, /passed:\s+2/);
        }
        console.log(`PASS ${browser}: record actions + API, link fresh IDs, detect repeat defect, pass after fix`);
        await page.close();
        await until(() => session.snapshot.status === 'disconnected', 'closed tab is reported');
    } finally { await session.disconnect(); await demo.close(); }
}

async function authentication(browser) {
    const demo = await startScoutDemo({ requireAuth: true, fixed: true });
    const adapter = new LaunchedBrowserAdapter(path.join(root, browser + '-sso'), undefined, true);
    const session = new ScoutSession();
    try {
        await session.connect({ browser, mode: 'launch', url: demo.url, allowedOrigins: [demo.url], excludedOrigins: [] }, adapter);
        const page = adapter.page;
        const signIn = async () => {
            await page.locator('input[name=username]').fill('test-user');
            await page.locator('input[name=password]').fill('do-not-record');
            await page.locator('input[name=otp]').fill('123456');
            await page.locator('button').click(); await page.waitForURL(demo.url + '/');
        };
        await page.goto(demo.url + '/sso');
        const popupPromise = page.waitForEvent('popup'); await page.locator('button').click(); const popup = await popupPromise;
        await popup.locator('[name=username]').fill('popup-user'); await popup.locator('[name=password]').fill('do-not-record'); await popup.locator('[name=otp]').fill('123456'); await popup.locator('button').click();
        await page.waitForURL(demo.url + '/');
        assert.equal(session.requireJourney().actions.length, 0, 'manual login excluded');
        await session.startTeaching(); await page.locator('#create-cart').click(); await page.locator('#checkout').click();
        await until(() => session.requireJourney().requests.length === 2, 'authenticated APIs recorded'); await session.stopTeaching();
        const journey = session.requireJourney();
        assert.ok(!JSON.stringify(journey).includes('do-not-record'));
        assert.ok(!JSON.stringify(journey).includes('scout-session='));
        session.update({ operation: 'update', baselineConfirmed: true, resetUrl: demo.url + '/reset' }); session.propose();
        journey.variants = journey.variants.filter(item => item.kind === 'baseline'); journey.variants[0].expectation.confirmed = true;
        demo.expireSessions(); await session.explore();
        assert.equal(session.snapshot.status, 'auth-required'); assert.equal(journey.variants[0].outcome, 'auth-required');
        await signIn(); await session.resume();
        assert.equal(journey.variants[0].outcome, 'passed', journey.variants[0].message);
        if (browser === 'chrome') {
            const unauthenticated = await karate(journey, 'auth-required'); assert.notEqual(unauthenticated.code, 0); assert.match(unauthenticated.output, /Authentication setup required/);
            const fixture = ['@ignore','Feature: Supported sample authentication','Scenario:', '  * configure followRedirects = false', `  Given url ${JSON.stringify(demo.url)}`, "  And path 'login'", "  And form field username = 'fixture-account'", "  And form field password = karate.properties['scout.testPassword']", '  When method post', '  Then status 302', "  * def cookies = {}", "  * eval cookies['scout-demo'] = responseCookies['scout-demo'].value", ''].join('\n');
            const authenticated = await karate(journey, 'auth-fixture', {'scout.authFixture':'classpath:auth.feature','scout.testPassword':'fixture-only'}, {'auth.feature':fixture});
            assert.equal(authenticated.code, 0, authenticated.output.slice(-10000));
        }
        await page.reload(); assert.equal(await adapter.currentUrl(), demo.url + '/');
        await page.goto(demo.url + '/logout'); assert.match(await adapter.currentUrl(), /\/login/);
        await signIn();
        console.log(`PASS ${browser}: SSO popup + redirects, manual MFA inputs excluded, expiry pauses, reauthentication resumes, refresh/logout`);
    } finally { await session.disconnect(); await demo.close(); }
}

(async () => {
    for (const browser of ['chrome','edge']) { await run(browser); await authentication(browser); }
    console.log('Scout browser and independent Karate evidence:', root);
})().catch(error => { console.error(error); console.error('Evidence:', root); process.exitCode = 1; });
