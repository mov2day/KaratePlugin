const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
    });
}

module.exports = {
    name: 'no-vscode-in-generation',
    run() {
        const dir = path.resolve(__dirname, '..', '..', 'out', 'generation');
        if (!fs.existsSync(dir)) return;
        const bad = [];
        for (const file of walk(dir)) {
            const text = fs.readFileSync(file, 'utf8');
            if (/require\(\s*["']vscode["']\s*\)/.test(text) || /require\(\s*["'](?:\.\.?\/)+utils\/logger["']\s*\)/.test(text)) bad.push(path.relative(dir, file));
        }
        assert.deepEqual(bad, [], `generation modules must not require vscode or utils/logger: ${bad.join(', ')}`);
    }
};
