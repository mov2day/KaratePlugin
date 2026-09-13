import { captureExpression, actionExpression } from './browser-scripts.js';

let session;
let enabled = false;
let lastActionId;
let epoch = 0;
let lastNetwork = 0;
const requests = new Map();
let pendingBodies = 0;
const MAX_BODY = 256 * 1024;
const authPath = /(?:^|\/)(?:login|logon|logout|signin|signout|sign-in|sign-out|sso|saml|oauth2?|oidc|authorize|authorization|token|callback|mfa|auth)(?:[/.?_-]|$)/i;
const command = (method, params = {}) => chrome.debugger.sendCommand({ tabId: session.tabId }, method, params);
const permitted = value => {
  try { const url = new URL(value); return session && session.connection.allowedOrigins.includes(url.origin) && !session.connection.excludedOrigins.includes(url.origin) && !authPath.test(url.pathname) && !/[?&](code|id_token|access_token|samlresponse)=/i.test(url.search); } catch { return false; }
};
const headers = value => Object.fromEntries(Object.entries(value || {}).filter(([key]) => ['content-type','accept','content-language','accept-language'].includes(key.toLowerCase())));
async function api(route, body = {}, token = session?.token, endpoint = session?.endpoint) {
  const response = await fetch(endpoint + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body), signal: AbortSignal.timeout(35000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Scout connection ended.');
  return result;
}
async function emit(type, data) {
  if (!session) return;
  try { await api('/events', { events: [{ type, data }] }); } catch { await disconnect(); }
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Browser interaction failed.');
  return result.result?.value;
}
async function disconnect() {
  const previous = session; session = undefined; enabled = false; epoch++; requests.clear();
  if (previous) { try { await chrome.debugger.detach({ tabId: previous.tabId }); } catch {} }
  await chrome.storage.session.remove('scoutTab');
}
async function settle() {
  const start = Date.now();
  do { await new Promise(resolve => setTimeout(resolve, 100)); }
  while (Date.now() - start < 5000 && (Date.now() - start < 500 || Date.now() - lastNetwork < 500 || requests.size || pendingBodies));
}
async function execute(item) {
  switch (item.operation) {
    case 'capture':
      enabled = item.payload.enabled === true; epoch++; requests.clear(); lastActionId = undefined;
      return evaluate(captureExpression({ ...session.connection, enabled: true }));
    case 'url': return (await chrome.tabs.get(session.tabId)).url;
    case 'navigate':
      if (!permitted(item.payload.url)) throw new Error('Navigation is outside the permitted application origins.');
      await command('Page.navigate', { url: item.payload.url });
      await new Promise(resolve => setTimeout(resolve, 300));
      await settle(); return true;
    case 'perform': {
      if (!permitted((await chrome.tabs.get(session.tabId)).url)) throw new Error('Return to the signed-in application before exploring.');
      lastActionId = item.payload.id;
      const deadline = Date.now() + 5000;
      while (!await evaluate('!!document.querySelector(' + JSON.stringify(item.payload.selector) + ')')) {
        if (Date.now() > deadline) throw new Error('Recorded control is no longer present: ' + item.payload.label);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await evaluate(actionExpression(item.payload)); await settle(); return true;
    }
    case 'settle': await settle(); return true;
    case 'disconnect': await disconnect(); return true;
    default: throw new Error('Unsupported Scout command.');
  }
}
async function poll(active) {
  while (session === active) {
    try {
      const result = await api('/poll');
      for (const item of result.commands || []) {
        if (session !== active) return;
        try { const value = await execute(item); if (session === active) await api('/result', { id: item.id, value }); }
        catch (error) { if (session === active) await api('/result', { id: item.id, error: error.message }); }
      }
    } catch { await disconnect(); return; }
  }
}
export async function handlePopupMessage(message) {
    if (message.operation === 'disconnect') { await emit('disconnected', 'Disconnected from the browser companion.'); await disconnect(); return {}; }
    if (message.operation !== 'pair') throw new Error('Unsupported action.');
    const endpoint = new URL(message.endpoint);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.pathname !== '/' || endpoint.search || endpoint.username || endpoint.password || !/^[a-f0-9]{64}$/.test(message.token)) throw new Error('Paste the local endpoint and temporary pairing key from Scout.');
    await disconnect();
    const tab = await chrome.tabs.get(message.tabId);
    if (!/^https?:/.test(tab.url || '')) throw new Error('Select your signed-in application tab.');
    try { await chrome.debugger.attach({ tabId: tab.id }, '1.3'); }
    catch (error) { throw new Error('Browser access was refused: ' + error.message + ' Ask your administrator about Scout access, or import a HAR if permitted.'); }
    session = { endpoint: endpoint.origin, token: message.token, tabId: tab.id, connection: { allowedOrigins: [], excludedOrigins: [] } };
    try {
      await command('Network.enable', { maxTotalBufferSize: 4 * 1024 * 1024, maxResourceBufferSize: MAX_BODY });
      await command('Page.enable'); await command('Runtime.enable');
      await command('Runtime.addBinding', { name: '__scoutReport' });
      const version = await command('Browser.getVersion').catch(() => ({ product: navigator.userAgent }));
      const browser = /Edg\//.test(navigator.userAgent) ? 'edge' : 'chrome';
      const result = await api('/pair', { browser, version: version.product, url: tab.url, capabilities: { actions: true, responseBodies: true, interaction: true, limitations: ['Actions inside cross-origin frames are not replayed in this release.'] } });
      session.token = result.token; session.connection = result.connection;
      const source = captureExpression({ ...session.connection, enabled: true });
      await command('Page.addScriptToEvaluateOnNewDocument', { source });
      await evaluate(source);
      await chrome.storage.session.set({ scoutTab: tab.id });
      void poll(session); return {};
    } catch (error) { await disconnect(); throw error; }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  handlePopupMessage(message).then(respond, error => respond({ error: error.message }));
  return true;
});
chrome.debugger.onDetach.addListener(source => {
  if (session?.tabId === source.tabId) { void emit('disconnected', 'The selected tab closed or browser access was revoked.'); void disconnect(); }
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!session || source.tabId !== session.tabId || source.sessionId) return;
  if (method === 'Page.frameNavigated' && !params.frame.parentId && enabled && !permitted(params.frame.url)) { void emit('auth-required', 'Return to the signed-in application before continuing.'); return; }
  if (!enabled) return;
  if (method === 'Runtime.bindingCalled' && params.name === '__scoutReport') {
    try { const action = JSON.parse(params.payload); if (permitted(action.url)) { lastActionId = action.id; void emit('action', action); } } catch {}
  }
  if (method === 'Network.requestWillBeSent') {
    lastNetwork = Date.now();
    requests.delete(params.requestId);
    if (['XHR','Fetch'].includes(params.type) && permitted(params.request.url) && requests.size < 300) requests.set(params.requestId, { id: crypto.randomUUID(), timestamp: Date.now(), epoch, actionId: lastActionId, method: params.request.method, url: params.request.url, headers: headers(params.request.headers), body: params.request.postData?.length <= MAX_BODY ? params.request.postData : undefined });
  }
  if (method === 'Network.requestWillBeSent' && params.request.postData?.length > MAX_BODY) {
    const captured = requests.get(params.requestId);
    if (captured) captured.incomplete = 'Request body exceeds the capture limit.';
  }
  if (method === 'Network.responseReceived') {
    const request = requests.get(params.requestId);
    if (request) request.response = { status: params.response.status, headers: headers(params.response.headers), duration: Date.now() - request.timestamp };
  }
  if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
    lastNetwork = Date.now();
    const request = requests.get(params.requestId); requests.delete(params.requestId);
    if (!request) return;
    pendingBodies++;
    (async () => {
      if (method === 'Network.loadingFailed') request.incomplete = 'Network request did not complete.';
      else if (params.encodedDataLength > MAX_BODY) request.incomplete = 'Response body exceeds the capture limit.';
      else {
        try {
          const result = await command('Network.getResponseBody', { requestId: params.requestId });
          const contentType = Object.entries(request.response?.headers || {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1] || '';
          if (result.base64Encoded || !/json|text\//i.test(contentType) || result.body.length > MAX_BODY) request.incomplete = 'This response body is not available as JSON or text.';
          else if (request.response) request.response.body = result.body;
        } catch { request.incomplete = 'The browser did not expose this response body.'; }
      }
      if (enabled && request.epoch === epoch) { delete request.epoch; await emit('request', request); }
    })().catch(() => {}).finally(() => { pendingBodies--; lastNetwork = Date.now(); });
  }
});
