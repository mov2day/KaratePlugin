import * as assert from 'assert';
import { collectZephyrExecutions, extractZephyrTestCaseKey, mapZephyrStatus } from '../../services/zephyr/ZephyrScalePublisher';
import { TestExecutionResult } from '../../types';

suite('ZephyrScalePublisher Test Suite', () => {
    test('extracts Zephyr Scale test case tags', () => {
        assert.strictEqual(extractZephyrTestCaseKey('@zephyr-PROJ-T123'), 'PROJ-T123');
        assert.strictEqual(extractZephyrTestCaseKey({ name: 'zephyr_PROJ-T123' }), undefined);
    });

    test('collects executions and skips duplicate or mismatched tags', () => {
        const result = {
            id: 'exec-1',
            timestamp: 1,
            duration: 10,
            status: 'failed',
            options: { type: 'feature', target: 'orders.feature' },
            summary: {
                totalFeatures: 1,
                totalScenarios: 4,
                passed: 1,
                failed: 1,
                skipped: 1,
                passPercentage: 25,
                executionTime: '10ms'
            },
            features: [{
                name: 'Orders',
                relativePath: 'orders.feature',
                absolutePath: '/tmp/orders.feature',
                duration: 10,
                passed: 1,
                failed: 1,
                skipped: 1,
                status: 'failed',
                scenarios: [
                    { name: 'create order', line: 1, status: 'passed', duration: 11, steps: [], tags: ['@zephyr-PROJ-T123'] },
                    { name: 'duplicate order', line: 2, status: 'failed', duration: 12, steps: [], tags: [{ name: '@zephyr-PROJ-T123' }] },
                    { name: 'other project', line: 3, status: 'skipped', duration: 13, steps: [], tags: ['@zephyr-OTHER-T5'] },
                    { name: 'cancel order', line: 4, status: 'skipped', duration: 14, steps: [], tags: ['@zephyr-PROJ-T124'] }
                ]
            }]
        } as unknown as TestExecutionResult;

        const batch = collectZephyrExecutions(result, 'PROJ', {
            passed: 'OK',
            failed: 'BAD',
            skipped: 'TODO'
        });

        assert.deepStrictEqual(batch.executions.map(e => [e.testCaseKey, e.statusName]), [
            ['PROJ-T123', 'OK'],
            ['PROJ-T124', 'TODO']
        ]);
        assert.deepStrictEqual(batch.duplicateKeys, ['PROJ-T123']);
        assert.deepStrictEqual(batch.projectMismatches, ['OTHER-T5']);
    });

    test('maps statuses with overrides', () => {
        assert.strictEqual(mapZephyrStatus('failed', { passed: 'P', failed: 'F', skipped: 'S' }), 'F');
    });
});
