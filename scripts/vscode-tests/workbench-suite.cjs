// Runs inside the VS Code extension host (see scripts/test-workbench-vscode.cjs). Drives Workbench through the real
// vscode API: CodeLens, commands, the document edits it makes, and the view state it would show.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vscode = require('vscode');

const notes = [];
const note = text => notes.push(text);

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
}

async function main() {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const uri = vscode.Uri.file(path.join(root, 'src', 'test', 'java', 'users.feature'));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  const extension = vscode.extensions.getExtension('MuthuKumarKoodalingam.karate-test-generator');
  assert.ok(extension, 'the extension under test must be installed');

  note(`active after opening a .feature file, before any command: ${extension.isActive}`);
  const before = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri);
  note(`Send lenses before activation: ${before.filter(l => /Send/.test(l.command?.title || '')).length}`);

  await extension.activate();
  const api = extension.exports.workbenchTesting;
  assert.ok(api, 'the extension must expose the Workbench test handle');

  const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri);
  const sends = lenses.filter(l => /Send/.test(l.command?.title || ''));
  assert.equal(sends.length, 2, 'one Send lens for each of the two method steps');
  note(`Send lenses after activation: ${sends.length}`);

  const text = () => doc.getText();
  const lineOf = pattern => text().split('\n').findIndex(line => pattern.test(line));
  const state = () => api.getState();

  // 0. "This step only" in a brand-new session must not fail for lack of the Background (url, variables).
  await vscode.commands.executeCommand('karate-dsl.workbench.runStep', uri, lineOf(/When method post/));
  assert.equal(state().step.status, 'PASSED', `a new session must run the Background first: ${state().step.error}`);
  assert.equal(state().response.status, 201);
  assert.match(state().notice, /session was new/);
  await vscode.commands.executeCommand('karate-dsl.workbench.stop');
  note('"This step only" on a new session ran the Background and earlier steps first');

  // 1. Run to the POST.
  await vscode.commands.executeCommand('karate-dsl.workbench.runToCursor', uri, lineOf(/When method post/));
  assert.equal(state().notice, '', `unexpected notice: ${state().notice}`);
  assert.equal(state().step.status, 'PASSED', state().step.error);
  assert.equal(state().response.status, 201);
  assert.equal(state().response.assertable, true);
  assert.equal(typeof state().variables.baseUrl, 'string');
  assert.equal(state().variables.token, '••••••', 'secret variables must be masked in the view');
  note('run to cursor on the POST: passed, 201, token masked');
  const createdId = Number(JSON.stringify(state().response.body).match(/"id":(\d+)/)[1]);

  // 2. Click-to-assert.
  const send = message => api.send({ type: 'assert', ...message });
  await send({ path: ['id'], action: 'type' });
  await send({ path: ['name'], action: 'value' });
  await send({ path: [], action: 'status' });
  assert.match(state().notice, /already in the scenario/, 'the fixture already has "Then status 201" for this response');
  const afterInsert = text();
  assert.match(afterInsert, /Then match response\.id == '#number'/);
  assert.match(afterInsert, /And match response\.name == 'Ada'/);
  const lines = afterInsert.split('\n');
  const post = lines.findIndex(l => /When method post/.test(l));
  assert.match(lines[post + 1], /match response\.id/, 'new lines go right after the last step that ran, ahead of the un-run status step');
  assert.match(lines[post + 2], /match response\.name/);
  note('click-to-assert inserted type and value lines in run order; a duplicate status line was refused');

  // 2b. Advanced options (applied directly; the editor shows the same options in a quick pick).
  const stepPassed = () => assert.equal(state().step.status, 'PASSED', state().step.error);
  await send({ path: ['name'], action: 'advanced', option: 'startsWith', param: 'Ad' });
  assert.match(text(), /match response\.name == '#\? _\.startsWith\("Ad"\)'/);
  stepPassed();
  await send({ path: ['email'], action: 'advanced', option: 'regex' });
  assert.match(text(), /match response\.email == '#regex /);
  stepPassed();
  await send({ path: ['id'], action: 'advanced', option: 'greaterThan' });
  assert.match(text(), /match response\.id == '#number\? _ > 0'/);
  stepPassed();
  await send({ path: [], action: 'advanced', option: 'responseTime', param: '60000' });
  assert.match(text(), /assert responseTime < 60000/);
  stepPassed();
  await send({ path: [], action: 'advanced', option: 'exact' });
  assert.match(text(), /match response == \{"id":"#ignore","role":"member","name":"Ada","email":"ada@example\.com"\}/);
  stepPassed();
  await api.send({ type: 'assert', root: 'headers', path: ['content-type'], action: 'headerContains' });
  assert.match(text(), /match header content-type contains 'application\/json'/);
  stepPassed();
  const beforeBad = text();
  await send({ path: ['name'], action: 'advanced', option: 'length', param: 'abc' });
  assert.match(state().notice, /must be a number/);
  assert.equal(text(), beforeBad, 'an invalid parameter must not change the file');
  await send({ path: ['name'], action: 'advanced', option: 'notAnOption' });
  assert.match(state().notice, /not available/);
  note('advanced options (text, regex, number, response time, exact, header) inserted, ran and passed; bad input changed nothing');

  // 3. Masked values are refused.
  await send({ path: ['token'], action: 'value' });
  assert.doesNotMatch(text(), /token/, 'a masked or missing field must not be written into the file');

  // 4. Run to the GET: the session is reused, so no second POST is sent.
  await vscode.commands.executeCommand('karate-dsl.workbench.runToCursor', uri, lineOf(/When method get/));
  assert.equal(state().step.status, 'PASSED', state().step.error);
  assert.equal(state().response.status, 200);
  assert.equal(Number(JSON.stringify(state().response.body).match(/"id":(\d+)/)[1]), createdId);
  assert.equal(await get(`http://127.0.0.1:8099/users/${createdId + 1}`), 404, 'the POST must not be sent a second time');
  note('run to cursor on the GET reused the session (no second POST)');

  // 5. Editing a step that already ran restarts the session, and the earlier assertion now fails.
  const edit = new vscode.WorkspaceEdit();
  const requestLine = lineOf(/And request/);
  edit.replace(uri, new vscode.Range(requestLine, 0, requestLine, doc.lineAt(requestLine).text.length), doc.lineAt(requestLine).text.replace('Ada', 'Bob'));
  await vscode.workspace.applyEdit(edit);
  await vscode.commands.executeCommand('karate-dsl.workbench.runToCursor', uri, lineOf(/When method get/));
  assert.equal(state().step.status, 'FAILED');
  assert.match(state().step.error, /not equal/);
  assert.match(state().step.text, /match response\.name == 'Ada'/);
  note('editing an executed step restarted the session; the earlier assertion failed with Karate\'s diff');

  // 6. Environments and lifecycle.
  await api.send({ type: 'selectEnv', env: 'staging' });
  assert.equal(state().env, 'staging');
  assert.match(state().notice, /staging/);
  await vscode.commands.executeCommand('karate-dsl.workbench.restart');
  assert.match(state().notice, /Restarted/);
  await vscode.commands.executeCommand('karate-dsl.workbench.stop');
  assert.match(state().notice, /stopped/i);
  note('environment switch, restart and stop commands work');
}

exports.run = async function run() {
  const file = process.env.WB_E2E_RESULT;
  try {
    await main();
    note('RESULT: PASS');
  } catch (error) {
    note(`RESULT: FAIL\n${error && error.stack ? error.stack : error}`);
    if (file) { fs.writeFileSync(file, notes.join('\n')); }
    throw error;
  }
  if (file) { fs.writeFileSync(file, notes.join('\n')); }
};
