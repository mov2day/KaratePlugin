const assert = require('node:assert/strict');
const out = rel => require('../../out/' + rel);
const jira = fields => out('services/jira/JiraParser').JiraParser.prototype.parse.call(new (out('services/jira/JiraParser').JiraParser)(), { key: 'K-1', fields: { summary: 's', issuetype: { name: 'Story' }, labels: [], ...fields } });
const page = value => ({ id: '1', title: 'T', body: { storage: { value } } });
const confluence = value => new (out('services/confluenceParser').ConfluenceParser)().parsePageContent(page(value));

module.exports = [
    { name: 'parsers: jira acceptanceCriteria string array is used as-is', run() {
        const c = jira({ acceptanceCriteria: ['  one thing  ', 'two thing', ''], description: 'ignored description line here' });
        assert.deepEqual(c.acceptanceCriteria.slice(0, 2), ['one thing', 'two thing']);
    } },
    { name: 'parsers: jira ADF custom field keeps the old adfToText path; non-string arrays are not treated as plain criteria', run() {
        const adf = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ADF criterion one is here' }] }] };
        assert.deepEqual(jira({ customfield_10001: adf }).acceptanceCriteria, ['ADF criterion one is here']);
        const objs = jira({ customfield_10020: [{ id: 1, name: 'Sprint 1' }], description: '' }).acceptanceCriteria;
        assert.ok(objs.every(x => typeof x === 'string'));
        assert.ok(objs.length === 0 || objs.join(' ').includes('Sprint'), 'old path: JSON text, unchanged');
        assert.deepEqual(jira({ acceptanceCriteria: [], description: 'A long enough description line' }).acceptanceCriteria, ['A long enough description line']);
    } },
    { name: 'parsers: confluence TC heading extracts steps, expected and description', run() {
        const d = confluence('<h2>TC-7 Pay</h2><p>Precondition: cart</p><ol><li>POST /pay</li><li>Expect status 200</li></ol>');
        assert.equal(d.testCases.length, 1);
        assert.deepEqual(d.testCases[0], { name: 'TC-7 Pay', description: 'Precondition: cart', steps: ['POST /pay'], expectedResult: 'Expect status 200' });
    } },
    { name: 'parsers: confluence ordinary headings and Scenario headings with a table never duplicate cases', run() {
        assert.equal(confluence('<h2>Overview</h2><ol><li>do x</li></ol>').testCases.length, 0);
        assert.equal(confluence('<h2>TC-1 empty</h2><p>nothing</p>').testCases.length, 0);
        const table = '<table><tr><th>Test Case</th><th>Steps</th><th>Expected Result</th></tr><tr><td>Login</td><td><ul><li>open</li></ul></td><td>ok</td></tr></table>';
        const d = confluence(`<h2>Scenario: logins</h2>${table}`);
        assert.equal(d.testCases.length, 1);
        assert.equal(d.testCases[0].name, 'Login');
    } }
];
