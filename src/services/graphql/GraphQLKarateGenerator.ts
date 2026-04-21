import { GraphQLSchema, GraphQLField, GraphQLArg } from './GraphQLParser';
import { logger } from '../../utils/logger';

/**
 * GraphQLKarateGenerator — converts GraphQL operations to Karate DSL feature files.
 * Uses path('graphql') + request { query: '...', variables: {...} } pattern.
 */
export class GraphQLKarateGenerator {

    /**
     * Generate a complete Karate feature file from a GraphQL schema.
     */
    generate(schema: GraphQLSchema, endpointUrl: string = 'graphqlEndpoint'): string {
        const lines: string[] = [];

        lines.push(`Feature: ${schema.name}`);
        lines.push('');
        lines.push('  Background:');
        lines.push(`    * url ${endpointUrl}`);
        lines.push("    * def headers = { 'Content-Type': 'application/json' }");
        lines.push('');

        // Generate Query scenarios
        for (const query of schema.queries) {
            lines.push(...this.generateScenario(query, endpointUrl));
            lines.push('');
        }

        // Generate Mutation scenarios
        for (const mutation of schema.mutations) {
            lines.push(...this.generateScenario(mutation, endpointUrl));
            lines.push('');
        }

        logger.info(`GraphQLKarateGenerator: generated ${schema.queries.length + schema.mutations.length} scenarios`);
        return lines.join('\n');
    }

    private generateScenario(field: GraphQLField, endpointUrl: string): string[] {
        const lines: string[] = [];
        const isQuery = field.type === 'Query';
        const operationType = isQuery ? 'query' : 'mutation';
        const tag = isQuery ? '@positive @query' : '@positive @mutation';

        // Build the GraphQL query string
        const args = this.buildArgsString(field.args);
        const variables = this.buildVariablesString(field.args);
        const returnFields = field.returnFields.join(' ');

        const queryBody = args
            ? `${operationType} { ${field.name}(${args}) { ${returnFields} } }`
            : `${operationType} { ${field.name} { ${returnFields} } }`;

        lines.push(`  ${tag}`);
        lines.push(`  Scenario: ${field.type} ${field.name} - success`);
        lines.push("    Given path 'graphql'");
        lines.push('    And request');
        lines.push('    """');

        if (field.args.length > 0) {
            lines.push(`    { "query": "${this.escapeJson(queryBody)}", "variables": ${variables} }`);
        } else {
            lines.push(`    { "query": "${this.escapeJson(queryBody)}" }`);
        }

        lines.push('    """');
        lines.push('    When method POST');
        lines.push('    Then status 200');
        lines.push(`    And match response.data.${field.name} == '#present'`);
        lines.push("    And match response.errors == '#notpresent'");

        // Add error scenario for operations with required args
        const requiredArgs = field.args.filter(a => a.required);
        if (requiredArgs.length > 0) {
            lines.push('');
            lines.push(`  @negative @${operationType}`);
            lines.push(`  Scenario: ${field.type} ${field.name} - missing required arguments`);
            lines.push("    Given path 'graphql'");
            lines.push('    And request');
            lines.push('    """');
            lines.push(`    { "query": "${this.escapeJson(`${operationType} { ${field.name} { ${returnFields} } }`)}" }`);
            lines.push('    """');
            lines.push('    When method POST');
            lines.push('    Then status 200');
            lines.push("    And match response.errors == '#present'");
            lines.push("    And match response.errors[0].message == '#present'");
        }

        return lines;
    }

    private buildArgsString(args: GraphQLArg[]): string {
        if (args.length === 0) {
            return '';
        }
        return args.map(a => `${a.name}: $${a.name}`).join(', ');
    }

    private buildVariablesString(args: GraphQLArg[]): string {
        if (args.length === 0) {
            return '{}';
        }

        const vars: Record<string, any> = {};
        for (const arg of args) {
            vars[arg.name] = this.getDefaultValue(arg);
        }
        return JSON.stringify(vars);
    }

    private getDefaultValue(arg: GraphQLArg): any {
        if (arg.defaultValue) {
            return arg.defaultValue;
        }

        const type = arg.type.replace(/[!\[\]]/g, '');
        switch (type) {
            case 'String':
                return 'test-value';
            case 'Int':
                return 1;
            case 'Float':
                return 1.0;
            case 'Boolean':
                return true;
            case 'ID':
                return 'test-id-123';
            default:
                return {};
        }
    }

    private escapeJson(str: string): string {
        return str.replace(/"/g, '\\"');
    }
}
