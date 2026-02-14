import * as assert from 'assert';
import { KarateGenerator } from '../../services/karateGenerator';
import { OpenAPIEndpoint } from '../../types';

suite('KarateGenerator Test Suite', () => {
    let generator: KarateGenerator;

    setup(() => {
        generator = new KarateGenerator();
    });

    test('generateFromOpenAPI should create a feature with positive scenarios', () => {
        const endpoints: OpenAPIEndpoint[] = [
            {
                path: '/users',
                method: 'GET',
                summary: 'Get Users',
                description: 'Retrieve a list of users',
                responses: { '200': { description: 'OK' } }
            }
        ];

        const feature = generator.generateFromOpenAPI(endpoints, 'users', ['positive']);

        assert.strictEqual(feature.name, 'users');
        assert.strictEqual(feature.scenarios.length, 1);

        const scenario = feature.scenarios[0];
        assert.strictEqual(scenario.name, 'Get Users');
        assert.strictEqual(scenario.description, 'Retrieve a list of users');
        assert.strictEqual(scenario.steps[0].keyword, 'Given');
        assert.strictEqual(scenario.steps[0].text, "path '/users'");
        assert.strictEqual(scenario.steps[1].keyword, 'When');
        assert.strictEqual(scenario.steps[1].text, 'method GET');
        assert.strictEqual(scenario.steps[2].keyword, 'Then');
        assert.strictEqual(scenario.steps[2].text, 'status 200');
    });

    test('generateFromOpenAPI should generate negative scenarios when requested', () => {
        const endpoints: OpenAPIEndpoint[] = [
            {
                path: '/users/{id}',
                method: 'GET',
                summary: 'Get User',
                responses: { '200': { description: 'OK' } },
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]
            }
        ];

        // Request negative scenarios only
        const feature = generator.generateFromOpenAPI(endpoints, 'users', ['negative']);

        // Should generate 404 (Not Found) and 405 (Method Not Allowed)
        // 404 because of path param, 405 always
        assert.ok(feature.scenarios.length >= 2, 'Should have at least 2 negative scenarios');

        const notFound = feature.scenarios.find(s => s.name.includes('Not Found'));
        assert.ok(notFound, 'Should generate Not Found scenario');
        assert.strictEqual(notFound?.category, 'negative');

        const methodNotAllowed = feature.scenarios.find(s => s.name.includes('Method Not Allowed'));
        assert.ok(methodNotAllowed, 'Should generate Method Not Allowed scenario');
        assert.strictEqual(methodNotAllowed?.category, 'negative');
    });

    test('generateBackground should create generic background steps', () => {
        const background = generator.generateBackground('http://api.example.com');

        assert.ok(background, 'Background should be generated');
        assert.strictEqual(background.steps[0].keyword, '*');
        assert.ok(background.steps[0].text.includes("def baseUrl = 'http://api.example.com'"));
        assert.strictEqual(background.steps[1].keyword, '*');
        assert.strictEqual(background.steps[1].text, 'url baseUrl');
    });

    test('should handle POST requests with body', () => {
        const endpoints: OpenAPIEndpoint[] = [
            {
                path: '/users',
                method: 'POST',
                summary: 'Create User',
                requestBody: {
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    name: { type: 'string', example: 'John' }
                                }
                            }
                        }
                    }
                },
                responses: { '201': { description: 'Created' } }
            }
        ];

        const feature = generator.generateFromOpenAPI(endpoints, 'users', ['positive']);
        const scenario = feature.scenarios[0];

        // Find 'request' step
        const requestStep = scenario.steps.find(s => s.text === 'request');
        assert.ok(requestStep, 'Should have a request step');
        assert.ok(requestStep?.docString, 'Request step should have a docString');
        assert.ok(requestStep?.docString?.includes('"name": "John"'), 'DocString should include example body');

        // Verify status
        const statusStep = scenario.steps.find(s => s.text.includes('status'));
        assert.strictEqual(statusStep?.text, 'status 201');
    });
});
