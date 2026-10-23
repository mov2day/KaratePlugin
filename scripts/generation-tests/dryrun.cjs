const assert = require('node:assert/strict');

const mod = () => require('../../out/generation/quality/DryRun');
const CLI = { command: 'karate', args: [] };
const fake = (code, out, calls = []) => async (cmd, args, o) => { calls.push({ cmd, args, o }); return { code, out }; };

module.exports = [
    {
        name: 'dryrun staging: writes only safe feature paths under the temp directory',
        run() {
            const writes = [];
            const stage = require('../../out/generation/vscode/DryRunRunner').stageDryRunFiles;
            const staged = stage('/tmp/stage', [
                { path: '/workspace/src/test/karate/a.feature', content: 'Feature: a\n' },
                { path: '/workspace/src/test/karate/b.feature', content: 'Feature: b\n' }
            ], '/workspace', { mkdir: p => writes.push(['mkdir', p]), write: (p, c) => writes.push(['write', p, c]) });
            assert.deepEqual(staged, ['/tmp/stage/src/test/karate/a.feature', '/tmp/stage/src/test/karate/b.feature']);
            assert.deepEqual(writes.filter(w => w[0] === 'write').map(w => w[1]), staged);
            assert.throws(() => stage('/tmp/stage', [{ path: '../../x.feature', content: 'x' }], '/workspace', { mkdir() {}, write() {} }), /outside the workspace/);
        }
    },
    {
        name: 'dryrun: success runs `run -D -o <outDir> <files>` with cwd root and passes',
        async run() {
            const calls = [];
            const r = await mod().dryRun({ cli: { command: 'java', args: ['-jar', '/k/karate.jar'] }, root: '/ws', files: ['a.feature', 'b.feature'], outDir: '/tmp/o', exec: fake(0, 'DRY RUN — nothing was executed', calls) });
            assert.equal(r.status, 'passed');
            assert.deepEqual(r.findings, []);
            assert.equal(calls[0].cmd, 'java');
            assert.deepEqual(calls[0].args, ['-jar', '/k/karate.jar', 'run', '-D', '-o', '/tmp/o', 'a.feature', 'b.feature']);
            assert.equal(calls[0].o.cwd, '/ws');
            assert.ok(calls[0].o.timeoutMs > 0);
        }
    },
    {
        name: 'dryrun: parse error output fails with V2-PARSE-001 at the reported line and file',
        async run() {
            const r = await mod().dryRun({ cli: CLI, root: '/ws', files: ['x/a.feature'], outDir: '/o', exec: fake(1, 'Karate 2.1.4\nx/a.feature:12 - unexpected token\n') });
            assert.equal(r.status, 'failed');
            assert.equal(r.findings.length, 1);
            assert.equal(r.findings[0].ruleId, 'V2-PARSE-001');
            assert.equal(r.findings[0].severity, 'error');
            assert.equal(r.findings[0].line, 12);
            assert.match(r.findings[0].message, /x\/a\.feature/);
            assert.match(r.findings[0].message, /unexpected token/);
        }
    },
    {
        name: 'dryrun: non-zero exit without parse lines is skipped',
        async run() {
            const r = await mod().dryRun({ cli: CLI, root: '/ws', files: ['a.feature'], outDir: '/o', exec: fake(2, 'something odd happened\n') });
            assert.equal(r.status, 'skipped');
            assert.deepEqual(r.findings, []);
        }
    },
    {
        name: 'dryrun: Java too old is skipped even when output looks like an error',
        async run() {
            const r = await mod().dryRun({ cli: CLI, root: '/ws', files: ['a.feature'], outDir: '/o', exec: fake(1, 'Exception in thread "main" java.lang.UnsupportedClassVersionError: x/Main has been compiled by a more recent version (class file version 65.0)') });
            assert.equal(r.status, 'skipped');
            assert.match(r.message, /Java 21/);
        }
    },
    {
        name: 'dryrun: exec throwing, missing cli and timeout are skipped',
        async run() {
            const t = await mod().dryRun({ cli: CLI, root: '/ws', files: ['a.feature'], outDir: '/o', exec: async () => { throw new Error('spawn ENOENT'); } });
            assert.equal(t.status, 'skipped');
            assert.match(t.message, /ENOENT/);
            let called = false;
            const n = await mod().dryRun({ cli: undefined, root: '/ws', files: ['a.feature'], outDir: '/o', exec: async () => { called = true; return { code: 0, out: '' }; } });
            assert.equal(n.status, 'skipped');
            assert.equal(n.message, 'Karate v2 CLI not found; static quality gate only');
            assert.equal(called, false);
            const slow = await mod().dryRun({ cli: CLI, root: '/ws', files: ['a.feature'], outDir: '/o', timeoutMs: 20, exec: () => new Promise(() => {}) });
            assert.equal(slow.status, 'skipped');
            assert.match(slow.message, /timed out/i);
        }
    },
    {
        name: 'dryrun: no feature files is skipped without running',
        async run() {
            let called = false;
            const r = await mod().dryRun({ cli: CLI, root: '/ws', files: [], outDir: '/o', exec: async () => { called = true; return { code: 0, out: '' }; } });
            assert.equal(r.status, 'skipped');
            assert.equal(called, false);
        }
    },
    {
        name: 'dryrun: finding messages are capped at 200 chars and output at 2000',
        async run() {
            const long = 'a.feature:3 - unexpected token ' + 'x'.repeat(5000);
            const r = await mod().dryRun({ cli: CLI, root: '/ws', files: ['a.feature'], outDir: '/o', exec: fake(1, long) });
            assert.equal(r.status, 'failed');
            assert.ok(r.findings[0].message.length <= 200);
            assert.ok(r.message.length <= 2200);
            assert.equal(mod().capOutput('y'.repeat(5000)).length, 2000);
        }
    },
    {
        name: 'parseDryRunOutput: recognises file:line, "at file:line", and "line n" shapes',
        run() {
            const p = mod().parseDryRunOutput;
            const a = p('feature.feature:12 - unexpected token\nsyntax error: bad thing at line 7\nline 9: expected Scenario');
            assert.deepEqual(a.map(x => x.line), [12], 'unlocated lines ignored when a located one exists');
            assert.equal(a[0].file, 'feature.feature');
            const fb = p('syntax error: bad thing at line 7\nline 9: expected Scenario');
            assert.deepEqual(fb.map(x => x.line), [7]);
            assert.equal(fb[0].file, undefined);
            assert.equal(p('x.feature:3 - syntax error\nx.feature:3 - syntax error').length, 1, 'deduped');
            assert.equal(p(Array.from({ length: 50 }, (_, n) => `x.feature:${n + 1} - syntax error`).join('\n')).length, 20, 'capped');
            const b = p('SyntaxError: Unexpected identifier \'x\' (did you double a quote?)\n    at src/test/a.feature:5');
            assert.equal(b.length, 1);
            assert.equal(b[0].line, 5);
            assert.equal(b[0].file, 'src/test/a.feature');
            assert.match(b[0].message, /SyntaxError/);
            const bare = p('SyntaxError: Unexpected token }');
            assert.equal(bare[0].line, 1);
            const c = p('Error: a step outside a Background/Scenario/Scenario Outline at orders/o.feature:4');
            assert.equal(c[0].line, 4);
            assert.equal(c[0].file, 'orders/o.feature');
        }
    },
    {
        name: 'parseDryRunOutput: noise lines yield nothing',
        run() {
            assert.deepEqual(mod().parseDryRunOutput('Karate 2.1.4\nDRY RUN — nothing was executed\nreport: /tmp/o/karate-summary.html\nrunning a.feature:3\n'), []);
            assert.deepEqual(mod().parseDryRunOutput(''), []);
        }
    },
    {
        name: 'version helpers: karate major and java major parsing',
        run() {
            const k = mod().isKarateV2;
            assert.equal(k('Karate 2.1.4'), true);
            assert.equal(k('karate v2.0.0-RC1'), true);
            assert.equal(k('Karate version: 2.1.4'), true);
            assert.equal(k('1.5.0'), false);
            assert.equal(k('Karate 1.5.0.RC3'), false);
            assert.equal(k(''), false);
            const j = mod().parseJavaMajor;
            assert.equal(j('openjdk version "21.0.7" 2025-04-15'), 21);
            assert.equal(j('java version "17.0.2" 2022-01-18'), 17);
            assert.equal(j('openjdk version "21" 2023-09-19'), 21);
            assert.equal(j('java version "1.8.0_292"'), 8);
            assert.equal(j('nonsense'), undefined);
            assert.equal(mod().isJava21('openjdk version "21" 2023-09-19'), true);
            assert.equal(mod().isJava21('openjdk version "17.0.2"'), false);
        }
    },
    {
        name: 'dryrun glue decision: off never runs; auto runs only with a cli',
        run() {
            const d = mod().dryRunDecision;
            assert.equal(d('off', true), 'disabled');
            assert.equal(d('off', false), 'disabled');
            assert.equal(d('auto', true), 'run');
            assert.equal(d('auto', false), 'no-cli');
        }
    },
    {
        name: 'dryrun + pipeline summary: failed dry run is reported without touching files; skipped passes message through',
        run() {
            const S = require('../../out/generation/pipeline/Summary');
            const base = { written: { created: ['a.feature'], updated: [], skippedExisting: [], sideBySide: [] }, features: [{ path: 'a.feature', findings: [], draft: false }], draftScenarios: 0, warnings: [], gate: { errors: 0, warnings: 0 } };
            const f = S.formatSummary({ ...base, dryRun: { status: 'failed', message: '1 parse error', findings: [{ ruleId: 'V2-PARSE-001', severity: 'error', line: 12, message: 'a.feature: unexpected token' }] } });
            assert.ok(f.details.some(d => d.startsWith('Dry run: failed')));
            assert.equal(f.level, 'warning');
            assert.ok(!f.details.some(d => d.includes('V2-PARSE-001')), 'findings are listed via pipeline warnings only');
            const s = S.formatSummary({ ...base, dryRun: { status: 'skipped', message: 'Karate v2 CLI not found; static quality gate only' } });
            assert.ok(s.details.some(d => d === 'Dry run: skipped (Karate v2 CLI not found; static quality gate only)'));
            const p = S.formatSummary({ ...base, dryRun: { status: 'passed', message: 'ok' } });
            assert.ok(p.details.some(d => d.startsWith('Dry run: passed')));
        }
    },
    {
        name: 'dryrun: noisy non-zero output is skipped, not failed',
        async run() {
            for (const line of [
                '0 failed, 3 passed (a.feature:7)',
                'No errors found in a.feature:1',
                'WARN deprecated syntax in a.feature:12',
                '[info] parsed a.feature:4 invalid scenarios: 0',
                'ERROR failed to write report to /tmp/o line 5'
            ]) {
                const r = await mod().dryRun({ cli: CLI, root: '/ws', files: ['a.feature'], outDir: '/o', exec: fake(1, line) });
                assert.equal(r.status, 'skipped', line);
            }
        }
    },
    {
        name: 'dryrun: parse errors past the 2000 char cap are still found; stored output is capped',
        async run() {
            const out = 'noise\n'.repeat(1000) + 'a.feature:9 - unexpected token';
            const r = await mod().dryRun({ cli: CLI, root: '/ws', files: ['a.feature'], outDir: '/o', exec: fake(1, out) });
            assert.equal(r.status, 'failed');
            assert.equal(r.findings[0].line, 9);
            assert.ok(r.output.length <= 2000);
        }
    }
];
