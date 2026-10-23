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
    },
    {
        name: 'karate v2 preflight: strips comments in linear time',
        run() {
            const p = preflight();
            const inputs = [
                '\n'.repeat(200_000),
                '\r\n'.repeat(200_000),
                ' \t \n'.repeat(200_000)
            ];

            for (const input of inputs) {
                const started = performance.now();
                assert.equal(p.usesKarateV2Constructs(input), false);
                assert.ok(performance.now() - started < 1000, 'comment stripping exceeded 1000 ms');
            }

            assert.equal(p.usesKarateV2Constructs("# karate.sysprop('x')\n// karate.sysprop('x')"), false);
            assert.equal(p.usesKarateV2Constructs("# karate.sysprop('x')\n* def x = karate.sysprop('x')"), true);
            assert.equal(p.usesKarateV2Constructs("// karate.sysprop('x')\n* def x = karate.sysprop('x')"), true);
        }
    }
];
