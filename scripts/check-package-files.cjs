const childProcess = require('child_process');
const path = require('path');

const vsceBin = path.join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vsce.cmd' : 'vsce'
);

const output = childProcess.execFileSync(
  vsceBin,
  ['ls'],
  { encoding: 'utf8' }
);

const files = output
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const forbidden = [
  /^\.agents\//,
  /^\.github\//,
  /^scripts\//,
  /^src\//,
  /^out\/test\//,
  /^out\/debug\//,
  /\.ts$/,
  /\.map$/,
  /\.bak$/,
  /(^|\/)\.DS_Store$/,
  /\.vsix$/
];

const offenders = files.filter((file) => forbidden.some((pattern) => pattern.test(file)));

if (offenders.length > 0) {
  console.error('Forbidden files would be packaged:');
  for (const offender of offenders) {
    console.error(`- ${offender}`);
  }
  process.exit(1);
}

const required = [
  'package.json',
  'out/extension.js',
  'skills/karate-dsl-reference.md',
  'lib/karate-1.5.0.RC3.jar'
];

const missing = required.filter((file) => !files.includes(file));
if (missing.length > 0) {
  console.error('Required runtime files missing from package:');
  for (const file of missing) {
    console.error(`- ${file}`);
  }
  process.exit(1);
}

console.log(`Package content audit passed (${files.length} files).`);
