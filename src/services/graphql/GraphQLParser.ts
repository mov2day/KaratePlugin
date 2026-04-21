import { logger } from '../../utils/logger';

/**
 * Parsed GraphQL field from SDL or introspection.
 */
export interface GraphQLField {
    name: string;
    type: 'Query' | 'Mutation';
    args: GraphQLArg[];
    returnType: string;
    returnFields: string[];
}

export interface GraphQLArg {
    name: string;
    type: string;
    required: boolean;
    defaultValue?: string;
}

export interface GraphQLSchema {
    name: string;
    queries: GraphQLField[];
    mutations: GraphQLField[];
}

/**
 * GraphQLParser — extracts Query and Mutation fields from SDL or introspection JSON.
 * Subscriptions are explicitly excluded per spec §4.1.2.
 */
export class GraphQLParser {

    /**
     * Parse from SDL string (.graphql / .gql content)
     */
    parseSDL(sdl: string): GraphQLSchema {
        const schema: GraphQLSchema = {
            name: 'GraphQL API',
            queries: [],
            mutations: []
        };

        // Extract type blocks
        const typeBlocks = this.extractTypeBlocks(sdl);

        for (const block of typeBlocks) {
            if (block.name === 'Query') {
                schema.queries = this.parseFields(block.body, 'Query');
            } else if (block.name === 'Mutation') {
                schema.mutations = this.parseFields(block.body, 'Mutation');
            }
            // Skip Subscription intentionally
        }

        logger.info(`GraphQLParser: parsed ${schema.queries.length} queries, ${schema.mutations.length} mutations`);
        return schema;
    }

    /**
     * Parse from introspection JSON (__schema format)
     */
    parseIntrospection(json: any): GraphQLSchema {
        const schema: GraphQLSchema = {
            name: 'GraphQL API',
            queries: [],
            mutations: []
        };

        const schemaData = json.__schema || json.data?.__schema || json;

        // Find Query and Mutation type names
        const queryTypeName = schemaData.queryType?.name || 'Query';
        const mutationTypeName = schemaData.mutationType?.name || 'Mutation';

        const types = schemaData.types || [];

        for (const type of types) {
            if (type.name === queryTypeName && type.fields) {
                schema.queries = type.fields.map((f: any) => this.introspectionFieldToGraphQL(f, 'Query'));
            } else if (type.name === mutationTypeName && type.fields) {
                schema.mutations = type.fields.map((f: any) => this.introspectionFieldToGraphQL(f, 'Mutation'));
            }
        }

        logger.info(`GraphQLParser (introspection): ${schema.queries.length} queries, ${schema.mutations.length} mutations`);
        return schema;
    }

    /**
     * Auto-detect format and parse
     */
    parse(content: string): GraphQLSchema {
        const trimmed = content.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                const json = JSON.parse(trimmed);
                return this.parseIntrospection(json);
            } catch {
                // Not JSON — try as SDL
            }
        }
        return this.parseSDL(content);
    }

    private extractTypeBlocks(sdl: string): Array<{ name: string; body: string }> {
        const blocks: Array<{ name: string; body: string }> = [];

        // Match: type TypeName { ... }
        // Also handle: type TypeName @directive { ... }
        const typeRegex = /type\s+(\w+)(?:\s+@\w+(?:\([^)]*\))?)*\s*\{([^}]*)\}/g;
        let match: RegExpExecArray | null;

        while ((match = typeRegex.exec(sdl)) !== null) {
            blocks.push({
                name: match[1],
                body: match[2]
            });
        }

        // Also handle extend type
        const extendRegex = /extend\s+type\s+(\w+)\s*\{([^}]*)\}/g;
        let extMatch: RegExpExecArray | null;
        while ((extMatch = extendRegex.exec(sdl)) !== null) {
            const existing = blocks.find(b => b.name === extMatch![1]);
            if (existing) {
                existing.body += '\n' + extMatch[2];
            } else {
                blocks.push({
                    name: extMatch[1],
                    body: extMatch[2]
                });
            }
        }

        return blocks;
    }

    private parseFields(body: string, type: 'Query' | 'Mutation'): GraphQLField[] {
        const fields: GraphQLField[] = [];
        const lines = body.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

        for (const line of lines) {
            // Match: fieldName(arg1: Type!, arg2: Type): ReturnType
            // Or: fieldName: ReturnType
            const fieldMatch = line.match(/^(\w+)(?:\(([^)]*)\))?\s*:\s*(.+?)(?:\s*@.*)?$/);
            if (!fieldMatch) {
                continue;
            }

            const [, name, argsStr, returnTypeStr] = fieldMatch;
            const args = argsStr ? this.parseArgs(argsStr) : [];
            const returnType = returnTypeStr.trim();
            const returnFields = this.extractReturnFields(returnType);

            fields.push({ name, type, args, returnType, returnFields });
        }

        return fields;
    }

    private parseArgs(argsStr: string): GraphQLArg[] {
        const args: GraphQLArg[] = [];

        // Split by comma, handling nested types
        const parts = this.splitArgs(argsStr);

        for (const part of parts) {
            const match = part.trim().match(/^(\w+)\s*:\s*(.+?)(?:\s*=\s*(.+))?$/);
            if (match) {
                const [, name, typeStr, defaultValue] = match;
                const required = typeStr.trim().endsWith('!');
                const type = typeStr.trim().replace(/!$/, '');
                args.push({ name, type, required, defaultValue });
            }
        }

        return args;
    }

    private splitArgs(argsStr: string): string[] {
        const parts: string[] = [];
        let depth = 0;
        let current = '';

        for (const char of argsStr) {
            if (char === '[' || char === '(') {
                depth++;
            }
            if (char === ']' || char === ')') {
                depth--;
            }
            if (char === ',' && depth === 0) {
                parts.push(current);
                current = '';
            } else {
                current += char;
            }
        }
        if (current.trim()) {
            parts.push(current);
        }

        return parts;
    }

    private extractReturnFields(returnType: string): string[] {
        // For scalar types, return the type name
        // For object types, we can't know the fields from the type reference alone
        // Return generic field placeholders
        const cleanType = returnType.replace(/[!\[\]]/g, '').trim();

        const scalarTypes = ['String', 'Int', 'Float', 'Boolean', 'ID'];
        if (scalarTypes.includes(cleanType)) {
            return [cleanType.toLowerCase()];
        }

        // For complex types, suggest common fields
        return ['id', '__typename'];
    }

    private introspectionFieldToGraphQL(field: any, type: 'Query' | 'Mutation'): GraphQLField {
        const args: GraphQLArg[] = (field.args || []).map((arg: any) => ({
            name: arg.name,
            type: this.introspectionTypeToString(arg.type),
            required: arg.type?.kind === 'NON_NULL',
            defaultValue: arg.defaultValue
        }));

        const returnType = this.introspectionTypeToString(field.type);
        const returnFields = this.extractReturnFields(returnType);

        return {
            name: field.name,
            type,
            args,
            returnType,
            returnFields
        };
    }

    private introspectionTypeToString(type: any): string {
        if (!type) {
            return 'Unknown';
        }
        if (type.kind === 'NON_NULL') {
            return this.introspectionTypeToString(type.ofType) + '!';
        }
        if (type.kind === 'LIST') {
            return '[' + this.introspectionTypeToString(type.ofType) + ']';
        }
        return type.name || 'Unknown';
    }
}
