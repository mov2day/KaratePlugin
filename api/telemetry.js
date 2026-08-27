const EVENT_FIELDS = {
  activation: ['event', 'version', 'vscodeVersion', 'platform', 'sessionId'],
  activation_error: ['event', 'version', 'vscodeVersion', 'platform', 'sessionId', 'error'],
  migration_started: ['event', 'version', 'vscodeVersion', 'platform', 'sessionId', 'schemaVersionFrom', 'schemaVersionTo', 'historyFileCount'],
  migration_completed: ['event', 'version', 'vscodeVersion', 'platform', 'sessionId', 'schemaVersionTo', 'historyFileCount', 'durationMs'],
  migration_failed: ['event', 'version', 'vscodeVersion', 'platform', 'sessionId', 'stage', 'error'],
  webview_shell_error: ['event', 'version', 'vscodeVersion', 'platform', 'sessionId', 'area', 'error'],
  command_error: ['event', 'version', 'vscodeVersion', 'platform', 'sessionId', 'commandId', 'error'],
  history_lock_conflict: ['event', 'version', 'vscodeVersion', 'platform', 'sessionId', 'retryCount', 'resolved'],
  ai_guardrail_triggered: ['event', 'version', 'vscodeVersion', 'platform', 'sessionId', 'guardrailType', 'limitValue'],
  user_reported_bug: ['event', 'version', 'vscodeVersion', 'platform', 'sessionId', 'activeArea', 'recentLogLines', 'userDescription']
};

const MAX_BODY_BYTES = 64 * 1024;
const MAX_EVENTS_PER_MINUTE = 30;

/**
 * Vercel Node function. Configure KV_REST_API_URL and KV_REST_API_TOKEN with
 * Vercel KV/Upstash REST credentials before deployment.
 */
module.exports = async function telemetry(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'method_not_allowed' });
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return response.status(503).json({ error: 'collector_not_configured' });
  }

  try {
    const payload = await readJson(request);
    const event = validatePayload(payload);
    const ip = String(request.headers['x-forwarded-for'] || request.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    const rateKey = `karate:telemetry:rate:${hash(ip)}:${event.sessionId}`;
    const count = await increment(rateKey, 60);
    if (count > MAX_EVENTS_PER_MINUTE) return response.status(429).json({ error: 'rate_limited' });

    await push('karate:telemetry:events', JSON.stringify({ ...event, receivedAt: Date.now() }));
    return response.status(202).json({ accepted: true });
  } catch (error) {
    const status = error && typeof error.status === 'number' ? error.status : 400;
    return response.status(status).json({ error: 'invalid_event' });
  }
};

function readJson(request) {
  if (request.body && typeof request.body === 'object') return Promise.resolve(request.body);
  if (typeof request.body === 'string') {
    try { return Promise.resolve(JSON.parse(request.body)); } catch { return Promise.reject(new Error('invalid_json')); }
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        const error = new Error('payload_too_large');
        error.status = 413;
        reject(error);
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid_json')); }
    });
    request.on('error', reject);
  });
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid_payload');
  const name = payload.event;
  const allowed = EVENT_FIELDS[name];
  if (!allowed || !isShortString(payload.version, 40) || !isShortString(payload.vscodeVersion, 40)
      || !isShortString(payload.platform, 40) || !isShortString(payload.sessionId, 64)) throw new Error('invalid_payload');
  if (Object.keys(payload).some(key => !allowed.includes(key))) throw new Error('unexpected_field');
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string' && value.length > 4000) throw new Error('field_too_long');
    if (Array.isArray(value) && (value.length > 200 || value.some(item => typeof item !== 'string' || item.length > 1000))) throw new Error('invalid_array');
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) throw new Error('nested_objects_not_allowed');
  }
  return Object.fromEntries(Object.entries(payload).filter(([key]) => allowed.includes(key)));
}

function isShortString(value, length) { return typeof value === 'string' && value.length > 0 && value.length <= length; }
function hash(value) { let result = 2166136261; for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619); return (result >>> 0).toString(36); }

async function kv(command) {
  const endpoint = process.env.KV_REST_API_URL.replace(/\/$/, '') + '/pipeline';
  const result = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  if (!result.ok) throw new Error('storage_unavailable');
  return result.json();
}

async function increment(key, seconds) {
  const result = await kv([['INCR', key], ['EXPIRE', key, String(seconds)]]);
  return Number(result[0]?.result || 0);
}

async function push(key, value) { await kv([['LPUSH', key, value], ['LTRIM', key, '0', '9999']]); }
