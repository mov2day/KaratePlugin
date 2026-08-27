const fs = require('fs');

// Vendor bundles are intentionally kept local. This check covers every
// first-party webview source and the compiled application bundle, where an
// accidental debug statement or CDN URL would otherwise ship unnoticed.
function firstPartyWebviewFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return firstPartyWebviewFiles(file);
    return /\.(?:ts|tsx|css)$/.test(entry.name) ? [file] : [];
  });
}

const files = [
  ...firstPartyWebviewFiles('src/webview'),
  'src/services/health/HealthDashboardPanel.ts',
  'media/test-management.js',
  'media/test-management.css',
  'media/main.js'
];
const forbidden = [
  /console\.log\s*\(/,
  /cdn\.jsdelivr\.net/i,
  /unpkg\.com/i,
  /<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i
];
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
