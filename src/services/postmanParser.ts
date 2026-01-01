import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

/**
 * Postman Collection v2.1 interfaces
 */
export interface PostmanCollection {
    info: {
        name: string;
        description?: string;
        schema: string;
    };
    item: PostmanItem[];
    variable?: PostmanVariable[];
    auth?: PostmanAuth;
    event?: PostmanEvent[];
}

export interface PostmanItem {
    name: string;
    description?: string;
    item?: PostmanItem[]; // Nested folders
    request?: PostmanRequest;
    event?: PostmanEvent[];
}

export interface PostmanRequest {
    method: string;
    header?: PostmanHeader[];
    url: string | PostmanUrl;
    body?: PostmanBody;
    auth?: PostmanAuth;
    description?: string;
}

export interface PostmanUrl {
    raw: string;
    protocol?: string;
    host?: string[];
    path?: string[];
    query?: PostmanQueryParam[];
    variable?: PostmanVariable[];
}

export interface PostmanHeader {
    key: string;
    value: string;
    disabled?: boolean;
    description?: string;
}

export interface PostmanQueryParam {
    key: string;
    value: string;
    disabled?: boolean;
    description?: string;
}

export interface PostmanBody {
    mode: 'raw' | 'urlencoded' | 'formdata' | 'file' | 'graphql';
    raw?: string;
    urlencoded?: Array<{ key: string; value: string; disabled?: boolean }>;
    formdata?: Array<{ key: string; value: string; type?: string; disabled?: boolean }>;
    options?: {
        raw?: {
            language?: string;
        };
    };
}

export interface PostmanAuth {
    type: 'basic' | 'bearer' | 'oauth2' | 'apikey' | 'noauth';
    basic?: Array<{ key: string; value: string }>;
    bearer?: Array<{ key: string; value: string }>;
    oauth2?: Array<{ key: string; value: string }>;
    apikey?: Array<{ key: string; value: string }>;
}

export interface PostmanVariable {
    key: string;
    value: string;
    type?: string;
    disabled?: boolean;
}

export interface PostmanEvent {
    listen: 'prerequest' | 'test';
    script: {
        type: string;
        exec: string[];
    };
}

export interface PostmanEnvironment {
    name: string;
    values: Array<{
        key: string;
        value: string;
        enabled: boolean;
        type?: string;
    }>;
}

/**
 * Parser for Postman collections and environments
 */
export class PostmanParser {

    /**
     * Parse a Postman collection from file
     */
    public parseCollectionFile(filePath: string): PostmanCollection {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const json = JSON.parse(content);

            // Validate it's a Postman collection
            if (!json.info || !json.info.schema) {
                throw new Error('Invalid Postman collection format');
            }

            logger.info(`Parsed Postman collection: ${json.info.name}`);
            return json as PostmanCollection;
        } catch (error) {
            logger.error('Failed to parse Postman collection', error as Error);
            throw error;
        }
    }

    /**
     * Parse a Postman environment from file
     */
    public parseEnvironmentFile(filePath: string): PostmanEnvironment {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const json = JSON.parse(content);

            if (!json.name || !json.values) {
                throw new Error('Invalid Postman environment format');
            }

            logger.info(`Parsed Postman environment: ${json.name}`);
            return json as PostmanEnvironment;
        } catch (error) {
            logger.error('Failed to parse Postman environment', error as Error);
            throw error;
        }
    }

    /**
     * Extract all requests from collection (flattens nested folders)
     */
    public extractRequests(collection: PostmanCollection): Array<{ request: PostmanRequest; path: string[] }> {
        const requests: Array<{ request: PostmanRequest; path: string[] }> = [];

        const traverse = (items: PostmanItem[], currentPath: string[] = []) => {
            for (const item of items) {
                if (item.request) {
                    // It's a request
                    requests.push({
                        request: item.request,
                        path: [...currentPath, item.name]
                    });
                } else if (item.item) {
                    // It's a folder, recurse
                    traverse(item.item, [...currentPath, item.name]);
                }
            }
        };

        traverse(collection.item);
        return requests;
    }

    /**
     * Extract variables from collection
     */
    public extractVariables(collection: PostmanCollection): Map<string, string> {
        const variables = new Map<string, string>();

        if (collection.variable) {
            for (const variable of collection.variable) {
                if (!variable.disabled) {
                    variables.set(variable.key, variable.value);
                }
            }
        }

        return variables;
    }

    /**
     * Extract variables from environment
     */
    public extractEnvironmentVariables(environment: PostmanEnvironment): Map<string, string> {
        const variables = new Map<string, string>();

        for (const value of environment.values) {
            if (value.enabled) {
                variables.set(value.key, value.value);
            }
        }

        return variables;
    }

    /**
     * Parse URL (handles both string and object formats)
     */
    public parseUrl(url: string | PostmanUrl): { raw: string; path: string; query: PostmanQueryParam[] } {
        if (typeof url === 'string') {
            return {
                raw: url,
                path: url,
                query: []
            };
        }

        return {
            raw: url.raw,
            path: url.path ? url.path.join('/') : url.raw,
            query: url.query || []
        };
    }

    /**
     * Extract pre-request script
     */
    public extractPreRequestScript(item: PostmanItem): string | undefined {
        const preRequestEvent = item.event?.find(e => e.listen === 'prerequest');
        return preRequestEvent ? preRequestEvent.script.exec.join('\n') : undefined;
    }

    /**
     * Extract test script
     */
    public extractTestScript(item: PostmanItem): string | undefined {
        const testEvent = item.event?.find(e => e.listen === 'test');
        return testEvent ? testEvent.script.exec.join('\n') : undefined;
    }

    /**
     * Get collection-level auth
     */
    public getCollectionAuth(collection: PostmanCollection): PostmanAuth | undefined {
        return collection.auth;
    }

    /**
     * Validate collection structure
     */
    public validateCollection(collection: any): { valid: boolean; errors: string[] } {
        const errors: string[] = [];

        if (!collection.info) {
            errors.push('Missing collection info');
        }

        if (!collection.info?.schema) {
            errors.push('Missing schema version');
        }

        if (!collection.item || !Array.isArray(collection.item)) {
            errors.push('Missing or invalid items array');
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    /**
     * Get collection statistics
     */
    public getCollectionStats(collection: PostmanCollection): {
        totalRequests: number;
        totalFolders: number;
        methods: Map<string, number>;
    } {
        let totalRequests = 0;
        let totalFolders = 0;
        const methods = new Map<string, number>();

        const traverse = (items: PostmanItem[]) => {
            for (const item of items) {
                if (item.request) {
                    totalRequests++;
                    const method = item.request.method.toUpperCase();
                    methods.set(method, (methods.get(method) || 0) + 1);
                } else if (item.item) {
                    totalFolders++;
                    traverse(item.item);
                }
            }
        };

        traverse(collection.item);

        return { totalRequests, totalFolders, methods };
    }
}
