// Workbench tests. Unit tests always run. Integration tests need Java 21+ and a Karate 2 jar:
//   KARATE_TEST_JAR=/path/to/karate-2.1.4.jar npm run test:workbench
// Gradle tests also need `gradle` on PATH and run offline.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'out', 'services', 'workbench');
const fixtures = path.join(__dirname, 'fixtures', 'workbench');
const hostDir = path.join(root, 'resources', 'workbench', 'host');

const steps = require(path.join(out, 'GherkinSteps.js'));
const assertions = require(path.join(out, 'AssertionBuilder.js'));
const advanced = require(path.join(out, 'AdvancedAssertions.js'));
const redaction = require(path.join(out, 'Redaction.js'));
const protocol = require(path.join(out, 'SessionProtocol.js'));
const envs = require(path.join(out, 'EnvDiscovery.js'));
const state = require(path.join(out, 'WorkbenchState.js'));
const classpath = require(path.join(out, 'ClasspathResolver.js'));
const { WorkbenchSession } = require(path.join(out, 'WorkbenchSession.js'));

async function passes(promise) {
  const result = await promise;
  assert.equal(result.status, 'PASSED', result.error);
  return result;
}

function tempCopy(from) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-test-'));
  fs.cpSync(from, dir, { recursive: true });
  return dir;
}

describe('GherkinSteps', () => {
  const text = [
    'Feature: Users',
    '',
    'Background:',
    "  * url 'http://x'",
    '',
    '# a comment',
    'Scenario: create',
    "  Given path 'users'",
    '  And request',
    '  """',
    '  { "name": "Ada" }',
    '  """',
    '  When method post',
    '  Then status 201',
    '  * table rows',
    '    | a | b |',
    '    | 1 | 2 |',
    '',
    '@slow',
    'Scenario Outline: out',
    '  * print <n>',
    '  Examples:',
    '    | n |',
    '    | 1 |',
    '',
    'Scenario: second',
    "  * print 'x'"
  ].join('\n');
  const parsed = steps.parseFeature(text);

  test('finds background, scenarios, and the outline flag', () => {
    assert.equal(parsed.background.length, 1);
    assert.deepEqual(parsed.scenarios.map(item => [item.name, item.outline]), [['create', false], ['out', true], ['second', false]]);
  });

  test('keeps docstrings and tables inside their step', () => {
    const create = parsed.scenarios[0];
    assert.equal(create.steps.length, 5);
    assert.match(create.steps[1].text, /^And request\n\s*"""\n\s*\{ "name": "Ada" \}\n\s*"""$/);
    assert.equal(create.steps[1].line, 8);
    assert.equal(create.steps[1].endLine, 11);
    assert.match(create.steps[4].text, /\| 1 \| 2 \|$/);
  });

  test('example rows do not become steps', () => {
    assert.equal(parsed.scenarios[1].steps.length, 1);
  });

  test('scenarioAtLine and stepAtLine use the cursor line', () => {
    assert.equal(steps.scenarioAtLine(parsed, 10).name, 'create');
    assert.equal(steps.scenarioAtLine(parsed, 26).name, 'second');
    assert.equal(steps.scenarioAtLine(parsed, 0).name, 'create');
    const hit = steps.stepAtLine(parsed.scenarios[0], 10);
    assert.equal(hit.index, 1);
    assert.equal(steps.stepAtLine(parsed.scenarios[0], 17), undefined);
  });

  test('normalizeStepText drops leading indentation and trailing spaces', () => {
    assert.equal(steps.normalizeStepText('   * def a = 1   '), '* def a = 1');
  });

  test('planRun reuses an unchanged prefix, restarts otherwise, and runs one step on request', () => {
    const background = ['* url 1'];
    const list = ['a', 'b', 'c'];
    assert.deepEqual(steps.planRun(background, list, 1, 'to', []), { restart: false, toRun: ['* url 1', 'a', 'b'] });
    assert.deepEqual(steps.planRun(background, list, 2, 'to', ['* url 1', 'a', 'b']), { restart: false, toRun: ['c'] });
    assert.deepEqual(steps.planRun(background, list, 1, 'to', ['* url 1', 'a', 'b']), { restart: true, toRun: ['* url 1', 'a', 'b'] });
    assert.deepEqual(steps.planRun(background, ['a', 'CHANGED', 'c'], 2, 'to', ['* url 1', 'a', 'b']).restart, true);
    assert.deepEqual(steps.planRun(background, list, 2, 'this', []), { restart: false, toRun: ['c'] });
  });

  test('insertionPoint appends after the assertion block of the method step', () => {
    const create = parsed.scenarios[0].steps;
    const point = steps.insertionPoint(create, 2);
    assert.equal(point.afterLine, 13);
    assert.equal(point.hasAssertions, true);
    assert.equal(point.indent, '  ');
    const none = steps.insertionPoint([{ ...create[2], endLine: 5 }, { ...create[4], text: '* print 1' }], 0);
    assert.equal(none.hasAssertions, false);
    assert.equal(none.afterLine, 5);
  });

  test('frontierIndex and insertionPointAt keep file order equal to run order', () => {
    const create = parsed.scenarios[0].steps;
    assert.equal(steps.frontierIndex(1 + 3, 1, 2, 5, false), 2);
    assert.equal(steps.frontierIndex(1 + 4, 1, 2, 5, false), 3);
    assert.equal(steps.frontierIndex(99, 1, 2, 5, false), 4);
    assert.equal(steps.frontierIndex(1, 1, 2, 5, false), 2);
    assert.equal(steps.frontierIndex(99, 1, 2, 5, true), 2);
    const atMethod = steps.insertionPointAt(create, 2, 2);
    assert.deepEqual([atMethod.afterLine, atMethod.hasAssertions, atMethod.indent], [12, false, '  ']);
    const afterStatus = steps.insertionPointAt(create, 2, 3);
    assert.deepEqual([afterStatus.afterLine, afterStatus.hasAssertions], [13, true]);
  });

  test('responseScope only covers the steps that apply to one response', () => {
    const list = [
      { text: '* method post' }, { text: '* status 201' }, { text: '* match response.a == 1' },
      { text: '* def x = response.id' }, { text: '* method get' }, { text: '* match response.a == 1' }
    ];
    assert.deepEqual(steps.responseScope(list, 0).map(step => step.text), ['* status 201', '* match response.a == 1', '* def x = response.id']);
    assert.deepEqual(steps.responseScope(list, 4).map(step => step.text), ['* match response.a == 1']);
    assert.deepEqual(steps.responseScope(list, 5), []);
  });

  test('methodVerb, isMutatingVerb, and pathHints', () => {
    assert.equal(steps.methodVerb('When method POST'), 'post');
    assert.equal(steps.methodVerb('* print 1'), undefined);
    assert.equal(steps.isMutatingVerb('post'), true);
    assert.equal(steps.isMutatingVerb('get'), false);
    assert.equal(steps.isMutatingVerb(undefined), false);
    assert.deepEqual(steps.pathHints(["Given path 'api', 'users'", "* path 'users', userId"]), ['api', 'users', 'users']);
  });
});

describe('AssertionBuilder', () => {
  test('jsPath quotes unusual keys and indexes arrays', () => {
    assert.equal(assertions.jsPath('response', ['items', 0, 'id']), 'response.items[0].id');
    assert.equal(assertions.jsPath('response', ['a-b', "it's"]), "response['a-b']['it\\'s']");
  });

  test('typeMarker and literal', () => {
    assert.equal(assertions.typeMarker(1), '#number');
    assert.equal(assertions.typeMarker('x'), '#string');
    assert.equal(assertions.typeMarker('123e4567-e89b-12d3-a456-426614174000'), '#uuid');
    assert.equal(assertions.typeMarker(null), '#null');
    assert.equal(assertions.typeMarker([1]), '#array');
    assert.equal(assertions.literal("it's"), "'it\\'s'");
    assert.equal(assertions.literal('a\nb'), "'a\\nb'");
    assert.equal(assertions.literal(true), 'true');
    assert.equal(assertions.literal({ a: 1 }), '{"a":1}');
  });

  test('matchStep covers type, value, and present', () => {
    assert.equal(assertions.matchStep(['id'], 42, 'type'), "match response.id == '#number'");
    assert.equal(assertions.matchStep(['name'], 'Ada', 'value'), "match response.name == 'Ada'");
    assert.equal(assertions.matchStep(['x'], null, 'present'), "match response.x == '#present'");
  });

  test('suggestMode prefers types for ids, dates, and large numbers', () => {
    assert.equal(assertions.suggestMode('id', 1), 'type');
    assert.equal(assertions.suggestMode('userId', 'abc'), 'type');
    assert.equal(assertions.suggestMode('createdAt', 'x'), 'type');
    assert.equal(assertions.suggestMode('when', '2026-11-03T09:14:00Z'), 'type');
    assert.equal(assertions.suggestMode('big', 1700000000000), 'type');
    assert.equal(assertions.suggestMode('name', 'Ada'), 'value');
  });

  test('schemaStep stays on one line when short and uses a docstring when long', () => {
    assert.equal(assertions.schemaStep([], { id: 1, name: 'Ada' }), "match response == { id: '#number', name: '#string' }");
    assert.equal(assertions.schemaStep([], [{ id: 1 }, { id: 2 }]), "match each response == { id: '#number' }");
    assert.equal(assertions.schemaStep(['n'], 5), "match response.n == '#number'");
    const body = { id: 1, name: 'Ada', tags: ['a', 'b'], address: { city: 'X', country: 'Y' }, extra: null, items: [{ a: 1 }], description: 'text' };
    assert.equal(assertions.schemaStep([], body), [
      'match response ==',
      '"""',
      '{',
      "  id: '#number',",
      "  name: '#string',",
      "  tags: '#[] #string',",
      '  address: {',
      "    city: '#string',",
      "    country: '#string'",
      '  },',
      "  extra: '#present',",
      "  items: '#[] #object',",
      "  description: '#string'",
      '}',
      '"""'
    ].join('\n'));
  });

  test('variableName is readable, avoids reserved words, and stays unique', () => {
    assert.equal(assertions.variableName(['id'], [], ['users']), 'userId');
    assert.equal(assertions.variableName(['id'], ['userId'], ['users']), 'userId2');
    assert.equal(assertions.variableName(['user', 'id'], [], []), 'userId');
    assert.equal(assertions.variableName(['items', 0], [], []), 'itemItem');
    assert.equal(assertions.variableName(['response'], [], []), 'myResponse');
    assert.equal(assertions.variableName(['created-at'], [], []), 'createdAt');
    assert.equal(assertions.variableName(['categories', 0], [], []), 'categoryItem');
  });

  test('defStep and valueAtPath', () => {
    assert.equal(assertions.defStep(['id'], 'userId'), 'def userId = response.id');
    assert.equal(assertions.valueAtPath({ a: [{ b: 5 }] }, ['a', 0, 'b']), 5);
    assert.equal(assertions.valueAtPath({ a: 1 }, ['a', 'b']), undefined);
  });
});

describe('Redaction', () => {
  test('masks secret keys and token-like values, leaves the rest', () => {
    const masked = redaction.maskDeep({ name: 'Ada', token: 'abc', nested: { Authorization: 'Bearer x', apiKey: 5 }, jwt: 'eyJhbGciOi.eyJzdWIi.sig', list: [{ password: 'p' }] });
    assert.deepEqual(masked, {
      name: 'Ada', token: redaction.MASK, nested: { Authorization: redaction.MASK, apiKey: redaction.MASK }, jwt: redaction.MASK, list: [{ password: redaction.MASK }]
    });
  });

  test('pathIsSecret', () => {
    assert.equal(redaction.pathIsSecret(['a', 'token']), true);
    assert.equal(redaction.pathIsSecret(['a', 'name']), false);
    assert.equal(redaction.pathIsSecret([0, 'x']), false);
  });
});

describe('SessionProtocol', () => {
  test('parseHostLine ignores stray output and malformed JSON', () => {
    assert.equal(protocol.parseHostLine('INFO started'), undefined);
    assert.equal(protocol.parseHostLine('{not json'), undefined);
    assert.equal(protocol.parseHostLine('{"hello":1}'), undefined);
    assert.deepEqual(protocol.parseHostLine('{"id":1,"ok":true}'), { id: 1, ok: true });
  });

  test('toStepResult validates and normalizes', () => {
    const result = protocol.toStepResult({ id: 1, ok: true, status: 'FAILED', error: 'boom', durationMs: 3, variables: { a: 1 }, response: { status: 200, body: { x: 1 }, timeMs: 4 } });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.error, 'boom');
    assert.deepEqual(result.response, { status: 200, headers: {}, body: { x: 1 }, timeMs: 4 });
    assert.throws(() => protocol.toStepResult({ id: 1, ok: true, status: 'WEIRD' }), /Unexpected step status/);
    assert.throws(() => protocol.toStepResult({ id: 1, ok: false, code: 'unsupported', error: 'Use 2.1' }), error => error.code === 'unsupported' && /Use 2.1/.test(error.message));
  });
});

describe('EnvDiscovery', () => {
  const plain = path.join(fixtures, 'plain');
  const feature = path.join(plain, 'src', 'test', 'java', 'users.feature');

  test('finds the nearest config directory and the environments', () => {
    const configDir = envs.findConfigDir(feature, plain);
    assert.equal(configDir, path.join(plain, 'src', 'test', 'java'));
    assert.deepEqual(envs.discoverEnvironments(configDir), ['staging']);
    assert.deepEqual(envs.discoverEnvironments(configDir, 'dev'), ['dev', 'staging']);
    assert.deepEqual(envs.discoverEnvironments(undefined), []);
  });

  test('prefers a config closer to the feature over one elsewhere', () => {
    const dir = tempCopy(plain);
    const nested = path.join(dir, 'src', 'test', 'java', 'sub');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'karate-config.js'), 'function fn() { return {}; }');
    fs.writeFileSync(path.join(nested, 'x.feature'), 'Feature: x');
    assert.equal(envs.findConfigDir(path.join(nested, 'x.feature'), dir), nested);
  });

  test('reads env names from a switch and from comparisons', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-env-'));
    fs.writeFileSync(path.join(dir, 'karate-config.js'), "function fn(){ var env = karate.env; if (env === 'qa') {} switch(env){ case 'uat': break; } }");
    assert.deepEqual(envs.discoverEnvironments(dir), ['qa', 'uat']);
  });
});

describe('ClasspathResolver', () => {
  test('plain strategy puts source folders first and adds the Karate jar', async () => {
    const dir = tempCopy(path.join(fixtures, 'plain'));
    fs.mkdirSync(path.join(dir, 'target', 'test-classes'), { recursive: true });
    const result = await classpath.resolveClasspath({ projectRoot: dir, strategy: 'cli', karateJar: '/k/karate-2.1.4.jar', additionalClasspath: ['extra'] });
    assert.equal(result.entries[0], path.join(dir, 'src', 'test', 'java'));
    assert.ok(result.entries.includes(path.join(dir, 'target', 'test-classes')));
    assert.ok(result.entries.includes(path.join(dir, 'extra')));
    assert.equal(result.entries[result.entries.length - 1], '/k/karate-2.1.4.jar');
    assert.equal(result.usedProjectKarate, false);
  });

  test('a Karate jar already on the project classpath is used instead of ours', async () => {
    const dir = tempCopy(path.join(fixtures, 'plain'));
    const result = await classpath.resolveClasspath({ projectRoot: dir, strategy: 'cli', karateJar: '/k/karate-2.1.4.jar', additionalClasspath: ['/proj/karate-core-2.0.0.jar'] });
    assert.equal(result.usedProjectKarate, true);
    assert.ok(!result.entries.includes('/k/karate-2.1.4.jar'));
  });

  test('gradle strategy runs the init script and picks the project that owns the directory', async () => {
    const dir = tempCopy(path.join(fixtures, 'plain'));
    let seen;
    const exec = async (file, args, options) => {
      seen = { file, args, options };
      return { stdout: `noise\nKARATE_WB_CP=/other\t/other/a.jar\nKARATE_WB_CP=${fs.realpathSync(dir)}\t/dep/b.jar${path.delimiter}/dep/c.jar\n`, stderr: '' };
    };
    const result = await classpath.resolveClasspath({ projectRoot: dir, strategy: 'gradle', karateJar: '/k.jar', buildArgs: ['--offline'], exec });
    assert.equal(seen.file, 'gradle');
    assert.ok(seen.args.includes('--init-script') && seen.args.includes('--offline') && seen.args.includes('karateWorkbenchClasspath'));
    assert.equal(seen.options.cwd, dir);
    assert.deepEqual(result.entries.filter(entry => entry.startsWith('/dep')), ['/dep/b.jar', '/dep/c.jar']);
    assert.ok(!result.entries.includes('/other/a.jar'));
    assert.throws(() => classpath.parseGradleOutput('nothing', dir), /did not report/);
  });

  test('maven strategy asks for the test classpath file and adds target folders', async () => {
    const dir = tempCopy(path.join(fixtures, 'plain'));
    fs.mkdirSync(path.join(dir, 'target', 'test-classes'), { recursive: true });
    let seen;
    const exec = async (file, args) => {
      seen = { file, args };
      const flag = args.find(arg => arg.startsWith('-Dmdep.outputFile='));
      fs.writeFileSync(flag.slice('-Dmdep.outputFile='.length), `/m2/a.jar${path.delimiter}/m2/b.jar`);
      return { stdout: '', stderr: '' };
    };
    const result = await classpath.resolveClasspath({ projectRoot: dir, strategy: 'maven', karateJar: '/k.jar', exec });
    assert.equal(seen.file, 'mvn');
    assert.ok(seen.args.includes('test-compile') && seen.args.includes('dependency:build-classpath') && seen.args.includes('-Dmdep.includeScope=test'));
    assert.ok(result.entries.includes('/m2/a.jar') && result.entries.includes('/m2/b.jar'));
    assert.ok(result.entries.includes(path.join(dir, 'target', 'test-classes')));
  });
});

describe('AdvancedAssertions', () => {
  const ctx = { secret: false, timeMs: 12, status: 201 };
  const ids = (p, v, parentIsArray = false, c = ctx) => advanced.advancedOptions(p, v, c, parentIsArray).map(o => o.id);

  test('options fit the data type', () => {
    assert.deepEqual(ids(['n'], 'Ada'), ['present', 'notNull', 'optional', 'notEqual', 'notEmpty', 'contains', 'startsWith', 'endsWith', 'regex', 'length', 'lengthBetween', 'ignoreCase', 'oneOf']);
    assert.deepEqual(ids(['n'], 5), ['present', 'notNull', 'optional', 'notEqual', 'positive', 'nonNegative', 'integer', 'greaterThan', 'atLeast', 'lessThan', 'atMost', 'between', 'closeTo']);
    assert.ok(!ids(['n'], 5.5).includes('integer'), 'a fractional number is not offered "whole number"');
    assert.deepEqual(ids(['n'], true), ['present', 'notNull', 'optional', 'notEqual']);
    assert.deepEqual(ids(['n'], null), ['present', 'isNull']);
    assert.ok(ids(['t'], ['a', 'b']).includes('eachType'));
    assert.ok(!ids(['t'], [{ a: 1 }]).includes('eachType'));
    assert.deepEqual(ids(['o'], { a: 1 }).slice(-4), ['notEmptyObject', 'hasKeys', 'onlyKeys', 'exact']);
    assert.ok(!ids(['o'], {}).includes('hasKeys'), 'an empty object has no fields to list');
    assert.ok(ids(['t', 0], 'a', true).includes('parentContains'));
    assert.ok(ids([], { a: 1 }).includes('responseTime') && ids([], { a: 1 }).includes('statusClass'));
    assert.ok(!ids(['n'], 'x').includes('responseTime'));
  });

  test('changing fields (ids, dates, tokens) only get options that stay true on the next response', () => {
    assert.deepEqual(ids(['id'], 7), ['present', 'notNull', 'optional', 'notEqual', 'positive', 'nonNegative', 'integer', 'greaterThan']);
    assert.deepEqual(ids(['createdAt'], '2026-11-03T09:14:00Z'), ['present', 'notNull', 'optional', 'notEmpty', 'regex']);
    const regexFor = (key, value) => advanced.advancedOptions([key], value, ctx).find(item => item.id === 'regex').param.value;
    const uuid = new RegExp(`^${regexFor('id', '123e4567-e89b-12d3-a456-426614174000')}$`);
    assert.ok(uuid.test('00000000-0000-4000-8000-000000000000') && uuid.test('abcdefab-cdef-abcd-efab-cdefabcdefab'), 'a generated id pattern must match other ids');
    assert.equal(advanced.advancedOptions(['id'], 7, ctx).find(item => item.id === 'notEqual').param.value, '0');
    assert.equal(advanced.advancedOptions(['id'], 7, ctx).find(item => item.id === 'greaterThan').param.value, '0');
  });

  test('secrets only get options that do not copy the value', () => {
    const secret = { secret: true };
    assert.deepEqual(ids(['token'], 'abc', false, secret), ['present', 'notNull', 'optional', 'notEmpty']);
    assert.deepEqual(ids(['pin'], 1234, false, secret), ['present', 'notNull', 'optional']);
    assert.throws(() => advanced.advancedStep('contains', ['token'], 'abc', 'abc', secret), /secret/);
    assert.throws(() => advanced.advancedStep('regex', ['token'], 'abc', 'a', secret), /secret/);
  });

  test('defaults are derived so they pass against the value they came from', () => {
    const o = (id, v) => advanced.advancedOptions(['x'], v, ctx).find(item => item.id === id).param.value;
    assert.equal(o('regex', 'ada@example.com'), '[A-Za-z]+@[A-Za-z]+\\.[A-Za-z]+');
    assert.equal(o('regex', 'AB-12 x'), '[A-Za-z]+\\-\\d+\\s+[A-Za-z]+');
    assert.equal(o('regex', 'a1b2'), '[A-Za-z0-9]+');
    assert.equal(o('startsWith', 'Ada Lovelace'), 'Ada');
    assert.equal(o('endsWith', 'Ada Lovelace'), 'ace');
    assert.equal(o('between', 10), '4,16');
    assert.equal(o('greaterThan', 10), '9');
    assert.equal(o('closeTo', 3.14), '3.14,0.01');
    assert.equal(o('closeTo', 3), '3,0');
    assert.equal(advanced.advancedOptions([], { a: 1 }, { secret: false, timeMs: 12 }).find(item => item.id === 'responseTime').param.value, '100');
    assert.equal(advanced.advancedOptions([], { a: 1 }, { secret: false, timeMs: 480 }).find(item => item.id === 'responseTime').param.value, '2000');
  });

  test('steps use ordinary Karate syntax', () => {
    const step = (id, p, v, param = '') => advanced.advancedStepFor(id, p, v, param, ctx);
    assert.equal(step('present', ['a'], 1), "match response.a == '#present'");
    assert.equal(step('optional', ['a'], 'x'), "match response.a == '##string'");
    assert.equal(step('startsWith', ['n'], 'Ada', 'Ad'), "match response.n == '#? _.startsWith(\"Ad\")'");
    assert.equal(step('contains', ['n'], 'Ada', "it's"), "match response.n contains 'it\\'s'");
    assert.equal(step('regex', ['n'], 'x', '\\d+'), "match response.n == '#regex \\\\d+'");
    assert.equal(step('between', ['n'], 5, '1, 9'), "match response.n == '#number? _ >= 1 && _ <= 9'");
    assert.equal(step('size', ['t'], [1], '3'), "match response.t == '#[3]'");
    assert.equal(step('contains', ['t'], ['a'], '"b"'), "match response.t contains 'b'");
    assert.equal(step('containsOnly', ['t'], ['a'], '["b","a"]'), 'match response.t contains only ["b","a"]');
    assert.equal(step('parentContains', ['t', 1], 'b'), "match response.t contains 'b'");
    assert.equal(step('hasKeys', ['o'], { a: 1, b: 2 }), "match response.o contains {\"a\":\"#present\",\"b\":\"#present\"}");
    assert.equal(step('onlyKeys', ['o'], { a: 1, b: 2 }), 'match karate.keysOf(response.o) contains only ["a","b"]');
    assert.equal(step('responseTime', [], {}, '500'), 'assert responseTime < 500');
    assert.equal(step('statusClass', [], {}, '2'), 'assert responseStatus >= 200 && responseStatus < 300');
  });

  test('exact ignores ids, dates and secrets and uses a docstring when long', () => {
    const text = advanced.advancedStep('exact', ['u'], { id: 7, name: 'Ada', createdAt: '2026-11-03T09:14:00Z', password: 'p', note: 'x' });
    assert.equal(text, 'match response.u == {"id":"#ignore","name":"Ada","createdAt":"#ignore","password":"#ignore","note":"x"}');
    const long = advanced.advancedStep('exact', [], { alpha: 'aaaaaaaaaaaaaaaaaaaa', beta: 'bbbbbbbbbbbbbbbbbbbb', gamma: 'cccccccccccccccccccc', delta: 'dddddddddddddddddddd', id: 1 });
    assert.match(long, /^match response ==\n"""\n\{\n/);
  });

  test('invalid parameters are rejected with readable messages', () => {
    const step = (id, v, param) => advanced.advancedStepFor(id, ['x'], v, param, ctx);
    assert.throws(() => step('greaterThan', 1, 'abc'), /must be a number/);
    assert.throws(() => step('between', 1, '1'), /two numbers/);
    assert.throws(() => step('size', [1], '-1'), /whole number/);
    assert.throws(() => step('size', [1], '1.5'), /whole number/);
    assert.throws(() => step('regex', 'x', '('), /regular expression/);
    assert.throws(() => step('containsOnly', [1], '1'), /JSON array/);
    assert.throws(() => step('closeTo', 1, '1,-2'), /negative/);
    assert.throws(() => step('oneOf', 'x', ' , '), /at least one/i);
    assert.throws(() => advanced.advancedStep('statusClass', [], {}, '9'), /1 to 5/);
    assert.throws(() => advanced.advancedStep('nope', [], 1), /Unknown/);
  });

  test('headerStep writes match header lines and rejects odd names', () => {
    assert.equal(advanced.headerStep('headerEquals', 'Content-Type', 'application/json'), "match header Content-Type == 'application/json'");
    assert.equal(advanced.headerStep('headerContains', 'Content-Type', 'application/json; charset=utf-8'), "match header Content-Type contains 'application/json'");
    assert.equal(advanced.headerStep('headerPresent', 'X-Id', ''), "match responseHeaders contains { 'X-Id': '#present' }");
    assert.throws(() => advanced.headerStep('headerEquals', 'bad name', 'x'), /cannot be written/);
  });
});

describe('WorkbenchState', () => {
  test('friendlyError explains a Java version mismatch and a missing Java', () => {
    const mismatch = state.friendlyError(new Error('com/x/Util has been compiled by a more recent version of the Java Runtime (class file version 67.0), this version only recognizes up to 65.0'));
    assert.match(mismatch, /Java 23/);
    assert.match(mismatch, /karateDsl\.workbench\.javaPath/);
    assert.match(state.friendlyError(new protocol.WorkbenchError('Could not start Java: ENOENT', 'spawn')), /javaPath/);
    assert.equal(state.friendlyError(new protocol.WorkbenchError('Cancelled.', 'cancelled')), 'Cancelled.');
  });

  test('isProductionContext checks the environment name and the base URL host', () => {
    assert.equal(state.isProductionContext('prod', {}, 'prod'), true);
    assert.equal(state.isProductionContext('PRODUCTION', {}, 'prod'), true);
    assert.equal(state.isProductionContext('dev', { baseUrl: 'https://api.prod.example.com/v1' }, 'prod'), true);
    assert.equal(state.isProductionContext('dev', { baseUrl: 'http://localhost:8080/products' }, 'prod'), false);
    assert.equal(state.isProductionContext('dev', {}, ''), false);
    assert.equal(state.isProductionContext('dev', { baseUrl: 'not a url' }, '('), false);
  });

  test('insertionText picks Then or And and keeps indentation on every line', () => {
    assert.equal(state.insertionText({ afterLine: 3, indent: '  ', hasAssertions: false }, 'match', 'match response.id == 1'), '\n  Then match response.id == 1');
    assert.equal(state.insertionText({ afterLine: 3, indent: '  ', hasAssertions: true }, 'match', 'match response ==\n"""\n{ a: 1 }\n"""'), '\n  And match response ==\n  """\n  { a: 1 }\n  """');
    assert.equal(state.insertionText({ afterLine: 3, indent: '    ', hasAssertions: true }, 'def', 'def x = response.id'), '\n    * def x = response.id');
  });

  test('response and variables are masked before they reach the view', () => {
    const response = state.maskedResponse({ status: 200, headers: { Authorization: ['Bearer abc'] }, body: { token: 't', name: 'Ada' }, timeMs: 5 }, true, true);
    assert.deepEqual(response.headers, { Authorization: redaction.MASK });
    assert.deepEqual(response.body, { token: redaction.MASK, name: 'Ada' });
    assert.deepEqual(state.maskedVariables({ token: 'x', userId: 1 }), { token: redaction.MASK, userId: 1 });
  });
});

const karateJar = process.env.KARATE_TEST_JAR;
function integrationSkip() {
  if (!karateJar || !fs.existsSync(karateJar)) { return 'set KARATE_TEST_JAR to a Karate 2 jar'; }
  if (!fs.existsSync(path.join(hostDir, 'KarateWorkbenchHost.class'))) { return 'run scripts/build-workbench-host.cjs first'; }
  const probe = childProcess.spawnSync('java', ['-version'], { encoding: 'utf8' });
  const match = /version "(\d+)(?:\.(\d+))?/.exec(`${probe.stdout}${probe.stderr}`);
  const major = match ? (Number(match[1]) === 1 ? Number(match[2]) : Number(match[1])) : 0;
  return major >= 21 ? undefined : 'Java 21 or newer is required';
}

describe('Integration: plain project', () => {
  const skip = integrationSkip();
  if (skip) {
    test('skipped', { skip }, () => {});
    return;
  }
  let server, base, project, session;

  before(async () => {
    server = childProcess.spawn(process.execPath, [path.join(fixtures, 'api', 'server.js'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
    base = await new Promise(resolve => server.stdout.once('data', data => resolve(`http://127.0.0.1:${/PORT=(\d+)/.exec(data.toString())[1]}`)));
    process.env.WB_BASE_URL = base;
    project = tempCopy(path.join(fixtures, 'plain'));
  });
  after(async () => {
    server.kill();
    delete process.env.WB_BASE_URL;
    await session?.stop();
  });

  async function open(env) {
    const feature = path.join(project, 'src', 'test', 'java', 'users.feature');
    const resolved = await classpath.resolveClasspath({ projectRoot: project, strategy: 'cli', karateJar });
    return WorkbenchSession.start({
      hostDir, classpath: resolved.entries, feature, env, configDir: path.join(project, 'src', 'test', 'java'), workDir: project, requestTimeoutMs: 60_000
    });
  }

  test('evaluates the real config, including computed values and callSingle', async () => {
    const started = await open('dev');
    session = started.session;
    assert.equal(started.result.config.env, 'dev');
    assert.equal(started.result.config.baseUrl, base);
    assert.equal(started.result.config.token, 'fixture-token-123');
  });

  test('keeps variables between steps, supports docstrings, and survives a failed step', async () => {
    const run = text => session.step(text);
    assert.equal((await run('* url baseUrl')).status, 'PASSED');
    assert.equal((await run("Given path 'users'")).status, 'PASSED');
    assert.equal((await run('* request\n"""\n{ "name": "Ada", "email": "ada@example.com" }\n"""')).status, 'PASSED');
    const sent = await run('When method post');
    assert.equal(sent.status, 'PASSED');
    assert.equal(sent.response.status, 201);
    assert.equal(sent.response.body.name, 'Ada');
    assert.ok(sent.response.timeMs >= 0);
    await run('* def userId = response.id');
    const failed = await run("* match response.name == 'Bob'");
    assert.equal(failed.status, 'FAILED');
    assert.match(failed.error, /not equal/);
    await run("* path 'users', userId");
    const fetched = await run('* method get');
    assert.equal(fetched.status, 'PASSED');
    assert.equal(fetched.response.body.id, sent.response.body.id);
    assert.ok('userId' in fetched.variables);
    assert.equal('response' in fetched.variables, false);
    assert.equal('fn' in fetched.variables, false);
  });

  test('reports a clear error for an unknown variable and for a refused connection', async () => {
    const unknown = await session.step('* print nope');
    assert.equal(unknown.status, 'FAILED');
    assert.match(unknown.error, /nope/);
  });

  test('cancel ends the session and rejects the step in flight', async () => {
    const started = await open('dev');
    const slow = started.session.step("* eval Java.type('java.lang.Thread').sleep(20000)");
    setTimeout(() => started.session.cancel(), 400);
    await assert.rejects(slow, error => error.code === 'cancelled');
    assert.equal(started.session.alive, false);
  });

  test('a request that never replies times out and stops the session', async () => {
    const feature = path.join(project, 'src', 'test', 'java', 'users.feature');
    const resolved = await classpath.resolveClasspath({ projectRoot: project, strategy: 'cli', karateJar });
    const { session: short } = await WorkbenchSession.start({
      hostDir, classpath: resolved.entries, feature, configDir: path.join(project, 'src', 'test', 'java'), workDir: project, requestTimeoutMs: 1500
    });
    await assert.rejects(short.step("* eval Java.type('java.lang.Thread').sleep(20000)"), error => error.code === 'timeout');
    assert.equal(short.alive, false);
  });

  test('switching environment changes the evaluated config', async () => {
    const started = await open('staging');
    assert.equal(started.result.config.env, 'staging');
    assert.equal(started.result.config.baseUrl, 'http://127.0.0.1:1');
    const result = await (async () => {
      await started.session.step('* url baseUrl');
      return started.session.step("* path 'users'") && started.session.step('* method get');
    })();
    assert.equal(result.status, 'FAILED');
    assert.match(result.error, /onnect|refused/i);
    assert.equal(result.response, undefined);
    await started.session.stop();
  });

  test('edits to config and features are seen on the next session (no stale copies)', async () => {
    const authFile = path.join(project, 'src', 'test', 'java', 'auth.feature');
    fs.writeFileSync(authFile, "Feature: auth\n\nScenario:\n  * def token = 'changed-456'\n");
    const started = await open('dev');
    assert.equal(started.result.config.token, 'changed-456');
    await started.session.stop();
  });

  test('click-to-assert: every inserted line passes live and in a normal Karate run', async () => {
    const dir = path.join(project, 'src', 'test', 'java');
    const featurePath = path.join(dir, 'assert.feature');
    let text = [
      'Feature: assert',
      '',
      'Background:',
      '  * url baseUrl',
      '',
      'Scenario: create',
      "  Given path 'users'",
      "  And request { name: 'Ada', email: 'ada@example.com', bio: 'a long biography', tags: ['a', 'b'], address: { city: 'London', zip: 'N1' } }",
      '  When method post',
      '  Then print response',
      '  * print userId',
      ''
    ].join('\n');
    // The first Scenario is what the host builds its runtime from; the file must parse, so write a valid one first.
    fs.writeFileSync(featurePath, text.replace('  * print userId\n', ''));
    const resolved = await classpath.resolveClasspath({ projectRoot: project, strategy: 'cli', karateJar });
    const { session: live } = await WorkbenchSession.start({
      hostDir, classpath: resolved.entries, feature: featurePath, env: 'dev', configDir: dir, workDir: project, requestTimeoutMs: 60_000
    });
    try {
      let parsed = steps.parseFeature(text);
      const scenario = () => steps.parseFeature(text).scenarios[0];
      const bg = parsed.background.map(step => step.text);
      for (const stepText of bg) { await passes(live.step(stepText)); }
      const created = scenario().steps;
      let executedCount = bg.length;
      let response;
      for (let i = 0; i < 3; i++) {
        const result = await passes(live.step(created[i].text));
        executedCount++;
        response = result.response || response;
      }
      assert.equal(response.status, 201);
      const body = response.body;
      let variables = {};
      const hints = steps.pathHints(created.map(step => step.text));

      const actions = [
        { path: ['id'], action: 'type' },
        { path: ['name'], action: 'value' },
        { path: ['tags', 0], action: 'value' },
        { path: ['address'], action: 'schema' },
        { path: [], action: 'schema' },
        { path: [], action: 'status' },
        { path: ['id'], action: 'def' }
      ];
      for (const { path: fieldPath, action } of actions) {
        const value = assertions.valueAtPath(body, fieldPath);
        let stepText, kind = 'match';
        if (action === 'status') { stepText = `status ${response.status}`; }
        else if (action === 'schema') { stepText = assertions.schemaStep(fieldPath, value); }
        else if (action === 'def') { kind = 'def'; stepText = assertions.defStep(fieldPath, assertions.variableName(fieldPath, Object.keys(variables), hints)); }
        else { stepText = assertions.matchStep(fieldPath, value, action); }

        const methodIndex = scenario().steps.findIndex(step => steps.methodVerb(step.text) === 'post');
        const frontier = steps.frontierIndex(executedCount, bg.length, methodIndex, scenario().steps.length, false);
        const point = steps.insertionPointAt(scenario().steps, methodIndex, frontier);
        const insertion = state.insertionText(point, kind, stepText);
        const lines = text.split('\n');
        lines[point.afterLine] += insertion;
        text = lines.join('\n');

        const synced = steps.normalizeStepText(insertion.slice(1));
        assert.ok(scenario().steps.some(step => step.text === synced), `inserted step must parse back to the text that was run: ${synced}`);
        const result = await passes(live.step(synced));
        executedCount++;
        variables = result.variables;
      }
      assert.ok('userId' in variables, 'the def step must define a variable in the live session');
    } finally {
      await live.stop();
    }

    fs.writeFileSync(featurePath, text);
    const normal = childProcess.spawnSync('java', ['-cp', `${path.resolve(karateJar)}${path.delimiter}${dir}`, 'io.karatelabs.Main', 'run', '-g', dir, '-e', 'dev', '-o', path.join(project, 'out'), featurePath], { encoding: 'utf8', cwd: project, env: process.env });
    assert.equal(normal.status, 0, `normal Karate run failed:\n${normal.stdout}\n${normal.stderr}`);
    assert.match(text, /match response ==\n\s+"""/, 'the long schema must use the docstring form');
  });

  test('every advanced option passes against real Karate, and wrong parameters fail', async () => {
    const dir = path.join(project, 'src', 'test', 'java');
    const resolved = await classpath.resolveClasspath({ projectRoot: project, strategy: 'cli', karateJar });
    const { session: live } = await WorkbenchSession.start({
      hostDir, classpath: resolved.entries, feature: path.join(dir, 'users.feature'), env: 'dev', configDir: dir, workDir: project, requestTimeoutMs: 60_000
    });
    try {
      await passes(live.step('* url baseUrl'));
      await passes(live.step("* path 'users'"));
      await passes(live.step("* request { name: 'Ada Lovelace', email: 'ada@example.com', age: 36, score: 3.14159, active: true, nickname: null, tags: ['a','b','c'], address: { city: 'London', zip: 'N1' }, items: [{ sku: 'x1', qty: 2 }, { sku: 'x2', qty: 5 }] }"));
      const posted = await passes(live.step('* method post'));
      const body = posted.response.body;
      const context = { secret: false, timeMs: posted.response.timeMs, status: posted.response.status };
      const paths = [[], ['name'], ['email'], ['age'], ['score'], ['active'], ['nickname'], ['tags'], ['tags', 0], ['address'], ['items'], ['items', 0], ['id']];
      const covered = new Set();
      const lines = [];
      for (const fieldPath of paths) {
        const value = assertions.valueAtPath(body, fieldPath);
        const parentIsArray = typeof fieldPath[fieldPath.length - 1] === 'number';
        for (const option of advanced.advancedOptions(fieldPath, value, context, parentIsArray)) {
          const text = advanced.advancedStepFor(option.id, fieldPath, value, option.param ? option.param.value : '', context);
          const result = await live.step(`* ${text}`);
          assert.equal(result.status, 'PASSED', `${JSON.stringify(fieldPath)} ${option.id}: ${text}\n${result.error}`);
          covered.add(option.id);
          lines.push(text);
        }
      }
      // Every option the builder knows must have been exercised against some field.
      const known = ['present', 'notNull', 'optional', 'isNull', 'notEqual', 'notEmpty', 'contains', 'startsWith', 'endsWith', 'regex', 'length', 'lengthBetween', 'ignoreCase', 'oneOf',
        'positive', 'nonNegative', 'integer', 'greaterThan', 'atLeast', 'lessThan', 'atMost', 'between', 'closeTo',
        'nonEmpty', 'size', 'minSize', 'maxSize', 'eachType', 'containsOnly', 'containsAny', 'notContains', 'parentContains',
        'notEmptyObject', 'hasKeys', 'onlyKeys', 'exact', 'responseTime', 'statusClass'];
      assert.deepEqual(known.filter(id => !covered.has(id)), [], 'options never exercised');

      // The assertions are not vacuous: deliberately wrong parameters must fail.
      const mustFail = [
        ['startsWith', ['name'], 'zz'], ['endsWith', ['name'], 'zz'], ['contains', ['name'], 'zz'], ['regex', ['name'], '\\d+'], ['length', ['name'], '3'],
        ['lengthBetween', ['name'], '1,2'], ['ignoreCase', ['name'], 'someone else'], ['oneOf', ['name'], 'a,b'], ['notEqual', ['name'], 'Ada Lovelace'],
        ['greaterThan', ['age'], '99'], ['lessThan', ['age'], '1'], ['atLeast', ['age'], '37'], ['atMost', ['age'], '35'], ['between', ['age'], '1,2'], ['closeTo', ['score'], '9,0.1'],
        ['size', ['tags'], '2'], ['minSize', ['tags'], '4'], ['maxSize', ['tags'], '2'], ['containsOnly', ['tags'], '["a","b"]'], ['containsAny', ['tags'], '["x","y"]'],
        ['notContains', ['tags'], '"a"'], ['responseTime', [], '0'], ['statusClass', [], '5']
      ];
      for (const [id, fieldPath, param] of mustFail) {
        const value = assertions.valueAtPath(body, fieldPath);
        const text = advanced.advancedStepFor(id, fieldPath, value, param, context);
        const result = await live.step(`* ${text}`);
        assert.equal(result.status, 'FAILED', `${id} with "${param}" must fail but passed: ${text}`);
      }
      assert.equal((await live.step('* match response.nickname == \'#notnull\'')).status, 'FAILED');

      // Response headers.
      for (const [option, name, value] of [['headerEquals', 'content-type', 'application/json'], ['headerContains', 'content-type', 'application/json; charset=x'], ['headerPresent', 'content-type', '']]) {
        const text = advanced.headerStep(option, name, value);
        const result = await live.step(`* ${text}`);
        assert.equal(result.status, 'PASSED', `${option}: ${text}\n${result.error}`);
      }

      // The same lines pass in a normal Karate run of the saved file.
      const featurePath = path.join(dir, 'advanced.feature');
      const feature = [
        'Feature: advanced', '', 'Background:', '  * url baseUrl', '', 'Scenario: all options', "  Given path 'users'",
        "  And request { name: 'Ada Lovelace', email: 'ada@example.com', age: 36, score: 3.14159, active: true, nickname: null, tags: ['a','b','c'], address: { city: 'London', zip: 'N1' }, items: [{ sku: 'x1', qty: 2 }, { sku: 'x2', qty: 5 }] }",
        '  When method post', ...lines.map(line => `  Then ${line.split('\n').join('\n  ')}`), ''
      ].join('\n');
      fs.writeFileSync(featurePath, feature);
      const normal = childProcess.spawnSync('java', ['-cp', `${path.resolve(karateJar)}${path.delimiter}${dir}`, 'io.karatelabs.Main', 'run', '-g', dir, '-e', 'dev', '-o', path.join(project, 'out-advanced'), featurePath], { encoding: 'utf8', cwd: project, env: process.env });
      assert.equal(normal.status, 0, `normal Karate run failed:\n${normal.stdout}\n${normal.stderr}`);
    } finally {
      await live.stop();
    }
  });

  test('a Scenario Outline only file is refused with a clear message', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-outline-'));
    fs.writeFileSync(path.join(dir, 'o.feature'), 'Feature: o\n\nScenario Outline: x\n  * print <a>\n  Examples:\n    | a |\n    | 1 |\n');
    await assert.rejects(
      WorkbenchSession.start({ hostDir, classpath: [dir, karateJar], feature: path.join(dir, 'o.feature'), workDir: dir, requestTimeoutMs: 30_000 }),
      error => error.code === 'noscenario'
    );
  });

  test('a classpath without the Karate session API is reported as unsupported', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-nokarate-'));
    fs.writeFileSync(path.join(dir, 'x.feature'), 'Feature: x\n\nScenario: y\n  * print 1\n');
    await assert.rejects(
      WorkbenchSession.start({ hostDir, classpath: [dir], feature: path.join(dir, 'x.feature'), workDir: dir, requestTimeoutMs: 30_000 }),
      error => error.code === 'unsupported'
    );
  });
});

describe('Integration: Gradle project with Java helpers', () => {
  const skip = integrationSkip()
    || (childProcess.spawnSync('gradle', ['--version'], { encoding: 'utf8' }).status === 0 ? undefined : 'gradle is not installed');
  if (skip) {
    test('skipped', { skip }, () => {});
    return;
  }

  test('resolves the build classpath so Java helpers and dependency jars work', async () => {
    const dir = tempCopy(path.join(fixtures, 'gradle'));
    const lib = path.join(dir, 'libsrc');
    fs.mkdirSync(path.join(dir, 'libs'));
    childProcess.execFileSync('javac', ['-d', path.join(lib, 'out'), path.join(lib, 'com', 'lib', 'Slug.java')]);
    childProcess.execFileSync('jar', ['cf', path.join(dir, 'libs', 'slug-lib.jar'), '-C', path.join(lib, 'out'), '.']);
    process.env.KARATE_TEST_JAR = path.resolve(karateJar);

    const resolved = await classpath.resolveClasspath({ projectRoot: dir, strategy: 'gradle', karateJar, buildArgs: ['--offline'], timeoutMs: 240_000 });
    assert.equal(resolved.entries[0], path.join(dir, 'src', 'test', 'java'));
    assert.ok(resolved.entries.some(entry => entry.endsWith('slug-lib.jar')), 'dependency jar must be on the classpath');
    assert.equal(resolved.usedProjectKarate, true);

    const feature = path.join(dir, 'src', 'test', 'java', 'helper.feature');
    const { session } = await WorkbenchSession.start({
      hostDir, classpath: resolved.entries, feature, configDir: path.join(dir, 'src', 'test', 'java'), workDir: dir, requestTimeoutMs: 60_000
    });
    try {
      await passes(session.step("* def Util = Java.type('com.example.Util')"));
      await passes(session.step("* def greeting = Util.greet('Ada Lovelace')"));
      await passes(session.step("* match greeting == 'hi ada-lovelace'"));

      // Editing a source feature or config is seen without a Gradle rebuild because source folders come first.
      fs.writeFileSync(path.join(dir, 'src', 'test', 'java', 'auth.feature'), "Feature: auth\n\nScenario:\n  * def token = 'edited-without-rebuild'\n");
    } finally {
      await session.stop();
    }
    const again = await WorkbenchSession.start({
      hostDir, classpath: resolved.entries, feature, configDir: path.join(dir, 'src', 'test', 'java'), workDir: dir, requestTimeoutMs: 60_000
    });
    try {
      assert.equal(again.result.config.token, 'edited-without-rebuild');
    } finally {
      await again.session.stop();
    }
  });
});
