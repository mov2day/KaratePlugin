import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GraphQLParser } from '../services/graphql/GraphQLParser';
import { GraphQLKarateGenerator } from '../services/graphql/GraphQLKarateGenerator';
import { logger } from '../utils/logger';

/**
 * Command: karate-dsl.generateFromGraphQL
 * Accepts a .graphql/.gql file or URL for live introspection.
 */
export async function generateFromGraphQL(): Promise<void> {
    try {
        // Ask user for source
        const sourceType = await vscode.window.showQuickPick(
            [
                { label: 'SDL File', description: 'Select a .graphql or .gql file', value: 'file' },
                { label: 'URL (Introspection)', description: 'Enter a GraphQL endpoint URL', value: 'url' }
            ],
            { placeHolder: 'Select GraphQL schema source' }
        );

        if (!sourceType) {
            return;
        }

        let schemaContent: string;
        let schemaName: string;

        if (sourceType.value === 'file') {
            const fileUri = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { 'GraphQL Schema': ['graphql', 'gql'] },
                title: 'Select GraphQL Schema File'
            });

            if (!fileUri || fileUri.length === 0) {
                return;
            }

            schemaContent = fs.readFileSync(fileUri[0].fsPath, 'utf-8');
            schemaName = path.basename(fileUri[0].fsPath, path.extname(fileUri[0].fsPath));
        } else {
            const url = await vscode.window.showInputBox({
                prompt: 'Enter GraphQL endpoint URL for introspection',
                placeHolder: 'https://api.example.com/graphql',
                validateInput: (value) => {
                    try {
                        new URL(value);
                        return null;
                    } catch {
                        return 'Please enter a valid URL';
                    }
                }
            });

            if (!url) {
                return;
            }

            schemaContent = await fetchIntrospection(url);
            schemaName = new URL(url).hostname.replace(/\./g, '-');
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Generating Karate tests from GraphQL...',
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 30, message: 'Parsing schema...' });

            const parser = new GraphQLParser();
            const schema = parser.parse(schemaContent);

            if (schema.queries.length === 0 && schema.mutations.length === 0) {
                vscode.window.showWarningMessage('No Query or Mutation fields found in schema.');
                return;
            }

            progress.report({ increment: 50, message: 'Generating tests...' });

            const generator = new GraphQLKarateGenerator();
            const featureContent = generator.generate(schema);

            // Save feature file
            const { FileUtils } = await import('../utils/fileUtils');
            const outputPath = FileUtils.resolveOutputPath();
            const outputFile = path.join(outputPath, `${schemaName}-graphql.feature`);
            const uniqueFile = FileUtils.getUniqueFilename(outputFile);
            FileUtils.writeFile(uniqueFile, featureContent);

            progress.report({ increment: 100 });

            const totalOps = schema.queries.length + schema.mutations.length;
            const action = await vscode.window.showInformationMessage(
                `✅ Generated ${totalOps} GraphQL test scenarios (${schema.queries.length} queries, ${schema.mutations.length} mutations)`,
                'Open File',
                'Dismiss'
            );

            if (action === 'Open File') {
                const doc = await vscode.workspace.openTextDocument(uniqueFile);
                await vscode.window.showTextDocument(doc);
            }
        });
    } catch (error) {
        logger.error('GraphQL generation failed', error as Error);
        vscode.window.showErrorMessage(`Failed to generate from GraphQL: ${error}`);
    }
}

/**
 * Fetch introspection schema from a GraphQL endpoint.
 */
async function fetchIntrospection(url: string): Promise<string> {
    const axios = require('axios');

    const introspectionQuery = `{
        __schema {
            queryType { name }
            mutationType { name }
            types {
                name
                kind
                fields {
                    name
                    args {
                        name
                        type { kind name ofType { kind name ofType { kind name } } }
                        defaultValue
                    }
                    type { kind name ofType { kind name ofType { kind name } } }
                }
            }
        }
    }`;

    const response = await axios.post(url, {
        query: introspectionQuery
    }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
    });

    return JSON.stringify(response.data);
}
