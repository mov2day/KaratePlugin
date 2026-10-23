const assert = require('node:assert/strict');

const mig = () => require('../../out/generation/vscode/migrateSettings');
const adapter = () => require('../../out/services/linter/gateAdapter');
const { resolveGeneratorConfig } = require('../../out/generation/config/GeneratorConfig');

module.exports = [
    {
        name: 'linter: gate findings duplicating K001/S002 on the same line are dropped',
        run() {
            const a = adapter();
            const f = (ruleId, line) => ({ ruleId, severity: 'error', line, message: 'm' });
            const findings = [f('V2-CFG-001', 3), f('V2-CFG-001', 9), f('V2-SEC-001', 5), f('V2-SEC-001', 6), f('V2-LOCK-001', 3)];
            const peers = new Map([['K001', new Set([3])], ['S002', new Set([5])]]);
            const kept = a.dedupeGateFindings(findings, peers).map(x => `${x.ruleId}:${x.line}`);
            assert.deepEqual(kept, ['V2-CFG-001:9', 'V2-SEC-001:6', 'V2-LOCK-001:3']);
            assert.equal(a.dedupeGateFindings(findings, new Map()).length, 5);
        }
    },
    {
        name: 'migration: empty legacy settings map to nothing',
        run() { assert.deepEqual(mig().migrateSettings({}), {}); }
    },
    {
        name: 'migration: each legacy setting lands in its new field',
        run() {
            const r = mig().migrateSettingsWithWarnings({
                structuringStrategy: 'flat', autoTag: false, outputPath: 'out/k',
                scenarioOutlineThreshold: 5, smartTestData: false, sharedStylePath: 'style.json'
            });
            assert.deepEqual(r.config, {
                layout: { strategy: 'flat', outputRoot: 'out/k' },
                tags: { auto: false },
                scenarios: { outlineThreshold: 5 },
                data: { smart: false }
            });
            assert.equal(r.sharedStylePath, 'style.json');
            assert.deepEqual(r.warnings, []);
        }
    },
    {
        name: 'migration: testTemplate presets map to scenario defaults and explicit settings win',
        run() {
            const m = mig().migrateSettings;
            assert.deepEqual(m({ testTemplate: 'standard' }), {});
            assert.deepEqual(m({ testTemplate: 'detailed' }), { scenarios: { exploratory: true } });
            assert.deepEqual(m({ testTemplate: 'minimal', scenarioOutlineThreshold: 4 }), { scenarios: { categories: ['positive', 'negative'], outlineThreshold: 4 } });
            const { config, warnings } = resolveGeneratorConfig(undefined, m({ testTemplate: 'minimal' }));
            assert.deepEqual(config.scenarios.categories, ['positive', 'negative']);
            assert.deepEqual(warnings, []);
        }
    },
    {
        name: 'migration: unknown legacy values warn and are ignored',
        run() {
            const r = mig().migrateSettingsWithWarnings({
                testTemplate: 'fancy', structuringStrategy: 'tree', autoTag: 'yes', outputPath: '',
                scenarioOutlineThreshold: 99, smartTestData: 1, sharedStylePath: 5
            });
            assert.deepEqual(r.config, {});
            assert.equal(r.warnings.length, 7);
            assert.match(r.warnings[0], /testTemplate.*"fancy"/);
            assert.ok(r.warnings.every(w => w.startsWith('Legacy setting karateDsl.')));
        }
    },
    {
        name: 'migration: false and boundary values are kept',
        run() {
            const c = mig().migrateSettings({ autoTag: false, scenarioOutlineThreshold: 1 });
            assert.deepEqual(c, { tags: { auto: false }, scenarios: { outlineThreshold: 1 } });
        }
    },
    {
        name: 'migration: mergeSettingsLayers lets the override win per key',
        run() {
            const out = mig().mergeSettingsLayers({ scenarios: { exploratory: true, crud: true } }, { scenarios: { exploratory: false } });
            assert.deepEqual(out, { scenarios: { exploratory: false, crud: true } });
        }
    },
    {
        name: 'linter: V2-LOCK-001 is reported for @parallel=false with a @lock= quick fix',
        run() {
            const text = ['Feature: Orders', '', 'Background:', '  * url baseUrl', '', '@parallel=false', 'Scenario: s', '  * def b = 2', ''].join('\n');
            const f = adapter().gateFindingsForText(text, '/w/Order Flow.feature').find(x => x.ruleId === 'V2-LOCK-001');
            assert.ok(f);
            assert.equal(f.line, 6);
            assert.equal(f.quickFix.replacement, '@lock=order-flow');
            assert.match(f.quickFix.title, /@lock=order-flow/);
            assert.equal(adapter().applyQuickFix(f, '@parallel=false @smoke'), '@lock=order-flow @smoke');
            assert.equal(adapter().applyQuickFix(f, '@other'), undefined);
        }
    },
    {
        name: 'linter: clean features yield no gate errors and other findings carry no quick fix',
        run() {
            const text = ['Feature: x', 'Scenario: s', "  Given path 'a'", '  When method get', '  Then status 200', '  And match response == {}', ''].join('\n');
            const fs = adapter().gateFindingsForText(text, 'x.feature');
            assert.ok(fs.every(f => !f.quickFix));
            assert.equal(adapter().lockNameFor(''), 'shared');
        }
    },
    {
        name: 'summary: AI refinement rejected line lists the aggregated rule ids',
        run() {
            const { formatSummary } = require('../../out/generation/pipeline/Summary');
            const fnd = ruleId => ({ ruleId, severity: 'error', line: 1, message: 'm' });
            const s = formatSummary({
                written: { created: [], updated: [], skippedExisting: ['k.feature'], sideBySide: [] },
                warnings: [], gate: { errors: 0, warnings: 0 },
                features: [
                    { path: 'a.feature', findings: [], refinement: { status: 'rejected', text: '', attempts: 2, findings: [fnd('V2-AI-003'), fnd('V2-AI-002')] } },
                    { path: 'b.feature', findings: [], refinement: { status: 'rejected', text: '', attempts: 2, findings: [fnd('V2-AI-002')] } }
                ],
                draftScenarios: 0
            });
            assert.ok(s.details.some(d => d.startsWith('AI refinement rejected: V2-AI-002, V2-AI-003')), s.details.join('\n'));
            assert.ok(s.details.some(d => d.startsWith('Kept as is')));
        }
    }
];
