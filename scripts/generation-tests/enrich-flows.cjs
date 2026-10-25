// Business-enrich context for GraphQL, Postman and HAR models, and the GraphQL command's AI switch.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const out = rel => require('../../out/' + rel);
const ctx = () => out('generation/ai/BusinessContext');
const cfgMod = () => out('generation/config/GeneratorConfig');
const config = () => JSON.parse(JSON.stringify(cfgMod().DEFAULT_GENERATOR_CONFIG));
const contextOf = model => ctx().buildBusinessContext(model)[0].text;

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl';
const BEARER = 'Bearer abcdef0123456789zz';

// ---- GraphQL
const SDL = `
"A book in the catalogue"
type Book {
  id: ID!
  "Current lifecycle state"
  status: Status!
  title: String!
}
"Where a book is in the lending cycle"
enum Status { AVAILABLE LOANED LOST }
input NewBook { title: String! status: Status }
type Query {
  "Fetch one book by id. Unknown ids return null."
  book(
    "The book id"
    id: ID!
  ): Book
  books("Only books in this state" status: Status): [Book!]!
}
type Mutation {
  """Add a book. Titles are not unique."""
  addBook(input: NewBook!): Book!
}
`;
const gqlPlan = (sdl = SDL) => {
    const parser = new (out('services/graphql/GraphQLParser').GraphQLParser)();
    return out('generation/adapters/graphql').buildGraphQLPlan(parser.parseSDL(sdl), { config: config(), name: 'Library' });
};

// ---- Postman
const pmReq = (name, method, p, o = {}) => ({
    name,
    ...(o.tests ? { event: [{ listen: 'test', script: { type: 'text/javascript', exec: o.tests } }] } : {}),
    ...(o.response ? { response: o.response } : {}),
    request: { method, header: o.header ?? [], description: o.description, url: { raw: `{{baseUrl}}${p}`, host: ['{{baseUrl}}'], path: p.split('/').filter(Boolean) } }
});
const collection = () => ({
    info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    variable: [{ key: 'baseUrl', value: 'https://api.example.test' }],
    item: [{
        name: 'Order management',
        item: [
            pmReq('Cancel order', 'DELETE', '/orders/1', {
                description: 'Cancels an order. A shipped order cannot be cancelled. password: hunter2secret',
                tests: [
                    'pm.test("Cancelling a shipped order is refused", function () { pm.response.to.have.status(409); });',
                    `pm.test("sends ${BEARER}", function () { pm.expect(1).to.eql(1); });`,
                    `pm.environment.set("sessionToken", "${JWT}");`
                ],
                response: [{ name: 'Order already shipped', code: 409, header: [{ key: 'Content-Type', value: 'application/json' }], body: '{"message":"order already shipped"}' }]
            })
        ]
    }]
});

// ---- HAR
let seq = 0;
const call = (method, url, o = {}) => {
    const u = new URL(url);
    const respBody = o.json !== undefined ? JSON.stringify(o.json) : undefined;
    return {
        id: `r${++seq}`, timestamp: 1000 + seq, method, url, path: u.pathname + u.search, host: u.host,
        headers: { ...(o.headers ?? {}) },
        ...(o.body !== undefined ? { body: o.body } : {}),
        response: { status: o.status ?? 200, headers: { 'content-type': 'application/json' }, body: respBody, duration: 5 }
    };
};
const harBuild = () => out('generation/adapters/har').buildHarModel([
    call('POST', 'https://shop.test/api/orders', { status: 201, headers: { Authorization: BEARER, 'Content-Type': 'application/json', 'X-Api-Key': 'key-lit-789', Cookie: 'sid=sess-lit-456' }, body: JSON.stringify({ sku: 'ABC-1', quantity: 2 }), json: { id: 'ord-1001', status: 'NEW' } }),
    call('GET', 'https://shop.test/api/orders/ord-1001', { headers: { Authorization: BEARER }, json: { id: 'ord-1001', status: 'NEW' } })
], { config: config(), name: 'Order journey', mode: 'har', sourceRef: 'journey.har' });

module.exports = [
    // GraphQL
    { name: 'enrich-flows: graphql model carries field, argument and type descriptions', run() {
        const model = gqlPlan().model;
        const book = model.operations.find(o => o.id === 'query-book');
        assert.equal(book.summary, 'Query book');
        assert.match(book.description, /Fetch one book by id\. Unknown ids return null\./);
        assert.match(book.description, /Argument id: The book id/);
        assert.match(book.description, /Returns Book: A book in the catalogue/);
        assert.match(book.description, /Field status: Current lifecycle state/);
        const add = model.operations.find(o => o.id === 'mutation-addbook' || o.id === 'mutation-addBook');
        assert.match(add.description, /Add a book\. Titles are not unique\./);
    } },
    { name: 'enrich-flows: graphql context lists enum values from arguments, input objects and return types', run() {
        const text = contextOf(gqlPlan().model);
        assert.match(text, /Fetch one book by id/);
        assert.match(text, /state field request variables\.status: AVAILABLE, LOANED, LOST|enum request variables\.status: AVAILABLE, LOANED, LOST/);
        assert.match(text, /request variables\.input\.status: AVAILABLE, LOANED, LOST/);
        assert.match(text, /response data\.book\.status: AVAILABLE, LOANED, LOST/);
        assert.match(text, /response data\.books\[\]\.status: AVAILABLE, LOANED, LOST/);
    } },
    { name: 'enrich-flows: graphql introspection descriptions reach the model too', run() {
        const intro = { data: { __schema: { queryType: { name: 'Query' }, mutationType: null, subscriptionType: null, types: [
            { kind: 'OBJECT', name: 'Query', description: null, fields: [{ name: 'ping', description: 'Health probe, always true', isDeprecated: false, args: [{ name: 'verbose', description: 'Adds details', defaultValue: null, type: { kind: 'SCALAR', name: 'Boolean', ofType: null } }], type: { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'Boolean', ofType: null } } }] },
            { kind: 'SCALAR', name: 'Boolean', description: null, fields: null, enumValues: null }
        ] } } };
        const schema = new (out('services/graphql/GraphQLParser').GraphQLParser)().parse(JSON.stringify(intro));
        const m = out('generation/adapters/graphql').buildGraphQLPlan(schema, { config: config(), name: 'Ping' }).model;
        assert.match(m.operations[0].description, /Health probe, always true/);
        assert.match(m.operations[0].description, /Argument verbose: Adds details/);
    } },
    { name: 'enrich-flows: graphql descriptions never render into the feature text', run() {
        const plan = gqlPlan();
        const text = plan.features.map(f => out('generation/render/FeatureRenderer').renderFeature(f.feature, { style: config().style })).join('\n');
        assert.doesNotMatch(text, /Unknown ids return null|Current lifecycle state|Titles are not unique/);
    } },
    { name: 'enrich-flows: a credential in a graphql description is redacted in the context', run() {
        const m = gqlPlan(SDL.replace('Unknown ids return null.', `Send header Authorization: ${BEARER} and use ${JWT}`)).model;
        const text = contextOf(m);
        assert.doesNotMatch(text, /abcdef0123456789zz/);
        assert.ok(!text.includes(JWT));
        assert.ok(!JSON.stringify(m).includes(JWT));
    } },
    { name: 'enrich-flows: graphql scenarios survive AI enrich with errors == #notpresent and a marked proposal', async run() {
        const plan = gqlPlan();
        const render = out('generation/render/FeatureRenderer').renderFeature;
        const feature = plan.features.map(f => render(f.feature, { style: config().style }))[0];
        assert.match(feature, /errors == '#notpresent'/);
        const proposal = ['', '# AI-proposed: book status comes from the Status enum', 'Scenario: books can be filtered by a declared status', "  Given path 'graphql'", '  And text query = """', '  query { books(status: AVAILABLE) { id } }', '  """', "  And request { query: '#(query)' }", '  When method post', '  Then status 200', "  And match response.errors == '#notpresent'", ''].join('\n');
        const { loadSkillPack } = out('generation/ai/SkillPack');
        const fsApi = { exists: p => fs.existsSync(p), read: p => fs.readFileSync(p, 'utf8'), list: d => fs.readdirSync(d) };
        const skills = loadSkillPack(path.resolve(__dirname, '..', '..', 'skills'), fsApi);
        const base = { feature, mode: 'graphql', task: 'enrich-business', evidence: [{ label: 'business-context', text: contextOf(plan.model) }], skills, knownFiles: new Set(), config: config() };
        const ok = await out('generation/ai/AiRefiner').refine({ ...base, ai: async () => feature + proposal });
        assert.equal(ok.status, 'refined', JSON.stringify(ok.findings));
        assert.match(ok.text, /errors == '#notpresent'/);
        // dropping the errors assertion of an existing scenario is not caught by the guards, but dropping a scenario is
        const dropped = feature.split('\n').slice(0, feature.split('\n').findIndex(l => /^\s*Scenario:/.test(l))).join('\n');
        const bad = await out('generation/ai/AiRefiner').refine({ ...base, ai: async () => dropped });
        assert.equal(bad.status, 'rejected');
        assert.ok(bad.findings.some(f => f.ruleId === 'V2-AI-002'));
    } },
    { name: 'enrich-flows: graphql command honors karateDsl.useCopilot instead of a hardcoded false', run() {
        const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'commands', 'generateFromGraphQL.ts'), 'utf8');
        assert.doesNotMatch(src, /useAi:\s*false/);
        assert.match(src, /getConfiguration\('karateDsl'\)\.get<boolean>\('useCopilot', false\)/);
        assert.match(src, /mode: 'graphql', useAi,/);
        const openapi = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'commands', 'generateFromOpenAPI.ts'), 'utf8');
        assert.match(openapi, /getConfiguration\('karateDsl'\)\.get<boolean>\('useCopilot', false\)/);
    } },
    // Postman
    { name: 'enrich-flows: postman context has folder, request description, test titles and saved example names', run() {
        const built = out('generation/adapters/postman').buildPostmanModel(collection(), null, { config: config(), collectionName: 'Shop' });
        const op = built.model.operations[0];
        assert.deepEqual(op.tags, ['order-management']);
        const text = contextOf(built.model);
        assert.match(text, /\[order-management\]/);
        assert.match(text, /Folder: Order management/);
        assert.match(text, /A shipped order cannot be cancelled/);
        assert.match(text, /Checks: Cancelling a shipped order is refused/);
        assert.match(text, /Saved examples: 409 Order already shipped/);
        assert.match(text, /409/);
    } },
    { name: 'enrich-flows: credentials in a postman script, description or test title never reach the context or the model', run() {
        const built = out('generation/adapters/postman').buildPostmanModel(collection(), null, { config: config(), collectionName: 'Shop' });
        const text = contextOf(built.model);
        for (const secret of ['hunter2secret', 'abcdef0123456789zz', JWT, 'c2lnbmF0dXJl']) {
            assert.ok(!text.includes(secret), `context leaks ${secret}`);
            assert.ok(!JSON.stringify(built.model).includes(secret), `model leaks ${secret}`);
        }
    } },
    { name: 'enrich-flows: postman descriptions are model-only (not in the feature text)', run() {
        const built = out('generation/adapters/postman').buildPostmanModel(collection(), null, { config: config(), collectionName: 'Shop' });
        const text = built.features.map(f => out('generation/render/FeatureRenderer').renderFeature(f.feature, { style: config().style })).join('\n');
        assert.doesNotMatch(text, /shipped order cannot be cancelled|Folder: Order management/);
    } },
    // HAR
    { name: 'enrich-flows: har context has the resource tag and the producer -> consumer id flow', run() {
        const built = harBuild();
        const [post, get] = [...built.model.operations].sort((a, b) => a.method.localeCompare(b.method)).reverse();
        assert.deepEqual(get.tags, ['orders']);
        assert.match(post.description ?? '', /Response response\.id \(\w+\) is reused by GET \/api\/orders\/\{\w+\}/);
        const text = contextOf(built.model);
        assert.match(text, /\[orders\]/);
        assert.match(text, /Response response\.id \(orderId\) is reused by GET \/api\/orders\/\{orderId\}/);
        assert.match(text, /Uses orderId from POST \/api\/orders/);
        assert.ok(!(post.description + get.description).includes('ord-1001'), 'id values are not part of the description');
    } },
    { name: 'enrich-flows: credentials in har headers never appear in the context or the model', run() {
        const built = harBuild();
        const text = contextOf(built.model);
        for (const secret of ['abcdef0123456789zz', 'key-lit-789', 'sess-lit-456']) {
            assert.ok(!text.includes(secret), `context leaks ${secret}`);
            assert.ok(!JSON.stringify(built.model).includes(secret), `model leaks ${secret}`);
        }
    } },
    { name: 'enrich-flows: the context redacts a credential even if an adapter let one into a description', run() {
        const m = { source: 'har', name: 'x', schemes: [], unsupported: [], operations: [{ id: 'a', method: 'GET', path: '/a', summary: 'List', description: `first line\nAuthorization: ${BEARER}\npassword: hunter2secret`, tags: [], pathParams: [], queryParams: [], headerParams: [], responses: [{ status: '200' }], security: 'none', sourceRef: 'GET /a' }] };
        const text = contextOf(m);
        assert.ok(!text.includes('abcdef0123456789zz') && !text.includes('hunter2secret'), text);
    } }
];
