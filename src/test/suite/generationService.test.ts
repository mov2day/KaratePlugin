import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { GenerationService } from '../../services/GenerationService';
import { SpecHashManager } from '../../services/specHashManager';
import { HistoryManager } from '../../services/historyManager';
import { FileUtils } from '../../utils/fileUtils';

suite('GenerationService Test Suite', () => {
    let service: GenerationService;
    let context: vscode.ExtensionContext;
    const tempDir = path.join(__dirname, 'temp_gen_test');
    const openApiFile = path.join(tempDir, 'petstore.json');

    setup(async () => {
        // Create temp dir
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        // Create sample OpenAPI file
        const openApiSpec = {
            openapi: '3.0.0',
            info: { title: 'Petstore', version: '1.0.0' },
            paths: {
                '/pets': {
                    get: {
                        summary: 'List all pets',
                        responses: {
                            '200': {
                                description: 'A paged array of pets',
                                content: {
                                    'application/json': {
                                        schema: {
                                            type: 'array',
                                            items: { type: 'string' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        };
        fs.writeFileSync(openApiFile, JSON.stringify(openApiSpec));

        // Mock Context
        context = {
            globalState: {
                get: (key: string, defaultValue?: any) => defaultValue,
                update: (key: string, value: any) => Promise.resolve(),
            },
            workspaceState: {
                get: (key: string, defaultValue?: any) => defaultValue,
                update: (key: string, value: any) => Promise.resolve(),
            },
            extensionPath: __dirname,
            storagePath: tempDir,
            globalStoragePath: tempDir,
            logPath: tempDir,
            subscriptions: [],
        } as unknown as vscode.ExtensionContext;

        const historyManager = new HistoryManager(context);
        const specHashManager = new SpecHashManager(context);
        service = new GenerationService(context, historyManager, specHashManager);
    });

    teardown(() => {
        // Cleanup temp dir
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('generateFromOpenAPI should generate files from spec', async () => {
        const originalResolveOutputPath = FileUtils.resolveOutputPath;
        (FileUtils as any).resolveOutputPath = () => tempDir;

        const progressCallback = (msg: string, increment: number) => {
            console.log(`Progress: ${msg} (${increment}%)`);
        };

        try {
            const result = await service.generateFromOpenAPI({
                filePath: openApiFile,
                useCopilot: false,
                scenarioTypes: ['positive']
            }, progressCallback);

            assert.ok(result.files.length > 0, 'Should generate at least one file');
            assert.ok(result.content.length > 0, 'Should return content');
        } finally {
            (FileUtils as any).resolveOutputPath = originalResolveOutputPath;
        }
    });

    // We cannot easily test Confluence without mocking network calls, which requires dependnecy injection.
    // Future work: Refactor GenerationService to accept ConfluenceClient as dependency.
});
