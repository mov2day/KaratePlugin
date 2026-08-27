const fs = require('fs');

const provider = fs.readFileSync('src/webview/WebviewProvider.ts', 'utf8');
const app = fs.readFileSync('src/webview/app/main.tsx', 'utf8');
const config = fs.readFileSync('tsconfig.json', 'utf8');

const requirements = [
  ['unreachable code protection', /"allowUnreachableCode"\s*:\s*false/],
  ['sidebar layout marker', /data-management-layout="\$\{layout\}"/],
  ['expanded editor workspace', /createWebviewPanel\(\s*'karateManagementWorkspace'/],
  ['expanded workspace action', /openExpandedWorkspace/],
  ['generation-first onboarding', /Generate your first tests|Generate tests/],
  ['advanced OpenAPI generation', /generateFromOpenAPI/],
  ['per-run HTTP method controls', /HTTP methods/]
];

const sources = `${provider}\n${app}\n${config}`;
const missing = requirements.filter(([, pattern]) => !pattern.test(sources)).map(([name]) => name);
if (missing.length) {
  console.error(`Management webview regression check failed: ${missing.join(', ')}`);
  process.exit(1);
}

console.log('Management webview regression contract passed.');
