// End-to-end test inside a real VS Code extension host, using the installed VS Code (nothing is downloaded).
//   KARATE_TEST_JAR=/path/to/karate-2.1.4.jar node scripts/test-workbench-vscode.cjs
// Set VSCODE_EXECUTABLE to a Code binary if it is not in the default macOS location.
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const jar = process.env.KARATE_TEST_JAR;
const defaults = ['/Applications/Visual Studio Code.app/Contents/MacOS/Code'];
const code = process.env.VSCODE_EXECUTABLE || defaults.find(fs.existsSync);

if (!jar || !fs.existsSync(jar)) { console.log('skipped: set KARATE_TEST_JAR to a Karate 2 jar'); process.exit(0); }
if (!code) { console.log('skipped: VS Code not found (set VSCODE_EXECUTABLE)'); process.exit(0); }
if (!fs.existsSync(path.join(root, 'resources', 'workbench', 'host', 'KarateWorkbenchHost.class'))) {
  console.error('Run "npm run build:host" first.'); process.exit(1);
}

// VS Code's IPC socket path is limited to about 100 characters, so keep the profile path short.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wbe-'));
const workspace = path.join(base, 'ws');
fs.cpSync(path.join(__dirname, 'fixtures', 'workbench', 'plain'), workspace, { recursive: true });
fs.mkdirSync(path.join(workspace, '.vscode'));
fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({
  'karateDsl.execution.jarPath': path.resolve(jar),
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none'
}));
const resultFile = path.join(base, 'result.txt');

const api = childProcess.spawn(process.execPath, [path.join(__dirname, 'fixtures', 'workbench', 'api', 'server.js'), '8099'], { stdio: 'ignore' });
setTimeout(() => {
  const run = childProcess.spawnSync(code, [
    '--user-data-dir', path.join(base, 'u'),
    '--extensions-dir', path.join(base, 'x'),
    '--extensionDevelopmentPath', root,
    '--extensionTestsPath', path.join(__dirname, 'vscode-tests', 'workbench-suite.cjs'),
    '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu',
    workspace
  ], { env: { ...process.env, WB_E2E_RESULT: resultFile }, encoding: 'utf8', timeout: 300_000 });
  api.kill();
  const report = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : `(no result file)\n${run.stdout}\n${run.stderr}`;
  console.log(report);
  const leftovers = childProcess.spawnSync('pgrep', ['-f', 'KarateWorkbenchHost'], { encoding: 'utf8' }).stdout.trim();
  if (leftovers) { console.log(`WARNING: leftover host processes: ${leftovers.split('\n').join(',')}`); }
  fs.rmSync(base, { recursive: true, force: true });
  process.exit(run.status === 0 && /RESULT: PASS/.test(report) ? 0 : 1);
}, 800);
