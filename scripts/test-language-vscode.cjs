// End-to-end checks in a real VS Code extension host (the installed VS Code; nothing is downloaded).
//   KARATE_TEST_JAR=/path/karate-2.1.4.jar [OFFICIAL_EXT_DIR=/path/to/unzipped/extension] node scripts/test-language-vscode.cjs
// OFFICIAL_EXT_DIR is the `extension` folder of an unzipped karatelabs.karate VSIX; it is loaded next to this extension.
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const jar = process.env.KARATE_TEST_JAR;
const officialDir = process.env.OFFICIAL_EXT_DIR;
const code = process.env.VSCODE_EXECUTABLE || ['/Applications/Visual Studio Code.app/Contents/MacOS/Code'].find(fs.existsSync);
if (!jar || !fs.existsSync(jar)) { console.log('skipped: set KARATE_TEST_JAR to a Karate 2 jar'); process.exit(0); }
if (!code) { console.log('skipped: VS Code not found (set VSCODE_EXECUTABLE)'); process.exit(0); }

const karateFeature = [
  'Feature: demo', '', '  Background:', "    * def base = 'http://localhost'", '',
  '  Scenario: debug demo',
  "    * def user = { name: 'ada', tags: [1, 2] }",
  '    * def n = user.tags.length',
  '    * match n == 2',
  "    * print 'done'", ''
].join('\n');
const probeFeature = [
  'Feature: probe', '', '  Scenario: probe',
  '    * ',
  '    * match response ',
  "    * match response == { id: '#",
  "    * def users = read('",
  '    * def a = karate.',
  '    When method ',
  '    * header Authorization = ',
  "    * path 'ow", ''
].join('\n');
const plainFeature = 'Feature: login\n  Scenario: plain\n    Given I am on the home page\n    When I click \'Login\'\n    Then I see the dashboard\n';

function scenario(name, { config, official }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-')); // short: VS Code's IPC socket path is limited
  const ws = path.join(base, 'ws');
  fs.mkdirSync(path.join(ws, 'data'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.vscode'));
  fs.writeFileSync(path.join(ws, 'data', 'users.json'), '[]');
  fs.writeFileSync(path.join(ws, 'demo.feature'), karateFeature);
  fs.writeFileSync(path.join(ws, 'plain.feature'), plainFeature);
  fs.writeFileSync(path.join(ws, 'probe.feature'), probeFeature);
  if (config) { fs.writeFileSync(path.join(ws, 'karate-config.js'), 'function fn() { return {}; }\n'); }
  if (name === 'plain') { fs.rmSync(path.join(ws, 'demo.feature')); fs.rmSync(path.join(ws, 'probe.feature')); }
  fs.writeFileSync(path.join(ws, '.vscode', 'settings.json'), JSON.stringify({
    'karateDsl.execution.jarPath': path.resolve(jar), 'telemetry.telemetryLevel': 'off', 'update.mode': 'none'
  }));
  const common = ['--user-data-dir', path.join(base, 'u'), '--extensions-dir', path.join(base, 'x')];
  const resultFile = path.join(base, 'result.txt');
  const run = childProcess.spawnSync(code, [
    ...common, '--extensionDevelopmentPath', root, ...(official ? ['--extensionDevelopmentPath', officialDir] : []), '--extensionTestsPath', path.join(__dirname, 'vscode-tests', 'language-suite.cjs'),
    ...(official ? [] : ['--disable-extensions']), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu', ws
  ], { env: { ...process.env, WB_E2E_RESULT: resultFile, WB_SCENARIO: name }, encoding: 'utf8', timeout: 300_000 });
  const report = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : `(no result file)\n${run.stdout}\n${run.stderr}`;
  fs.rmSync(base, { recursive: true, force: true });
  return report;
}

const plan = [['karate', { config: true }], ['plain', { config: false }]];
if (officialDir && fs.existsSync(officialDir)) { plan.push(['official', { config: true, official: true }]); }
let failed = false;
for (const [name, options] of plan) {
  const report = scenario(name, options);
  console.log(`== ${name}\n${report}`);
  if (!/RESULT: PASS/.test(report)) { failed = true; }
}
process.exit(failed ? 1 : 0);
