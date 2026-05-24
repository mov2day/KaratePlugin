import * as assert from 'assert';
import { FlakinessAnalyzer, FlakinessTierThresholds } from '../../services/flakiness/FlakinessAnalyzer';

suite('FlakinessAnalyzer Tier Boundaries', () => {
    test('assigns tiers at exact watch/flaky/broken boundaries', () => {
        const analyzer = new FlakinessAnalyzer();
        const thresholds: FlakinessTierThresholds = {
            watch: 0.2,
            flaky: 0.5,
            broken: 0.8
        };

        assert.strictEqual(analyzer.getTier(0.1999, thresholds), 'stable');
        assert.strictEqual(analyzer.getTier(0.2, thresholds), 'watch');
        assert.strictEqual(analyzer.getTier(0.4999, thresholds), 'watch');
        assert.strictEqual(analyzer.getTier(0.5, thresholds), 'flaky');
        assert.strictEqual(analyzer.getTier(0.7999, thresholds), 'flaky');
        assert.strictEqual(analyzer.getTier(0.8, thresholds), 'broken');
        assert.strictEqual(analyzer.getTier(1, thresholds), 'broken');
    });
});
