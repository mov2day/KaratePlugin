/* Extension testing in disposable profiles. Testing flags are NEVER used by Scout. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { ScoutSession } = require('../out/services/scout/ScoutSession');
const { CompanionBrowserAdapter } = require('../out/services/scout/CompanionBrowserAdapter');
const { startScoutDemo } = require('../out/services/scout/demo');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karate-scout-companion-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label) { for (let i = 0; i < 100; i++) { if (await test()) return; await pause(100); } throw new Error(label); }
async function run(browser) {
    const demo = await startScoutDemo({ requireAuth: true });
    let context; const session = new ScoutSession();
    try {
        const extensionPath = path.join(root, browser + '-extension');
        fs.cpSync(path.resolve('resources/scout-companion'), extensionPath, { recursive: true });
        const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'));
        manifest.background.service_worker = 'test-driver.js';
        fs.writeFileSync(path.join(extensionPath, 'manifest.json'), JSON.stringify(manifest));
        fs.writeFileSync(path.join(extensionPath, 'test-driver.js'), "import { handlePopupMessage } from './background.js'; globalThis.scoutTestPair = handlePopupMessage;");
        context = await chromium.launchPersistentContext(path.join(root, browser), { channel: browser === 'edge' ? 'msedge' : 'chrome', headless: true,
            ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
        const cdp = await context.browser().newBrowserCDPSession();
        const extension = await cdp.send('Extensions.loadUnpacked', { path: extensionPath });
        console.log(browser + ': installed optional companion in temporary test profile');
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
        const page = context.pages()[0]; await page.goto(demo.url);
        async function signIn(user) { await page.locator('[name=username]').fill(user); await page.locator('[name=password]').fill('excluded'); await page.locator('[name=otp]').fill('123456'); await page.locator('button').click(); await page.waitForURL(demo.url + '/'); }
        await signIn('first-account');
        const cookieBefore = (await context.cookies())[0];
        const adapter = new CompanionBrowserAdapter();
        await session.connect({ browser, mode: 'companion', url: demo.url, allowedOrigins: [demo.url], excludedOrigins: [] }, adapter);
        const pairing = adapter.pairing;
        const result = await worker.evaluate(async ({ url, pairing }) => {
            const tabs = await chrome.tabs.query({}); const tab = tabs.find(item => item.url === url + '/');
            return globalThis.scoutTestPair({ operation: 'pair', tabId: tab.id, endpoint: pairing.endpoint, token: pairing.token });
        }, { url: demo.url, pairing });
        assert.deepEqual(result, {});
        assert.equal(adapter.capabilities.actions, true); assert.equal(adapter.capabilities.interaction, true);
        await session.startTeaching(); await page.locator('#quantity').fill('2'); await page.locator('#create-cart').click(); await page.locator('#checkout').click();
        await until(() => session.requireJourney().requests.length === 2, 'companion must deliver both REST responses'); await session.stopTeaching();
        const journey = session.requireJourney();
        assert.equal(journey.dependencies.length, 1); assert.equal(journey.actions.length, 3);
        assert.ok(!JSON.stringify(journey).includes(cookieBefore.value));
        session.update({ operation: 'update', baselineConfirmed: true, resetUrl: demo.url + '/reset' }); session.propose();
        journey.variants = journey.variants.filter(item => ['baseline','repeat'].includes(item.kind));
        for (const variant of journey.variants) { variant.expectation.confirmed = true; if (variant.kind === 'repeat') { variant.expectation.statuses = [200]; variant.expectation.assertions = [{ pointer: '/orderCount', operator: 'at-most', value: 1 }]; } }
        await session.explore();
        fs.writeFileSync(path.join(root, browser + '.json'), JSON.stringify(journey, null, 2));
        assert.deepEqual(journey.variants.map(item => item.outcome), ['passed','failed'], JSON.stringify(journey.variants.map(item => item.message)));
        demo.setFixed(true); demo.expireSessions(); await session.explore(); assert.equal(session.snapshot.status, 'auth-required');
        await signIn('second-account'); await session.resume();
        assert.deepEqual(journey.variants.map(item => item.outcome), ['passed','passed']);
        await session.disconnect(); await until(async () => !(await worker.evaluate(() => chrome.storage.session.get('scoutTab'))).scoutTab, 'companion detaches');
        assert.equal(page.isClosed(), false, 'existing tab stays open'); assert.ok((await context.cookies()).length, 'sign-in stays in the browser');
        console.log(`PASS ${browser} companion: existing sign-in, capture, defect evidence, account switch, session resume, clean detach`);
        await cdp.send('Extensions.uninstall', { id: extension.id });
    } finally { await session.disconnect(); await context?.close(); await demo.close(); }
}
(async () => { for (const browser of ['chrome','edge']) await run(browser); console.log('Companion evidence:', root); })().catch(error => { console.error(error); console.error('Evidence:', root); process.exitCode = 1; });
