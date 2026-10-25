const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..', '..', 'fixtures', 'generation');
const goldenDir = path.join(root, 'golden');
const fixtureDir = root;

function golden(name, text) {
    const file = path.join(goldenDir, name);
    const normalise = value => String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const actual = normalise(text);
    if (process.env.UPDATE_GOLDEN === '1') {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, actual);
        return;
    }
    if (!fs.existsSync(file)) {
        assert.fail(`Missing golden ${name}; run with UPDATE_GOLDEN=1 to create it`);
    }
    assert.equal(actual, normalise(fs.readFileSync(file, 'utf8')), `Golden mismatch: ${name}`);
}

function suite(name, tests) {
    // tests: array of { name, run } or object map { testName: fn }
    const list = Array.isArray(tests) ? tests : Object.entries(tests).map(([n, run]) => ({ name: n, run }));
    return list.map(t => ({ name: `${name}: ${t.name}`, run: t.run }));
}

const fixture = (...parts) => path.join(fixtureDir, ...parts);

module.exports = { golden, suite, fixture, goldenDir, fixtureDir };
