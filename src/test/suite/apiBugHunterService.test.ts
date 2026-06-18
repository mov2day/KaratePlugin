import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApiBugHunterService, BugHunterHttpClient } from '../../services/bugHunter/ApiBugHunterService';
import { OpenAPIParser } from '../../services/openApiParser';
import { BugHunterOptions, OpenAPIEndpoint } from '../../types';

suite('ApiBugHunterService', () => {
    const baseOptions: BugHunterOptions = {
        baseUrl: 'https://api.example.test',
        safeMode: false,
        maxRequests: 20,
        timeoutMs: 1000,
        concurrency: 1,
        includeDestructiveMethods: true
    };

    test('builds baseline payloads from schema examples and heuristics', () => {
        const service = new ApiBugHunterService();
        const payload = service.buildBaselinePayload({
            type: 'object',
            required: ['email', 'age'],
            properties: {
                email: { type: 'string', format: 'email' },
                role: { type: 'string', enum: ['admin', 'user'] },
                age: { type: 'integer', minimum: 21 }
            }
        }) as Record<string, unknown>;

        assert.strictEqual(payload.email, 'test.user@example.com');
        assert.strictEqual(payload.role, 'admin');
        assert.strictEqual(payload.age, 30);
    });

    test('builds validation and injection mutations from request schema', () => {
        const service = new ApiBugHunterService();
        const mutations = service.buildPayloadMutations({
            type: 'object',
            required: ['email'],
            properties: {
                email: { type: 'string', format: 'email' },
                status: { type: 'string', enum: ['active'] },
                count: { type: 'integer', maximum: 10 }
            }
        });

        assert.ok(mutations.some(m => m.name.includes('missing required email')));
        assert.ok(mutations.some(m => m.name.includes('invalid enum status')));
        assert.ok(mutations.some(m => m.name.includes('boundary overflow count')));
        assert.ok(mutations.some(m => m.category === 'injection-smoke'));
    });

    test('does not export repro scenarios without findings', () => {
        const service = new ApiBugHunterService();
        assert.strictEqual(service.generateReproFeature([], baseOptions.baseUrl), '');
    });

    test('reads base url from OpenAPI servers', async () => {
        const specPath = writeTempSpec();
        const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
        spec.servers = [{
            url: 'https://{env}.example.test/v1/',
            variables: { env: { default: 'staging' } }
        }];
        fs.writeFileSync(specPath, JSON.stringify(spec), 'utf-8');

        assert.strictEqual(await new OpenAPIParser().parseBaseUrl(specPath), 'https://staging.example.test/v1');
    });

    test('safe mode skips destructive method probes', () => {
        const service = new ApiBugHunterService();
        const endpoints: OpenAPIEndpoint[] = [
            { path: '/users', method: 'GET', responses: { '200': { description: 'OK' } } },
            { path: '/users', method: 'POST', responses: { '201': { description: 'Created' } } }
        ];

        const result = service.buildProbes(endpoints, {
            ...baseOptions,
            safeMode: true,
            includeDestructiveMethods: false
        });

        assert.ok(result.probes.every(probe => probe.method === 'GET'));
        assert.strictEqual(result.skippedProbes, 1);
        assert.ok(result.skippedProbeReports[0].reason?.includes('safe mode'));
    });

    test('detects validation bypass and server crash with mocked HTTP responses', async () => {
        const specPath = writeTempSpec();
        const client: BugHunterHttpClient = {
            async request(config) {
                if (typeof config.data === 'string') {
                    return { status: 500, headers: {}, data: { error: 'boom' } };
                }
                const body = config.data as Record<string, unknown>;
                if (body && body.email === 12345) {
                    return { status: 500, headers: {}, data: { error: 'boom' } };
                }
                if (body && body.email === undefined) {
                    return { status: 200, headers: {}, data: { accepted: true } };
                }
                return { status: 201, headers: {}, data: { id: 'u1', email: 'test.user@example.com' } };
            }
        };

        const service = new ApiBugHunterService(client);
        const result = await service.hunt(specPath, { ...baseOptions, maxRequests: 4 });

        assert.ok(result.findings.some(f => f.category === 'validation-bypass'));
        assert.ok(result.findings.some(f => f.category === 'server-crash'));
        assert.strictEqual(result.probes.filter(probe => probe.status === 'executed').length, 4);
        assert.ok(result.probes.some(probe => probe.status === 'executed' && probe.responseStatus === 500));
        assert.ok(result.probes.some(probe => probe.status === 'skipped' && probe.reason?.includes('maxRequests')));
        assert.ok(result.reproFeature.includes('@bug @validation_bypass'));
        assert.ok(result.reproFeature.includes('Then assert responseStatus >= 400'));
    });

    test('detects schema drift on valid baseline responses', async () => {
        const specPath = writeTempSpec();
        const client: BugHunterHttpClient = {
            async request() {
                return { status: 201, headers: {}, data: { id: 123, email: 'test.user@example.com' } };
            }
        };

        const service = new ApiBugHunterService(client);
        const result = await service.hunt(specPath, { ...baseOptions, maxRequests: 1 });

        assert.strictEqual(result.findings.length, 1);
        assert.strictEqual(result.findings[0].category, 'schema-drift');
        assert.ok(result.findings[0].karateScenario.includes('match response'));
    });

    test('detects missing auth accepted by API', async () => {
        const specPath = writeTempSpec('/users/{id}', 'GET');
        const client: BugHunterHttpClient = {
            async request(config) {
                if (!config.headers.Authorization) {
                    return { status: 200, headers: {}, data: { id: 'u1', email: 'test.user@example.com' } };
                }
                return { status: 200, headers: {}, data: { id: 'u1', email: 'test.user@example.com' } };
            }
        };

        const service = new ApiBugHunterService(client);
        const result = await service.hunt(specPath, {
            ...baseOptions,
            authHeader: 'Bearer super-secret-token',
            maxRequests: 3
        });

        const finding = result.findings.find(f => f.category === 'auth-missing');
        assert.ok(finding);
        assert.strictEqual(finding?.request.headers.Authorization, undefined);
        assert.ok(!finding?.curl.includes('Authorization:'));
    });

    test('detects swapped path id accepted by API', async () => {
        const specPath = writeTempSpec('/users/{id}', 'GET');
        const client: BugHunterHttpClient = {
            async request(config) {
                if (!config.headers.Authorization) {
                    return { status: 401, headers: {}, data: { error: 'missing auth' } };
                }
                return {
                    status: 200,
                    headers: {},
                    data: {
                        id: config.url.endsWith('/999999999') ? '999999999' : 'u1',
                        email: 'test.user@example.com'
                    }
                };
            }
        };

        const service = new ApiBugHunterService(client);
        const result = await service.hunt(specPath, {
            ...baseOptions,
            authHeader: 'Bearer super-secret-token',
            maxRequests: 3
        });

        const finding = result.findings.find(f => f.category === 'bola-smoke');
        assert.ok(finding);
        assert.ok(finding?.request.url.endsWith('/999999999'));
    });

    test('redacts auth headers and common secret patterns', () => {
        const redacted = ApiBugHunterService.redactSecrets({
            Authorization: 'Bearer abc123',
            password: 'clear-text',
            nested: { token: 'abc123' }
        }, 'Bearer abc123');

        assert.ok(!redacted.includes('abc123'));
        assert.ok(redacted.includes('<redacted>'));
    });
});

function writeTempSpec(endpointPath: string = '/users', method: string = 'POST'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karate-bug-hunter-'));
    const specPath = path.join(dir, 'openapi.json');
    const lowerMethod = method.toLowerCase();

    const operation: Record<string, unknown> = {
        operationId: `${lowerMethod}User`,
        parameters: endpointPath.includes('{id}')
            ? [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]
            : [],
        responses: {
            [method === 'POST' ? '201' : '200']: {
                description: 'OK',
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['id', 'email'],
                            properties: {
                                id: { type: 'string' },
                                email: { type: 'string', format: 'email' }
                            }
                        }
                    }
                }
            }
        }
    };

    if (method === 'POST') {
        operation.requestBody = {
            required: true,
            content: {
                'application/json': {
                    schema: {
                        type: 'object',
                        required: ['email'],
                        properties: {
                            email: { type: 'string', format: 'email' },
                            name: { type: 'string' }
                        }
                    }
                }
            }
        };
    }

    const spec = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        paths: {
            [endpointPath]: {
                [lowerMethod]: operation
            }
        }
    };

    fs.writeFileSync(specPath, JSON.stringify(spec), 'utf-8');
    return specPath;
}
