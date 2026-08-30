/** Detect provider errors where a model was advertised but rejected at send time. */
export function isUnsupportedModelRejection(error: unknown): boolean {
    const text = flattenError(error).toLowerCase();
    return text.includes('model_not_supported')
        || text.includes('requested model is not supported')
        || /model.{0,48}not supported/.test(text);
}

function flattenError(value: unknown, depth = 0, seen = new Set<unknown>()): string {
    if (value === undefined || value === null || depth > 4 || seen.has(value)) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value !== 'object') return '';

    seen.add(value);
    const record = value as Record<string, unknown>;
    return ['message', 'code', 'type', 'param', 'cause', 'error', 'response', 'data']
        .map(key => flattenError(record[key], depth + 1, seen))
        .filter(Boolean)
        .join(' ');
}
