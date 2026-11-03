/** Masks secret-looking values before anything is shown in the Workbench view. No vscode dependency. */

export const MASK = '••••••';

const SECRET_KEY = /authorization|cookie|token|secret|passw(?:or)?d|api[-_]?key|credential|session|bearer|signature|private[-_]?key/i;
const SECRET_VALUE = /^(?:Bearer|Basic)\s+\S+$|^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;

export function isSecretKey(key: string | number): boolean {
    return typeof key === 'string' && SECRET_KEY.test(key);
}

export function pathIsSecret(path: Array<string | number>): boolean {
    return path.some(isSecretKey);
}

export function isSecretValue(value: unknown): boolean {
    return typeof value === 'string' && SECRET_VALUE.test(value.trim());
}

/** A deep copy with secret values replaced by a mask. Containers under a secret key are masked entirely. */
export function maskDeep(value: unknown, keyIsSecret = false, depth = 0): unknown {
    if (keyIsSecret && value !== null && value !== undefined) {
        return MASK;
    }
    if (isSecretValue(value)) {
        return MASK;
    }
    if (depth > 20 || value === null || typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(item => maskDeep(item, false, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        out[key] = maskDeep(child, isSecretKey(key), depth + 1);
    }
    return out;
}
