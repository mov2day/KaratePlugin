const assert = require('assert');
const { PassThrough } = require('stream');

process.env.KV_REST_API_URL = 'https://kv.example.test';
process.env.KV_REST_API_TOKEN = 'test-token';
global.fetch = async () => ({ ok: true, json: async () => [{ result: 1 }, { result: 'OK' }] });

const handler = require('../api/telemetry');

function baseEvent() {
  return { event: 'activation', version: '2.0.0', vscodeVersion: '1.125.0', platform: 'darwin', sessionId: 'test-session' };
}

function responseCapture() {
  return {
    code: 0,
    body: undefined,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

async function invoke(body, raw = false) {
  const request = new PassThrough();
  request.method = 'POST';
  request.headers = { 'x-forwarded-for': '127.0.0.1' };
  request.socket = { remoteAddress: '127.0.0.1' };
  if (raw) request.end(JSON.stringify(body));
  else request.body = body;
  const response = responseCapture();
  await handler(request, response);
  return response;
}

(async () => {
  const parsed = await invoke(baseEvent());
  assert.strictEqual(parsed.code, 202);
  assert.strictEqual(parsed.body.accepted, true);

  const raw = await invoke(baseEvent(), true);
  assert.strictEqual(raw.code, 202);

  const rejected = await invoke({ ...baseEvent(), unexpected: 'nope' });
  assert.strictEqual(rejected.code, 400);
  assert.strictEqual(rejected.body.error, 'invalid_event');
  process.stdout.write('Telemetry collector contract passed.\n');
})().catch(error => { console.error(error); process.exit(1); });
