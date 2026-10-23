// Pure credential-detection helpers shared by the source adapters (Postman, HAR/session). No vscode, no logger, no I/O.
// Policy: values of secret-named keys never reach a file; they become `karate.sysenv('NAME', '')` variables.

/** Variable names that hold secrets (Postman variables, auth keys). */
export const SECRET_NAME = /token|secret|password|passwd|apikey|api_key|api-key|authorization|bearer/i;
/** Header / query / form / JSON key names whose literal values are credentials. */
export const SECRET_HEADER = /authorization|api[-_]?key|token|secret|password|passwd|cookie|x-auth/i;

/** True when `key` is a secret-looking variable name. */
export const isSecretName = (key: string): boolean => SECRET_NAME.test(key);
/** True when a header/query/form/JSON key carries a credential. */
export const isSecretKey = (key: string): boolean => SECRET_HEADER.test(key);

const JWT_VALUE = /^eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*$/;
const BEARER_VALUE = /^Bearer\s+\S+/i;
const BASIC_VALUE = /^Basic\s+[A-Za-z0-9+/=]{6,}$/i;
/** True when a whole value has the shape of a credential (JWT, `Bearer ...`, `Basic ...`). */
export function looksLikeCredentialValue(value: string): boolean {
    const v = value.trim();
    return JWT_VALUE.test(v) || BEARER_VALUE.test(v) || BASIC_VALUE.test(v);
}

const EMBEDDED_JWT = /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/;
const EMBEDDED_BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i;
const EMBEDDED_BASIC = /\bBasic\s+[A-Za-z0-9+/=]{8,}/;
/** True when free-form text contains a credential-shaped value anywhere (not only as a whole value). */
export function containsCredentialValue(text: string): boolean {
    return EMBEDDED_JWT.test(text) || EMBEDDED_BEARER.test(text) || EMBEDDED_BASIC.test(text);
}

export const words = (name: string): string[] => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
/** Environment variable name for a secret: `apiKey` / `x-api-key` -> `API_KEY` / `X_API_KEY`. */
export const upperSnake = (name: string): string => words(name).map(w => w.toUpperCase()).join('_') || 'SECRET';
/** Karate variable name for a secret key: `x-api-key` -> `xApiKey`. */
export const camelName = (name: string): string => {
    const w = words(name);
    if (w.length === 0) {return 'secret';}
    const joined = w[0].toLowerCase() + w.slice(1).map(x => x[0].toUpperCase() + x.slice(1).toLowerCase()).join('');
    return /^\d/.test(joined) ? `v${joined}` : joined;
};

const CRED_KEY = '(password|passwd|pwd|secret|token|api[_-]?key|authorization|bearer|credential|private[_-]?key|client[_-]?secret|access[_-]?key)';
/**
 * Deliberately broad detector for credential-like keys in free-form text: JSON-ish/YAML/form pairs (`key:` `key=`),
 * XML/HTML tags and attributes. A value that is a pure `{{var}}` reference is not a literal and is ignored.
 * Returns the matched key names (never values).
 */
export function credentialKeys(text: string): string[] {
    const found = new Set<string>();
    const pure = /^\s*["']?\{\{[^}]*\}\}["']?\s*(?:[,}&;\n<]|$)/;
    const pair = new RegExp(`[\\w.-]*${CRED_KEY}[\\w.-]*["']?\\s*[:=]`, 'gi');
    for (const m of text.matchAll(pair)) {
        if (!pure.test(text.slice(m.index! + m[0].length))) {found.add(m[1].toLowerCase());}
    }
    const tag = new RegExp(`<[\\w:.-]*${CRED_KEY}[\\w:.-]*[^>]*>`, 'gi');
    for (const m of text.matchAll(tag)) {
        if (!pure.test(text.slice(m.index! + m[0].length)) || /=/.test(m[0])) {found.add(m[1].toLowerCase());}
    }
    return [...found].sort();
}

/** URL with the values of secret-looking query parameters masked; for logs only (never for generated files). */
export function redactUrl(raw: string): string {
    // userinfo (`user:pw@host`) is always removed
    const url = raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, '$1[REDACTED]@');
    const cut = url.indexOf('?');
    if (cut < 0) {return url;}
    const head = url.slice(0, cut);
    const hash = url.indexOf('#', cut);
    const query = url.slice(cut + 1, hash < 0 ? undefined : hash);
    const masked = query.split('&').map(part => {
        const eq = part.indexOf('=');
        if (eq < 0) {return part;}
        const key = part.slice(0, eq);
        const value = part.slice(eq + 1);
        return isSecretKey(key) || looksLikeCredentialValue(value) ? `${key}=[REDACTED]` : part;
    }).join('&');
    return `${head}?${masked}${hash < 0 ? '' : url.slice(hash)}`;
}
