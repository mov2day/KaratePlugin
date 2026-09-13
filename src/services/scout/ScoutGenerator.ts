import { ScoutAction, ScoutAssertion, ScoutJourney, ScoutRequest, ScoutVariant } from './types';
import { bodyBinding } from './JourneyModel';
import { REDACTED } from './privacy';

export interface ScoutSuite { files: Record<string, string>; runnableScenarios: number; draftReasons: string[] }
const quote = (value: unknown) => JSON.stringify(value);
const lineText = (value: string) => value.replace(/[\r\n]/g, ' ').slice(0, 180);
const access = (root: string, pointer: string) => root + (pointer ? pointer.slice(1).split('/').map(part => `[${quote(part.replace(/~1/g, '/').replace(/~0/g, '~'))}]`).join('') : '');

export function generateScoutSuite(journey: ScoutJourney): ScoutSuite {
    if (!journey.requests.length) throw new Error('Capture at least one API request before generating a suite.');
    const origins = [...new Set(journey.requests.map(request => new URL(request.url).origin))];
    const originNames = new Map(origins.map((origin, index) => [origin, index === 0 ? 'app' : `api${index + 1}`]));
    const draftReasons: string[] = [];
    if (!journey.baselineConfirmed || journey.expectations.some(item => !item.confirmed)) draftReasons.push('Baseline expectations need confirmation.');
    if (journey.dependencies.some(item => !item.confirmed)) draftReasons.push('Ambiguous data links need confirmation.');
    if (journey.requests.some(request => !request.response || request.incomplete)) draftReasons.push('Some requests or responses are incomplete.');
    if (JSON.stringify(journey.requests).includes(REDACTED)) draftReasons.push('Redacted inputs need replacement in scout-data.json.');
    const data = journey.requests.map(request => {
        const url = new URL(request.url);
        const query: Record<string, string | string[]> = {};
        for (const key of new Set(url.searchParams.keys())) { const values = url.searchParams.getAll(key); query[key] = values.length === 1 ? values[0] : values; }
        return { path: url.pathname.split('/').slice(1).map(part => decodeURIComponent(part)), query, headers: request.headers, body: request.body };
    });
    const unsafeWrites = journey.requests.some(request => !['GET','HEAD','OPTIONS'].includes(request.method)) && !journey.resetUrl && !journey.freshDataPerRun;
    if (unsafeWrites) draftReasons.push('State-changing journeys need a reset or fresh data per scenario.');
    const lines = [
        '@scout', `Feature: ${lineText(journey.name)}`, '', 'Background:',
        "  * def scoutSetup = call read('scout-setup.feature')",
        "  * def scoutData = JSON.parse(karate.readAsString('scout-data.json'))",
        "  * def scoutEqual = read('scout-equal.js')",
        `  * if (JSON.stringify(scoutData).indexOf(${quote(REDACTED)}) !== -1) karate.fail('Replace redacted inputs in scout-data.json before running')`,
        "  * configure headers = scoutSetup.headers",
        "  * call read('scout-reset.feature')", ''
    ];
    const requestNames = new Map(journey.requests.map((request, index) => [request.id, `response_${index + 1}`]));
    let runnableScenarios = 0;
    const writeRequest = (request: ScoutRequest, index: number, variant?: ScoutVariant, repeated = false) => {
        const url = new URL(request.url);
        const row = `scoutData[${index}]`;
        lines.push(`  # ${lineText(request.method + ' ' + url.pathname)}${repeated ? ' (repeat)' : ''}`,
            `  * copy scoutPath = ${row}.path`, `  * copy scoutQuery = ${row}.query`, `  * def scoutBody = ${row}.body === undefined ? null : JSON.parse(JSON.stringify(${row}.body))`);
        for (const dep of journey.dependencies.filter(item => item.toRequestId === request.id && item.confirmed)) {
            const source = access(requestNames.get(dep.fromRequestId)!, dep.fromPointer);
            const target = dep.target === 'body' ? access('scoutBody', dep.toPointer) : dep.target === 'query' ? `scoutQuery[${quote(dep.toPointer)}]` : `scoutPath[${Number(dep.toPointer.slice(1)) - 1}]`;
            lines.push(`  * eval ${target} = ${source}`);
        }
        if (variant?.actionId && variant.value !== undefined) {
            const action = journey.actions.find(item => item.id === variant.actionId)!;
            const binding = bodyBinding(request, action);
            if (binding && variant.expectation.requestId === request.id) {
                const target = binding.target === 'body' ? access('scoutBody', binding.pointer) : `scoutQuery[${quote(binding.pointer)}]`;
                const value = action.inputType === 'number' && variant.value !== '' && Number.isFinite(Number(variant.value)) ? Number(variant.value) : variant.value;
                lines.push(`  * eval ${target} = ${quote(value)}`);
            }
        }
        lines.push(`  Given url scoutSetup.origins[${quote(originNames.get(url.origin))}]`, '  And path scoutPath', '  And params scoutQuery', `  And headers ${row}.headers`, '  And cookies scoutSetup.cookies');
        if (request.body !== undefined) lines.push('  And request scoutBody');
        lines.push(`  When method ${request.method.toLowerCase()}`);
        const override = variant && variant.expectation.requestId === request.id && (variant.kind !== 'repeat' || repeated) ? variant.expectation : undefined;
        const expectation = override || journey.expectations.find(item => item.requestId === request.id);
        if (expectation) {
            lines.push(`  Then assert ${quote(expectation.statuses)}.indexOf(responseStatus) !== -1`);
            for (const assertion of expectation.assertions) lines.push(...assertionLines(assertion));
        }
        lines.push(`  * def ${requestNames.get(request.id)} = response`, '');
    };
    const writeScenario = (name: string, variant?: ScoutVariant) => {
        const reasons = [...draftReasons];
        if (variant && !variant.expectation.confirmed) reasons.push('Variation expectation needs confirmation.');
        if (variant?.actionId && variant.value !== undefined) {
            const request = journey.requests.find(item => item.id === variant.expectation.requestId)!;
            const action = journey.actions.find(item => item.id === variant.actionId) as ScoutAction;
            if (!action || !bodyBinding(request, action)) reasons.push('The browser field does not have a unique API binding.');
        }
        if (reasons.length) lines.push('  @ignore', ...reasons.map(reason => `  # Draft: ${reason}`)); else runnableScenarios++;
        lines.push(`Scenario: ${lineText(name)}`);
        for (let index = 0; index < journey.requests.length; index++) {
            const request = journey.requests[index];
            writeRequest(request, index, variant);
            if (variant?.kind === 'repeat' && request.actionId === variant.actionId) writeRequest(request, index, variant, true);
            if (variant && ['required','boundary'].includes(variant.kind) && variant.expectation.requestId === request.id) break;
        }
    };
    writeScenario('The taught journey');
    for (const variant of journey.variants.filter(item => item.kind !== 'baseline')) writeScenario(variant.name, variant);

    const defaultOrigins = Object.fromEntries(origins.map(origin => [originNames.get(origin)!, origin]));
    const setup = [
        '@ignore', 'Feature: Scout environment and authentication', 'Scenario:',
        `  * def defaults = ${quote(defaultOrigins)}`,
        "  * def configuredOrigin = karate.properties['scout.baseUrl']",
        "  * if (configuredOrigin) defaults.app = configuredOrigin",
        "  * def authFixture = karate.properties['scout.authFixture']",
        ...(journey.verification.auth !== 'none' ? ["  * if (!authFixture) karate.fail('Authentication setup required: provide -Dscout.authFixture=classpath:your-auth.feature; browser sign-in is not copied')"] : []),
        '  * def auth = authFixture ? karate.call(authFixture) : {}',
        '  * def origins = auth.origins || defaults', '  * def headers = auth.headers || {}', '  * def cookies = auth.cookies || {}', ''
    ].join('\n');
    const reset = ['@ignore', 'Feature: Fresh data for every Scout scenario', 'Scenario:', "  * def resetFixture = karate.properties['scout.resetFixture']"];
    if (journey.resetUrl) {
        const resetUrl = new URL(journey.resetUrl);
        const origin = originNames.get(resetUrl.origin);
        if (!origin) throw new Error('The reset URL must use an origin present in the captured API requests.');
        reset.push('  * if (resetFixture) karate.call(resetFixture)', '  * if (resetFixture) karate.abort()',
            `  Given url scoutSetup.origins[${quote(origin)}]`, `  And path ${quote(resetUrl.pathname.split('/').slice(1))}`,
            `  And params ${quote(Object.fromEntries(resetUrl.searchParams))}`, '  And cookies scoutSetup.cookies', '  When method get', '  Then status 200');
    } else reset.push('  * if (resetFixture) karate.call(resetFixture)', ...(unsafeWrites ? ["  * if (!resetFixture) karate.fail('Configure a reset fixture or fresh data before running this journey')"] : []));

    return { runnableScenarios, draftReasons, files: {
        'journey.feature': lines.join('\n') + '\n', 'scout-setup.feature': setup, 'scout-reset.feature': reset.join('\n') + '\n',
        'scout-data.json': JSON.stringify(data, null, 2) + '\n',
        'scout-equal.js': 'function equal(a, b) { if (a === b) return true; if (a === null || b === null || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false; var keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(function(key) { return Object.prototype.hasOwnProperty.call(b, key) && equal(a[key], b[key]); }); }\n',
        'README.md': `# ${lineText(journey.name)}\n\nGenerated by Karate Scout. Browser verification and Karate execution are separate.\n\n## Run\n\nOpen journey.feature and use Karate: Run Feature. Set scout.baseUrl to change the primary API origin.\n\nFor SSO-backed applications, supply scout.authFixture with a supported authentication helper. It must return headers and/or cookies; optionally return an origins map to target another environment. Browser sessions are never copied into this suite.\n\nThe reset helper runs before every scenario. You can replace it with scout.resetFixture.\n\n${draftReasons.length ? '## Draft requirements\n\n' + draftReasons.map(reason => '- ' + reason).join('\n') : 'All exported scenarios with confirmed expectations are enabled.'}\n\nReview expected behavior and test data before running against your test environment. Verification labels in the plugin are awarded only after actual execution.\n`
    } };
}

function assertionLines(assertion: ScoutAssertion): string[] {
    const expression = access('response', assertion.pointer);
    if (assertion.operator === 'present') return [`  Then match ${expression} == '#present'`];
    if (assertion.operator === 'equals') return [`  Then assert scoutEqual(${expression}, ${quote(assertion.value)})`];
    return [`  Then assert ${expression} ${assertion.operator === 'at-most' ? '<=' : '>='} ${quote(assertion.value)}`];
}
