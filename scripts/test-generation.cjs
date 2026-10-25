const fs = require('fs');
const path = require('path');
const vscodeStub = require('./generation-tests/support/vscode-stub.cjs');

async function main() {
    vscodeStub.install();
    const dir = path.join(__dirname, 'generation-tests');
    const tests = [];
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.cjs')).sort()) {
        const mod = require(path.join(dir, file));
        for (const t of [].concat(mod)) tests.push(t);
    }
    let failed = 0;
    for (const t of tests) {
        try {
            await t.run();
            console.log(`PASS ${t.name}`);
        } catch (error) {
            failed++;
            console.log(`FAIL ${t.name}\n  ${String(error && error.stack || error).split('\n').join('\n  ')}`);
        }
    }
    console.log(`\n${tests.length - failed}/${tests.length} passed`);
    vscodeStub.uninstall();
    process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
