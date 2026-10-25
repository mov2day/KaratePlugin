const assert = require('node:assert/strict');
const fs = require('fs');
const yaml = require('js-yaml');
const { fixture } = require('./support/golden.cjs');

const out = rel => require('../../out/' + rel);
const cfgMod = () => out('generation/config/GeneratorConfig');
const config = () => JSON.parse(JSON.stringify(cfgMod().DEFAULT_GENERATOR_CONFIG));
const exploratory = () => { const c = config(); c.scenarios.exploratory = true; return c; };
const load = name => yaml.load(fs.readFileSync(fixture('openapi', name), 'utf8'));
const model = name => out('generation/adapters/openapi').buildOpenApiModel(load(name), name);
const planOf = m => out('generation/plan/OpenApiPlanner').planOpenApi(m, exploratory());
const authFeature = m => {
    const files = out('generation/scaffold/ProjectScaffolder').planScaffold({
        project: { classpathRoot: 'cp', envConfigs: [], hasEnvJson: false, runnerStyle: 'unknown' }, config: config(), model: m
    });
    return files.find(f => f.path === 'cp/common/auth.feature').content;
};
const scenarios = planned => planned.features.flatMap(f => f.feature.scenarios);
const bySource = (planned, source) => scenarios(planned).filter(s => s.source === source);
const stepTexts = s => s.steps.map(x => x.text);
const scheme = (m, n) => m.schemes.find(s => s.name === n);
const op = (m, id) => m.operations.find(o => o.id === id);
const unsupportedFor = (m, name) => m.unsupported.find(u => u.sourceRef === `securityScheme:${name}`);

module.exports = [
    {
        name: 'auth: OAS 3.0 schemes resolve $refs, normalise apiKey.in and flag unsupported or unknown ones',
        run() {
            const m = model('auth-multi-30.yaml');
            assert.deepEqual(scheme(m, 'refQuery'), { name: 'refQuery', kind: 'apiKey', in: 'query', paramName: 'api_key' });
            assert.equal(scheme(m, 'cookieKey').in, 'cookie');
            assert.match(unsupportedFor(m, 'badIn').reason, /invalid "in"/);
            assert.equal(scheme(m, 'badIn').in, undefined);
            assert.match(unsupportedFor(m, 'mtls').reason, /mutualTLS is not supported/);
            assert.match(unsupportedFor(m, 'digestAuth').reason, /http scheme "digest"/);
            assert.ok(!scheme(m, 'mtls') && !scheme(m, 'digestAuth'));
            assert.match(unsupportedFor(m, 'ghostScheme').reason, /GET \/ghost references security scheme "ghostScheme"/);
            assert.deepEqual(scheme(m, 'pwFlow'), { name: 'pwFlow', kind: 'oauth2', flow: 'password', tokenUrl: 'https://idp.example.com/token', scopes: ['read', 'write'] });
            assert.equal(scheme(m, 'oidc').openIdConnectUrl, 'https://idp.example.com/.well-known/openid-configuration');
            assert.equal(op(m, 'optionalOp').optionalAuth, true);
            assert.deepEqual(op(m, 'optionalOp').security, ['bearerAuth']);
            assert.equal(op(m, 'listItems').optionalAuth, undefined);
        }
    },
    {
        name: 'auth: the primary scheme is the most used one, not the first declared; others stay listed',
        run() {
            const m = model('auth-multi-30.yaml');
            const { planAuth, schemeUsage } = out('generation/plan/AuthSchemes');
            assert.equal(schemeUsage(m.operations).get('bearerAuth'), 3);
            const plan = planAuth(m.schemes, m.operations);
            assert.equal(plan.primary.name, 'bearerAuth');
            assert.equal(planAuth(m.schemes).primary.name, 'basicAuth', 'no usage info keeps declaration order');
            assert.deepEqual(plan.unsupported.map(s => s.name).sort(), ['basicAuth', 'oidc', 'pwFlow']);
            const a = authFeature(m);
            assert.match(a, /^# Configures: bearerAuth(, [^;\n]+)?; per-scenario step needed: refQuery, cookieKey$/m);
            assert.match(a, /\* configure auth = \{ type: 'bearer'/);
            assert.match(a, /# Cannot configure basicAuth: Karate v2 applies a single auth scheme/);
        }
    },
    {
        name: 'auth: optional auth skips the 401 and empty-credential probes; secured operations keep them',
        run() {
            const planned = planOf(model('auth-multi-30.yaml'));
            const names = src => bySource(planned, src).map(s => s.name);
            assert.ok(!names('GET /optional').some(n => /401|unauthenticated|empty credentials/.test(n)), names('GET /optional').join('|'));
            assert.ok(names('GET /optional').some(n => !/401/.test(n)), 'positive scenario still generated');
            assert.ok(names('GET /items').some(n => /unauthenticated request with 401/.test(n)));
            assert.ok(names('GET /items').some(n => /empty credentials/.test(n)));
        }
    },
    {
        name: 'auth: planner warns for unsupported schemes, unknown references and drafts operations it cannot authenticate',
        run() {
            const planned = planOf(model('auth-multi-30.yaml'));
            const w = planned.warnings.join('\n');
            assert.match(w, /Security scheme "mtls": mutualTLS is not supported/);
            assert.match(w, /Security scheme "digestAuth"/);
            assert.match(w, /Security scheme "ghostScheme"/);
            assert.match(w, /Security scheme "badIn": apiKey scheme has an invalid "in"/);
            const draft = src => bySource(planned, src).find(s => s.category === 'positive').draftReason;
            assert.match(draft('GET /tls'), /Requires mtls/);
            assert.match(draft('GET /ghost'), /Requires ghostScheme/);
            assert.equal(draft('GET /items'), undefined);
            // ghostScheme is not declared: no arbitrary scheme is picked, so no 403/empty-credential probe is invented
            assert.ok(!bySource(planned, 'GET /ghost').some(s => /empty credentials|403/.test(s.name)));
        }
    },
    {
        name: 'auth: OAS 3.1 global optional auth, $ref scheme, apiKey.in case, empty tokenUrl and openIdConnect',
        run() {
            const m = model('auth-multi-31.yaml');
            assert.equal(scheme(m, 'headerKey').in, 'header');
            assert.equal(scheme(m, 'bearerRef').kind, 'bearer');
            assert.match(unsupportedFor(m, 'mtls').reason, /mutualTLS/);
            assert.equal(op(m, 'listThings').optionalAuth, true, 'global {} alternative');
            assert.equal(op(m, 'secureThing').optionalAuth, undefined);
            const planned = planOf(m);
            assert.ok(!bySource(planned, 'GET /things').some(s => /401|empty credentials/.test(s.name)));
            assert.ok(bySource(planned, 'GET /secure').some(s => /401/.test(s.name)));
            assert.match(planned.warnings.join('\n'), /Security scheme "emptyToken": oauth2 has no tokenUrl/);
            const a = authFeature(m);
            assert.match(a, /^# Configures: bearerRef, headerKey$/m);
            assert.match(a, /\* configure headers = \{ 'X-API-Key': '#\(apiKey\)' \}/);
            // oidc is only a candidate, so make it primary to check the comment
            const oidcOnly = { ...m, schemes: m.schemes.filter(s => s.name === 'oidc'), operations: [] };
            assert.match(authFeature(oidcOnly), /# openIdConnect \(https:\/\/idp\.example\.com\/\.well-known\/openid-configuration\): obtain an access token from the provider and set API_TOKEN/);
            const emptyOnly = { ...m, schemes: m.schemes.filter(s => s.name === 'emptyToken'), operations: [] };
            const e = authFeature(emptyOnly);
            assert.match(e, /# WARNING: the spec declares no tokenUrl/);
            assert.match(e, /\* def tokenUrl = karate\.sysenv\('API_TOKEN_URL', ''\)/);
            assert.doesNotMatch(e, /tokenUrl: ''/);
        }
    },
    {
        name: 'auth: Swagger 2 picks the password-flow scheme by use, passes scopes, and explains authorizationCode/implicit',
        run() {
            const m = model('auth-multi-20.yaml');
            assert.equal(scheme(m, 'keyAuth').in, 'header');
            assert.deepEqual(scheme(m, 'pwFlow').scopes, ['read', 'write']);
            const { planAuth, requiredSecrets, unsupportedReason } = out('generation/plan/AuthSchemes');
            const plan = planAuth(m.schemes, m.operations);
            assert.equal(plan.primary.name, 'pwFlow');
            assert.deepEqual(requiredSecrets(plan), ['API_CLIENT_ID', 'API_CLIENT_SECRET', 'API_USERNAME', 'API_PASSWORD', 'API_KEY']);
            assert.match(unsupportedReason(scheme(m, 'implicitFlow')), /implicit flow needs an interactive browser login.*API_TOKEN/);
            const a = authFeature(m);
            assert.match(a, /Password flow: API_USERNAME and API_PASSWORD/);
            assert.match(a, /\* def scope = karate\.sysenv\('API_SCOPE', 'read write'\)/);
            assert.match(a, /\* url 'https:\/\/idp\.example\.com\/token'/);
            assert.match(a, /\* form field grant_type = 'password'/);
            assert.match(a, /\* form field scope = scope/);
            assert.match(a, /\* configure auth = \{ type: 'bearer', token: '#\(token\)' \}/);
            assert.match(a, /^# Configures: pwFlow, keyAuth$/m);
            assert.match(a, /# Cannot configure basicAuth/);
            assert.match(a, /# Cannot configure implicitFlow: oauth2 implicit flow/);
        }
    },
    {
        name: 'auth: client-credentials scopes are passed to configure auth; no scopes keeps the original line',
        run() {
            const m = model('auth-multi-31.yaml');
            const cc = (extra, tokenUrl = 'https://t') => ({ ...m, operations: [], schemes: [{ name: 'cc', kind: 'oauth2', flow: 'clientCredentials', tokenUrl, ...extra }] });
            assert.match(authFeature(cc({ scopes: ['a', 'b'] })), /\* configure auth = \{ type: 'oauth2', tokenUrl: 'https:\/\/t', clientId: '#\(clientId\)', clientSecret: '#\(clientSecret\)', scope: '#\(scope\)' \}/);
            assert.match(authFeature(cc({})), /\* configure auth = \{ type: 'oauth2', tokenUrl: 'https:\/\/t', clientId: '#\(clientId\)', clientSecret: '#\(clientSecret\)' \}/);
        }
    },
    {
        name: 'auth: credential steps follow the scheme (Bearer, Basic, raw apiKey) and quote parameter names',
        run() {
            const resp = { '200': { description: 'ok' }, '403': { description: 'no' } };
            const api = {
                openapi: '3.0.0',
                components: { securitySchemes: {
                    b: { type: 'http', scheme: 'bearer' }, ba: { type: 'http', scheme: 'basic' },
                    q: { type: 'apiKey', in: 'query', name: 'api key' }, c: { type: 'apiKey', in: 'cookie', name: 'my session' },
                    o: { type: 'openIdConnect', openIdConnectUrl: 'https://x/.well-known' }
                } },
                paths: Object.fromEntries(['b', 'ba', 'q', 'c', 'o'].map(n => [`/${n}`, { get: { operationId: `op${n}`, security: [{ [n]: [] }], responses: resp } }]))
            };
            const m = out('generation/adapters/openapi').buildOpenApiModel(api, 'creds');
            // each scheme used once: declaration order makes b primary; q and c are query/cookie keys, ba and o are unconfigured but still named
            const planned = planOf(m);
            const forbidden = src => stepTexts(bySource(planned, src).find(s => /403/.test(s.name)));
            const empty = src => stepTexts(bySource(planned, src).find(s => /empty credentials/.test(s.name)));
            assert.ok(forbidden('GET /b').includes("header Authorization = 'Bearer ' + token"));
            assert.ok(forbidden('GET /ba').includes("header Authorization = 'Basic ' + token"));
            assert.ok(forbidden('GET /o').includes("header Authorization = 'Bearer ' + token"));
            assert.ok(forbidden('GET /q').includes("param 'api key' = token"));
            assert.ok(forbidden('GET /c').includes("cookie 'my session' = token"));
            assert.ok(empty('GET /b').includes("header Authorization = ''"));
            assert.ok(empty('GET /ba').includes("header Authorization = ''"));
            assert.ok(empty('GET /q').includes("param 'api key' = ''"));
        }
    },
    {
        name: 'auth: GraphQL auth hint declares schemes, secures operations and calls auth.feature; no hint is unchanged',
        run() {
            const adapter = out('generation/adapters/graphql');
            const schema = new (out('services/graphql/GraphQLParser').GraphQLParser)().parseSDL('type Query { ping: String! }');
            const render = p => p.features.map(f => out('generation/render/FeatureRenderer').renderFeature(f.feature, { style: config().style })).join('\n');
            const base = adapter.buildGraphQLPlan(schema, { config: config(), name: 'Api' });
            assert.deepEqual(base.model.schemes, []);
            assert.equal(base.model.operations[0].security, 'none');
            assert.doesNotMatch(render(base), /auth\.feature/);
            const same = adapter.buildGraphQLPlan(schema, { config: config(), name: 'Api', auth: undefined });
            assert.equal(render(same), render(base));
            for (const [auth, expected] of [
                [{ type: 'bearer' }, { name: 'bearer', kind: 'bearer' }],
                [{ type: 'basic' }, { name: 'basic', kind: 'basic' }],
                [{ type: 'apiKey', header: 'X-Gql-Key' }, { name: 'apiKey', kind: 'apiKey', in: 'header', paramName: 'X-Gql-Key' }]
            ]) {
                const p = adapter.buildGraphQLPlan(schema, { config: config(), name: 'Api', auth });
                assert.deepEqual(p.model.schemes, [expected]);
                assert.deepEqual(p.model.operations[0].security, [expected.name]);
                assert.match(render(p), /\* call read\('classpath:common\/auth\.feature'\)/);
                assert.match(authFeature(p.model), new RegExp(`# Configures: ${expected.name}$`, 'm'));
            }
        }
    },
    {
        name: 'auth: Postman primary scheme follows request usage; HAR classifies API key headers',
        run() {
            const pm = out('generation/adapters/postman');
            const item = (name, auth) => ({ name, request: { method: 'GET', header: [], auth, url: { raw: `{{baseUrl}}/${name}`, host: ['{{baseUrl}}'], path: [name] } } });
            const basic = { type: 'basic', basic: [{ key: 'username', value: 'u' }, { key: 'password', value: 'p' }] };
            const bearer = { type: 'bearer', bearer: [{ key: 'token', value: 't' }] };
            const col = { info: { name: 'C', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, variable: [{ key: 'baseUrl', value: 'https://x.test' }], item: [item('a', basic), item('b', bearer), item('c', bearer)] };
            const built = pm.buildPostmanModel(col, undefined, { config: config(), collectionName: 'C' });
            assert.deepEqual(built.model.schemes.map(s => s.name), ['basic', 'bearer']);
            assert.deepEqual(built.model.operations.map(o => o.security), [['basic'], ['bearer'], ['bearer']]);
            assert.deepEqual(built.unsupported.map(u => u.sourceRef), ['auth:basic']);
            assert.match(authFeature(built.model), /^# Configures: bearer$/m);
        }
    }
];
