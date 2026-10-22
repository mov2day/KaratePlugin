const assert = require('node:assert/strict');
const mod = () => require('../../out/generation/plan/RequirementDrafts');
const render = () => require('../../out/generation/render/FeatureRenderer');
const cfg = () => require('../../out/generation/config/GeneratorConfig').DEFAULT_GENERATOR_CONFIG;
const gate = () => require('../../out/generation/quality/QualityGate');

module.exports = [
    { name: 'requirement-drafts: no cases yields no feature', run() {
        assert.equal(mod().requirementsFeature('pets', 'Page', []), undefined);
    } },
    { name: 'requirement-drafts: every scenario is a draft and the rendered feature is gate-clean', run() {
        const pf = mod().requirementsFeature('pets', 'Pet rules', [
            { name: 'Pets are listed', steps: ['Open list', 'Filter'], expectedResult: 'A list' }, { name: '' }
        ]);
        assert.equal(pf.relativePath, 'pets-requirements.feature');
        assert.ok(pf.feature.scenarios.every(s => s.draftReason === mod().REQUIREMENT_DRAFT_REASON));
        const text = render().renderFeature(pf.feature, { style: cfg().style });
        assert.match(text, /@ignore/);
        assert.match(text, /Draft: No API contract linked/);
        assert.match(text, /Scenario: Requirement 2/);
        const g = gate().runGate(text, { knownFiles: new Set(), config: cfg() });
        assert.deepEqual(g.findings.filter(f => f.severity === 'error'), [], JSON.stringify(g.findings));
    } }
];
