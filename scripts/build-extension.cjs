const esbuild = require('esbuild');

esbuild.buildSync({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: ['node18'],
  format: 'cjs',
  external: ['vscode'],
  outfile: 'out/extension.js'
});
