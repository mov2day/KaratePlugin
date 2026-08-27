const fs = require('fs');

const typeSource = fs.readFileSync('src/types/index.ts', 'utf8');
const providerSource = fs.readFileSync('src/webview/WebviewProvider.ts', 'utf8');
const typeMatch = typeSource.match(/export type WebviewMessage\s*=([\s\S]*?);\n/);

if (!typeMatch) {
  console.error('Could not locate the WebviewMessage contract.');
  process.exit(1);
}

const commands = [...typeMatch[1].matchAll(/command:\s*'([^']+)'/g)].map((match) => match[1]);
const missing = commands.filter((command) => !providerSource.includes(`case '${command}'`));

if (missing.length) {
  console.error('Webview message contract has no runtime validator case for:');
  missing.forEach((command) => console.error(`- ${command}`));
  process.exit(1);
}

console.log(`Webview message contract audit passed (${commands.length} message types).`);
