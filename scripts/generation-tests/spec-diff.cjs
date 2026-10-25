const assert = require('node:assert/strict');
const m = () => require('../../out/services/specDiffMatch');

const feature = [
    'Feature: Pets',
    '',
    '  Background:',
    '    * url baseUrl',
    '',
    '  @positive @op=listPets',
    '  Scenario: List pets - returns 200',
    '    # source: GET /pets',
    '    When method get',
    '    Then status 200',
    '',
    '  @negative @op=listPets',
    '  Scenario: List pets - bad limit',
    '    # source: GET /pets',
    '    When method get',
    '    Then status 400',
    '',
    '  @positive @op=getPet',
    '  Scenario: Get pet - returns 200',
    '    # source: GET /pets/{petId}',
    '    When method get',
    '    Then status 200',
    ''
].join('\n');

module.exports = [
    { name: 'spec-diff: summary-named scenarios are found by their source comment, with path params tolerated', run() {
        const lines = feature.split('\n');
        const r = m().findScenarioRanges(lines, 'get', '/pets/{id}');
        assert.equal(r.length, 1);
        assert.equal(r[0].matchedBy, 'source');
        assert.equal(lines[r[0].headerLine], '  Scenario: Get pet - returns 200');
        assert.equal(m().findScenarioRanges(lines, 'POST', '/pets').length, 0, 'method must match exactly');
    } },
    { name: 'spec-diff: range starts at the scenario tags and never eats the next scenario tag line', run() {
        const lines = feature.split('\n');
        const r = m().findScenarioRanges(lines, 'GET', '/pets');
        assert.equal(r.length, 2);
        assert.equal(lines[r[0].startLine], '  @positive @op=listPets');
        assert.equal(lines[r[0].endLine], '    Then status 200');
        assert.equal(lines[r[1].startLine], '  @negative @op=listPets');
        assert.equal(lines[r[1].endLine], '    Then status 400');
    } },
    { name: 'spec-diff: replace swaps all scenarios of the operation (contiguous or not) with the snippet and keeps others', run() {
        const snippet = '  @positive\n  Scenario: NEW\n    # source: GET /pets\n    Then status 200';
        const r = m().replaceScenarios(feature, 'GET', '/pets', snippet);
        assert.equal(r.replaced, 2);
        assert.ok(r.content.includes('Scenario: NEW'));
        assert.ok(!r.content.includes('List pets'));
        assert.ok(r.content.includes('  @positive @op=getPet\n  Scenario: Get pet - returns 200'), 'other scenario keeps its tags');
        assert.equal((r.content.match(/Scenario:/g) || []).length, 2);
        assert.ok(!/\n\n\n/.test(r.content), 'no triple blank lines');
    } },
    { name: 'spec-diff: non-contiguous scenarios are all replaced', run() {
        const split = feature.replace('  @positive @op=getPet', '  @positive @op=other\n  Scenario: Other\n    # source: GET /other\n    Then status 200\n\n  @edge @op=listPets\n  Scenario: Late list\n    # source: GET /pets\n    Then status 200\n\n  @positive @op=getPet');
        const r = m().replaceScenarios(split, 'GET', '/pets', '  Scenario: ONE\n    # source: GET /pets\n    Then status 200');
        assert.equal(r.replaced, 3);
        assert.ok(r.content.includes('Scenario: Other'));
        assert.ok(!r.content.includes('Late list'));
        assert.equal((r.content.match(/Scenario: ONE/g) || []).length, 1);
    } },
    { name: 'spec-diff: replace appends when nothing matches', run() {
        const r = m().replaceScenarios(feature, 'DELETE', '/pets/{id}', '  Scenario: Del');
        assert.equal(r.replaced, 0);
        assert.ok(r.content.endsWith('\n\n  Scenario: Del'));
    } },
    { name: 'spec-diff: old-style name matching still works', run() {
        const old = 'Feature: X\n\n  Scenario: Test GET /users/{id}\n    Then status 200\n';
        const r = m().findScenarioRanges(old.split('\n'), 'GET', '/users/{userId}');
        assert.equal(r.length, 1);
        assert.equal(r[0].matchedBy, 'name');
    } },
    { name: 'spec-diff: removal marks every matching scenario once', run() {
        const r = m().markScenariosDeprecated(feature, 'GET', '/pets', '2026-01-01');
        assert.equal(r.marked, 2);
        assert.equal((r.content.match(/DEPRECATED/g) || []).length, 2);
        const again = m().markScenariosDeprecated(r.content, 'GET', '/pets', '2026-01-02');
        assert.equal(again.marked, 0);
        assert.ok(r.content.includes('Scenario: List pets - returns 200\n    # DEPRECATED'));
    } }
];
