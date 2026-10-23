const fs = require('fs');
const assert = require('node:assert/strict');
const { fixture } = require('./support/golden.cjs');

const out = rel => require('../../out/' + rel);
const cfgMod = () => out('generation/config/GeneratorConfig');
const adapter = () => out('generation/adapters/graphql');
const parser = () => new (out('services/graphql/GraphQLParser').GraphQLParser)();

const config = (over = {}) => {
    const base = JSON.parse(JSON.stringify(cfgMod().DEFAULT_GENERATOR_CONFIG));
    for (const [k, v] of Object.entries(over)) base[k] = { ...base[k], ...v };
    return base;
};

const SDL = `
"""The schema"""
scalar DateTime
scalar Money
enum Genre { FICTION "desc" NONFICTION }
enum Quirky { "A\\"quoted\\\\value" PLAIN }
input NewBook { title: String!, author: String!, genre: Genre, published: DateTime! }
interface Node { id: ID! }
input Filter { name: String! rec: Filter! }
type Grid { cells: [[Int!]!]! rows: [[Author!]!] tags: [String!]! }
union SearchResult = Book | Author
type Author { id: ID! name: String! }
type Book implements Node {
  id: ID!
  title: String!
  genre: Genre
  tags: [String!]!
  author: Author!
  price: Money
  secret(pin: Int!): String
}
type Query {
  "get one"
  book(id: ID!): Book
  books(limit: Int = 10, genre: Genre, note: String = "say \\"hi\\" \\\\ back\\nline \\u00e9 \\u2603"): [Book!]!
  search(text: String!): [SearchResult]
  total: Int!
  tagged(token: String!, kind: Genre!): Book
  oldThing: String @deprecated(reason: "no")
  priced(amount: Money!): Boolean
  grid: [[Int!]!]!
  gridObj: Grid!
  node(id: ID!): Node
  filtered(f: Filter!): Boolean
}
type Mutation {
  addBook(input: NewBook!): Book!
  deleteBook(id: ID!, force: Boolean = false): Boolean
}
type Subscription { bookAdded: Book }
`;
const schema = () => parser().parseSDL(SDL);
const plan = (over = {}, cfg = config()) => adapter().buildGraphQLPlan(schema(), { config: cfg, name: 'Library', ...over });
const render = (p, cfg = config()) => p.features.map(f => ({
    path: f.relativePath,
    text: out('generation/render/FeatureRenderer').renderFeature(f.feature, { style: cfg.style })
}));
const text = p => render(p).map(f => f.text).join('\n=====\n');
const gateAll = (p, cfg = config()) => {
    const { runGate } = out('generation/quality/QualityGate');
    const known = new Set(['common/auth.feature', 'common/utils.feature', ...p.files.map(f => f.path)]);
    return render(p, cfg).map(f => ({ path: f.path, gate: runGate(f.text, { knownFiles: known, config: cfg }) }));
};
const scenarios = p => p.features.flatMap(f => f.feature.scenarios);
const byName = (p, n) => scenarios(p).find(s => s.name === n);

const memFs = () => {
    const map = new Map();
    return {
        map,
        exists: p => map.has(p) || [...map.keys()].some(k => k.startsWith(p + '/')),
        read: p => { if (!map.has(p)) throw new Error('ENOENT ' + p); return map.get(p); },
        list: dir => [...new Set([...map.keys()].filter(k => k.startsWith(dir + '/')).map(k => k.slice(dir.length + 1).split('/')[0]))],
        write: (p, c) => { map.set(p, c); }
    };
};

module.exports = [
    {
        name: 'graphql parser: SDL types, enums, unions, descriptions, multi-line args and subscriptions are read',
        run() {
            const s = parser().parseSDL(`
type Query {
  """doc with { braces }"""
  a(
    # comment
    x: [Int!]! = [1, 2],
    y: String = "a)b"
  ): [Item!]
}
type Subscription { s: Item }
type Item { id: ID! n: Int }`);
            assert.equal(s.queries.length, 1);
            assert.deepEqual(s.queries[0].args.map(a => [a.name, a.type, a.required, a.defaultValue]), [['x', '[Int!]', true, '[1, 2]'], ['y', 'String', false, '"a)b"']]);
            assert.equal(s.queries[0].returnType, '[Item!]');
            assert.deepEqual(s.queries[0].returnFields, ['id', 'n']);
            assert.deepEqual(s.subscriptions.map(f => f.name), ['s']);
            const d = schema();
            assert.deepEqual(d.types.Genre.enumValues, ['FICTION', 'NONFICTION']);
            assert.deepEqual(d.types.SearchResult.possibleTypes, ['Book', 'Author']);
            assert.equal(d.queries.find(f => f.name === 'oldThing').deprecated, true);
        }
    },
    {
        name: 'graphql parser: introspection JSON gives the same shape (required args without the trailing !)',
        run() {
            const ref = (kind, name, of) => ({ kind, name, ofType: of ?? null });
            const nn = t => ref('NON_NULL', null, t);
            const json = { data: { __schema: {
                queryType: { name: 'Query' }, mutationType: null,
                types: [
                    { kind: 'OBJECT', name: 'Query', fields: [{ name: 'book', args: [{ name: 'id', type: nn(ref('SCALAR', 'ID')) }], type: ref('OBJECT', 'Book') }] },
                    { kind: 'OBJECT', name: 'Book', fields: [{ name: 'id', args: [], type: nn(ref('SCALAR', 'ID')) }, { name: 'old', args: [], isDeprecated: true, type: ref('SCALAR', 'String') }] }
                ]
            } } };
            const s = parser().parse(JSON.stringify(json));
            assert.deepEqual(s.queries[0].args, [{ name: 'id', type: 'ID', required: true }]);
            assert.deepEqual(s.queries[0].returnFields, ['id', 'old']);
            assert.equal(s.mutations.length, 0);
        }
    },
    {
        name: 'graphql: query text uses declared variables and the variables map; values are never spliced into the query',
        run() {
            const t = text(plan());
            assert.match(t, /query Book\(\$id: ID!\) \{\n\s+book\(id: \$id\) \{/);
            assert.match(t, /And def variables = \{ id: '[^']+' \}/);
            assert.match(t, /And request \{ query: '#\(query\)', variables: '#\(variables\)' \}/);
            assert.match(t, /And text query =\n\s+"""/);
            assert.match(t, /Given path 'graphql'/);
            for (const s of scenarios(plan())) {
                const doc = s.steps.find(x => x.text === 'text query =').docString;
                assert.ok(!/book\(id: ["'\d]/.test(doc), 'value spliced into query');
            }
        }
    },
    {
        name: 'graphql: SDL default values with quotes, backslashes, newlines and unicode survive; the query text stays plain',
        run() {
            const p = plan();
            const s = byName(p, 'Query books - success');
            const lineVars = s.steps.find(x => x.text.startsWith('def variables ='));
            const literal = lineVars.text.replace(/^def variables = /, '') || lineVars.docString;
            const vars = new Function(`return (${literal});`)();
            assert.equal(vars.note, 'say "hi" \\ back\nline é ☃');
            assert.equal(vars.limit, 10);
            assert.ok(!('genre' in vars), 'optional argument without default is not sent');
            const doc = s.steps.find(x => x.text === 'text query =').docString;
            assert.ok(!doc.includes('\\"') && !doc.includes('hi'), 'defaults must not be written into the query text');
            const rendered = text(p);
            assert.ok(!rendered.includes('\n  back'), 'newline escaped inside the literal');
            assert.ok(rendered.includes('é') && rendered.includes('☃'));
        }
    },
    {
        name: 'graphql: enum values with odd characters never reach the query text; the first enum value is the sample',
        run() {
            const p = plan();
            const s = byName(p, 'Query tagged - success');
            assert.match(s.steps.find(x => x.text.startsWith('def variables =')).text, /kind: 'FICTION'/);
            assert.deepEqual(schema().types.Quirky.enumValues, ['PLAIN']);
        }
    },
    {
        name: 'graphql: required variables get typed sample values; input objects contain their required fields only',
        run() {
            const s = byName(plan(), 'Mutation addBook - success');
            const d = s.steps.find(x => x.text.startsWith('def variables =')) ;
            const vars = new Function(`return (${d.text ? d.text.replace(/^def variables = /, '') : ''});`)();
            assert.deepEqual(Object.keys(vars.input).sort(), ['author', 'published', 'title']);
            assert.match(vars.input.published, /^\d{4}-\d\d-\d\d/);
            assert.match(s.steps.find(x => x.text === 'text query =').docString, /mutation AddBook\(\$input: NewBook!\)/);
        }
    },
    {
        name: 'graphql: one negative per field with required arguments, omitting only the first required variable',
        run() {
            const p = plan();
            const neg = scenarios(p).filter(s => s.category === 'negative').map(s => s.name);
            assert.deepEqual(neg, [
                'Query book - missing required variable id', 'Query search - missing required variable text',
                'Query tagged - missing required variable token', 'Query priced - missing required variable amount',
                'Query node - missing required variable id', 'Query filtered - missing required variable f',
                'Mutation addBook - missing required variable input', 'Mutation deleteBook - missing required variable id'
            ]);
            const t = byName(p, 'Query tagged - missing required variable token');
            const def = t.steps.find(x => x.text.startsWith('def variables ='));
            assert.ok(def && /kind: 'FICTION'/.test(def.text) && !/token/.test(def.text), 'only token omitted');
            assert.match(t.steps.find(x => x.text === 'text query =').docString, /\$token: String!, \$kind: Genre!/);
            assert.ok(t.steps.some(x => x.text === "match response.errors == '#[_ > 0]'"));
            assert.ok(!neg.some(n => /books|total/.test(n)));
            const bookNeg = byName(p, 'Query book - missing required variable id');
            assert.ok(!bookNeg.steps.some(x => x.text.startsWith('def variables')));
            assert.ok(bookNeg.steps.some(x => x.text === "request { query: '#(query)' }"));
        }
    },
    {
        name: 'graphql: assertions use markers derived from the declared return types',
        run() {
            const p = plan();
            const t = text(p);
            assert.match(t, /match response\.data\.total == '#number'/);
            assert.match(t, /match response\.data\.book == '#present'/);
            assert.match(t, /match response\.data\.deleteBook == '##boolean'/);
            assert.match(t, /match response\.data\.books == '#\[\] #object'/);
            assert.match(t, /match each response\.data\.books ==\s*(?:"""\s*)?\{[^}]*id: '#string'[^}]*title: '#string'[^}]*genre: '##string'[^}]*tags: '#\[\] #string'[^}]*author: '#object'[^}]*\}/s);
            assert.match(t, /match response\.data\.search == '##\[\]'/);
            assert.match(t, /match response\.data\.addBook ==\s*(?:"""\s*)?\{/);
            const books = byName(p, 'Query books - success').steps.find(x => x.text === 'text query =').docString;
            assert.match(books, /author \{\n\s+id\n\s+name\n\s+\}/);
            assert.ok(!/\bsecret\b/.test(books), 'fields with required arguments are not selected');
            for (const s of scenarios(p).filter(x => x.category === 'positive')) {
                assert.ok(s.steps.some(x => x.text === 'status 200'));
                assert.ok(s.steps.some(x => x.text === "match response.errors == '#notpresent'"));
            }
            assert.match(byName(p, 'Query search - success').steps.find(x => x.text === 'text query =').docString, /__typename/);
        }
    },
    {
        name: 'graphql: custom scalars use a typed sample or are drafted with a warning when unknown',
        run() {
            const p = plan();
            const money = byName(p, 'Query priced - success');
            assert.ok(money.draftReason && /Money/.test(money.draftReason));
            assert.ok(p.warnings.some(w => /Money/.test(w)));
            const t = text(p);
            assert.match(t, /@ignore [^\n]*\n\s+Scenario: Query priced - success/);
            assert.ok(!byName(p, 'Query book - success').draftReason);
            assert.ok(!byName(p, 'Mutation addBook - success').draftReason, 'DateTime has a known sample');
        }
    },
    {
        name: 'graphql: nested list types assert only the list marker; single-level lists keep the element marker',
        run() {
            const p = plan();
            const t = text(p);
            assert.match(t, /match response\.data\.grid == '#\[\]'/);
            assert.ok(!/response\.data\.grid == '#\[\] #number'/.test(t));
            const gridObj = byName(p, 'Query gridObj - success').steps.find(x => /match response\.data\.gridObj/.test(x.text));
            const m = (gridObj.docString ?? gridObj.text);
            assert.match(m, /cells: '#\[\]'/);
            assert.match(m, /rows: '##\[\]'/);
            assert.match(m, /tags: '#\[\] #string'/);
            assert.match(text(p), /match response\.data\.books == '#\[\] #object'/);
        }
    },
    {
        name: 'graphql: an interface return selects its declared fields (a union selects __typename)',
        run() {
            const p = plan();
            const s = byName(p, 'Query node - success');
            assert.match(s.steps.find(x => x.text === 'text query =').docString, /node\(id: \$id\) \{\n\s+id\n\s+\}/);
            assert.ok(s.steps.some(x => x.text === "match response.data.node == '#present'"));
        }
    },
    {
        name: 'graphql: a recursive required input is drafted with a dedicated warning, not a custom-type one',
        run() {
            const p = plan();
            const s = byName(p, 'Query filtered - success');
            assert.match(s.draftReason, /Recursive required input Filter\.rec/);
            assert.ok(p.warnings.some(w => /recursive required input Filter\.rec; supply a value manually/.test(w)));
            assert.ok(!p.warnings.some(w => /custom type Filter/.test(w)));
        }
    },
    {
        name: 'graphql: endpoint redaction removes host, credentials, query values and key-like path segments',
        run() {
            const url = 'https://user:pw@api.example.com/graphql/abcd1234efgh5678ijkl9012?token=t1';
            const msg = `getaddrinfo ENOTFOUND api.example.com for ${url} (user pw t1 abcd1234efgh5678ijkl9012)`;
            const r = adapter().redactEndpoint(msg, url);
            for (const bad of ['api.example.com', 'pw', 't1', 'abcd1234efgh5678ijkl9012', 'user:']) assert.ok(!r.includes(bad), `${bad} in ${r}`);
            assert.equal(adapter().redactEndpoint('plain', undefined), 'plain');
        }
    },
    {
        name: 'graphql: credential-named arguments use karate.sysenv, never a literal',
        run() {
            const p = plan();
            const t = text(p);
            assert.match(t, /\* def token = karate\.sysenv\('TOKEN', ''\)/);
            assert.match(t, /token: '#\(token\)'/);
            assert.ok(!/token: '(?!#)/.test(t));
            assert.ok(p.warnings.some(w => /TOKEN/.test(w)));
            for (const g of gateAll(p)) assert.deepEqual(g.gate.findings.filter(f => f.severity === 'error'), [], g.path);
        }
    },
    {
        name: 'graphql: subscriptions and deprecated fields are skipped and reported',
        run() {
            const p = plan();
            assert.deepEqual(p.unsupported.map(u => u.sourceRef), ['Subscription bookAdded']);
            assert.deepEqual(p.model.unsupported, p.unsupported);
            assert.ok(p.warnings.some(w => /subscription/i.test(w)));
            assert.ok(p.warnings.some(w => /1 deprecated/.test(w)));
            const t = text(p);
            assert.ok(!/bookAdded|oldThing/.test(t));
        }
    },
    {
        name: 'graphql: no literal host or credential in any feature; the endpoint origin is only in model.baseUrl',
        run() {
            const p = plan({ baseUrl: 'https://user:pw@api.shop.test:8443/graphql?token=sekret123#x', endpointPath: '/api/gql?token=sekret123' });
            assert.equal(p.model.baseUrl, 'https://api.shop.test:8443');
            const all = [text(p), JSON.stringify(p.model), JSON.stringify(p.unsupported), p.warnings.join('\n'), p.files.map(f => f.content).join('')].join('\n');
            for (const bad of ['sekret123', 'user:pw', 'api.shop.test', 'localhost']) {
                if (bad === 'api.shop.test') assert.ok(!text(p).includes(bad) && !p.warnings.join().includes(bad));
                else assert.ok(!all.includes(bad), bad);
            }
            assert.ok(!/https?:/.test(text(p)));
            assert.match(text(p), /Given path 'api\/gql'/);
            assert.match(text(p), /\* url baseUrl\n/);
            assert.ok(p.warnings.some(w => /query string|credentials/i.test(w)));
            const split = adapter().splitEndpointUrl('https://h.test/a/graphql?token=zz');
            assert.deepEqual(split, { baseUrl: 'https://h.test', endpointPath: 'a/graphql', strippedQuery: true });
        }
    },
    {
        name: 'graphql: layout, tags, source comments, model operations',
        run() {
            const p = plan();
            assert.deepEqual(p.features.map(f => f.relativePath), ['library/library-queries.feature', 'library/library-mutations.feature']);
            assert.deepEqual(plan({}, config({ layout: { strategy: 'flat' } })).features.map(f => f.relativePath), ['library-queries.feature', 'library-mutations.feature']);
            const t = text(p);
            assert.match(t, /@positive @op=book\n\s+Scenario: Query book - success\n\s+# source: Query book/);
            assert.match(t, /@negative @op=addBook/);
            assert.equal(p.model.source, 'graphql');
            assert.ok(p.model.operations.every(o => o.method === 'POST' && o.path === '/graphql'));
            assert.equal(plan({}, config({ tags: { auto: false } })).features[0].feature.scenarios[0].tags.length, 0);
        }
    },
    {
        name: 'graphql: exploratory probes only when configured, tagged and asserting no server error',
        run() {
            assert.ok(!/exploratory/i.test(text(plan())));
            const p = plan({}, config({ scenarios: { exploratory: true } }));
            const t = text(p);
            assert.match(t, /@exploratory @op=introspection\n\s+Scenario: Exploratory - introspection query/);
            assert.match(t, /Then assert responseStatus < 500/);
            for (const g of gateAll(p, config({ scenarios: { exploratory: true } }))) assert.deepEqual(g.gate.findings.filter(f => f.severity === 'error'), [], g.path);
        }
    },
    {
        name: 'graphql: every feature of the fixture and of the rich schema is gate-clean; output is deterministic',
        run() {
            for (const g of gateAll(plan())) assert.deepEqual(g.gate.findings.filter(f => f.severity === 'error'), [], g.path);
            const fx = parser().parseSDL(fs.readFileSync(fixture('graphql', 'schema.graphql'), 'utf8'));
            const fp = adapter().buildGraphQLPlan(fx, { config: config(), name: 'Books' });
            for (const g of gateAll(fp)) assert.deepEqual(g.gate.findings.filter(f => f.severity === 'error'), [], g.path);
            assert.equal(text(plan()), text(plan()));
            assert.equal(JSON.stringify(plan()), JSON.stringify(plan()));
        }
    },
    {
        name: 'graphql: full in-memory pipeline writes the features with zero gate errors',
        async run() {
            const p = plan({ baseUrl: 'https://api.shop.test/graphql' });
            const fsApi = memFs();
            const result = await out('generation/pipeline/GenerationPipeline').runPipeline({
                model: p.model, scenarios: p.features, extraFiles: [],
                config: config(), project: { classpathRoot: 'src/test/java', envConfigs: [], hasEnvJson: false, runnerStyle: 'unknown' },
                fsApi, history: { get: () => undefined, set: () => undefined }, generatorVersion: '9.9.9', sourceRef: 'schema.graphql', mode: 'graphql'
            });
            assert.equal(result.features.length, 2);
            assert.equal(result.gate.errors, 0);
            const written = [...fsApi.map.entries()].filter(([k]) => k.endsWith('.feature') && k.includes('/library/'));
            assert.equal(written.length, 2);
            for (const [, c] of written) assert.ok(!/api\.shop\.test|https?:/.test(c));
        }
    },
    {
        name: 'graphql: the legacy GraphQLKarateGenerator.generate wrapper still returns one feature string',
        run() {
            const { GraphQLKarateGenerator } = out('services/graphql/GraphQLKarateGenerator');
            const fx = parser().parseSDL(fs.readFileSync(fixture('graphql', 'schema.graphql'), 'utf8'));
            const t = new GraphQLKarateGenerator().generate(fx, 'graphqlEndpoint');
            assert.equal(typeof t, 'string');
            assert.equal((t.match(/^Feature:/gm) || []).length, 1);
            assert.match(t, /Scenario: Query book - success/);
            assert.match(t, /Scenario: Mutation addBook - success/);
            assert.ok(!/graphqlEndpoint|http/.test(t));
        }
    }
];
