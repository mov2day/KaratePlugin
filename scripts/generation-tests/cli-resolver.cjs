const assert = require('node:assert/strict');

const mod = () => require('../../out/generation/quality/CliResolver');
const probeFrom = map => { const calls = []; const f = async (cmd, args) => { const k = [cmd, ...args].join(' '); calls.push(k); return map[k]; }; f.calls = calls; return f; };
const JAVA21 = 'openjdk version "21.0.7" 2025-04-15';

module.exports = [
    {
        name: 'cli-resolver: karate v2 on PATH wins',
        async run() {
            const probe = probeFrom({ 'karate --version': 'Karate 2.1.4' });
            const cli = await mod().resolveCli({ probe, exists: () => true, jarPath: '/j.jar' });
            assert.deepEqual(cli, { command: 'karate', args: [] });
            assert.deepEqual(probe.calls, ['karate --version']);
        }
    },
    {
        name: 'cli-resolver: PATH v1 falls through to a v2 jar on Java 21',
        async run() {
            const probe = probeFrom({ 'karate --version': '1.5.0', 'java -version': JAVA21, 'java -jar /j.jar --version': 'Karate 2.0.0' });
            const cli = await mod().resolveCli({ probe, exists: () => true, jarPath: '/j.jar' });
            assert.deepEqual(cli, { command: 'java', args: ['-jar', '/j.jar'] });
        }
    },
    {
        name: 'cli-resolver: jar needing Java 17, v1 jar, missing jar and blank jar all resolve to undefined',
        async run() {
            const j17 = probeFrom({ 'java -version': 'openjdk version "17.0.2"', 'java -jar /j.jar --version': 'Karate 2.0.0' });
            assert.equal(await mod().resolveCli({ probe: j17, exists: () => true, jarPath: '/j.jar' }), undefined);
            assert.ok(!j17.calls.includes('java -jar /j.jar --version'));
            const v1 = probeFrom({ 'java -version': JAVA21, 'java -jar /j.jar --version': 'Karate 1.5.0.RC3' });
            assert.equal(await mod().resolveCli({ probe: v1, exists: () => true, jarPath: '/j.jar' }), undefined);
            assert.equal(await mod().resolveCli({ probe: probeFrom({}), exists: () => false, jarPath: '/j.jar' }), undefined);
            const blank = probeFrom({});
            assert.equal(await mod().resolveCli({ probe: blank, exists: () => true, jarPath: '  ' }), undefined);
            assert.deepEqual(blank.calls, ['karate --version']);
        }
    },
    {
        name: 'cli-resolver cache: hit for 5 min, key change invalidates, miss expires after 30 s',
        async run() {
            let t = 0;
            const c = new (mod().CliCache)(() => t);
            let n = 0;
            const hit = async () => { n++; return { command: 'karate', args: [] }; };
            await c.get('a', hit); await c.get('a', hit);
            assert.equal(n, 1);
            t = 4 * 60 * 1000; await c.get('a', hit);
            assert.equal(n, 1);
            await c.get('b', hit);
            assert.equal(n, 2, 'changed jarPath key re-resolves');
            t += 5 * 60 * 1000 + 1; await c.get('b', hit);
            assert.equal(n, 3);
            let m = 0;
            const miss = async () => { m++; return undefined; };
            await c.get('c', miss); t += 29_000; await c.get('c', miss);
            assert.equal(m, 1);
            t += 2_000; await c.get('c', miss);
            assert.equal(m, 2);
        }
    },
    {
        name: 'cli-resolver: temp dir is removed after success and after a throw',
        async run() {
            const removed = [];
            const r = await mod().withTempDir(() => '/t/1', d => removed.push(d), async d => d + '!');
            assert.equal(r, '/t/1!');
            await assert.rejects(mod().withTempDir(() => '/t/2', d => removed.push(d), async () => { throw new Error('x'); }), /x/);
            assert.deepEqual(removed, ['/t/1', '/t/2']);
            await assert.rejects(mod().withTempDir(() => '/t/3', () => { throw new Error('rm'); }, async () => { throw new Error('fn'); }), /fn/);
        }
    }
];
