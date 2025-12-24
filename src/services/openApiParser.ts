import SwaggerParser from '@apidevtools/swagger-parser';
import * as fs from 'fs';
import { OpenAPIEndpoint } from '../types';
import { logger } from '../utils/logger';

export class OpenAPIParser {
    /**
     * Parse OpenAPI specification file
     */
    async parseSpec(filePath: string): Promise<OpenAPIEndpoint[]> {
        try {
            logger.info(`Parsing OpenAPI spec: ${filePath}`);

            // Parse and validate the OpenAPI spec
            const api = await SwaggerParser.validate(filePath) as any;

            const endpoints: OpenAPIEndpoint[] = [];

            // Extract endpoints from paths
            if (api && api.paths) {
                for (const [path, pathItem] of Object.entries(api.paths)) {
                    const methods = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'];

                    for (const method of methods) {
                        const operation = (pathItem as any)[method];
                        if (operation) {
                            endpoints.push(this.extractEndpoint(path, method, operation));
                        }
                    }
                }
            }

            logger.info(`Extracted ${endpoints.length} endpoints from OpenAPI spec`);
            return endpoints;
        } catch (error) {
            logger.error('Failed to parse OpenAPI spec', error as Error);
            throw error;
        }
    }

    /**
     * Extract endpoint information from OpenAPI operation
     */
    private extractEndpoint(path: string, method: string, operation: any): OpenAPIEndpoint {
        return {
            path,
            method: method.toUpperCase(),
            operationId: operation.operationId,
            summary: operation.summary,
            description: operation.description,
            parameters: operation.parameters || [],
            requestBody: operation.requestBody,
            responses: operation.responses || {},
            tags: operation.tags || []
        };
    }

    /**
     * Get example value for a schema
     */
    getExampleValue(schema: any): any {
        if (!schema) {
            return null;
        }

        if (schema.example !== undefined) {
            return schema.example;
        }

        if (schema.default !== undefined) {
            return schema.default;
        }

        switch (schema.type) {
            case 'string':
                return schema.format === 'email' ? 'test@example.com' :
                    schema.format === 'date' ? '2024-01-01' :
                        schema.format === 'date-time' ? '2024-01-01T00:00:00Z' :
                            'string';
            case 'number':
            case 'integer':
                return 123;
            case 'boolean':
                return true;
            case 'array':
                return schema.items ? [this.getExampleValue(schema.items)] : [];
            case 'object':
                if (schema.properties) {
                    const obj: any = {};
                    for (const [key, value] of Object.entries(schema.properties)) {
                        obj[key] = this.getExampleValue(value);
                    }
                    return obj;
                }
                return {};
            default:
                return null;
        }
    }
}
