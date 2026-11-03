/** HTML for the Karate Workbench view. Data is only ever inserted with textContent. No vscode dependency. */

export function renderWorkbenchHtml(nonce: string, cspSource: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Karate Workbench</title>
<style nonce="${nonce}">
  body { font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px 12px; }
  header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
  h1 { font-size: 1.1em; margin: 0; flex: 1; min-width: 120px; font-weight: 600; }
  [hidden] { display: none !important; }
  button, select { font: inherit; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 1px solid var(--vscode-button-border, transparent); padding: 2px 8px; border-radius: 3px; cursor: pointer; }
  button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: 0.45; cursor: default; }
  button:focus-visible, select:focus-visible, .row:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  .busy, .notice { padding: 6px 8px; border-radius: 3px; margin: 6px 0; display: flex; gap: 8px; align-items: center; }
  .busy { background: var(--vscode-inputValidation-infoBackground); border: 1px solid var(--vscode-inputValidation-infoBorder); }
  .notice { background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); }
  .busy span, .notice span { flex: 1; }
  .chip { display: inline-block; padding: 1px 8px; border-radius: 10px; font-weight: 600; font-size: 0.9em; }
  .ok { background: var(--vscode-testing-iconPassed); color: var(--vscode-editor-background); }
  .bad { background: var(--vscode-testing-iconFailed); color: var(--vscode-editor-background); }
  .muted { color: var(--vscode-descriptionForeground); }
  .mono, pre { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  pre.error { white-space: pre-wrap; background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); padding: 6px 8px; border-radius: 3px; margin: 6px 0; }
  section { margin: 10px 0; }
  .line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 4px 0; }
  .tree { margin-top: 6px; }
  .row { display: flex; align-items: center; gap: 6px; min-height: 22px; padding-left: calc(var(--depth, 0) * 14px); border-radius: 3px; }
  .row:hover, .row:focus-within { background: var(--vscode-list-hoverBackground); }
  .key { color: var(--vscode-symbolIcon-propertyForeground, var(--vscode-foreground)); }
  .str { color: var(--vscode-debugTokenExpression-string); }
  .num { color: var(--vscode-debugTokenExpression-number); }
  .lit { color: var(--vscode-debugTokenExpression-boolean); }
  .acts { margin-left: auto; display: none; gap: 4px; }
  .row:hover .acts, .row:focus-within .acts { display: flex; }
  .acts button { padding: 0 6px; font-size: 0.85em; }
  .vars { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .var { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 1px 8px; border-radius: 10px; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
  details summary { cursor: pointer; }
  .empty { color: var(--vscode-descriptionForeground); padding: 12px 0; }
</style>
</head>
<body>
<header>
  <h1 id="title">Karate Workbench</h1>
  <label class="muted" for="env">Environment</label>
  <select id="env" aria-label="Environment"></select>
  <button id="restart" type="button">Restart</button>
  <button id="stop" type="button">Stop</button>
</header>
<div id="busy" class="busy" hidden><span id="busyText"></span><button id="cancel" type="button">Cancel</button></div>
<div id="notice" class="notice" hidden><span id="noticeText"></span></div>
<main id="main"><div class="empty">Place the cursor on a step in a .feature file and choose Karate Workbench: Run to Cursor, or use the Send action above a method step.</div></main>
<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  var MASK = '\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022';
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function post(msg) { vscode.postMessage(msg); }
  $('restart').onclick = function () { post({ type: 'restart' }); };
  $('stop').onclick = function () { post({ type: 'stop' }); };
  $('cancel').onclick = function () { post({ type: 'cancel' }); };
  $('env').onchange = function () { post({ type: 'selectEnv', env: this.value }); };

  function button(label, title, handler, disabled) {
    var b = el('button', '', label); b.type = 'button'; b.title = title; b.disabled = !!disabled; b.onclick = handler; return b;
  }

  function node(container, key, value, path, depth, assertable) {
    var row = el('div', 'row'); row.style.setProperty('--depth', String(depth)); row.tabIndex = 0;
    var isContainer = value !== null && typeof value === 'object';
    if (key !== undefined) { row.appendChild(el('span', 'key', String(key) + ':')); }
    if (isContainer) {
      row.appendChild(el('span', 'muted', Array.isArray(value) ? '[' + value.length + ']' : '{' + Object.keys(value).length + '}'));
    } else {
      var cls = typeof value === 'string' ? 'str' : (typeof value === 'number' ? 'num' : 'lit');
      row.appendChild(el('span', cls + ' mono', JSON.stringify(value)));
    }
    var secret = value === MASK;
    if (assertable) {
      var acts = el('span', 'acts');
      var send = function (action) { return function () { post({ type: 'assert', path: path, action: action }); }; };
      if (isContainer) {
        acts.appendChild(button('schema', 'Add a schema match for this part', send('schema')));
      } else {
        acts.appendChild(button('type', 'match the type of this field', send('type')));
        acts.appendChild(button('value', secret ? 'Masked values cannot be asserted' : 'match this exact value', send('value'), secret));
        acts.appendChild(button('def', secret ? 'Masked values cannot be saved' : 'Save this field as a variable', send('def'), secret));
      }
      row.appendChild(acts);
    }
    container.appendChild(row);
    if (isContainer) {
      var keys = Object.keys(value);
      for (var i = 0; i < keys.length && i < 500; i++) {
        var childKey = Array.isArray(value) ? i : keys[i];
        node(container, Array.isArray(value) ? '[' + i + ']' : keys[i], value[keys[i]], path.concat([Array.isArray(value) ? i : keys[i]]), depth + 1, assertable);
      }
      if (keys.length > 500) { var more = el('div', 'row muted', '... ' + (keys.length - 500) + ' more'); more.style.setProperty('--depth', String(depth + 1)); container.appendChild(more); }
    }
  }

  function render(state) {
    $('title').textContent = state.title;
    var select = $('env'); select.textContent = '';
    var options = [''].concat(state.envs);
    if (state.env && options.indexOf(state.env) < 0) { options.push(state.env); }
    options.forEach(function (name) { var o = el('option', '', name || '(default)'); o.value = name; if (name === state.env) { o.selected = true; } select.appendChild(o); });
    $('busy').hidden = !state.busy; $('busyText').textContent = state.busy;
    $('notice').hidden = !state.notice; $('noticeText').textContent = state.notice;
    var main = $('main'); main.textContent = '';
    if (!state.step && !state.response) { main.appendChild(el('div', 'empty', 'Place the cursor on a step in a .feature file and choose Karate Workbench: Run to Cursor, or use the Send action above a method step.')); }
    if (state.step) {
      var line = el('div', 'line');
      line.appendChild(el('span', 'chip ' + (state.step.status === 'PASSED' ? 'ok' : 'bad'), state.step.status.toLowerCase()));
      line.appendChild(el('span', 'mono', state.step.text.split('\\n')[0]));
      line.appendChild(el('span', 'muted', Math.round(state.step.durationMs) + ' ms'));
      main.appendChild(line);
      if (state.step.error) { main.appendChild(el('pre', 'error', state.step.error)); }
    }
    if (state.response) {
      var r = state.response; var sec = el('section');
      var head = el('div', 'line');
      var statusChip = el('span', 'chip ' + (r.status >= 200 && r.status < 400 ? 'ok' : 'bad'), String(r.status));
      head.appendChild(statusChip);
      head.appendChild(el('span', 'muted', r.timeMs + ' ms'));
      if (!r.fresh) { head.appendChild(el('span', 'muted', 'from an earlier step')); }
      if (r.assertable) { head.appendChild(button('status', 'Add a status assertion', function () { post({ type: 'assert', path: [], action: 'status' }); })); }
      if (r.assertable) { head.appendChild(button('schema match', 'Add a schema match for the whole body', function () { post({ type: 'assert', path: [], action: 'schema' }); })); }
      sec.appendChild(head);
      var details = el('details'); details.appendChild(el('summary', '', 'Headers'));
      var hdr = el('div', 'tree');
      Object.keys(r.headers || {}).forEach(function (k) { node(hdr, k, r.headers[k], [], 0, false); });
      details.appendChild(hdr); sec.appendChild(details);
      var tree = el('div', 'tree');
      if (r.body === undefined || r.body === null) { tree.appendChild(el('div', 'muted', 'No body')); } else { node(tree, undefined, r.body, [], 0, r.assertable); }
      sec.appendChild(tree); main.appendChild(sec);
    }
    var names = Object.keys(state.variables || {});
    var vs = el('section'); vs.appendChild(el('div', 'muted', 'Variables'));
    var vars = el('div', 'vars');
    if (!names.length) { vars.appendChild(el('span', 'muted', 'none yet')); }
    names.forEach(function (n) {
      var text = JSON.stringify(state.variables[n]); if (text && text.length > 60) { text = text.slice(0, 57) + '...'; }
      vars.appendChild(el('span', 'var', n + ' = ' + text));
    });
    vs.appendChild(vars); main.appendChild(vs);
  }

  window.addEventListener('message', function (event) { if (event.data && event.data.type === 'state') { render(event.data.state); } });
  post({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
