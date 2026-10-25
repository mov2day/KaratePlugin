// Builds a ResponseModel from an observed or saved response (Postman examples, HAR entries). Pure: no vscode, no I/O.
import type { HeaderModel, ResponseModel } from '../model/TestModel';
import { isSecretKey } from './secrets';

/** Headers worth modelling: the ones response checks can assert. Others (Date, Server, Set-Cookie...) are volatile or sensitive. */
const KEPT_HEADER = /^(?:location|etag|retry-after|link|x-total(?:-count)?|x-total-pages|x-page-count|x-per-page|x-limit)$/i;
const MAX_EXAMPLE_CHARS = 4000;

function redact(value: unknown, depth = 0): unknown {
    if (depth > 6) {return undefined;}
    if (Array.isArray(value)) {return value.slice(0, 20).map(v => redact(v, depth + 1));}
    if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isSecretKey(k) ? '[REDACTED]' : redact(v, depth + 1)]));
    }
    return value;
}

function parseExample(body: string | undefined): unknown {
    if (typeof body !== 'string' || body.trim() === '' || body.length > MAX_EXAMPLE_CHARS) {return undefined;}
    try {
        const value: unknown = JSON.parse(body);
        return typeof value === 'object' && value !== null ? redact(value) : undefined;
    } catch {
        return undefined;
    }
}

export function observedResponse(status: string, headers: Array<{ key: string; value: string }>, body?: string): ResponseModel {
    const model: ResponseModel = { status };
    const contentType = headers.find(h => h.key.toLowerCase() === 'content-type')?.value;
    if (contentType) {model.contentType = contentType;}
    const kept: HeaderModel[] = headers.filter(h => KEPT_HEADER.test(h.key)).map(h => ({ name: h.key, required: false }));
    if (kept.length > 0) {model.headers = kept;}
    const json = !contentType || /json/i.test(contentType);
    const example = json ? parseExample(body) : undefined;
    if (example !== undefined) {model.example = example;}
    return model;
}
