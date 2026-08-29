const fs = require('fs');

const provider = fs.readFileSync('src/webview/WebviewProvider.ts', 'utf8');
const app = fs.readFileSync('src/webview/app/main.tsx', 'utf8');
const config = fs.readFileSync('tsconfig.json', 'utf8');
const extension = fs.readFileSync('src/extension.ts', 'utf8');
const health = fs.readFileSync('src/services/health/ProjectAnalyzer.ts', 'utf8');
const types = fs.readFileSync('src/types/index.ts', 'utf8');

const requirements = [
  ['unreachable code protection', /"allowUnreachableCode"\s*:\s*false/],
  ['sidebar layout marker', /data-management-layout="\$\{layout\}"/],
  ['expanded editor workspace', /createWebviewPanel\(\s*'karateManagementWorkspace'/],
  ['expanded workspace action', /openExpandedWorkspace/],
  ['generation-first onboarding', /Generate your first tests|Generate tests/],
  ['advanced OpenAPI generation', /generateFromOpenAPI/],
  ['per-run HTTP method controls', /HTTP methods/],
  ['explicit coverage spec selection', /selectCoverageSpecs/],
  ['explicit coverage feature selection', /selectCoverageFeatures/],
  ['coverage requires both input arrays', /analyzeCoverage'; specPaths: string\[\]; featurePaths: string\[\]/],
  ['coverage report export', /exportCoverageReport/],
  ['coverage gap generation', /generateCoverageTest/],
  ['run report export', /exportRunReport/],
  ['run comparison', /Compare previous/],
  ['health dependency map', /Feature dependency map/],
  ['bug hunter evidence', /curl reproducer/],
  ['bug hunter probe trace', /Probe trace/],
  ['application icon in webview', /data-app-icon="\$\{appIconUri\}"/],
  ['folder-scoped history services', /testHistoryServices = new Map/],
  ['folder-scoped health analysis', /analyzeWorkspace\(folder\)/],
  ['folder-scoped feature discovery', /new vscode\.RelativePattern\(workspaceFolder, '\*\*\/\*\.feature'\)/]
];

const sources = `${provider}\n${app}\n${config}\n${extension}\n${health}\n${types}`;
const missing = requirements.filter(([, pattern]) => !pattern.test(sources)).map(([name]) => name);
if (/analyzeCoverage\(data\.folderPath\)/.test(provider)) missing.push('coverage must not analyse an implicit workspace-wide feature scope');
if (/codicon-beaker/.test(app)) missing.push('generic beaker branding must not replace the application icon');
if (missing.length) {
  console.error(`Management webview regression check failed: ${missing.join(', ')}`);
  process.exit(1);
}

console.log('Management webview regression contract passed.');
