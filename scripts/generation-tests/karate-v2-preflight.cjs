const assert = require('node:assert/strict');
const preflight = () => require('../../out/services/execution/KarateV2Preflight');

module.exports = [
    {
        name: 'karate v2 preflight: detects bounded v2 constructs and blocks bundled v1',
        run() {
            const p = preflight();
            for (const text of ["* def x = karate.sysprop('x')", "* def x = karate.sysenv('x')", '@lock=orders', "* configure auth = { type: 'bearer' }"]) {
                assert.equal(p.usesKarateV2Constructs(text), true);
                assert.match(p.karateV2Preflight('1.5.0.RC3', true, [text]), /karateDsl\.execution\.jarPath/);
            }
            assert.equal(p.karateV2Preflight('2.1.0', false, ["* configure auth = { type: 'bearer' }"]), undefined);
            assert.equal(p.usesKarateV2Constructs('x'.repeat(1024 * 1024) + " karate.sysenv('x')"), false);
        }
    },
    {
        name: 'karate v2 preflight: ignores hash and JavaScript comment-only v2 mentions',
        run() {
            const p = preflight();
            assert.equal(p.usesKarateV2Constructs("# karate.sysprop('x')\n# @lock=orders"), false);
            assert.equal(p.usesKarateV2Constructs("// karate.sysenv('x')\n// configure auth"), false);
        }
    }
];
