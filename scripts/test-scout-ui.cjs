const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const output = path.resolve('output/playwright/scout'); fs.mkdirSync(output, { recursive: true });
const origin = 'https://sample.test';
const call = (id, actionId, endpoint, body, response) => ({ id, actionId, timestamp: 1, url: origin + endpoint, method: 'POST', headers: {}, body, response: { status: id === 'cart' ? 201 : 200, body: response, headers: {}, duration: 42 } });
const requests = [call('cart','create','/api/cart',{quantity:2},{cartId:'cart-123',quantity:2}),call('checkout','checkout','/api/checkout',{cartId:'cart-123'},{orderId:'order-456',orderCount:1})];
const expectation = { requestId: 'checkout', statuses: [200], assertions: [{ pointer: '/orderCount', operator: 'at-most', value: 1 }], confirmed: true };
const journey = { schemaVersion: 1, id: 'sample', name: 'Checkout · field notebook', connection: { browser: 'edge', mode: 'companion', url: origin, allowedOrigins:[origin],excludedOrigins:[] },origin:'browser',
    actions: [{id:'quantity',kind:'fill',label:'Quantity',value:'2'}, {id:'create',kind:'click',label:'Create cart'}, {id:'checkout',kind:'click',label:'Check out'}].map(action=>({...action,timestamp:1,url:origin,selector:'#'+action.id})),
    requests, dependencies: [{id:'cart-link',fromRequestId:'cart',fromPointer:'/cartId',toRequestId:'checkout',toPointer:'/cartId',target:'body',candidates:[{requestId:'cart',pointer:'/cartId'}],confirmed:true}],
    expectations: requests.map(item => ({requestId:item.id,statuses:[item.response.status],assertions:[],confirmed:true})),
    variants: [{id:'baseline',kind:'baseline',source:'observed',name:'Replay the taught journey',outcome:'passed',expectation,evidence:requests,message:'Confirmed expectations passed in this browser session.'},
        {id:'repeat',kind:'repeat',source:'observed',name:'Repeat Check out',outcome:'failed',expectation,evidence:[...requests,call('repeat-call','checkout','/api/checkout',{cartId:'cart-123'},{orderId:'order-457',orderCount:2})],message:'/orderCount did not satisfy at-most 1.'}],
    resetUrl:origin+'/reset',freshDataPerRun:false,baselineConfirmed:true,verification:{auth:'required',browser:{at:Date.now(),passed:true}} };
const snapshot = { status:'ready',journey,capabilities:{actions:true,responseBodies:true,interaction:true,limitations:[]}, message:'Exploration finished. Open a branch to review its evidence.' };
const theme = `:root{--vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-foreground:#c9d1d9;--vscode-descriptionForeground:#909ba8;--vscode-editor-background:#14191f;--vscode-sideBar-background:#10151a;--vscode-panel-background:#14191f;--vscode-panel-border:#303943;--vscode-widget-border:#303943;--vscode-input-background:#202832;--vscode-input-foreground:#e2e8ee;--vscode-input-border:#3b4653;--vscode-button-background:#17674f;--vscode-button-foreground:#f0fffa;--vscode-button-hoverBackground:#1f8063;--vscode-focusBorder:#5bd7b3;--vscode-testing-iconPassed:#5bd7b3;--vscode-testing-iconFailed:#f08c95;--vscode-errorForeground:#f08c95;--vscode-editorWarning-foreground:#eac279;--vscode-textCodeBlock-background:#10151a;--vscode-editor-font-family:monospace;--vscode-list-hoverBackground:#232c35;--vscode-list-activeSelectionBackground:#243a34;--vscode-list-activeSelectionForeground:#e2e8ee}`;
(async()=>{
    const browser = await chromium.launch({channel:'chrome',headless:true});
    try {
        const page = await browser.newPage({viewport:{width:1360,height:1000}}); const errors=[]; page.on('pageerror',error=>errors.push(error.message));
        await page.route('http://scout-preview.test/**', route => {
            const file = new URL(route.request().url()).pathname;
            if (file === '/') return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><link rel="stylesheet" href="/media/test-management.css"></head><body data-management-layout="expanded" data-app-icon="/resources/icon.svg"><div id="root"></div></body></html>'});
            const allowed = ['/media/test-management.css','/media/codicon.ttf','/resources/icon.svg'];
            return allowed.includes(file) ? route.fulfill({path:path.resolve('.'+file)}) : route.abort();
        });
        await page.goto('http://scout-preview.test/'); await page.addStyleTag({content:theme});
        await page.evaluate(()=>{window.scoutMessages=[];window.acquireVsCodeApi=()=>({getState:()=>({activeArea:'scout'}),setState:()=>{},postMessage:message=>window.scoutMessages.push(message)});});
        await page.addScriptTag({path:path.resolve('media/test-management.js')});
        await page.evaluate(()=>document.fonts.ready);
        await page.getByRole('heading',{name:'Show it once. Explore what follows.'}).waitFor();
        await page.getByLabel('Application URL',{exact:true}).fill(origin);
        await page.getByLabel('Required browser').selectOption('edge'); await page.getByLabel('Connection',{exact:true}).selectOption('companion');
        await page.getByRole('button',{name:'Get pairing details'}).click();
        const sent=await page.evaluate(()=>window.scoutMessages.filter(message=>message.command==='scout').at(-1));
        assert.equal(sent.request.connection.browser,'edge');assert.equal(sent.request.connection.mode,'companion');
        await page.screenshot({path:path.join(output,'setup.png'),fullPage:true});
        await page.evaluate(snapshot=>window.postMessage({type:'scoutSnapshot',data:snapshot},'*'),snapshot);
        await page.getByText('Verified in browser',{exact:true}).waitFor();
        assert.equal(await page.getByText('Verified in Karate',{exact:true}).count(),0);
        await page.getByRole('button',{name:'View evidence · 3 requests'}).click();
        await page.getByRole('region',{name:'Variation evidence'}).locator('details').last().locator('summary').click();
        await page.screenshot({path:path.join(output,'journey.png'),fullPage:true});
        for (const width of [1360,390]) {
            await page.setViewportSize({width,height:1000});
            assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),`no horizontal overflow at ${width}px`);
            if(width===390) await page.screenshot({path:path.join(output,'compact.png'),fullPage:true});
        }
        assert.deepEqual(errors,[]);
        console.log('PASS Scout UI: browser choice, command payload, separate verification labels, branch evidence, wide/compact layouts');
        console.log('Screenshots:',output);
    }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
