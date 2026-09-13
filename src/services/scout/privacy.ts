import { ScoutConnection, ScoutRequest } from './types';

export const REDACTED = '[SCOUT_REDACTED]';
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_CAPTURE_REQUESTS = 300;
export const SENSITIVE_KEY = /(?:password|passwd|secret|token|authorization|cookie|credential|assertion|saml|session|csrf|xsrf|api[-_]?key|otp|mfa|verification[-_]?code|email|phone|credit[-_]?card)/i;
const AUTH_PATH = /(?:^|\/)(?:login|logon|logout|signin|signout|sign-in|sign-out|sso|saml|oauth2?|oidc|authorize|authorization|token|callback|mfa|verify-otp|auth)(?:[/.?_-]|$)/i;

export function isAuthUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return AUTH_PATH.test(url.pathname) || [...url.searchParams.keys()].some(key => /^(?:code|id_token|access_token|samlresponse|samlrequest)$/i.test(key));
    } catch { return true; }
}

export function httpUrl(value: string): URL {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) URL without embedded credentials.');
    return url;
}

export function normalizeConnection(input: ScoutConnection): ScoutConnection {
    if (!input || !['chrome', 'edge'].includes(input.browser) || !['launch', 'companion', 'har'].includes(input.mode)) throw new Error('Choose Chrome or Edge and a supported connection.');
    const url = httpUrl(input.url);
    const excludedOrigins = [...new Set((input.excludedOrigins || []).map(value => httpUrl(value).origin))];
    const allowedOrigins = [...new Set([url.origin, ...(input.allowedOrigins || []).map(value => httpUrl(value).origin)])];
    if (excludedOrigins.includes(url.origin)) throw new Error('The application origin cannot also be excluded.');
    return { browser: input.browser, mode: input.mode, url: url.href, allowedOrigins, excludedOrigins,
        executablePath: input.executablePath, browserVersion: input.browserVersion };
}

export function allowedUrl(value: string, connection: Pick<ScoutConnection, 'allowedOrigins' | 'excludedOrigins'>): boolean {
    try {
        const origin = httpUrl(value).origin;
        return connection.allowedOrigins.includes(origin) && !connection.excludedOrigins.includes(origin) && !isAuthUrl(value);
    } catch { return false; }
}

export function redactText(value: string): string {
    return value.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED)
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REDACTED);
}

export function sanitize(value: unknown, key = '', depth = 0): unknown {
    if (SENSITIVE_KEY.test(key)) return REDACTED;
    if (depth > 25) return '[SCOUT_DEPTH_LIMIT]';
    if (typeof value === 'string') {
        if (Buffer.byteLength(value) > MAX_BODY_BYTES) return '[SCOUT_BODY_OMITTED]';
        return redactText(value);
    }
    if (Array.isArray(value)) return value.slice(0, 2000).map(item => sanitize(item, '', depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 2000).map(([name, item]) => [name, sanitize(item, name, depth + 1)]));
    return value;
}

export function safeUrl(value: string): string {
    const url = httpUrl(value);
    url.hash = '';
    const parameters = [...url.searchParams]; url.search = '';
    for (const [key, item] of parameters) url.searchParams.append(key, SENSITIVE_KEY.test(key) || /^(?:code|state)$/i.test(key) ? REDACTED : redactText(item));
    url.pathname = redactText(url.pathname);
    return url.href;
}

export function safeHeaders(headers: Record<string, string>): Record<string, string> {
    // Capture only descriptive headers; browser authentication stays in the browser.
    const allowed = new Set(['content-type', 'accept', 'content-language', 'accept-language']);
    return Object.fromEntries(Object.entries(headers || {}).filter(([key, value]) => allowed.has(key.toLowerCase()) && typeof value === 'string').map(([key, value]) => [key, redactText(value)]));
}

export function safeRequest(request: ScoutRequest): ScoutRequest {
    return {
        id: request.id, timestamp: request.timestamp, actionId: typeof request.actionId === 'string' ? request.actionId : undefined,
        method: request.method, url: safeUrl(request.url), headers: safeHeaders(request.headers), body: sanitizeBody(request.body),
        incomplete: typeof request.incomplete === 'string' ? redactText(request.incomplete).slice(0, 500) : undefined,
        response: request.response && { status: request.response.status, duration: request.response.duration,
            headers: safeHeaders(request.response.headers), body: sanitizeBody(request.response.body) }
    };
}

export function sanitizeBody(value: unknown): unknown {
    if (typeof value === 'string') {
        try { return sanitize(JSON.parse(value)); } catch {
            // Form-encoded and plain text bodies are not JSON; redact key/value secrets too.
            return redactText(value).replace(/((?:password|secret|token|api[-_]?key|session|csrf|otp|email)\s*[=:]\s*)([^&\s<]+)/gi, `$1${REDACTED}`);
        }
    }
    return sanitize(value);
}

export function pointerGet(value: unknown, pointer: string): unknown {
    if (!pointer) return value;
    if (!pointer.startsWith('/')) return undefined;
    return pointer.slice(1).split('/').reduce<unknown>((current, part) => {
        const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
        return current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, key) ? (current as Record<string, unknown>)[key] : undefined;
    }, value);
}

export function leaves(value: unknown, prefix = '', depth = 0): Array<{ pointer: string; value: string | number | boolean }> {
    if (depth > 12) return [];
    if (value && typeof value === 'object') return Object.entries(value).slice(0, 500).flatMap(([key, item]) => SENSITIVE_KEY.test(key) ? [] : leaves(item, `${prefix}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, depth + 1));
    return (typeof value === 'string' && value !== REDACTED) || typeof value === 'number' || typeof value === 'boolean' ? [{ pointer: prefix, value }] : [];
}
