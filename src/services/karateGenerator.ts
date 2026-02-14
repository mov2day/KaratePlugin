import { KarateFeature, KarateScenario, KarateStep, OpenAPIEndpoint } from '../types';
import { ConfigManager } from '../utils/configManager';
import { OpenAPIParser } from './openApiParser';
import { FeatureStructurer, StructuringOptions, StructuredOutput } from './FeatureStructurer';

export class KarateGenerator {
    private openApiParser: OpenAPIParser;
    private style: any = {
        indentation: '  ',
        variableCase: 'camelCase',
        lineSpacing: 1
    };
    private template: string | null = null;

    constructor() {
        this.openApiParser = new OpenAPIParser();
    }

    public setStyle(style: any) {
        this.style = { ...this.style, ...style };
    }

    public setTemplate(template: string) {
        this.template = template;
    }

    /**
     * Generate Karate feature from OpenAPI endpoints
     */
    generateFromOpenAPI(endpoints: OpenAPIEndpoint[], featureName: string, scenarioTypes?: string[]): KarateFeature {
        const scenarios = this.createScenariosForEndpoints(endpoints, scenarioTypes);

        return {
            name: featureName,
            description: 'Auto-generated Karate tests from OpenAPI specification',
            scenarios
        };
    }

    /**
     * Generate structured multi-file output from OpenAPI endpoints
     * Groups scenarios by domain, classifies them, and injects tags
     */
    generateStructured(endpoints: OpenAPIEndpoint[], options: StructuringOptions, scenarioTypes?: string[]): StructuredOutput {
        const scenarios = this.createScenariosForEndpoints(endpoints, scenarioTypes);
        return FeatureStructurer.structure(scenarios, endpoints, options);
    }

    /**
     * Create all requested scenario types for a set of endpoints.
     * If scenarioTypes is empty or undefined, generates all types.
     */
    private createScenariosForEndpoints(endpoints: OpenAPIEndpoint[], scenarioTypes?: string[]): KarateScenario[] {
        const types = scenarioTypes && scenarioTypes.length > 0
            ? scenarioTypes
            : ['positive', 'negative', 'edge', 'security'];

        const scenarios: KarateScenario[] = [];

        for (const endpoint of endpoints) {
            if (types.includes('positive')) {
                scenarios.push(this.createScenarioFromEndpoint(endpoint));
            }
            if (types.includes('negative')) {
                scenarios.push(...this.createNegativeScenarios(endpoint));
            }
            if (types.includes('edge')) {
                scenarios.push(...this.createEdgeScenarios(endpoint));
            }
            if (types.includes('security')) {
                scenarios.push(...this.createSecurityScenarios(endpoint));
            }
        }

        return scenarios;
    }

    /**
     * Create a Karate scenario from an OpenAPI endpoint
     */
    private createScenarioFromEndpoint(endpoint: OpenAPIEndpoint): KarateScenario {
        const steps: KarateStep[] = [];
        const scenarioName = endpoint.summary ||
            endpoint.operationId ||
            `${endpoint.method} ${endpoint.path}`;

        // Add path (URL set in background)
        steps.push({
            keyword: 'Given',
            text: `path '${endpoint.path}'`
        });

        // Add path parameters as variables (Karate auto-substitutes in path)
        const pathParams = endpoint.parameters?.filter(p => p.in === 'path') || [];
        for (const param of pathParams) {
            const exampleValue = this.openApiParser.getExampleValue(param.schema);
            steps.push({
                keyword: 'And',
                text: `def ${param.name} = ${JSON.stringify(exampleValue)}`
            });
        }

        // Add query parameters
        const queryParams = endpoint.parameters?.filter(p => p.in === 'query') || [];
        for (const param of queryParams) {
            const exampleValue = this.openApiParser.getExampleValue(param.schema);
            steps.push({
                keyword: 'And',
                text: `param '${param.name}' = ${JSON.stringify(exampleValue)}`
            });
        }

        // Add headers
        const headerParams = endpoint.parameters?.filter(p => p.in === 'header') || [];
        for (const param of headerParams) {
            const exampleValue = this.openApiParser.getExampleValue(param.schema);
            steps.push({
                keyword: 'And',
                text: `header ${param.name} = ${JSON.stringify(exampleValue)}`
            });
        }

        // Add request body for POST/PUT/PATCH
        if (['POST', 'PUT', 'PATCH'].includes(endpoint.method) && endpoint.requestBody) {
            const content = endpoint.requestBody.content;
            if (content && content['application/json']) {
                const schema = content['application/json'].schema;
                const exampleBody = this.openApiParser.getExampleValue(schema);
                steps.push({
                    keyword: 'And',
                    text: 'request',
                    docString: JSON.stringify(exampleBody, null, 2)
                });
            }
        }

        // Execute request
        steps.push({
            keyword: 'When',
            text: `method ${endpoint.method.toUpperCase()}`
        });

        // Add response assertions
        const successResponse = endpoint.responses?.['200'] ||
            endpoint.responses?.['201'] ||
            endpoint.responses?.['204'];

        if (successResponse) {
            const statusCode = endpoint.responses?.['200'] ? '200' :
                endpoint.responses?.['201'] ? '201' : '204';
            steps.push({
                keyword: 'Then',
                text: `status ${statusCode}`
            });

            // Add response schema validation if available
            if (successResponse.content && successResponse.content['application/json']) {
                const schema = successResponse.content['application/json'].schema;
                if (schema && schema.properties) {
                    const properties = Object.keys(schema.properties);
                    if (properties.length > 0) {
                        const matchObj = properties.slice(0, 5).map(p => `${p}: '#notnull'`).join(', ');
                        steps.push({
                            keyword: 'And',
                            text: `match response contains { ${matchObj} }`
                        });
                    }
                }
            }
        } else {
            steps.push({
                keyword: 'Then',
                text: 'status 200'
            });
        }

        return {
            name: scenarioName,
            description: endpoint.description,
            steps,
            tags: endpoint.tags,
            domain: FeatureStructurer.detectDomain(endpoint),
            category: 'positive'
        };
    }

    /**
     * Create negative test scenarios for an endpoint.
     * Tests expected error responses (400, 401, 404, 405).
     */
    private createNegativeScenarios(endpoint: OpenAPIEndpoint): KarateScenario[] {
        const scenarios: KarateScenario[] = [];
        const baseName = endpoint.summary || endpoint.operationId || `${endpoint.method} ${endpoint.path}`;
        const domain = FeatureStructurer.detectDomain(endpoint);

        // 400 Bad Request — invalid body for POST/PUT/PATCH
        if (['POST', 'PUT', 'PATCH'].includes(endpoint.method) && endpoint.requestBody) {
            scenarios.push({
                name: `${baseName} - Invalid Request Body`,
                description: 'Verify 400 when request body is invalid',
                steps: [
                    { keyword: 'Given', text: `path '${endpoint.path}'` },
                    { keyword: 'And', text: 'request { invalid: true }' },
                    { keyword: 'When', text: `method ${endpoint.method.toUpperCase()}` },
                    { keyword: 'Then', text: 'status 400' },
                ],
                tags: endpoint.tags,
                domain,
                category: 'negative'
            });
        }

        // 404 Not Found — non-existent resource for single-resource paths
        if (endpoint.path.includes('{')) {
            scenarios.push({
                name: `${baseName} - Not Found`,
                description: 'Verify 404 for non-existent resource',
                steps: [
                    { keyword: 'Given', text: `path '${endpoint.path.replace(/\{[^}]+\}/g, '99999999')}'` },
                    { keyword: 'When', text: `method ${endpoint.method.toUpperCase()}` },
                    { keyword: 'Then', text: 'status 404' },
                ],
                tags: endpoint.tags,
                domain,
                category: 'negative'
            });
        }

        // 405 Method Not Allowed — wrong HTTP method
        const wrongMethod = endpoint.method === 'GET' ? 'DELETE' : 'GET';
        scenarios.push({
            name: `${baseName} - Method Not Allowed`,
            description: `Verify 405 when using wrong HTTP method (${wrongMethod})`,
            steps: [
                { keyword: 'Given', text: `path '${endpoint.path}'` },
                { keyword: 'When', text: `method ${wrongMethod}` },
                { keyword: 'Then', text: 'status 405' },
            ],
            tags: endpoint.tags,
            domain,
            category: 'negative'
        });

        return scenarios;
    }

    /**
     * Create edge case scenarios for an endpoint.
     * Tests boundary conditions: empty payloads, missing params, large values.
     */
    private createEdgeScenarios(endpoint: OpenAPIEndpoint): KarateScenario[] {
        const scenarios: KarateScenario[] = [];
        const baseName = endpoint.summary || endpoint.operationId || `${endpoint.method} ${endpoint.path}`;
        const domain = FeatureStructurer.detectDomain(endpoint);

        // Empty body for POST/PUT/PATCH
        if (['POST', 'PUT', 'PATCH'].includes(endpoint.method) && endpoint.requestBody) {
            scenarios.push({
                name: `${baseName} - Empty Request Body`,
                description: 'Verify behavior with empty request body',
                steps: [
                    { keyword: 'Given', text: `path '${endpoint.path}'` },
                    { keyword: 'And', text: 'request {}' },
                    { keyword: 'When', text: `method ${endpoint.method.toUpperCase()}` },
                    { keyword: 'Then', text: "assert responseStatus == 400 || responseStatus == 422" },
                ],
                tags: endpoint.tags,
                domain,
                category: 'edge'
            });
        }

        // Missing required query parameters
        const requiredParams = endpoint.parameters?.filter(p => p.required && p.in === 'query') || [];
        if (requiredParams.length > 0) {
            scenarios.push({
                name: `${baseName} - Missing Required Parameters`,
                description: `Verify error when required query params are omitted`,
                steps: [
                    { keyword: 'Given', text: `path '${endpoint.path}'` },
                    { keyword: 'When', text: `method ${endpoint.method.toUpperCase()}` },
                    { keyword: 'Then', text: "assert responseStatus == 400 || responseStatus == 422" },
                ],
                tags: endpoint.tags,
                domain,
                category: 'edge'
            });
        }

        return scenarios;
    }

    /**
     * Create security test scenarios for an endpoint.
     * Tests authentication, authorization, and injection patterns.
     */
    private createSecurityScenarios(endpoint: OpenAPIEndpoint): KarateScenario[] {
        const scenarios: KarateScenario[] = [];
        const baseName = endpoint.summary || endpoint.operationId || `${endpoint.method} ${endpoint.path}`;
        const domain = FeatureStructurer.detectDomain(endpoint);

        // 401 Unauthorized — no auth header
        scenarios.push({
            name: `${baseName} - Unauthorized Access`,
            description: 'Verify 401 when no authentication is provided',
            steps: [
                { keyword: 'Given', text: `path '${endpoint.path}'` },
                { keyword: 'And', text: "header Authorization = ''" },
                { keyword: 'When', text: `method ${endpoint.method.toUpperCase()}` },
                { keyword: 'Then', text: 'status 401' },
            ],
            tags: endpoint.tags,
            domain,
            category: 'security'
        });

        // SQL injection in path params
        if (endpoint.path.includes('{')) {
            scenarios.push({
                name: `${baseName} - SQL Injection in Path`,
                description: 'Verify protection against SQL injection in path parameters',
                steps: [
                    { keyword: 'Given', text: `path '${endpoint.path.replace(/\{[^}]+\}/g, "1' OR '1'='1")}'` },
                    { keyword: 'When', text: `method ${endpoint.method.toUpperCase()}` },
                    { keyword: 'Then', text: "assert responseStatus == 400 || responseStatus == 404" },
                ],
                tags: endpoint.tags,
                domain,
                category: 'security'
            });
        }

        return scenarios;
    }

    /**
     * Convert Karate feature to .feature file content
     */
    featureToString(feature: KarateFeature): string {
        if (this.template) {
            return this.applyTemplate(feature);
        }

        const lines: string[] = [];

        // Feature declaration
        lines.push(`Feature: ${feature.name}`);
        if (feature.description) {
            lines.push(`  ${feature.description}`);
        }
        lines.push('');

        // Background section
        if (feature.background) {
            lines.push('  Background:');
            for (const step of feature.background.steps) {
                lines.push(this.stepToString(step, 4));
            }
            lines.push('');
        }

        // Scenarios
        for (const scenario of feature.scenarios) {
            // Tags
            if (scenario.tags && scenario.tags.length > 0) {
                lines.push(`  @${scenario.tags.join(' @')}`);
            }

            // Scenario declaration
            lines.push(`  Scenario: ${scenario.name}`);
            if (scenario.description) {
                lines.push(`    # ${scenario.description}`);
            }

            // Steps
            for (const step of scenario.steps) {
                lines.push(this.stepToString(step, 4));
            }
            lines.push('');
        }

        return lines.join('\n');
    }

    /**
     * Apply custom template to the feature
     */
    private applyTemplate(feature: KarateFeature): string {
        if (!this.template) return '';

        let content = this.template
            .replace('{{featureName}}', feature.name)
            .replace('{{featureDescription}}', feature.description || '')
            .replace('{{backgroundSteps}}', feature.background ? feature.background.steps.map(s => this.stepToString(s, 4)).join('\n') : '')
            .replace('{{scenarios}}', feature.scenarios.map(s => this.scenarioToString(s)).join('\n\n'));

        return content;
    }

    private scenarioToString(scenario: KarateScenario): string {
        const lines: string[] = [];
        if (scenario.tags && scenario.tags.length > 0) {
            lines.push(`  @${scenario.tags.join(' @')}`);
        }
        lines.push(`  Scenario: ${scenario.name}`);
        if (scenario.description) {
            lines.push(`    # ${scenario.description}`);
        }
        for (const step of scenario.steps) {
            lines.push(this.stepToString(step, 4));
        }
        return lines.join('\n');
    }

    /**
     * Convert a step to string
     */
    private stepToString(step: KarateStep, indent: number): string {
        const indentation = this.style.indentation || '  ';
        const spaces = indentation.repeat(Math.floor(indent / 2)); // Adjust based on base indent
        let line = `${spaces}${step.keyword} ${step.text}`;

        if (step.docString) {
            return `${line}\n${spaces}\"\"\"\n${step.docString}\n${spaces}\"\"\"`;
        }

        if (step.table) {
            const tableLines = step.table.map(row =>
                `${spaces}  | ${row.join(' | ')} |`
            ).join('\n');
            return `${line}\n${tableLines}`;
        }

        return line;
    }

    /**
     * Generate background section with common setup
     */
    generateBackground(baseUrl?: string): KarateFeature['background'] {
        const steps: KarateStep[] = [];

        const varName = this.style.variableCase === 'snake_case' ? 'base_url' : 'baseUrl';

        // Define base URL variable
        steps.push({
            keyword: '*',
            text: `def ${varName} = '${baseUrl || 'http://localhost:8080'}'`
        });

        // Set URL for all scenarios
        steps.push({
            keyword: '*',
            text: `url ${varName}`
        });

        const template = ConfigManager.getTestTemplate();

        if (template === 'detailed') {
            steps.push({
                keyword: '*',
                text: "configure headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' }"
            });
        }

        return { steps };
    }
}
