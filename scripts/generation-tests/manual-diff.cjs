const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const body = [
    'Feature: Pets', '', '  Background:', '    * url baseUrl', '',
    '  Scenario: List pets', '    # source: GET /pets', '    When method get', '    Then status 200', ''
].join('\n');
const replacement = ['  Scenario: Updated pets', '    # source: GET /pets', '    When method get', '    Then status 200'].join('\n');

module.exports = [{
    name: 'manual diff: stale generated header writes a sibling instead of overwriting user edits',
    async run() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karate-manual-diff-'));
        try {
            const file = path.join(dir, 'pets.feature');
            const { OutputWriter } = require('../../out/generation/write/OutputWriter');
            const fsApi = { exists: p => fs.existsSync(path.join(dir, p)), read: p => fs.readFileSync(path.join(dir, p), 'utf8'), list: p => fs.readdirSync(path.join(dir, p)), write: (p, text) => fs.writeFileSync(path.join(dir, p), text) };
            OutputWriter.write([{ path: 'pets.feature', content: body, owner: 'generated', source: 'spec' }], fsApi, { get: () => undefined, set: () => {} }, { generatorVersion: 'test', workspaceRoot: dir });
            const edited = fs.readFileSync(file, 'utf8') + '# user edit\n';
            fs.writeFileSync(file, edited);
            await new (require('../../out/services/manualDiffService').ManualDiffService)().updateFeatureFile(file, { method: 'GET', path: '/pets' }, replacement);
            assert.equal(fs.readFileSync(file, 'utf8'), edited);
            assert.ok(fs.existsSync(path.join(dir, 'pets.generated.feature')));
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
}, {
    name: 'manual diff: pre-existing gate errors do not block an otherwise valid spec update',
    async run() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karate-manual-diff-'));
        try {
            const file = path.join(dir, 'pets.feature');
            const userFile = body + '\n  Scenario: pre-existing invalid\n    When method get\n';
            fs.writeFileSync(file, userFile);
            await new (require('../../out/services/manualDiffService').ManualDiffService)().updateFeatureFile(file, { method: 'GET', path: '/pets' }, replacement);
            assert.equal(fs.readFileSync(file, 'utf8'), userFile);
            assert.ok(fs.existsSync(path.join(dir, 'pets.generated.feature')));
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
}];
