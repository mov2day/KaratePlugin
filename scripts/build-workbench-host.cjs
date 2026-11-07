const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

// Compiles the Karate Workbench session host to plain .class files (the package audit forbids .jar files).
// Karate is reached through reflection, so only a JDK 21+ is needed here, not a Karate jar.
const sourceDir = path.join(__dirname, '..', 'workbench-host');
const sources = fs.readdirSync(sourceDir).filter(file => file.endsWith('.java')).map(file => path.join(sourceDir, file));
const output = path.join(__dirname, '..', 'resources', 'workbench', 'host');

function javac() {
  const home = process.env.JAVA_HOME;
  const candidates = [home ? path.join(home, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac') : '', 'javac'];
  for (const candidate of candidates.filter(Boolean)) {
    const probe = childProcess.spawnSync(candidate, ['-version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) { return candidate; }
  }
  return undefined;
}

const compiler = javac();
if (!compiler) {
  console.error('A JDK 21 or newer (javac) is required to build the Workbench host. Set JAVA_HOME or install a JDK.');
  process.exit(1);
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
const result = childProcess.spawnSync(compiler, ['--release', '21', '-Xlint:all', '-d', output, ...sources], { encoding: 'utf8' });
if (result.status !== 0) {
  console.error(result.stderr || result.stdout || 'javac failed');
  process.exit(1);
}
const classes = fs.readdirSync(output).filter(file => file.endsWith('.class'));
console.log(`Workbench host built (${classes.length} classes) -> ${path.relative(process.cwd(), output)}`);
