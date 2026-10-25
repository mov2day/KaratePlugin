const assert = require('node:assert/strict');

const mod = () => require('../../out/generation/config/GeneratorConfig');
const resolve = (file, settings = {}) => mod().resolveGeneratorConfig(file, settings);

module.exports = [
    {
        name: 'config: defaults',
        run() {
            const { config, warnings } = resolve(undefined, {});
            assert.deepEqual(warnings, []);
            assert.equal(config.karateVersion, '2');
            assert.equal(config.scenarios.exploratory, false);
            assert.equal(config.config.mode, 'standard');
            assert.equal(config.config.urlVariable, 'baseUrl');
            assert.equal(config.layout.strategy, 'domain');
            assert.equal(config.layout.outputRoot, 'src/test/karate');
            assert.deepEqual(config.config.envs, ['dev', 'staging']);
            assert.equal(config.tags.taxonomy.security, '@security');
            assert.equal(config.gate.dryRun, 'auto');
            assert.deepEqual(mod().DEFAULT_GENERATOR_CONFIG.style, { indentation: '  ', variableCase: 'camelCase', commentStyle: 'hash', lineSpacing: 1 });
        }
    },
    {
        name: 'config: file beats settings beats defaults',
        run() {
            const { config } = resolve(
                { style: { indentation: '\t' }, scenarios: { crud: false } },
                { style: { indentation: '    ', lineSpacing: 2 }, scenarios: { outlineThreshold: 5 } }
            );
            assert.equal(config.style.indentation, '\t');
            assert.equal(config.style.lineSpacing, 2);
            assert.equal(config.scenarios.crud, false);
            assert.equal(config.scenarios.outlineThreshold, 5);
            assert.equal(config.style.variableCase, 'camelCase');
        }
    },
    {
        name: 'config: arrays replaced, not merged',
        run() {
            const { config } = resolve({ config: { envs: ['prod'] } }, { scenarios: { categories: ['positive'] } });
            assert.deepEqual(config.config.envs, ['prod']);
            assert.deepEqual(config.scenarios.categories, ['positive']);
        }
    },
    {
        name: 'config: unknown keys warn, never throw',
        run() {
            const { config, warnings } = resolve({ bogus: 1, layout: { nope: true } }, {});
            assert.ok(warnings.some(w => w.includes('bogus')), warnings.join('|'));
            assert.ok(warnings.some(w => w.includes('layout.nope')), warnings.join('|'));
            assert.equal(config.layout.strategy, 'domain');
            assert.equal(config.bogus, undefined);
        }
    },
    {
        name: 'config: invalid enum falls back with warning',
        run() {
            const { config, warnings } = resolve({ layout: { strategy: 'weird' } }, {});
            assert.equal(config.layout.strategy, 'domain');
            assert.ok(warnings.some(w => w.includes('layout.strategy')), warnings.join('|'));
        }
    },
    {
        name: 'config: legacy sharedStylePath shape accepted as style',
        run() {
            const legacy = { indentation: '\t', variableCase: 'snake_case', commentStyle: 'doubleSlash', lineSpacing: 2 };
            const top = resolve(legacy, {});
            assert.deepEqual(top.config.style, legacy);
            assert.deepEqual(top.warnings, []);
            const nested = resolve({ style: legacy }, {});
            assert.deepEqual(nested.config.style, legacy);
        }
    },
    {
        name: 'config: non-object file input ignored',
        run() {
            const { config } = resolve('garbage', {});
            assert.equal(config.config.mode, 'standard');
        }
    }
];
