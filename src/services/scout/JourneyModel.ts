import { randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { ScoutAction, ScoutAssertion, ScoutCommand, ScoutDependency, ScoutExpectation, ScoutJourney, ScoutRequest, ScoutVariant } from './types';
import { allowedUrl, leaves, normalizeConnection, pointerGet, REDACTED, safeRequest, safeUrl, sanitize, SENSITIVE_KEY } from './privacy';

export function inferDependencies(requests: ScoutRequest[]): ScoutDependency[] {
    const dependencies: ScoutDependency[] = [];
    for (let index = 0; index < requests.length; index++) {
        const request = requests[index];
        const url = new URL(request.url);
        const targets: Array<{ target: ScoutDependency['target']; pointer: string; value: unknown }> = [
            ...leaves(request.body).map(item => ({ ...item, target: 'body' as const })),
            ...url.pathname.split('/').map((value, part) => ({ target: 'path' as const, pointer: `/${part}`, value: decodeURIComponent(value) })),
            ...[...url.searchParams.entries()].map(([key, value]) => ({ target: 'query' as const, pointer: key, value }))
        ];
        for (const target of targets) {
            if (target.value === '' || target.value === REDACTED || target.value === null || typeof target.value === 'boolean') continue;
            const candidates = requests.slice(0, index).flatMap(previous => leaves(previous.response?.body)
                .filter(item => /(?:^|\/)(?:[\w~-]*[iI][dD]|uuid|key|reference)$/.test(item.pointer) && String(item.value) === String(target.value))
                .map(item => ({ requestId: previous.id, pointer: item.pointer })));
            if (!candidates.length) continue;
            const source = candidates[candidates.length - 1];
            dependencies.push({ id: `${request.id}:${target.target}:${target.pointer}`, fromRequestId: source.requestId, fromPointer: source.pointer,
                toRequestId: request.id, target: target.target, toPointer: target.pointer, candidates, confirmed: candidates.length === 1 });
        }
    }
    return dependencies;
}

export function validAssertion(value: unknown): value is ScoutAssertion {
    if (!value || typeof value !== 'object') return false;
    const item = value as ScoutAssertion;
    return typeof item.pointer === 'string' && (item.pointer === '' || item.pointer.startsWith('/')) && item.pointer.length < 500
        && ['equals', 'present', 'at-most', 'at-least'].includes(item.operator)
        && (item.operator !== 'equals' || item.value !== undefined)
        && (!['at-most', 'at-least'].includes(item.operator) || typeof item.value === 'number' && Number.isFinite(item.value));
}

export function validExpectation(value: unknown): value is ScoutExpectation {
    if (!value || typeof value !== 'object') return false;
    const item = value as ScoutExpectation;
    return typeof item.requestId === 'string' && typeof item.confirmed === 'boolean' && Array.isArray(item.statuses) && item.statuses.length > 0 && item.statuses.length <= 20
        && item.statuses.every(status => Number.isInteger(status) && status >= 100 && status <= 599)
        && Array.isArray(item.assertions) && item.assertions.length <= 30 && item.assertions.every(validAssertion);
}

export function validAction(value: unknown): value is ScoutAction {
    if (!value || typeof value !== 'object') return false;
    const item = value as ScoutAction;
    return ['click', 'fill', 'select', 'check'].includes(item.kind) && ['id', 'url', 'selector', 'label'].every(key => typeof (item as unknown as Record<string, unknown>)[key] === 'string')
        && Number.isFinite(item.timestamp) && item.selector.length <= 1000 && item.label.length <= 200 && (item.value === undefined || typeof item.value === 'string' && item.value.length <= 4096)
        && (item.field === undefined || typeof item.field === 'string' && item.field.length <= 200)
        && (item.inputType === undefined || typeof item.inputType === 'string' && item.inputType.length <= 50)
        && (!item.constraints || typeof item.constraints === 'object' && Object.entries(item.constraints).every(([key, value]) => key === 'required' ? typeof value === 'boolean' : ['min','max','maxLength'].includes(key) && typeof value === 'number' && Number.isFinite(value)))
        && !SENSITIVE_KEY.test(`${item.field || ''} ${item.inputType || ''} ${item.label} ${item.selector}`);
}

export function isScoutCommand(value: unknown): value is ScoutCommand {
    if (!value || typeof value !== 'object') return false;
    const item = value as ScoutCommand;
    const operations = ['snapshot','connect','start','stop','disconnect','cancel','propose','explore','resume','save','load','import-har','export','verify-karate','companion-files','demo','update'];
    if (!operations.includes(item.operation)) return false;
    if (item.operation === 'connect') { try { normalizeConnection(item.connection!); } catch { return false; } }
    if (item.expectations && (!Array.isArray(item.expectations) || !item.expectations.every(validExpectation))) return false;
    if (item.variants && (!Array.isArray(item.variants) || item.variants.length > 30 || !item.variants.every(variant => variant && typeof variant.id === 'string' && validExpectation(variant.expectation)))) return false;
    if (item.variantIds && (!Array.isArray(item.variantIds) || !item.variantIds.every(id => typeof id === 'string'))) return false;
    if (item.discardVariantIds && (!Array.isArray(item.discardVariantIds) || item.discardVariantIds.length > 30 || !item.discardVariantIds.every(id => typeof id === 'string'))) return false;
    if (item.dependencies && (!Array.isArray(item.dependencies) || !item.dependencies.every(dep => dep && typeof dep.id === 'string' && typeof dep.fromRequestId === 'string' && typeof dep.fromPointer === 'string' && typeof dep.confirmed === 'boolean'))) return false;
    if (item.auth && !['required','fixture','none'].includes(item.auth)) return false;
    return ['name','resetUrl'].every(key => (item as unknown as Record<string, unknown>)[key] === undefined || typeof (item as unknown as Record<string, unknown>)[key] === 'string')
        && ['useAI','freshDataPerRun','baselineConfirmed','reconnect'].every(key => (item as unknown as Record<string, unknown>)[key] === undefined || typeof (item as unknown as Record<string, unknown>)[key] === 'boolean');
}

export function proposeVariants(journey: ScoutJourney): ScoutVariant[] {
    const last = journey.expectations[journey.expectations.length - 1];
    if (!last) return [];
    const result: ScoutVariant[] = [{ id: randomUUID(), name: 'Replay the taught journey', kind: 'baseline', source: 'observed', expectation: { ...last, confirmed: false }, outcome: 'proposed', evidence: [] }];
    for (const action of journey.actions.filter(item => item.kind === 'fill')) {
        if (action.value?.includes(REDACTED)) continue;
        const related = journey.requests.find(request => request.actionId === action.id || bodyBinding(request, action) !== undefined);
        if (!related) continue;
        const add = (kind: 'required' | 'boundary', name: string, value: string) => result.push({
            id: randomUUID(), name, source: 'observed', kind, actionId: action.id, value,
            expectation: { requestId: related.id, statuses: [400, 422], assertions: [], confirmed: false }, outcome: 'proposed', evidence: []
        });
        if (action.constraints?.required) add('required', `Leave ${action.label} empty`, '');
        if (action.constraints?.min !== undefined) add('boundary', `${action.label} below its minimum`, String(action.constraints.min - 1));
        if (action.constraints?.max !== undefined) add('boundary', `${action.label} above its maximum`, String(action.constraints.max + 1));
        if (result.length >= 10) break;
    }
    const lastWrite = [...journey.requests].reverse().find(request => !['GET', 'HEAD', 'OPTIONS'].includes(request.method));
    const lastClick = lastWrite && journey.actions.find(action => action.id === lastWrite.actionId && action.kind === 'click');
    if (lastWrite && lastClick) result.push({ id: randomUUID(), name: `Repeat ${lastClick.label}`, source: 'observed', kind: 'repeat', actionId: lastClick.id,
        expectation: { requestId: lastWrite.id, statuses: [409], assertions: [], confirmed: false }, outcome: 'proposed', evidence: [] });
    return result.slice(0, 12);
}

/** Unique bindings only. Ambiguous values must never silently mutate an unrelated request field. */
export function bodyBinding(request: ScoutRequest, action: ScoutAction): { target: 'body' | 'query'; pointer: string } | undefined {
    if (action.value === undefined) return undefined;
    const url = new URL(request.url);
    const fields = [...leaves(request.body).map(item => ({ ...item, target: 'body' as const })), ...[...url.searchParams.entries()].map(([pointer, value]) => ({ pointer, value, target: 'query' as const }))];
    const named = fields.filter(item => (item.pointer.split('/').pop() || '').toLowerCase() === (action.field || '').toLowerCase());
    const matches = named.length ? named : fields.filter(item => String(item.value) === action.value);
    return matches.length === 1 ? { target: matches[0].target, pointer: matches[0].pointer } : undefined;
}

export function matchesRequest(recorded: ScoutRequest, actual: ScoutRequest, dependencies: ScoutDependency[]): boolean {
    if (recorded.method !== actual.method) return false;
    const expected = new URL(recorded.url); const observed = new URL(actual.url);
    if (expected.origin !== observed.origin) return false;
    const dynamic = new Set(dependencies.filter(dep => dep.toRequestId === recorded.id && dep.target === 'path' && dep.confirmed).map(dep => Number(dep.toPointer.slice(1))));
    const left = expected.pathname.split('/'); const right = observed.pathname.split('/');
    return left.length === right.length && left.every((part, index) => dynamic.has(index) || part === right[index]);
}

export function assess(request: ScoutRequest, expectation: ScoutExpectation): { passed: boolean; message: string } {
    if (!request.response) return { passed: false, message: 'No complete response was captured.' };
    if (!expectation.statuses.includes(request.response.status)) return { passed: false, message: `Expected HTTP ${expectation.statuses.join(' or ')}; received ${request.response.status}.` };
    for (const assertion of expectation.assertions) {
        const actual = pointerGet(request.response.body, assertion.pointer);
        const passed = assertion.operator === 'present' ? actual !== undefined
            : assertion.operator === 'equals' ? isDeepStrictEqual(actual, assertion.value)
            : typeof actual === 'number' && typeof assertion.value === 'number' && (assertion.operator === 'at-most' ? actual <= assertion.value : actual >= assertion.value);
        if (!passed) return { passed: false, message: `${assertion.pointer || 'Response'} did not satisfy ${assertion.operator} ${JSON.stringify(assertion.value) ?? ''}.` };
    }
    return { passed: true, message: 'The confirmed expectations passed.' };
}

/** Sanitize payloads without confusing schema fields such as assertions with SAML credentials. */
export function journeyDocument(journey: ScoutJourney): ScoutJourney {
    const expectation = (item: ScoutExpectation): ScoutExpectation => ({ requestId: item.requestId, statuses: [...item.statuses], confirmed: item.confirmed,
        assertions: item.assertions.map(check => ({ pointer: check.pointer, operator: check.operator, value: sanitize(check.value) })) });
    return { ...journey, name: String(sanitize(journey.name)), connection: { ...journey.connection, executablePath: undefined, url: safeUrl(journey.connection.url) },
        requests: journey.requests.map(safeRequest), expectations: journey.expectations.map(expectation),
        actions: journey.actions.map(action => ({ id: action.id, timestamp: action.timestamp, kind: action.kind, url: safeUrl(action.url), selector: action.selector,
            label: String(sanitize(action.label)), value: action.value === undefined ? undefined : String(sanitize(action.value)), field: action.field, inputType: action.inputType, constraints: action.constraints })),
        variants: journey.variants.map(variant => ({ ...variant, name: String(sanitize(variant.name)), value: variant.value === undefined ? undefined : String(sanitize(variant.value)),
            message: variant.message === undefined ? undefined : String(sanitize(variant.message)), expectation: expectation(variant.expectation), evidence: variant.evidence.map(safeRequest) })) };
}

export function loadJourney(text: string): ScoutJourney {
    if (Buffer.byteLength(text) > 10 * 1024 * 1024) throw new Error('Journey exceeds the 10 MB limit.');
    const value = JSON.parse(text) as ScoutJourney;
    if (!value || value.schemaVersion !== 1 || typeof value.name !== 'string' || !Array.isArray(value.actions) || !Array.isArray(value.requests) || !Array.isArray(value.expectations) || !Array.isArray(value.variants)) throw new Error('Unsupported or invalid Scout journey document.');
    const connection = normalizeConnection(value.connection);
    delete connection.executablePath;
    connection.url = safeUrl(connection.url);
    if (value.requests.length > 300 || value.actions.length > 500 || !value.actions.every(validAction) || !value.expectations.every(validExpectation)) throw new Error('Journey contains invalid actions or expectations.');
    for (const request of value.requests) {
        if (!request || typeof request.id !== 'string' || typeof request.url !== 'string' || !Number.isFinite(request.timestamp) || !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(request.method) || !allowedUrl(request.url, connection)
            || request.response && (!Number.isInteger(request.response.status) || request.response.status < 100 || request.response.status > 599)) throw new Error('Journey contains an unsupported or out-of-scope request.');
    }
    const requests = value.requests.map(safeRequest);
    return { schemaVersion: 1, id: randomUUID(), name: value.name.slice(0, 150), createdAt: Date.now(), updatedAt: Date.now(), connection, origin: value.origin === 'har' ? 'har' : 'browser',
        actions: value.actions.filter(action => allowedUrl(action.url, connection)).map(action => ({ id: action.id, timestamp: action.timestamp, kind: action.kind, url: safeUrl(action.url), selector: action.selector, label: String(sanitize(action.label)), value: action.value === undefined ? undefined : String(sanitize(action.value)), field: action.field, inputType: action.inputType, constraints: action.constraints })), requests, dependencies: inferDependencies(requests),
        expectations: value.expectations.filter(item => requests.some(request => request.id === item.requestId)).map(item => ({ ...item, confirmed: false })),
        variants: value.variants.slice(0, 20).filter(item => item && typeof item.id === 'string' && typeof item.name === 'string' && ['baseline','required','boundary','repeat'].includes(item.kind)
            && validExpectation(item.expectation) && requests.some(request => request.id === item.expectation.requestId)
            && (item.kind === 'baseline' || value.actions.some(action => action.id === item.actionId))
            && (item.value === undefined || typeof item.value === 'string' && item.value.length <= 4096))
            .map(item => ({ id: item.id, name: String(sanitize(item.name)).slice(0, 150), kind: item.kind, source: 'manual', actionId: item.actionId,
                value: item.value === undefined ? undefined : String(sanitize(item.value)), expectation: { ...item.expectation, confirmed: false }, outcome: 'proposed', evidence: [] })),
        baselineConfirmed: false, freshDataPerRun: false, verification: { auth: 'required' } };
}
