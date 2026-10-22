const assert = require('node:assert/strict');
const fn = () => require('../../out/generation/config/ScenarioTypes').categoriesForScenarioTypes;
const ALL = ['positive', 'negative', 'edge', 'boundary', 'security'];

module.exports = [
    { name: 'scenario-types: empty or undefined selection uses the configured default', run() {
        assert.deepEqual(fn()(undefined, ALL), ALL);
        assert.deepEqual(fn()([], ['positive']), ['positive']);
        assert.deepEqual(fn()(['bogus'], ALL), ALL);
    } },
    { name: 'scenario-types: edge selects edge and boundary, others map one to one', run() {
        assert.deepEqual(fn()(['edge'], ALL), ['edge', 'boundary']);
        assert.deepEqual(fn()(['Security', 'positive'], ALL), ['positive', 'security']);
    } },
    { name: 'scenario-types: selection outside the configured default is still honoured', run() {
        assert.deepEqual(fn()(['security'], ['positive']), ['security']);
    } }
];
