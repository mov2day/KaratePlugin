const fs = require('fs');

// Vendor bundles are intentionally kept local. This check covers every
// first-party webview source and the compiled application bundle, where an
// accidental debug statement or CDN URL would otherwise ship unnoticed.
const files = [
  'src/webview/app/main.tsx',
  'src/webview/app/style.css',
  'src/webview/WebviewProvider.ts',
  'media/test-management.js',
  'media/test-management.css',
  'media/main.js'
];
const forbidden = [/console\.log\s*\(/, /cdn\.jsdelivr\.net/i, /unpkg\.com/i];
const offenders = [];

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  for (const pattern of forbidden) {
    if (pattern.test(source)) offenders.push(`${file}: ${pattern}`);
  }
}

if (offenders.length) {
  console.error('First-party webview asset check failed:');
  offenders.forEach((item) => console.error(`- ${item}`));
  process.exit(1);
}

console.log('Webview asset audit passed.');
