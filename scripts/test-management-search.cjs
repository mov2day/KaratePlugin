const assert = require('assert');
const Module = require('module');
const esbuild = require('esbuild');

const output = esbuild.buildSync({
  entryPoints: ['src/webview/app/managementSearch.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false
}).outputFiles[0].text;
const compiled = new Module('management-search-test');
compiled.filename = 'management-search-test.js';
compiled._compile(output, compiled.filename);
const { searchManagement } = compiled.exports;

const source = {
  features: Array.from({ length: 1000 }, (_, index) => ({
    path: `features/checkout-${index}.feature`,
    scenarios: [{ name: `Checkout order ${index}`, tags: ['@checkout'] }]
  })),
  findings: Array.from({ length: 500 }, (_, index) => ({
    title: `Checkout coverage finding ${index}`,
    source: 'coverage',
    state: 'New',
    severity: 'normal'
  })),
  runs: Array.from({ length: 100 }, (_, index) => ({
    id: `checkout-run-${index}`,
    timestamp: index,
    status: 'success',
    options: { environment: 'staging', target: 'features' }
  }))
};

const started = performance.now();
const result = searchManagement(source, 'checkout');
const elapsed = performance.now() - started;

assert.strictEqual(result.total, 1600);
assert.strictEqual(result.scenarios.length, 5);
assert.strictEqual(result.findings.length, 4);
assert.strictEqual(result.runs.length, 4);
assert.ok(elapsed < 100, `indexed search took ${elapsed.toFixed(1)}ms`);
process.stdout.write(`Management search scale test passed (${elapsed.toFixed(1)}ms).\n`);
