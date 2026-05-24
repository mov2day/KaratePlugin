import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { CoverageAnalyzer } from '../../services/coverageAnalyzer';
import { CopilotService } from '../../services/copilotService';

suite('CoverageAnalyzer Test Suite', () => {
    const tempDir = path.join(__dirname, 'temp_coverage_analyzer');
    const specPath = path.join(tempDir, 'petstore.json');

    setup(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        fs.mkdirSync(tempDir, { recursive: true });

        const spec = {
            openapi: '3.0.0',
            info: {
                title: 'Petstore',
                version: '1.0.0'
            },
            paths: {
                '/pets/{petId}': {
                    get: {
                        operationId: 'getPet',
                        parameters: [{
                            name: 'petId',
                            in: 'path',
                            required: true,
                            schema: { type: 'string' }
                        }],
                        responses: {
                            '200': {
                                description: 'Pet response'
                            }
                        }
                    }
                }
            }
        };

        fs.writeFileSync(specPath, JSON.stringify(spec), 'utf-8');
    });

    teardown(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('falls back to default missing tests when Copilot is unavailable', async () => {
        const originalIsCopilotAvailable = CopilotService.isCopilotAvailable;
        (CopilotService as any).isCopilotAvailable = async () => false;

        try {
            const analyzer = new CoverageAnalyzer();
            const report = await analyzer.analyzeCoverageWithFiles(specPath, []);
            assert.strictEqual(report.uncoveredEndpoints.length, 1);
            assert.deepStrictEqual(report.uncoveredEndpoints[0].missingTests, [
                'Basic success test (200 OK)',
                'Error handling test (404, 400, 500)',
                'Authentication test'
            ]);
        } finally {
            (CopilotService as any).isCopilotAvailable = originalIsCopilotAvailable;
        }
    });
});
