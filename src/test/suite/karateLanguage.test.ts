import * as assert from 'assert';
import { isKarateText, shouldApplyKarateMode } from '../../services/language/karateDetection';
import { completionContext } from '../../services/language/karateCompletionContext';

const base = {
    fileName: '/p/a.feature',
    languageId: 'plaintext',
    autoDetect: true,
    officialInstalled: false,
    workspaceHasKarateConfig: false,
    text: "Feature: x\n  Scenario: y\n    * url 'http://a'\n"
};

suite('Karate language detection', () => {
    test('detects Karate text and rejects plain Cucumber', () => {
        assert.strictEqual(isKarateText(base.text), true);
        assert.strictEqual(isKarateText("Feature: login\n  Given I am on the home page\n  When I click 'Login'\n  Then I see the dashboard\n"), false);
        assert.strictEqual(isKarateText("Scenario: a\n * def x = karate.read('a.json')\n"), true);
        assert.strictEqual(isKarateText("Given text = read('classpath:data.json')"), true);
    });

    test('applies to Karate text in a candidate language', () => {
        assert.strictEqual(shouldApplyKarateMode(base), true);
        assert.strictEqual(shouldApplyKarateMode({ ...base, languageId: 'gherkin' }), true);
    });

    test('never applies when the official extension is installed', () => {
        assert.strictEqual(shouldApplyKarateMode({ ...base, officialInstalled: true }), false);
    });

    test('never applies when autoDetect is off', () => {
        assert.strictEqual(shouldApplyKarateMode({ ...base, autoDetect: false }), false);
    });

    test('never touches karate or karate-dsl documents or non-feature files', () => {
        assert.strictEqual(shouldApplyKarateMode({ ...base, languageId: 'karate' }), false);
        assert.strictEqual(shouldApplyKarateMode({ ...base, languageId: 'karate-dsl' }), false);
        assert.strictEqual(shouldApplyKarateMode({ ...base, fileName: '/p/a.txt' }), false);
    });

    test('workspace Karate config is enough without Karate text', () => {
        const text = 'Feature: x\n  Scenario: y\n    Given I log in\n';
        assert.strictEqual(shouldApplyKarateMode({ ...base, text }), false);
        assert.strictEqual(shouldApplyKarateMode({ ...base, text, workspaceHasKarateConfig: true }), true);
    });
});

suite('Karate completion context', () => {
    test('keyword after a step keyword', () => {
        assert.deepStrictEqual(completionContext('    * '), { kind: 'keyword' });
        assert.deepStrictEqual(completionContext('    Given ma'), { kind: 'keyword' });
    });
    test('operator after match target', () => {
        assert.deepStrictEqual(completionContext('    * match response '), { kind: 'operator' });
        assert.strictEqual(completionContext('    * match response == ').kind, 'none');
    });
    test('fuzzy marker after #', () => {
        assert.deepStrictEqual(completionContext("    * match response == { id: '#"), { kind: 'marker' });
    });
    test('read paths', () => {
        assert.deepStrictEqual(completionContext("    * def x = read('"), { kind: 'path', prefix: '', classpath: false });
        assert.deepStrictEqual(completionContext("    * call read('classpath:api/"), { kind: 'path', prefix: 'api/', classpath: true });
        assert.deepStrictEqual(completionContext('    * def x = read("data/'), { kind: 'path', prefix: 'data/', classpath: false });
    });
    test('nothing on plain lines', () => {
        assert.strictEqual(completionContext('  Scenario: foo').kind, 'none');
    });
});

import { INITIAL_REVIEW_STATE, afterAnswer, recordSuccess, reviewUrl } from '../../services/growth/ReviewPrompt';

suite('Review prompt state', () => {
    test('asks at the third success, then permanently stops on "never"', () => {
        let state = INITIAL_REVIEW_STATE;
        const asks: boolean[] = [];
        for (let i = 0; i < 3; i++) { const r = recordSuccess(state); state = r.state; asks.push(r.ask); }
        assert.deepStrictEqual(asks, [false, false, true]);
        state = afterAnswer(state, 'never');
        assert.strictEqual(recordSuccess(state).ask, false);
    });
    test('later asks again after 10 more successes, at most twice in total', () => {
        let state = afterAnswer({ ...INITIAL_REVIEW_STATE, successes: 3 }, 'later');
        assert.strictEqual(state.nextAskAt, 13);
        for (let i = 0; i < 9; i++) { state = recordSuccess(state).state; }
        const r = recordSuccess(state);
        assert.strictEqual(r.ask, true);
        state = afterAnswer(r.state, 'later');
        assert.strictEqual(state.optedOut, true);
        assert.strictEqual(recordSuccess(state).ask, false);
    });
    test('review URL follows the host editor', () => {
        assert.ok(reviewUrl('Visual Studio Code').startsWith('https://marketplace.visualstudio.com/'));
        assert.ok(reviewUrl('Cursor').startsWith('https://open-vsx.org/'));
    });
});


import { smartContext } from '../../services/language/smart/smartContext';
import { inlineSuggestion, smartItems } from '../../services/language/smart/smartCompletions';
import { predictNextStep } from '../../services/language/smart/predictor';
import { parseFeature, requestState, currentScenarioSteps, variablesIn, responseKeys } from '../../services/language/smart/scenarioModel';

const feature = [
    'Feature: pets',
    '',
    '  Background:',
    "    * def baseUrl = 'http://localhost:8080'",
    '    * url baseUrl',
    '',
    '  Scenario: list pets',
    "    Given path 'pet'",
    '    When method get',
    '    Then status 200',
    "    And match response == '#array'",
    '',
    '  Scenario: create pet',
    "    * def pet = { name: 'rex', status: 'available' }",
    "    Given path 'pet'",
    '    And request pet',
    '    When method post',
    '    Then status 201',
    "    And match response contains { id: '#number', name: '#string' }",
    '',
    '  Scenario: get one',
    "    Given path 'pet', 1",
    '    When method get',
    ''
];
const at = (needle: string, from = 0): number => feature.findIndex((l, i) => i >= from && l.includes(needle));

suite('Smart context', () => {
    test('detects member, karate api, method, status, header and configure contexts', () => {
        assert.deepStrictEqual(smartContext('    * match response.'), { kind: 'member', object: 'response', typed: '' });
        assert.deepStrictEqual(smartContext('    * def x = karate.ge'), { kind: 'karate-member', typed: 'ge' });
        assert.deepStrictEqual(smartContext('    When method '), { kind: 'method', typed: '' });
        assert.deepStrictEqual(smartContext('    Then status '), { kind: 'status' });
        assert.deepStrictEqual(smartContext('    * header Auth'), { kind: 'header-name', typed: 'Auth' });
        assert.deepStrictEqual(smartContext('    * header Content-Type = '), { kind: 'header-value', header: 'Content-Type' });
        assert.deepStrictEqual(smartContext('    * configure '), { kind: 'configure-key', typed: '' });
        assert.deepStrictEqual(smartContext("    * path 'pe"), { kind: 'url-path', typed: 'pe' });
        assert.deepStrictEqual(smartContext('@sm'), { kind: 'tag', typed: 'sm' });
        assert.deepStrictEqual(smartContext('    * def y = pet.'), { kind: 'member', object: 'pet', typed: '' });
        assert.strictEqual(smartContext('    * def y = pe').kind, 'expression');
        assert.strictEqual(smartContext('  Scenario: x').kind, 'none');
    });
});

suite('Smart scenario model', () => {
    test('reads variables with shapes and keys, and the request being built', () => {
        const model = parseFeature(feature, at('When method post') + 1);
        const steps = currentScenarioSteps(model);
        const vars = variablesIn(steps);
        assert.deepStrictEqual(vars.get('pet')?.keys, ['name', 'status']);
        assert.strictEqual(vars.get('baseUrl')?.shape, 'string');
        const state = requestState(steps);
        assert.strictEqual(state.hasUrl, true);
        assert.strictEqual(state.hasRequest, true);
        assert.strictEqual(state.method, 'post');
        assert.deepStrictEqual(responseKeys(feature), ['id', 'name']);
    });
    test('ignores doc-string bodies', () => {
        const lines = ['Scenario: a', '  * text x =', '  """', '  * def hidden = 1', '  """', '  * def y = 2'];
        const names = [...variablesIn(parseFeature(lines).steps).keys()];
        assert.ok(names.includes('y') && !names.includes('hidden'));
    });
});

suite('Smart suggestions', () => {
    test('predicts the next step from workflow rules', () => {
        assert.strictEqual(predictNextStep(feature, at('Given path', at('Scenario: get one')) + 1)?.text, 'method get');
        assert.strictEqual(predictNextStep(feature, feature.length - 1)?.text, 'status 200');
        const afterPost = [...feature.slice(0, at('Then status 201')), '    '];
        assert.strictEqual(predictNextStep(afterPost, afterPost.length - 1)?.text, 'status 201');
    });
    test('repeats a pattern the file already uses, and says so', () => {
        const lines = [
            'Scenario: a', "  * path 'x'", '  * method get', '  * status 200', "  * match response == '#array'",
            'Scenario: b', "  * path 'y'", '  * method get', '  * status 200', "  * match response == '#array'",
            'Scenario: c', "  * path 'z'", '  * method get', '  * status 200', '  * '
        ];
        const prediction = predictNextStep(lines, lines.length - 1);
        assert.strictEqual(prediction?.source, 'learned');
        assert.strictEqual(prediction?.text, "match response == '#array'");
    });
    test('does not suggest what the scenario already has', () => {
        const lines = ['Scenario: a', "  * path 'x'", '  * method get', '  * status 200', "  * match response == '#array'", '  * '];
        assert.strictEqual(predictNextStep(lines, lines.length - 1), undefined);
    });
    test('ghost text for a keyword, a partial step and a blank line', () => {
        const base = [...feature.slice(0, feature.length - 1)];
        const lines = [...base, '    * '];
        assert.strictEqual(inlineSuggestion(lines, lines.length - 1, 6), 'status 200');
        const partial = [...base, '    * sta'];
        assert.strictEqual(inlineSuggestion(partial, partial.length - 1, 9), 'tus 200');
        const styled = [...base.slice(0, -1), "    Given path 'pet', 1", '    When method get', '    '];
        assert.strictEqual(inlineSuggestion(styled, styled.length - 1, 4), 'Then status 200');
        const header = [...feature, '  Scenario: z'];
        assert.strictEqual(inlineSuggestion(header, header.length - 1, header[header.length - 1].length), undefined);
    });
    test('variable, member, api, method, status and tag items', () => {
        const line = at('And request pet') ;
        const labels = (context: ReturnType<typeof smartContext>, ln = line) => smartItems(context, feature, ln, { configVariables: ['token'], paths: ['owner'], tags: ['smoke'] }).map(i => i.label);
        const expr = labels(smartContext('    * print p'));
        assert.ok(expr.indexOf('pet') < expr.indexOf('response') && expr.includes('token') && expr.includes('baseUrl'));
        assert.deepStrictEqual(labels(smartContext('    * print pet.')), ['name', 'status']);
        assert.ok(labels(smartContext('    * print response.')).includes('id'));
        const api = smartItems(smartContext('    * def a = karate.'), feature, line);
        assert.ok(api.some(i => i.label === 'get' && i.insertText === 'get($1)' && i.snippet));
        assert.ok(api.some(i => i.label === 'env' && !i.snippet));
        const methods = smartItems(smartContext('    When method '), feature, at('When method post')).sort((a, b) => (a.sortText ?? '').localeCompare(b.sortText ?? ''));
        assert.strictEqual(methods[0].label, 'post');
        const statuses = smartItems(smartContext('    Then status '), feature, at('Then status 201')).sort((a, b) => (a.sortText ?? '').localeCompare(b.sortText ?? ''));
        assert.strictEqual(statuses[0].label, '201');
        assert.ok(labels(smartContext('@')).includes('smoke') && labels(smartContext('@')).includes('ignore'));
        assert.ok(labels(smartContext("    * path 'o")).includes('owner') && labels(smartContext("    * path 'o")).includes('pet'));
        assert.deepStrictEqual(labels(smartContext('    * header Authorization = ')), ["'Bearer '"]);
    });
    test('keyword list puts the predicted next step first', () => {
        const items = smartItems(smartContext('    * '), feature, feature.length - 1).sort((a, b) => (a.sortText ?? '').localeCompare(b.sortText ?? ''));
        assert.strictEqual(items[0].label, 'status 200');
        assert.strictEqual(items[1].label, 'status');
    });
});
