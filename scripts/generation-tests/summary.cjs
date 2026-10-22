const assert = require('node:assert/strict');

const mod = () => require('../../out/generation/pipeline/Summary');
const finding = (ruleId, severity = 'error') => ({ ruleId, severity, line: 1, message: 'm' });
const result = (over = {}) => ({
    written: { created: [], updated: [], skippedExisting: [], sideBySide: [] },
    features: [], draftScenarios: 0, warnings: [], gate: { errors: 0, warnings: 0 }, ...over
});

module.exports = [
    {
        name: 'summary: clean run has an info level headline counting created and updated files',
        run() {
            const s = mod().formatSummary(result({
                written: { created: ['a/x.feature', 'a/c.js'], updated: ['a/y.feature'], skippedExisting: ['a/karate-config.js'], sideBySide: [] },
                features: [{ path: 'a/x.feature', findings: [], draft: false }, { path: 'a/y.feature', findings: [], draft: false }]
            }));
            assert.match(s.headline, /2 feature files/);
            assert.match(s.headline, /2 created/);
            assert.match(s.headline, /1 updated/);
            assert.equal(s.level, 'info');
            assert.ok(s.details.some(d => d.includes('a/karate-config.js')), 'kept-as-is file listed');
            assert.ok(s.details.some(d => /kept as is/i.test(d)));
        }
    },
    {
        name: 'summary: gate findings are grouped by rule id with counts and raise a warning level',
        run() {
            const s = mod().formatSummary(result({
                gate: { errors: 3, warnings: 1 },
                features: [
                    { path: 'a.feature', findings: [finding('V2-STY-001'), finding('V2-STY-001'), finding('V2-DAT-002', 'warning')], draft: false },
                    { path: 'b.feature', findings: [finding('V2-STY-001')], draft: false }
                ]
            }));
            assert.equal(s.level, 'warning');
            assert.match(s.headline, /3 gate errors/);
            assert.ok(s.details.some(d => /V2-STY-001.*x3/.test(d)), s.details.join('\n'));
            assert.ok(s.details.some(d => /V2-DAT-002.*x1/.test(d)));
        }
    },
    {
        name: 'summary: side-by-side files, drafts, warnings and rejected AI refinement are all surfaced',
        run() {
            const s = mod().formatSummary(result({
                written: { created: [], updated: [], skippedExisting: [], sideBySide: [{ path: 'u.feature', generatedPath: 'u.generated.feature' }] },
                draftScenarios: 2,
                warnings: ['multipart skipped'],
                features: [{ path: 'u.feature', findings: [], draft: true, refinement: { status: 'rejected', text: '', attempts: 2, findings: [finding('V2-AI-002'), finding('V2-AI-003')] } }]
            }));
            assert.equal(s.level, 'warning');
            assert.match(s.headline, /1 side-by-side/);
            assert.match(s.headline, /2 draft/);
            assert.match(s.headline, /1 AI refinement rejected/);
            const all = s.details.join('\n');
            assert.match(all, /u\.generated\.feature/);
            assert.match(all, /multipart skipped/);
            assert.match(all, /V2-AI-002/);
            assert.match(all, /V2-AI-003/);
        }
    },
    {
        name: 'summary: dry run result and empty run are described',
        run() {
            const s = mod().formatSummary(result({ dryRun: { status: 'failed', message: 'boom' } }));
            assert.match(s.headline, /No files/i);
            assert.ok(s.details.some(d => /boom/.test(d)));
        }
    },
    {
        name: 'summary: mergeResults combines batch results and de-duplicates shared paths',
        run() {
            const a = result({ written: { created: ['a'], updated: [], skippedExisting: [], sideBySide: [] }, features: [{ path: 'a.feature', findings: [], draft: false }] });
            const b = result({ written: { created: ['b'], updated: [], skippedExisting: [], sideBySide: [] }, features: [{ path: 'b.feature', findings: [], draft: false }], warnings: ['w'] });
            const m = mod().mergeResults([a, b]);
            assert.deepEqual(m.written.created, ['a', 'b']);
            assert.equal(m.features.length, 2);
            assert.deepEqual(m.warnings, ['w']);
            const shared = { written: { created: [], updated: [], skippedExisting: ['cfg.js'], sideBySide: [] } };
            const d = mod().mergeResults([result(shared), result(shared)]);
            assert.deepEqual(d.written.skippedExisting, ['cfg.js']);
        }
    },
    {
        name: 'summary: expected requirement drafts are listed but do not escalate the level',
        run() {
            const r = result({ draftScenarios: 2, features: [{ path: 'x/pets-requirements.feature', findings: [], draft: true }] });
            const only = mod().formatSummary(r, { expectedDraftFeature: p => p.endsWith('-requirements.feature') });
            assert.equal(only.level, 'info');
            assert.match(only.headline, /2 draft/);
            assert.ok(only.details.some(d => d.includes('pets-requirements.feature')));
            const mixed = mod().formatSummary({ ...r, features: [...r.features, { path: 'x/pets.feature', findings: [], draft: true }] }, { expectedDraftFeature: p => p.endsWith('-requirements.feature') });
            assert.equal(mixed.level, 'warning');
            assert.equal(mod().formatSummary(r).level, 'warning');
        }
    }
];
