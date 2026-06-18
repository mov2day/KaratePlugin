import * as assert from 'assert';
import { KarateV2Migrator } from '../../services/KarateV2Migrator';

suite('KarateV2Migrator Test Suite', () => {
    test('migrates v1 parallel and caller-scope syntax in place', () => {
        const result = KarateV2Migrator.migrate(`@parallel=false
Feature: Order Workflow

Scenario: UI flow
  * configure driver = { type: 'chrome', scope: 'caller' }
  * delay(1000)
`, '/tmp/order.feature');

        assert.ok(result.content.includes('@lock=order-workflow'));
        assert.ok(!result.content.includes('@parallel=false'));
        assert.ok(!result.content.includes("scope: 'caller'"));
        assert.ok(result.warnings.some(w => w.includes('karate.pause')));
    });
});
