import * as assert from 'assert';
import { isKarateText, shouldApplyKarateMode } from '../../services/language/karateDetection';
import { buildPrompt, cleanCompletion, contextFrom, redactLine, shouldSuggest, variablesDefined } from '../../services/language/inlineSuggestionLogic';
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

suite('Inline suggestion logic', () => {
    test('suggests only at the end of a step line or after a step on a blank indented line', () => {
        assert.strictEqual(shouldSuggest('    * ', '', undefined), true);
        assert.strictEqual(shouldSuggest("    Given path 'pets'", '', undefined), true);
        assert.strictEqual(shouldSuggest('    ', '', "    * def a = 1"), true);
        assert.strictEqual(shouldSuggest('    ', '', '  Scenario: x'), false);
        assert.strictEqual(shouldSuggest('    * def', ' = 1', undefined), false);
        assert.strictEqual(shouldSuggest('  # note', '', undefined), false);
        assert.strictEqual(shouldSuggest('  Scenario: foo', '', undefined), false);
    });
    test('redacts secret-looking values before they leave the editor', () => {
        assert.ok(!redactLine("    * header Authorization = 'Bearer abcdefghijklmnop'").includes('abcdefghijklmnop'));
        assert.strictEqual(redactLine("    * def a = 'hello'"), "    * def a = 'hello'");
    });
    test('prompt carries context and defined variables', () => {
        const lines = ['Feature: x', '  Scenario: y', "    * def id = 1", '    * url base', '    * '];
        const { user, system } = buildPrompt(contextFrom(lines, 4, lines[4].length));
        assert.ok(user.includes('Variables defined so far: id'));
        assert.ok(user.includes('<CURSOR>'));
        assert.ok(/ONLY the text to insert/.test(system));
        assert.deepStrictEqual(variablesDefined(lines), ['id']);
    });
    test('cleans model replies into safe insertions', () => {
        assert.strictEqual(cleanCompletion("def user = { name: 'ada' }", '    * '), "def user = { name: 'ada' }");
        assert.strictEqual(cleanCompletion("* match response == { id: '#number' }", '    * '), "match response == { id: '#number' }");
        assert.strictEqual(cleanCompletion("```\npath 'pets'\n```", "    Given "), "path 'pets'");
        assert.strictEqual(cleanCompletion("status 200\n* match response == '#array'\nScenario: no", '    Then '), "status 200\n    * match response == '#array'");
        assert.strictEqual(cleanCompletion("match response == 1", '    * '), "match response == 1");
        assert.strictEqual(cleanCompletion("   \n", '    * '), undefined);
        // a bare step on an empty line gets a keyword
        assert.strictEqual(cleanCompletion("def a = 1", '    '), '* def a = 1');
        // text the model repeated is not inserted twice
        assert.strictEqual(cleanCompletion("* match response contains { a: 1 }", '    * match response '), "contains { a: 1 }");
    });
});
