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
