import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GraphQLParser } from '../services/graphql/GraphQLParser';
import { buildGraphQLPlan, splitEndpointUrl } from '../generation/adapters/graphql';
import { reportSummary } from '../generation/vscode/reportSummary';
import { runGenerationForModel, toIncrementalProgress } from '../generation/vscode/runGeneration';
import { GeneratorConfigLoader } from '../generation/vscode/GeneratorConfigLoader';
import { FileUtils } from '../utils/fileUtils';
import { logger } from '../utils/logger';

/**
 * Command: karate-dsl.generateFromGraphQL
 * Accepts a .graphql/.gql file or URL for live introspection. Generation runs on the shared pipeline.
 */
export async function generateFromGraphQL(context: vscode.ExtensionContext): Promise<void> {
    let secretUrl: string | undefined;
    try {
        const sourceType = await vscode.window.showQuickPick(
            [
                { label: 'SDL File', description: 'Select a .graphql or .gql file', value: 'file' },
                { label: 'URL (Introspection)', description: 'Enter a GraphQL endpoint URL', value: 'url' }
            ],
            { placeHolder: 'Select GraphQL schema source' }
        );
        if (!sourceType) {return;}

        const workspaceRoot = FileUtils.getWorkspaceRoot();
        if (!workspaceRoot) {throw new Error('No workspace folder is open');}

        let schemaContent: string;
        let schemaName: string;
        let sourceRef: string;
        let endpoint: { baseUrl?: string; endpointPath: string } = { endpointPath: 'graphql' };

        if (sourceType.value === 'file') {
            const fileUri = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { 'GraphQL Schema': ['graphql', 'gql'] },
                title: 'Select GraphQL Schema File'
            });
            if (!fileUri || fileUri.length === 0) {return;}
            schemaContent = fs.readFileSync(fileUri[0].fsPath, 'utf-8');
            schemaName = path.basename(fileUri[0].fsPath, path.extname(fileUri[0].fsPath));
            sourceRef = path.basename(fileUri[0].fsPath);
        } else {
            const url = await vscode.window.showInputBox({
                prompt: 'Enter GraphQL endpoint URL for introspection',
                placeHolder: 'https://api.example.com/graphql',
                validateInput: value => {
                    try {
                        const u = new URL(value);
                        return /^https?:$/.test(u.protocol) ? null : 'Please enter an http(s) URL';
                    } catch {
                        return 'Please enter a valid URL';
                    }
                }
            });
            if (!url) {return;}
            secretUrl = url;
            schemaContent = await fetchIntrospection(url);
            // The host, query string and credentials of the URL are never part of a name, file or log.
            schemaName = 'graphql-api';
            sourceRef = 'GraphQL introspection';
            endpoint = splitEndpointUrl(url);
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Generating Karate tests from GraphQL...',
            cancellable: false
        }, async progress => {
            progress.report({ message: 'Parsing schema...' });
            const schema = new GraphQLParser().parse(schemaContent);
            if (schema.queries.length === 0 && schema.mutations.length === 0) {
                vscode.window.showWarningMessage('No Query or Mutation fields found in schema.');
                return;
            }

            const loaded = await GeneratorConfigLoader.load(workspaceRoot);
            for (const w of loaded.warnings) {logger.warn(`Generator config: ${w}`);}
            const plan = buildGraphQLPlan(schema, {
                config: loaded.config, name: schemaName, endpointPath: endpoint.endpointPath, baseUrl: endpoint.baseUrl
            });
            for (const w of plan.warnings) {logger.warn(`GraphQL: ${w}`);}

            const run = await runGenerationForModel({
                context, workspaceRoot, model: plan.model, sourceRef, mode: 'graphql', useAi: false,
                scenarios: plan.features, classpathFiles: plan.files, config: loaded.config,
                notes: plan.warnings, progress: toIncrementalProgress(progress)
            });
            logger.info(`Generated GraphQL tests: ${run.createdPaths.join(', ') || '(none)'}`);
            void reportSummary(run.summary, `GraphQL: ${sourceRef}`, run.createdPaths[0]);
        });
    } catch (error) {
        const message = redact(String((error as Error)?.message ?? error), secretUrl);
        logger.error('GraphQL generation failed', new Error(message));
        vscode.window.showErrorMessage(`Failed to generate from GraphQL: ${message}`);
    }
}

/** Removes the user's URL (it may carry a token) from text that is logged or shown. */
function redact(text: string, url: string | undefined): string {
    if (!url) {return text;}
    let out = text.split(url).join('[endpoint]');
    try {
        const u = new URL(url);
        for (const part of [u.search.replace(/^\?/, ''), u.password, u.username]) {
            if (part) {out = out.split(part).join('[redacted]');}
        }
    } catch { /* keep text */ }
    return out;
}

const TYPE_REF = 'kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }';
const INTROSPECTION_QUERY = `{
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind
      name
      enumValues { name }
      possibleTypes { name }
      inputFields { name defaultValue type { ${TYPE_REF} } }
      fields {
        name
        isDeprecated
        args { name defaultValue type { ${TYPE_REF} } }
        type { ${TYPE_REF} }
      }
    }
  }
}`;

/** Fetch the introspection schema from a GraphQL endpoint. The URL is used as given for the request only. */
async function fetchIntrospection(url: string): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const axios = require('axios');
    const response = await axios.post(url, { query: INTROSPECTION_QUERY }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
    });
    return JSON.stringify(response.data);
}
