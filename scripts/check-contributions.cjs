const fs = require('fs');
const path = require('path');

function readTree(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? readTree(fullPath) : (entry.name.endsWith('.ts') ? [fs.readFileSync(fullPath, 'utf8')] : []);
  });
}

const manifest = require('../package.json');
const source = readTree(path.join(process.cwd(), 'src')).join('\n');
const commands = manifest.contributes.commands.map((item) => item.command);
const unimplemented = commands.filter((command) => !source.includes(command));

if (unimplemented.length) {
  console.error('Contributed commands without an implementation reference:');
  unimplemented.forEach((command) => console.error(`- ${command}`));
  process.exit(1);
}

const settings = Object.keys(manifest.contributes.configuration.properties || {});
if (!settings.length) {
  console.error('No extension settings are contributed.');
  process.exit(1);
}

console.log(`Contribution compatibility audit passed (${commands.length} commands, ${settings.length} settings).`);
