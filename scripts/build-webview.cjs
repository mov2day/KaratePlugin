const esbuild = require('esbuild');

esbuild.buildSync({
  entryPoints: ['src/webview/app/main.tsx'],
  bundle: true,
  minify: true,
  sourcemap: false,
  platform: 'browser',
  target: ['es2020'],
  format: 'iife',
  outfile: 'media/test-management.js',
  loader: { '.css': 'css' }
});
