const assert = require('node:assert/strict');

const map = s => require('../../out/generation/config/SettingsMapping').mapSettingsToConfig(s);

module.exports = [
    {
        name: 'settings-mapping: empty settings map to nothing',
        run() {
            assert.deepEqual(map({}), {});
        }
    },
    {
        name: 'settings-mapping: every setting lands in its config section',
        run() {
            const out = map({
                structuringStrategy: 'flat', autoTag: false, outputPath: 'out/k', scenarioOutlineThreshold: 5,
                smartTestData: false, exploratory: true, configMode: 'env-json', style: { indentation: '\t' }
            });
            assert.deepEqual(out, {
                layout: { strategy: 'flat', outputRoot: 'out/k' },
                tags: { auto: false },
                scenarios: { outlineThreshold: 5, exploratory: true },
                data: { smart: false },
                config: { mode: 'env-json' },
                style: { indentation: '\t' }
            });
        }
    },
    {
        name: 'settings-mapping: undefined values are omitted, false/0 are kept',
        run() {
            const out = map({ autoTag: false, scenarioOutlineThreshold: 0, exploratory: undefined });
            assert.deepEqual(out, { tags: { auto: false }, scenarios: { outlineThreshold: 0 } });
        }
    },
    {
        name: 'settings-mapping: output resolves through the config resolver',
        run() {
            const { resolveGeneratorConfig } = require('../../out/generation/config/GeneratorConfig');
            const { config, warnings } = resolveGeneratorConfig(undefined, map({ structuringStrategy: 'method', outputPath: 'x/y' }));
            assert.deepEqual(warnings, []);
            assert.equal(config.layout.strategy, 'method');
            assert.equal(config.layout.outputRoot, 'x/y');
            assert.equal(config.layout.classpathRoot, 'src/test/java');
        }
    }
];
