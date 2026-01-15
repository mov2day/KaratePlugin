import * as vscode from 'vscode';
import * as path from 'path';
import { OpenAPIParser } from '../services/openApiParser';
import { ConfluenceClient } from '../services/confluenceClient';
import { ConfluenceParser } from '../services/confluenceParser';
import { KarateGenerator } from '../services/karateGenerator';
import { ConfigManager } from '../utils/configManager';
import { FileUtils } from '../utils/fileUtils';
import { logger } from '../utils/logger';
import { KarateScenario, KarateStep, OpenAPIEndpoint } from '../types';

export async function generateCombined(context: vscode.ExtensionContext): Promise<void> {
    try {
        // Step 1: Select OpenAPI spec
        const fileUri = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Select OpenAPI Spec',
            filters: {
                'OpenAPI Spec': ['json', 'yaml', 'yml']
            }
        });

        if (!fileUri || fileUri.length === 0) {
            return;
        }

        const specPath = fileUri[0].fsPath;

        // Step 2: Get Confluence page
        const input = await vscode.window.showInputBox({
            prompt: 'Enter Confluence page URL or page ID',
            placeHolder: 'https://yourcompany.atlassian.net/wiki/spaces/SPACE/pages/123456 or 123456'
        });

        if (!input) {
            return;
        }

        let pageId = input.trim();
        if (input.startsWith('http')) {
            const extractedId = ConfluenceClient.extractPageIdFromUrl(input);
            if (!extractedId) {
                vscode.window.showErrorMessage('Could not extract page ID from URL');
                return;
            }
            pageId = extractedId;
        }

        // Step 3: Process both sources
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Generating combined Karate tests',
            cancellable: false
        }, async (progress) => {
            // Parse OpenAPI
            progress.report({ increment: 20, message: 'Parsing OpenAPI specification...' });
            const openApiParser = new OpenAPIParser();
            const endpoints = await openApiParser.parseSpec(specPath);

            // Fetch Confluence page
            progress.report({ increment: 20, message: 'Fetching Confluence page...' });
            const baseUrl = ConfigManager.getConfluenceBaseUrl();
            const email = ConfigManager.getConfluenceEmail();
            const apiToken = await ConfigManager.getConfluenceApiToken(context);
            const authType = vscode.workspace.getConfiguration('karateDsl.confluence').get<'basic' | 'bearer'>('authType', 'basic');

            const confluenceClient = new ConfluenceClient(baseUrl, email || "", apiToken, authType);
            const page = await confluenceClient.getPageById(pageId);

            // Parse Confluence content
            progress.report({ increment: 20, message: 'Parsing Confluence content...' });
            const confluenceParser = new ConfluenceParser();
            const testData = confluenceParser.parsePageContent(page);

            // Generate combined tests
            progress.report({ increment: 30, message: 'Generating combined tests...' });
            const generator = new KarateGenerator();
            const scenarios: KarateScenario[] = [];

            // Map Confluence test cases to OpenAPI endpoints
            const endpointMap = mapTestCasesToEndpoints(testData.testCases, endpoints);

            // Generate scenarios for mapped test cases
            for (const [testCase, endpoint] of endpointMap) {
                if (endpoint) {
                    // Generate OpenAPI-based scenario with Confluence context
                    const apiScenario = createEnhancedScenario(testCase, endpoint, openApiParser);
                    scenarios.push(apiScenario);
                } else {
                    // Generate Confluence-only scenario
                    const steps: KarateStep[] = testCase.steps.map((step: string, i: number) => ({
                        keyword: i === 0 ? 'Given' : 'And',
                        text: `# ${step}`
                    }));

                    scenarios.push({
                        name: testCase.name,
                        description: testCase.description,
                        steps
                    });
                }
            }

            // Add remaining OpenAPI endpoints not covered by Confluence
            const coveredEndpoints = new Set(
                Array.from(endpointMap.values()).filter((e): e is OpenAPIEndpoint => e !== null).map(e => e.operationId || `${e.method}${e.path}`)
            );

            for (const endpoint of endpoints) {
                const endpointKey = endpoint.operationId || `${endpoint.method}${endpoint.path}`;
                if (!coveredEndpoints.has(endpointKey)) {
                    const feature = generator.generateFromOpenAPI([endpoint], 'temp');
                    scenarios.push(...feature.scenarios);
                }
            }

            // Create combined feature
            const specFileName = path.basename(specPath, path.extname(specPath));
            const feature = {
                name: `${specFileName} - ${page.title}`,
                description: 'Combined tests from OpenAPI specification and Confluence requirements',
                background: generator.generateBackground(),
                scenarios
            };

            let featureContent = generator.featureToString(feature);

            // Optionally enhance with Copilot
            const config = vscode.workspace.getConfiguration('karateDsl');
            const useCopilot = config.get<boolean>('useCopilot', false);

            if (useCopilot) {
                progress.report({ increment: 5, message: 'Enhancing with GitHub Copilot...' });

                const { CopilotService } = await import('../services/copilotService');
                const isAvailable = await CopilotService.isCopilotAvailable();

                if (isAvailable) {
                    try {
                        const context = `Combined: OpenAPI ${specFileName} + Confluence ${page.title}, ${scenarios.length} scenarios`;

                        // Prepare full context
                        const fs = await import('fs');
                        const fullSpecContent = fs.readFileSync(specPath, 'utf-8');
                        const pageContent = page.body.storage?.value || page.body.view?.value || '';

                        featureContent = await CopilotService.enhanceKarateTestComprehensive(
                            featureContent,
                            context,
                            {
                                type: 'combined',
                                openApiSpec: fullSpecContent,
                                confluencePage: pageContent,
                                requirements: testData.requirements
                            }
                        );
                        logger.info('Enhanced combined tests with Copilot');
                    } catch (error) {
                        logger.warn('Copilot enhancement failed, using original tests', error as Error);
                    }
                }
            }

            // Save file
            progress.report({ increment: 10, message: 'Saving feature file...' });
            const outputPath = FileUtils.resolveOutputPath();
            const outputFile = path.join(outputPath, `${specFileName}_combined.feature`);
            const uniqueFile = FileUtils.getUniqueFilename(outputFile);

            FileUtils.writeFile(uniqueFile, featureContent);

            // Show success
            const openFile = 'Open File';
            const result = await vscode.window.showInformationMessage(
                `Generated combined Karate tests: ${path.basename(uniqueFile)} (${scenarios.length} scenarios)`,
                openFile
            );

            if (result === openFile) {
                const doc = await vscode.workspace.openTextDocument(uniqueFile);
                await vscode.window.showTextDocument(doc);
            }

            logger.info(`Successfully generated combined tests: ${uniqueFile}`);
        });

    } catch (error) {
        logger.error('Failed to generate combined tests', error as Error);
        vscode.window.showErrorMessage(`Failed to generate combined tests: ${(error as Error).message}`);
    }
}

/**
 * Map Confluence test cases to OpenAPI endpoints
 */
function mapTestCasesToEndpoints(
    testCases: any[],
    endpoints: OpenAPIEndpoint[]
): Map<any, OpenAPIEndpoint | null> {
    const map = new Map();

    for (const testCase of testCases) {
        let matchedEndpoint: OpenAPIEndpoint | null = null;

        // Try to match by name/description
        const testCaseLower = (testCase.name + ' ' + (testCase.description || '')).toLowerCase();

        for (const endpoint of endpoints) {
            const endpointText = (
                endpoint.summary + ' ' +
                endpoint.description + ' ' +
                endpoint.operationId + ' ' +
                endpoint.path
            ).toLowerCase();

            // Simple keyword matching
            if (testCaseLower.includes(endpoint.method.toLowerCase()) ||
                testCaseLower.includes(endpoint.path.split('/').pop() || '')) {
                matchedEndpoint = endpoint;
                break;
            }
        }

        map.set(testCase, matchedEndpoint);
    }

    return map;
}

/**
 * Create enhanced scenario combining Confluence test case and OpenAPI endpoint
 */
function createEnhancedScenario(
    testCase: any,
    endpoint: OpenAPIEndpoint,
    parser: OpenAPIParser
): KarateScenario {
    const steps: KarateStep[] = [];

    // Add Confluence context as comments
    steps.push({
        keyword: 'Given',
        text: `# Test Case: ${testCase.name}`
    });

    if (testCase.description) {
        steps.push({
            keyword: 'And',
            text: `# ${testCase.description}`
        });
    }

    // Add OpenAPI-based steps
    steps.push({
        keyword: 'And',
        text: `url baseUrl + '${endpoint.path}'`
    });

    // Add parameters
    const pathParams = endpoint.parameters?.filter(p => p.in === 'path') || [];
    for (const param of pathParams) {
        const exampleValue = parser.getExampleValue(param.schema);
        steps.push({
            keyword: 'And',
            text: `path '${param.name}' = ${JSON.stringify(exampleValue)}`
        });
    }

    // Add request
    if (['POST', 'PUT', 'PATCH'].includes(endpoint.method) && endpoint.requestBody) {
        const content = endpoint.requestBody.content;
        if (content && content['application/json']) {
            const schema = content['application/json'].schema;
            const exampleBody = parser.getExampleValue(schema);
            steps.push({
                keyword: 'And',
                text: 'request',
                docString: JSON.stringify(exampleBody, null, 2)
            });
        }
    }

    steps.push({
        keyword: 'When',
        text: `method ${endpoint.method.toLowerCase()}`
    });

    steps.push({
        keyword: 'Then',
        text: 'status 200'
    });

    // Add expected result from Confluence
    if (testCase.expectedResult) {
        steps.push({
            keyword: 'And',
            text: `# Expected: ${testCase.expectedResult}`
        });
    }

    return {
        name: testCase.name,
        description: `${endpoint.method} ${endpoint.path}`,
        steps,
        tags: endpoint.tags
    };
}
