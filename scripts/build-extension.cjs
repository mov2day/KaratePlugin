const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

// Playwright resolves browser launch helpers relative to its own package directory.
// Preserve that runtime layout rather than inlining it into the extension bundle.
const runtime = path.join('lib', 'scout-runtime', 'playwright-core');
fs.rmSync(runtime, { recursive: true, force: true });
fs.mkdirSync(path.dirname(runtime), { recursive: true });
fs.cpSync('node_modules/playwright-core', runtime, { recursive: true, filter: file => !/\.(?:ts|map)$/.test(file) });

esbuild.buildSync({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: ['node18'],
  format: 'cjs',
  external: ['vscode'],
  outfile: 'out/extension.js'
});
