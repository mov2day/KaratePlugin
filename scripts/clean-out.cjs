const fs = require('fs');
const path = require('path');

const outDir = path.join(process.cwd(), 'out');
fs.rmSync(outDir, { recursive: true, force: true });
console.log('Cleaned out/');
