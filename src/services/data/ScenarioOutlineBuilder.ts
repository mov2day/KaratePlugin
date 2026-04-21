import * as vscode from 'vscode';
import { KarateScenario, KarateStep, OpenAPIEndpoint } from '../../types';
import { SmartValueGenerator } from './SmartValueGenerator';
import { logger } from '../../utils/logger';

/**
 * ScenarioOutlineBuilder — auto-generates Scenario Outline with Examples tables
 * for POST/PUT endpoints with 3+ required fields.
 */
export class ScenarioOutlineBuilder {

    /**
     * Decide whether to produce flat scenarios or a Scenario Outline.
     * Returns KarateScenario[] — either a single outline or flat scenarios.
     */
    static build(endpoint: OpenAPIEndpoint): KarateScenario[] {
        const method = endpoint.method.toUpperCase();

        // Only apply outline to POST/PUT
        if (method !== 'POST' && method !== 'PUT') {
            return [];
        }

        const schema = this.extractRequestSchema(endpoint);
        if (!schema || !schema.properties) {
            return [];
        }

        const requiredFields = schema.required || [];
        const threshold = this.getThreshold();

        if (requiredFields.length < threshold) {
            return [];
        }

        logger.info(`ScenarioOutlineBuilder: generating outline for ${method} ${endpoint.path} (${requiredFields.length} required fields)`);

        return [this.buildOutlineScenario(endpoint, schema, requiredFields)];
    }

    private static buildOutlineScenario(
        endpoint: OpenAPIEndpoint,
        schema: any,
        requiredFields: string[]
    ): KarateScenario {
        const method = endpoint.method.toUpperCase();
        const allProps = Object.keys(schema.properties);

        // Build request body template with <placeholders>
        const bodyLines: string[] = ['{'];
        for (const prop of allProps) {
            const isString = this.isStringField(schema.properties[prop]);
            const placeholder = `<${prop}>`;
            const value = isString ? `"${placeholder}"` : placeholder;
            bodyLines.push(`  "${prop}": ${value},`);
        }
        // Remove trailing comma from last line
        if (bodyLines.length > 1) {
            bodyLines[bodyLines.length - 1] = bodyLines[bodyLines.length - 1].replace(/,$/, '');
        }
        bodyLines.push('}');

        const steps: KarateStep[] = [
            { keyword: 'Given', text: `path '${endpoint.path}'` },
            { keyword: 'And', text: 'request', docString: bodyLines.join('\n') },
            { keyword: 'When', text: `method ${method}` },
            { keyword: 'Then', text: 'status <expectedStatus>' },
        ];

        // Build Examples table
        const headers = [...allProps, 'expectedStatus', 'testCase'];
        const rows: string[][] = [headers];

        // Row 1: valid positive case
        const validRow: string[] = allProps.map(prop =>
            String(SmartValueGenerator.generate(prop, schema.properties[prop]))
        );
        validRow.push('201', 'valid_complete');
        rows.push(validRow);

        // Row 2: missing required field → 400
        if (requiredFields.length > 0) {
            const missingRow: string[] = allProps.map(prop => {
                if (prop === requiredFields[0]) {
                    return '';  // blank required field
                }
                return String(SmartValueGenerator.generate(prop, schema.properties[prop]));
            });
            missingRow.push('400', `missing_${requiredFields[0]}`);
            rows.push(missingRow);
        }

        // Row 3: boundary value
        const boundaryRow: string[] = allProps.map(prop => {
            const propSchema = schema.properties[prop];
            if (propSchema?.type === 'string' && !propSchema.format) {
                return '';  // empty string boundary
            }
            if (propSchema?.type === 'integer' || propSchema?.type === 'number') {
                return '0';  // zero boundary
            }
            return String(SmartValueGenerator.generate(prop, propSchema));
        });
        boundaryRow.push('400', 'boundary_values');
        rows.push(boundaryRow);

        return {
            name: `${method} ${endpoint.path} - data-driven validation - <testCase>`,
            steps,
            tags: ['@positive', '@negative', '@boundary', '@data-driven'],
            category: 'boundary'
        };
    }

    private static extractRequestSchema(endpoint: OpenAPIEndpoint): any {
        if (!endpoint.requestBody || !endpoint.requestBody.content) {
            return null;
        }

        const jsonContent = endpoint.requestBody.content['application/json'];
        return jsonContent?.schema || null;
    }

    private static isStringField(schema: any): boolean {
        return schema?.type === 'string';
    }

    private static getThreshold(): number {
        const config = vscode.workspace.getConfiguration('karateDsl');
        return config.get<number>('generation.scenarioOutlineThreshold') || 3;
    }
}
