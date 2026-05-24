import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { KarateMcpToolService } from '../../services/mcp/KarateMcpToolService';
import { AIProviderRegistry } from '../../services/ai/AIProviderRegistry';
import { TestExecutionResult } from '../../types';

function makeExecutionResult(featurePath: string): TestExecutionResult {
    return {
        id: 'run-1',
        timestamp: Date.now(),
        options: {
            type: 'feature',
            target: featurePath,
            buildTool: 'cli'
        },
        summary: {
            totalFeatures: 1,
            totalScenarios: 1,
            passed: 1,
            failed: 0,
            skipped: 0,
            passPercentage: 100,
            executionTime: '0.10s'
        },
        features: [{
            name: 'pets',
            relativePath: 'src/test/karate/pets.feature',
            absolutePath: featurePath,
            scenarios: [{
                name: 'list pets',
                line: 3,
                status: 'passed',
                duration: 100,
                steps: [{
                    keyword: 'When',
                    text: 'method get',
                    status: 'passed',
                    duration: 100
                }]
            }],
            duration: 100,
            passed: 1,
            failed: 0,
            skipped: 0,
            status: 'passed'
        }],
        duration: 100,
        status: 'success'
    };
}

suite('KarateMcpToolService', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karate-mcp-tool-test-'));
    const workspaceRoot = tempDir;
    const specPath = path.join(tempDir, 'openapi.json');
    const featureDir = path.join(tempDir, 'features');
    const featurePath = path.join(featureDir, 'pets.feature');

    setup(() => {
        fs.mkdirSync(tempDir, { recursive: true });
        fs.mkdirSync(featureDir, { recursive: true });
        fs.writeFileSync(specPath, JSON.stringify({
            openapi: '3.0.0',
            info: { title: 'Pets', version: '1.0.0' },
            paths: {
                '/pets': {
                    get: {
                        operationId: 'listPets',
                        responses: {
                            '200': { description: 'ok' }
                        }
                    }
                }
            }
        }), 'utf-8');

        fs.writeFileSync(featurePath, `Feature: pets

Scenario: list pets
  Given path 'pets'
  When method get
  Then status 500
`, 'utf-8');
    });

    teardown(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('generate/check coverage enforce workspace path guard and structured output', async () => {
        const service = new KarateMcpToolService({} as vscode.ExtensionContext, workspaceRoot);
        (service as any).getWorkspaceRoot = () => workspaceRoot;

        const blocked = await service.generateTests({ spec_path: '../outside.yaml' });
        assert.strictEqual(blocked.ok, false);

        const generated = await service.generateTests({ spec_path: specPath });
        assert.strictEqual(generated.ok, true);
        assert.ok(Array.isArray(generated.data.files));

        const coverage = await service.checkCoverage({
            spec_path: specPath,
            feature_dir: featureDir
        });
        assert.strictEqual(coverage.ok, true);
        assert.ok((coverage.data.percent as number) >= 0);
        assert.ok(Array.isArray(coverage.data.tested));
        assert.ok(Array.isArray(coverage.data.untested));
    });

    test('repair_test supports dry-run and apply modes', async () => {
        const service = new KarateMcpToolService({} as vscode.ExtensionContext, workspaceRoot);
        (service as any).getWorkspaceRoot = () => workspaceRoot;
        const originalGetInstance = AIProviderRegistry.getInstance;
        (AIProviderRegistry as any).getInstance = () => ({
            complete: async () => `Scenario: list pets
  Given path 'pets'
  When method get
  Then status 200`
        });

        const originalContent = fs.readFileSync(featurePath, 'utf-8');

        try {
            const dryRun = await service.repairTest({
                feature_path: featurePath,
                scenario_name: 'list pets',
                error_message: 'status code was: 500, expected: 200',
                apply: false
            });
            assert.strictEqual(dryRun.ok, true);
            assert.strictEqual(dryRun.data.applied, false);
            assert.strictEqual(fs.readFileSync(featurePath, 'utf-8'), originalContent);

            const applied = await service.repairTest({
                feature_path: featurePath,
                scenario_name: 'list pets',
                error_message: 'status code was: 500, expected: 200',
                apply: true
            });
            assert.strictEqual(applied.ok, true);
            assert.strictEqual(applied.data.applied, true);
            assert.notStrictEqual(fs.readFileSync(featurePath, 'utf-8'), originalContent);
        } finally {
            (AIProviderRegistry as any).getInstance = originalGetInstance;
        }
    });

    test('repair_test updates Scenario Outline blocks', async () => {
        const outlinePath = path.join(featureDir, 'pets-outline.feature');
        fs.writeFileSync(outlinePath, `Feature: pets outline

Scenario Outline: list pets by type
  Given path 'pets'
  And param type = <type>
  When method get
  Then status 500

Examples:
  | type |
  | dog  |
`, 'utf-8');

        const service = new KarateMcpToolService({} as vscode.ExtensionContext, workspaceRoot);
        (service as any).getWorkspaceRoot = () => workspaceRoot;
        const originalGetInstance = AIProviderRegistry.getInstance;
        (AIProviderRegistry as any).getInstance = () => ({
            complete: async () => `Scenario Outline: list pets by type
  Given path 'pets'
  And param type = <type>
  When method get
  Then status 200

Examples:
  | type |
  | dog  |`
        });

        try {
            const result = await service.repairTest({
                feature_path: outlinePath,
                scenario_name: 'list pets by type',
                error_message: 'status code was: 500, expected: 200',
                apply: true
            });

            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.data.applied, true);
            assert.ok(fs.readFileSync(outlinePath, 'utf-8').includes('Then status 200'));
        } finally {
            (AIProviderRegistry as any).getInstance = originalGetInstance;
        }
    });

    test('repair_test returns failure when target scenario is not matched', async () => {
        const service = new KarateMcpToolService({} as vscode.ExtensionContext, workspaceRoot);
        (service as any).getWorkspaceRoot = () => workspaceRoot;
        const originalGetInstance = AIProviderRegistry.getInstance;
        (AIProviderRegistry as any).getInstance = () => ({
            complete: async () => `Scenario: missing scenario
  Given path 'pets'
  When method get
  Then status 200`
        });

        try {
            const result = await service.repairTest({
                feature_path: featurePath,
                scenario_name: 'does not exist',
                error_message: 'status code was: 500, expected: 200',
                apply: true
            });

            assert.strictEqual(result.ok, false);
            assert.strictEqual(result.data.applied, false);
        } finally {
            (AIProviderRegistry as any).getInstance = originalGetInstance;
        }
    });

    test('run_feature uses CLI backend in MCP mode', async () => {
        const service = new KarateMcpToolService({} as vscode.ExtensionContext, workspaceRoot);
        (service as any).getWorkspaceRoot = () => workspaceRoot;

        let capturedOptions: any;
        (service as any).testExecutor.execute = async (options: any) => {
            capturedOptions = options;
            return makeExecutionResult(featurePath);
        };

        const result = await service.runFeature({
            feature_path: featurePath,
            tags: ['smoke']
        });

        assert.strictEqual(result.ok, true);
        assert.strictEqual(capturedOptions.buildTool, 'cli');
        assert.strictEqual(capturedOptions.type, 'feature');
    });
});
