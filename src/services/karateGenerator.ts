import { KarateFeature, KarateScenario, KarateStep, OpenAPIEndpoint } from '../types';
import { ConfigManager } from '../utils/configManager';
import { OpenAPIParser } from './openApiParser';

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
    generateFromOpenAPI(endpoints: OpenAPIEndpoint[], featureName: string): KarateFeature {
        const scenarios: KarateScenario[] = [];

        for (const endpoint of endpoints) {
            scenarios.push(this.createScenarioFromEndpoint(endpoint));
        }

        return {
            name: featureName,
            description: 'Auto-generated Karate tests from OpenAPI specification',
            scenarios
        };
    }

    /**
     * Create a Karate scenario from an OpenAPI endpoint
     */
    private createScenarioFromEndpoint(endpoint: OpenAPIEndpoint): KarateScenario {
        const steps: KarateStep[] = [];
        const scenarioName = endpoint.summary ||
            endpoint.operationId ||
            `${endpoint.method} ${endpoint.path}`;

        // Set base URL
        steps.push({
            keyword: 'Given',
            text: "url baseUrl + '" + endpoint.path + "'"
        });

        // Add path parameters
        const pathParams = endpoint.parameters?.filter(p => p.in === 'path') || [];
        for (const param of pathParams) {
            const exampleValue = this.openApiParser.getExampleValue(param.schema);
            steps.push({
                keyword: 'And',
                text: `path '${param.name}' = ${JSON.stringify(exampleValue)}`
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
            text: `method ${endpoint.method.toLowerCase()}`
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
                        steps.push({
                            keyword: 'And',
                            text: `match response contains { ${properties.slice(0, 3).map(p => `${p}: '#present'`).join(', ')} }`
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
            tags: endpoint.tags
        };
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
        steps.push({
            keyword: 'Given',
            text: `def ${varName} = '${baseUrl || 'http://localhost:8080'}'`
        });

        const template = ConfigManager.getTestTemplate();

        if (template === 'detailed') {
            steps.push({
                keyword: 'And',
                text: "configure headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' }"
            });
        }

        return { steps };
    }
}
