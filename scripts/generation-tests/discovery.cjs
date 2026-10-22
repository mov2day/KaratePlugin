const assert = require('node:assert/strict');

const discover = (files, root = '/ws') => {
    const { discoverProject } = require('../../out/generation/config/ProjectDiscovery');
    const map = new Map(Object.entries(files).map(([k, v]) => [`${root}/${k}`, v]));
    const fsApi = {
        exists: p => map.has(p) || [...map.keys()].some(k => k.startsWith(p + '/')),
        read: p => {
            if (!map.has(p)) throw new Error('ENOENT ' + p);
            return map.get(p);
        },
        list: dir => [...new Set([...map.keys()].filter(k => k.startsWith(dir + '/')).map(k => k.slice(dir.length + 1).split('/')[0]))]
    };
    return discoverProject(root, fsApi);
};

module.exports = [
    {
        name: 'discovery: apiUrl in src/test/java',
        run() {
            const info = discover({ 'src/test/java/karate-config.js': "function fn() { var config = { apiUrl: 'http://x', foo: 1 }; return config; }" });
            assert.equal(info.classpathRoot, 'src/test/java');
            assert.equal(info.baseConfig.path, 'src/test/java/karate-config.js');
            assert.equal(info.baseConfig.urlVariable, 'apiUrl');
            assert.deepEqual(info.baseConfig.variables, ['apiUrl', 'foo']);
        }
    },
    {
        name: 'discovery: baseUrl in src/test/resources, preferred over other urls',
        run() {
            const info = discover({ 'src/test/resources/karate-config.js': "function fn() { var config = { authUrl: 'a', baseUrl: 'b' }; return config; }" });
            assert.equal(info.classpathRoot, 'src/test/resources');
            assert.equal(info.baseConfig.urlVariable, 'baseUrl');
        }
    },
    {
        name: 'discovery: env configs beside base config',
        run() {
            const info = discover({
                'src/test/java/karate-config.js': 'function fn() { return { baseUrl: "x" }; }',
                'src/test/java/karate-config-staging.js': 'x',
                'src/test/java/karate-config-prod.js': 'x'
            });
            assert.deepEqual([...info.envConfigs].sort(), ['prod', 'staging']);
        }
    },
    {
        name: 'discovery: no config defaults',
        run() {
            const info = discover({ 'pom.xml': '<project/>' });
            assert.equal(info.baseConfig, undefined);
            assert.equal(info.classpathRoot, 'src/test/java');
            assert.deepEqual(info.envConfigs, []);
            assert.equal(info.hasEnvJson, false);
            assert.equal(info.runnerStyle, 'unknown');
        }
    },
    {
        name: 'discovery: return-literal host',
        run() {
            const info = discover({ 'karate-config.js': "function fn() { return { host: 'h', timeout: 5 }; }" });
            assert.equal(info.classpathRoot, '.');
            assert.equal(info.baseConfig.urlVariable, 'host');
        }
    },
    {
        name: 'discovery: undetectable url variable',
        run() {
            const info = discover({ 'src/test/java/karate-config.js': 'function fn() { var config = { env: "dev", timeout: 5 }; return config; }' });
            assert.equal(info.baseConfig.urlVariable, undefined);
            assert.deepEqual(info.baseConfig.variables, ['env', 'timeout']);
        }
    },
    {
        name: 'discovery: env json dir and runner style',
        run() {
            const a = discover({
                'src/test/java/karate-config.js': 'function fn() { return { baseUrl: "x" }; }',
                'src/test/java/config/dev.json': '{}',
                'src/test/java/Runner.java': 'import io.karatelabs.junit6.Karate;',
                'pom.xml': ''
            });
            assert.equal(a.hasEnvJson, true);
            assert.equal(a.runnerStyle, 'junit6');
            const b = discover({ 'src/test/java/karate-config.js': 'function fn() { return { baseUrl: "x" }; }' });
            assert.equal(b.runnerStyle, 'cli');
            assert.equal(b.hasEnvJson, false);
        }
    },
    {
        name: 'config: __proto__/constructor file keys are unknown keys',
        run() {
            const { resolveGeneratorConfig } = require('../../out/generation/config/GeneratorConfig');
            const file = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"x": 1}}');
            const { config, warnings } = resolveGeneratorConfig(file, {});
            assert.ok(warnings.some(w => w.includes('unknown config key "__proto__"')), warnings.join('|'));
            assert.ok(warnings.some(w => w.includes('unknown config key "constructor"')), warnings.join('|'));
            assert.equal({}.polluted, undefined);
            assert.equal(Object.getPrototypeOf(config), Object.prototype);
            assert.equal(config.polluted, undefined);
        }
    }
];
