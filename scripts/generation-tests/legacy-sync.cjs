const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');

module.exports = [{
    name: 'legacy sync: valid regenerated content is written beside, never over a user scenario',
    run() {
        const { writeLegacySyncSibling } = require('../../out/services/testSyncManager');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karate-sync-test-'));
        try {
            const target = path.join(dir, 'pets.feature');
            const original = 'Feature: User edits\n\nScenario: mine\n  * def preserved = true\n';
            fs.writeFileSync(target, original);
            const result = writeLegacySyncSibling(target, 'Feature: Generated\n\nScenario: regenerated\n  * url baseUrl\n  * path \'pets\'\n  * method get\n  * status 200\n');
            assert.equal(result, path.join(dir, 'pets.generated.feature'));
            assert.equal(fs.readFileSync(target, 'utf8'), original);
            assert.match(fs.readFileSync(result, 'utf8'), /Scenario: regenerated/);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
}];
