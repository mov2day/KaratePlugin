// Snapshots of the CURRENT (pre-rebuild) generators, so reviewers can diff old vs new output.
const fs = require('fs');
const { golden, fixture } = require('./support/golden.cjs');

const out = rel => require('../../out/' + rel);

async function openApiEndpoints() {
    const { OpenAPIParser } = out('services/openApiParser');
    return new OpenAPIParser().parseSpec(fixture('openapi', 'petstore-secured.yaml'));
}

module.exports = [
    {
        name: 'baseline: openapi flat',
        async run() {
            const { KarateGenerator } = out('services/karateGenerator');
            const gen = new KarateGenerator();
            const feature = gen.generateFromOpenAPI(await openApiEndpoints(), 'Petstore Secured');
            golden('baseline/openapi-flat.feature', gen.featureToString(feature));
        }
    },
    {
        name: 'baseline: openapi domain-structured',
        async run() {
            const { KarateGenerator } = out('services/karateGenerator');
            const gen = new KarateGenerator();
            const result = gen.generateStructured(await openApiEndpoints(), { strategy: 'domain', autoTag: true, outputRoot: 'features' });
            const text = result.files.map(f => `### ${f.relativePath} (${f.featureName})\n${f.content}`).join('\n')
                + `\n### commonFiles\n${JSON.stringify(result.commonFiles, null, 2)}\n`;
            golden('baseline/openapi-domain.txt', text);
        }
    },
    {
        name: 'baseline: postman',
        async run() {
            const { PostmanParser } = out('services/postmanParser');
            const { PostmanToKarateConverter } = out('services/postmanToKarateConverter');
            const parser = new PostmanParser();
            const converter = new PostmanToKarateConverter();
            const collection = parser.parseCollectionFile(fixture('postman', 'collection.json'));
            const variables = parser.extractVariables(collection);
            const scenarios = [];
            const walk = items => {
                for (const item of items) {
                    if (item.request) {
                        scenarios.push(converter.convertRequest(item.request, item.name, variables,
                            parser.extractPreRequestScript(item), parser.extractTestScript(item)));
                    } else if (item.item) walk(item.item);
                }
            };
            walk(collection.item);
            golden('baseline/postman.feature', converter.createFeatureFile(collection.info.name, scenarios, variables));
        }
    },
    {
        name: 'baseline: graphql',
        run() {
            const { GraphQLParser } = out('services/graphql/GraphQLParser');
            const { GraphQLKarateGenerator } = out('services/graphql/GraphQLKarateGenerator');
            const schema = new GraphQLParser().parseSDL(fs.readFileSync(fixture('graphql', 'schema.graphql'), 'utf8'));
            golden('baseline/graphql.feature', new GraphQLKarateGenerator().generate(schema, 'graphqlEndpoint'));
        }
    },
    {
        name: 'baseline: scout',
        run() {
            const { generateScoutSuite } = out('services/scout/ScoutGenerator');
            const connection = { browser: 'chrome', mode: 'har', url: 'https://shop.test/', allowedOrigins: ['https://shop.test'], excludedOrigins: [] };
            const req = (id, ts, method, url, body, resBody) => ({ id, timestamp: ts, method, url, headers: {}, body,
                response: { status: 200, headers: {}, body: resBody, duration: 1 } });
            const requests = [
                req('create', 1, 'POST', 'https://shop.test/api/orders', { sku: 'ABC-1', quantity: 2 }, { id: 'ord-1001' }),
                req('fetch', 2, 'GET', 'https://shop.test/api/orders/ord-1001', undefined, { id: 'ord-1001', quantity: 2 })
            ];
            const journey = {
                schemaVersion: 1, id: 'journey-fixed', name: 'Order journey', createdAt: 0, updatedAt: 0, connection, origin: 'har',
                actions: [], requests,
                dependencies: [{ id: 'dep-1', fromRequestId: 'create', fromPointer: '/id', toRequestId: 'fetch', target: 'path', toPointer: '/api/orders/ord-1001', candidates: [{ requestId: 'create', pointer: '/id' }], confirmed: true }],
                expectations: requests.map(r => ({ requestId: r.id, statuses: [200], assertions: [], confirmed: true })),
                variants: [], freshDataPerRun: true, baselineConfirmed: true, verification: { auth: 'none' }
            };
            const suite = generateScoutSuite(journey);
            const text = Object.keys(suite.files).sort().map(f => `### ${f}\n${suite.files[f]}`).join('\n')
                + `\n### meta\nrunnableScenarios=${suite.runnableScenarios}\ndraftReasons=${JSON.stringify(suite.draftReasons)}\n`;
            golden('baseline/scout.txt', text);
        }
    }
];
