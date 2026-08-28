const esbuild = require('esbuild');
const fs = require('fs');

esbuild.buildSync({
  entryPoints: ['src/webview/app/main.tsx'],
  bundle: true,
  minify: true,
  sourcemap: false,
  platform: 'browser',
  target: ['es2020'],
  format: 'iife',
  outfile: 'media/test-management.js',
  loader: { '.css': 'css', '.ttf': 'file' },
  assetNames: '[name]'
});

fs.copyFileSync('node_modules/chart.js/dist/chart.umd.js', 'media/chart.umd.js');
fs.copyFileSync('node_modules/mermaid/dist/mermaid.esm.min.mjs', 'media/mermaid.esm.min.mjs');
