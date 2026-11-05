// Runs inside the VS Code extension host (see scripts/test-language-vscode.cjs). WB_SCENARIO selects the check:
//   karate   - Karate project: language mode switches, completion works, the step debugger stops and steps
//   plain    - plain Cucumber project: the language mode is left alone
//   official - the official Karate extension is installed: this extension never switches the mode
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, what, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) { return value; }
    if (Date.now() > end) { throw new Error(`timed out waiting for ${what}`); }
    await sleep(150);
  }
}
const notes = [];
const note = text => notes.push(text);

async function karate(root) {
  const demo = vscode.Uri.file(path.join(root, 'demo.feature'));
  const doc = await vscode.workspace.openTextDocument(demo);
  await vscode.window.showTextDocument(doc);
  await until(() => doc.languageId === 'karate-dsl', 'language mode karate-dsl');
  note('demo.feature switched to karate-dsl automatically');

  // Completion
  const probe = vscode.Uri.file(path.join(root, 'probe.feature'));
  const probeDoc = await vscode.workspace.openTextDocument(probe);
  await vscode.window.showTextDocument(probeDoc);
  await until(() => probeDoc.languageId === 'karate-dsl', 'probe language mode');
  const lines = probeDoc.getText().split('\n');
  const at = prefix => {
    const line = lines.findIndex(l => l === prefix);
    assert.ok(line >= 0, `probe line missing: ${prefix}`);
    return new vscode.Position(line, prefix.length);
  };
  const labels = async prefix => {
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', probe, at(prefix));
    return list.items.map(i => (typeof i.label === 'string' ? i.label : i.label.label));
  };
  const keywords = await labels('    * ');
  assert.ok(keywords.includes('match') && keywords.includes('def') && keywords.includes('configure'), 'step keywords');
  note(`step keyword completion: ${keywords.length} items`);
  const ops = await labels('    * match response ');
  assert.ok(ops.includes('contains only') && ops.includes('=='), 'match operators');
  note('match operator completion ok');
  const markers = await labels("    * match response == { id: '#");
  assert.ok(markers.includes('#number') && markers.includes('#string'), 'fuzzy markers');
  note('fuzzy marker completion ok');
  const files = await labels("    * def users = read('");
  assert.ok(files.includes('data/users.json'), `read() path completion, got ${files.slice(0, 5)}`);
  note('read() file path completion ok');

  // Debugger
  const wantedLine = doc.getText().split('\n').findIndex(l => /def n =/.test(l)); // zero-based
  vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(demo, new vscode.Position(wantedLine, 0)))]);
  const stops = [];
  let terminated = false;
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('karate-dsl', {
    createDebugAdapterTracker: () => ({
      onDidSendMessage: m => {
        if (m.type === 'event' && m.event === 'stopped') { stops.push(m.body); }
        if (m.type === 'event' && m.event === 'terminated') { terminated = true; }
        if (m.type === 'event' && m.event === 'output') { note(`debug output: ${String(m.body.output).trim().slice(0, 400)}`); }
        if (m.type === 'response' && m.success === false) { note(`debug ${m.command} failed: ${m.message}`); }
      }
    })
  });
  const started = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], {
    type: 'karate-dsl', request: 'launch', name: 'Debug demo', feature: demo.fsPath
  });
  assert.ok(started, 'debug session must start');
  await until(() => stops.length >= 1, 'breakpoint stop', 90000);
  assert.equal(stops[0].reason, 'breakpoint');
  const session = vscode.debug.activeDebugSession;
  const stack = await session.customRequest('stackTrace', { threadId: 1 });
  assert.equal(stack.stackFrames[0].line, wantedLine + 1);
  assert.match(stack.stackFrames[0].name, /def n/);
  const scopes = await session.customRequest('scopes', { frameId: 1 });
  const vars = await session.customRequest('variables', { variablesReference: scopes.scopes[0].variablesReference });
  const names = vars.variables.map(v => v.name);
  assert.ok(names.includes('user'), `variables should include user, got ${names}`);
  const evaluated = await session.customRequest('evaluate', { expression: 'user.name', frameId: 1 });
  assert.equal(evaluated.result, 'ada');
  note(`stopped at line ${wantedLine + 1}; variables ${names.join(',')}; evaluate user.name = ada`);
  await session.customRequest('next', { threadId: 1 });
  await until(() => stops.length >= 2, 'step stop');
  assert.equal(stops[1].reason, 'step');
  await session.customRequest('continue', { threadId: 1 });
  await until(() => terminated, 'session end');
  tracker.dispose();
  note('stepped once, continued, session terminated');
}

async function plain(root) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'plain.feature')));
  await vscode.window.showTextDocument(doc);
  await sleep(4000);
  assert.notEqual(doc.languageId, 'karate-dsl');
  note(`plain Cucumber file left alone (languageId=${doc.languageId})`);
}

async function official(root) {
  assert.ok(vscode.extensions.getExtension('karatelabs.karate'), 'official extension must be installed for this scenario');
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'demo.feature')));
  await vscode.window.showTextDocument(doc);
  await sleep(4000);
  assert.notEqual(doc.languageId, 'karate-dsl');
  note(`official extension present; languageId stays ${doc.languageId}`);
  const items = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(0, 0));
  assert.ok(items, 'completion query works');
}

async function run() {
  const out = process.env.WB_E2E_RESULT;
  try {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const ext = vscode.extensions.getExtension('MuthuKumarKoodalingam.karate-test-generator');
    assert.ok(ext, 'extension under test must be installed');
    await ext.activate();
    await { karate, plain, official }[process.env.WB_SCENARIO](root);
    fs.writeFileSync(out, `${notes.join('\n')}\nRESULT: PASS\n`);
  } catch (error) {
    fs.writeFileSync(out, `${notes.join('\n')}\nFAIL: ${error.stack || error}\nRESULT: FAIL\n`);
    throw error;
  }
}

module.exports = { run };
