// src/services/scout/browserScripts.ts
var INSTALL_CAPTURE = String.raw`(config) => {
    const previous = window.__karateScout;
    if (previous) { previous.config = config; return true; }
    const state = window.__karateScout = { config };
    const sensitive = /password|passwd|secret|token|authorization|cookie|credential|saml|session|csrf|xsrf|api[-_]?key|otp|mfa|verification[-_]?code|email|phone|credit[-_]?card/i;
    const authPath = /(?:^|\/)(?:login|logon|logout|signin|signout|sign-in|sign-out|sso|saml|oauth2?|oidc|authorize|authorization|token|callback|mfa|auth)(?:[/.?_-]|$)/i;
    function permitted() {
        const c = state.config;
        return c.enabled && c.allowedOrigins.includes(location.origin) && !c.excludedOrigins.includes(location.origin) && !authPath.test(location.pathname) && !/[?&](code|id_token|access_token|samlresponse)=/i.test(location.search);
    }
    function selector(el) {
        if (el.id) return '#' + CSS.escape(el.id);
        const testId = el.getAttribute('data-testid');
        if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
        const parts = [];
        while (el && el.nodeType === 1 && el !== document.body) {
            const tag = el.tagName.toLowerCase();
            const peers = el.parentElement ? Array.from(el.parentElement.children).filter(n => n.tagName === el.tagName) : [];
            parts.unshift(tag + (peers.length > 1 ? ':nth-of-type(' + (peers.indexOf(el) + 1) + ')' : ''));
            el = el.parentElement;
        }
        return 'body > ' + parts.join(' > ');
    }
    function capture(event) {
        if (!permitted()) return;
        let el = event.target;
        if (!(el instanceof Element)) return;
        if (event.type === 'click') el = el.closest('button,a,input[type=submit],input[type=button],input[type=checkbox],input[type=radio]');
        if (!el || el.closest('[data-scout-private]')) return;
        const inputType = (el.type || '').toLowerCase();
        const identity = [el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('aria-label')].filter(Boolean).join(' ');
        if (sensitive.test(identity) || /one-time-code|current-password|new-password/i.test(identity) || ['password','email','tel','hidden','file'].includes(inputType) || (el.form && el.form.querySelector('input[type=password],input[autocomplete=one-time-code]'))) return;
        if (event.type === 'change' && !['INPUT','TEXTAREA','SELECT'].includes(el.tagName)) return;
        let kind = event.type === 'click' ? 'click' : el.tagName === 'SELECT' ? 'select' : 'fill';
        let value = event.type === 'change' ? String(el.value || '') : undefined;
        if (['checkbox','radio'].includes(inputType)) { if (event.type === 'change') return; kind = 'check'; value = String(el.checked); }
        const label = (el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].textContent) || el.name || el.textContent || el.id || kind).trim().replace(/\s+/g,' ').slice(0,100);
        const constraints = { required: !!el.required };
        for (const key of ['min','max']) if (el.getAttribute(key) !== null && Number.isFinite(Number(el.getAttribute(key)))) constraints[key] = Number(el.getAttribute(key));
        if (el.maxLength > 0) constraints.maxLength = el.maxLength;
        const url = new URL(location.href); url.hash = '';
        for (const key of Array.from(url.searchParams.keys())) if (sensitive.test(key) || /^(code|state)$/i.test(key)) url.searchParams.set(key, '[SCOUT_REDACTED]');
        const id = crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
        const action = { id, timestamp: Date.now(), kind, url: url.href, selector: selector(el), label, value: value && value.slice(0,4096), field: el.name || el.id || undefined, inputType, constraints };
        try { window.__scoutReport(JSON.stringify(action)); } catch (_) {}
    }
    document.addEventListener('click', capture, true);
    document.addEventListener('change', capture, true);
    return true;
}`;
var PERFORM_ACTION = String.raw`async (action) => {
    const element = document.querySelector(action.selector);
    if (!element) throw new Error('Recorded control is no longer present: ' + action.label);
    if (element.disabled) throw new Error('Recorded control is disabled: ' + action.label);
    if (action.kind === 'click') { element.click(); return true; }
    if (action.kind === 'check') {
        if (element.checked !== (action.value === 'true')) element.click();
        return true;
    }
    const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(element, action.value || '');
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}`;
function captureExpression(config) {
  return `(${INSTALL_CAPTURE})(${JSON.stringify(config)})`;
}
function actionExpression(action) {
  return `(${PERFORM_ACTION})(${JSON.stringify(action)})`;
}
export {
  INSTALL_CAPTURE,
  PERFORM_ACTION,
  actionExpression,
  captureExpression
};
