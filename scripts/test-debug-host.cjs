// Debug host integration test. Needs Java 21+ and a Karate 2 jar:
//   KARATE_TEST_JAR=/path/to/karate-2.1.4.jar node scripts/test-debug-host.cjs
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const hostDir = path.join(__dirname, '..', 'resources', 'workbench', 'host');
const jar = process.env.KARATE_TEST_JAR;
const skip = !jar || !fs.existsSync(jar) ? 'set KARATE_TEST_JAR to a Karate 2 jar' : false;

class Host {
  constructor() {
    this.child = childProcess.spawn('java', ['-cp', [hostDir, jar].join(path.delimiter), 'KarateDebugHost'], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    readline.createInterface({ input: this.child.stdout }).on('line', line => {
      const msg = JSON.parse(line);
      if (msg.event) {
        const waiter = this.waiters.findIndex(w => w.match(msg));
        if (waiter >= 0) { this.waiters.splice(waiter, 1)[0].resolve(msg); } else { this.events.push(msg); }
      } else if (this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg); this.pending.delete(msg.id);
      }
    });
  }
  send(cmd, args = {}) {
    const id = this.nextId++;
    return new Promise(resolve => { this.pending.set(id, resolve); this.child.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n'); });
  }
  event(name) {
    const i = this.events.findIndex(e => e.event === name);
    if (i >= 0) { return Promise.resolve(this.events.splice(i, 1)[0]); }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${name}`)), 60000);
      this.waiters.push({ match: m => m.event === name, resolve: m => { clearTimeout(t); resolve(m); } });
    });
  }
  stop() { this.child.kill(); }
}

describe('KarateDebugHost', { skip }, () => {
  let dir; let feature; let host;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-test-'));
    feature = path.join(dir, 'sample.feature');
    fs.writeFileSync(feature, [
      'Feature: debug sample',
      '',
      '  Scenario: steps',
      '    * def a = 1',
      "    * def b = { x: '#(a)' }",
      '    * def c = a + 1',
      '    * match c == 2',
      ''
    ].join('\n'));
    host = new Host();
  });
  after(() => { host.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('stops at a breakpoint, shows variables, steps and finishes', async () => {
    const launched = await host.send('launch', { feature, workDir: dir, breakpoints: { [feature]: [6] } });
    assert.equal(launched.ok, true, launched.error);
    let stop = await host.event('stopped');
    assert.equal(stop.reason, 'breakpoint');
    assert.equal(stop.line, 6);
    const vars = (await host.send('variables')).variables;
    assert.equal(vars.a.value, '1');
    assert.equal(vars.b.children.x.value, '1');
    assert.equal(vars.c, undefined);
    const evaluated = await host.send('evaluate', { expression: 'a + 41' });
    assert.equal(evaluated.result.value, '42');

    await host.send('stepOver');
    stop = await host.event('stopped');
    assert.equal(stop.reason, 'step');
    assert.equal(stop.line, 7);
    assert.equal((await host.send('variables')).variables.c.value, '2');

    await host.send('continue');
    const done = await host.event('terminated');
    assert.equal(done.error, undefined);
    assert.equal(done.failed, 0);
  });
});

describe('KarateDebugHost pause', { skip }, () => {
  test('pause stops before the next step while the scenario is running, then continue finishes it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-pause-'));
    const feature = path.join(dir, 'slow.feature');
    fs.writeFileSync(feature, ['Feature: slow', '', '  Scenario: s', '    * def a = 1', '    * karate.pause(1500)', '    * def b = 2', '    * def c = 3', ''].join('\n'));
    const host = new Host();
    try {
      assert.equal((await host.send('launch', { feature, workDir: dir })).ok, true);
      await new Promise(resolve => setTimeout(resolve, 600)); // inside the slow step
      assert.equal((await host.send('pause')).ok, true);
      const stop = await host.event('stopped');
      assert.equal(stop.reason, 'pause');
      assert.ok(stop.line >= 6, `stopped after the slow step, at line ${stop.line}`);
      assert.equal((await host.send('pause')).ok, false, 'pausing twice is refused');
      assert.equal((await host.send('continue')).ok, true);
      const done = await host.event('terminated');
      assert.equal(done.failed, 0);
    } finally { host.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('KarateDebugAdapter (DAP)', { skip }, () => {
  const { KarateDebugAdapter } = require(path.join(__dirname, '..', 'out', 'debug', 'KarateDebugAdapter.js'));
  let dir; let feature;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dap-test-'));
    feature = path.join(dir, 'sample.feature');
    fs.writeFileSync(feature, 'Feature: dap\n\n  Scenario: s\n    * def user = { name: \'ada\', tags: [1, 2] }\n    * def n = user.tags.length\n    * match n == 2\n');
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('initialize, breakpoint, stack, scopes, variables, evaluate, step, terminate', async () => {
    const messages = [];
    const waiters = [];
    const adapter = new KarateDebugAdapter(msg => {
      const i = waiters.findIndex(w => w.match(msg));
      if (i >= 0) { waiters.splice(i, 1)[0].resolve(msg); } else { messages.push(msg); }
    }, async () => ({ javaPath: 'java', hostDir, classpath: [jar], feature, env: '', configDir: '', workDir: dir }));
    const wait = match => {
      const i = messages.findIndex(match);
      if (i >= 0) { return Promise.resolve(messages.splice(i, 1)[0]); }
      return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('timeout')), 60000); waiters.push({ match, resolve: m => { clearTimeout(t); resolve(m); } }); });
    };
    let seq = 1;
    const request = async (command, args) => {
      const id = seq++;
      adapter.handleMessage({ seq: id, type: 'request', command, arguments: args });
      return wait(m => m.type === 'response' && m.request_seq === id);
    };

    assert.equal((await request('initialize', {})).success, true);
    await wait(m => m.event === 'initialized');
    assert.equal((await request('launch', { feature })).success, true);
    const bp = await request('setBreakpoints', { source: { path: feature }, breakpoints: [{ line: 5 }] });
    assert.equal(bp.body.breakpoints[0].verified, true);
    await request('configurationDone', {});
    const stop = await wait(m => m.event === 'stopped');
    assert.equal(stop.body.reason, 'breakpoint');

    const stack = await request('stackTrace', { threadId: 1 });
    assert.equal(stack.body.stackFrames[0].line, 5);
    assert.match(stack.body.stackFrames[0].name, /def n/);
    const scopes = await request('scopes', { frameId: 1 });
    const vars = await request('variables', { variablesReference: scopes.body.scopes[0].variablesReference });
    const user = vars.body.variables.find(v => v.name === 'user');
    assert.ok(user.variablesReference > 0);
    const fields = await request('variables', { variablesReference: user.variablesReference });
    assert.deepEqual(fields.body.variables.map(v => v.name), ['name', 'tags']);
    const evaluated = await request('evaluate', { expression: 'user.name', frameId: 1 });
    assert.equal(evaluated.body.result, 'ada');

    await request('next', { threadId: 1 });
    const second = await wait(m => m.event === 'stopped');
    assert.equal(second.body.reason, 'step');
    assert.equal((await request('stackTrace', {})).body.stackFrames[0].line, 6);
    await request('continue', { threadId: 1 });
    await wait(m => m.event === 'terminated');
    await request('disconnect', {});
  });
});

describe('KarateDebugAdapter pause request', { skip }, () => {
  const { KarateDebugAdapter } = require(path.join(__dirname, '..', 'out', 'debug', 'KarateDebugAdapter.js'));
  test('the Pause button stops a running session before the next step', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dap-pause-'));
    const feature = path.join(dir, 'slow.feature');
    fs.writeFileSync(feature, ['Feature: slow', '', '  Scenario: s', '    * def a = 1', '    * karate.pause(1500)', '    * def b = 2', ''].join('\n'));
    const messages = []; const waiters = [];
    const adapter = new KarateDebugAdapter(msg => {
      const i = waiters.findIndex(w => w.match(msg));
      if (i >= 0) { waiters.splice(i, 1)[0].resolve(msg); } else { messages.push(msg); }
    }, async () => ({ javaPath: 'java', hostDir, classpath: [jar], feature, env: '', configDir: '', workDir: dir }));
    const wait = match => {
      const i = messages.findIndex(match);
      if (i >= 0) { return Promise.resolve(messages.splice(i, 1)[0]); }
      return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('timeout')), 60000); waiters.push({ match, resolve: m => { clearTimeout(t); resolve(m); } }); });
    };
    let seq = 1;
    const request = async (command, args) => { const id = seq++; adapter.handleMessage({ seq: id, type: 'request', command, arguments: args }); return wait(m => m.type === 'response' && m.request_seq === id); };
    try {
      await request('initialize', {}); await wait(m => m.event === 'initialized');
      await request('launch', { feature });
      await request('configurationDone', {});
      await new Promise(resolve => setTimeout(resolve, 700));
      assert.equal((await request('pause', { threadId: 1 })).success, true);
      const stop = await wait(m => m.event === 'stopped');
      assert.equal(stop.body.reason, 'pause');
      await request('continue', { threadId: 1 });
      await wait(m => m.event === 'terminated');
    } finally { await request('disconnect', {}).catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
