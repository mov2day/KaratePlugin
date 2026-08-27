import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { ScenarioLocator } from '../../services/ci/ScenarioLocator';
import { WorkspaceEntityStore } from '../../services/workspace/WorkspaceEntityStore';
import { QualityWorkflowService } from '../../services/workspace/QualityWorkflowService';
import { normalizeHistoryLimit } from '../../services/execution/historyRetention';
import { toWorkspaceAbsolutePath, toWorkspaceRelativePath } from '../../services/workspace/workspacePaths';

suite('Workspace Entity Store', () => {
    let root: string;

    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'karate-workspace-store-'));
    });

    teardown(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('stores records in UUID-named entity files with nested local git ignores', () => {
        const store = new WorkspaceEntityStore(root);
        const profile = store.save('run-profiles', { name: 'staging', environment: 'staging' });

        assert.match(profile.id, /^[0-9a-f-]{36}$/i);
        assert.ok(fs.existsSync(path.join(root, '.karate-test-management', 'run-profiles', `${profile.id}.json`)));
        const ignored = fs.readFileSync(path.join(root, '.karate-test-management', '.gitignore'), 'utf8');
        assert.ok(ignored.includes('locks/'));
        assert.ok(ignored.includes('migration/'));
        assert.ok(ignored.includes('backups/'));
    });

    test('migrates valid legacy records and reports corrupt files without touching originals', () => {
        const legacy = path.join(root, '.karate-test-history');
        fs.mkdirSync(legacy);
        fs.writeFileSync(path.join(legacy, 'valid.json'), JSON.stringify({ id: 'legacy-run', timestamp: 42, summary: {} }));
        fs.writeFileSync(path.join(legacy, 'broken.json'), '{not-json');
        const store = new WorkspaceEntityStore(root);

        const result = store.migrateLegacyHistory();

        assert.strictEqual(result.migrated, 1);
        assert.deepStrictEqual(result.corrupted, ['broken.json']);
        assert.ok(fs.existsSync(path.join(legacy, 'valid.json')));
        const run = store.list<{ id: string; legacyId?: string }>('runs')[0];
        assert.match(run.id, /^[0-9a-f-]{36}$/i);
        assert.strictEqual(run.legacyId, 'legacy-run');
        assert.strictEqual(store.migrateLegacyHistory().migrated, 1);
    });

    test('does not duplicate legacy records if a migration journal is lost', () => {
        const legacy = path.join(root, '.karate-test-history');
        fs.mkdirSync(legacy);
        fs.writeFileSync(path.join(legacy, 'run.json'), JSON.stringify({ id: 'legacy-run', timestamp: 42, summary: {} }));
        const store = new WorkspaceEntityStore(root);

        store.migrateLegacyHistory();
        fs.unlinkSync(path.join(root, '.karate-test-management', 'migration', 'history-v1.json'));
        const result = store.migrateLegacyHistory();

        assert.strictEqual(result.migrated, 1);
        assert.strictEqual(store.list<{ id: string }>('runs').length, 1);
    });

    test('migrates old execution IDs to UUID filenames while retaining their legacy identifier', () => {
        const legacy = path.join(root, '.karate-test-history');
        fs.mkdirSync(legacy);
        fs.writeFileSync(path.join(legacy, 'run.json'), JSON.stringify({ id: 'exec_12345_old', timestamp: 42, summary: {} }));
        const store = new WorkspaceEntityStore(root);

        store.migrateLegacyHistory();
        const run = store.list<{ id: string; legacyId?: string }>('runs')[0];

        assert.match(run.id, /^[0-9a-f-]{36}$/i);
        assert.strictEqual(run.legacyId, 'exec_12345_old');
    });

    test('recovers an abandoned workspace lock', () => {
        const store = new WorkspaceEntityStore(root);
        store.initialize();
        const lock = path.join(root, '.karate-test-management', 'locks', 'workspace.lock');
        fs.writeFileSync(lock, 'crashed');
        const staleTime = new Date(Date.now() - 31_000);
        fs.utimesSync(lock, staleTime, staleTime);

        assert.doesNotThrow(() => store.save('environments', { name: 'staging' }));
    });

    test('reports an active workspace lock instead of writing concurrently', () => {
        const store = new WorkspaceEntityStore(root);
        store.initialize();
        fs.writeFileSync(path.join(root, '.karate-test-management', 'locks', 'workspace.lock'), 'another process');

        assert.throws(() => store.save('environments', { name: 'staging' }), /state is busy/);
    });

    test('keeps sibling workspace migrations isolated', () => {
        const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'karate-workspace-sibling-'));
        try {
            const failedLegacy = path.join(root, '.karate-test-history');
            const healthyLegacy = path.join(sibling, '.karate-test-history');
            fs.mkdirSync(failedLegacy);
            fs.mkdirSync(healthyLegacy);
            fs.writeFileSync(path.join(failedLegacy, 'broken.json'), '{broken');
            fs.writeFileSync(path.join(healthyLegacy, 'run.json'), JSON.stringify({ id: 'legacy-sibling', timestamp: 10, summary: {} }));

            const failed = new WorkspaceEntityStore(root).migrateLegacyHistory();
            const healthyStore = new WorkspaceEntityStore(sibling);
            const healthy = healthyStore.migrateLegacyHistory();

            assert.deepStrictEqual(failed.corrupted, ['broken.json']);
            assert.strictEqual(healthy.migrated, 1);
            assert.strictEqual(healthyStore.list('runs').length, 1);
        } finally {
            fs.rmSync(sibling, { recursive: true, force: true });
        }
    });

    test('accepts UUID execution records as workspace run entities', () => {
        const store = new WorkspaceEntityStore(root);
        const resultId = randomUUID();
        const run = store.save('runs', { timestamp: Date.now(), status: 'success' }, resultId);
        assert.strictEqual(run.id, resultId);
    });
});

suite('Quality Workflow', () => {
    let root: string;
    setup(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'karate-quality-workflow-')); });
    teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

    test('allows only the planned lifecycle transitions', () => {
        const workflow = new QualityWorkflowService(new WorkspaceEntityStore(root));
        const finding = workflow.create({ title: 'Untested endpoint', severity: 'high', source: 'coverage' });
        assert.strictEqual(workflow.advance(finding.id, 'Investigating').state, 'Investigating');
        assert.throws(() => workflow.advance(finding.id, 'Verified'), /Cannot move/);
        assert.strictEqual(workflow.advance(finding.id, 'Fixed').state, 'Fixed');
        assert.strictEqual(workflow.advance(finding.id, 'Verified').state, 'Verified');
    });

    test('updates an open coverage gap instead of duplicating it on every scan', () => {
        const workflow = new QualityWorkflowService(new WorkspaceEntityStore(root));
        const first = workflow.recordCoverageGap({
            title: 'Missing coverage: GET /orders', severity: 'normal', sourceRef: 'GET /orders'
        });
        const second = workflow.recordCoverageGap({
            title: 'Missing coverage: GET /orders', severity: 'high', sourceRef: 'GET /orders'
        });

        assert.strictEqual(second.id, first.id);
        assert.strictEqual(second.severity, 'high');
    });

    test('updates an open spec-diff finding with the same source reference', () => {
        const workflow = new QualityWorkflowService(new WorkspaceEntityStore(root));
        const first = workflow.upsertOpen({ title: 'Review deleted endpoint', severity: 'high', source: 'spec-diff', sourceRef: 'spec:/orders:DELETE' });
        const second = workflow.upsertOpen({ title: 'Review removed endpoint', severity: 'critical', source: 'spec-diff', sourceRef: 'spec:/orders:DELETE' });
        assert.strictEqual(second.id, first.id);
        assert.strictEqual(second.severity, 'critical');
    });
});

suite('Scenario Locator', () => {
    const content = `Feature: repairs

@first
Scenario: create order
  Given url baseUrl

@second
Scenario: create order safely
  Given url baseUrl

@duplicate
Scenario: create order
  Given url baseUrl
`;

    test('matches exact names rather than substrings', () => {
        const locator = new ScenarioLocator();
        const match = locator.find(content, { name: 'create order safely' });
        assert.strictEqual(match?.startLine, 7);
    });

    test('refuses an ambiguous exact-name repair without tag context', () => {
        const locator = new ScenarioLocator();
        assert.strictEqual(locator.replace(content, { name: 'create order' }, 'Scenario: repaired'), undefined);
    });

    test('uses tags to resolve an otherwise ambiguous exact-name repair', () => {
        const locator = new ScenarioLocator();
        const updated = locator.replace(content, { name: 'create order', tags: ['@first'] }, 'Scenario: repaired');
        assert.ok(updated?.includes('Scenario: repaired'));
        assert.ok(updated?.includes('Scenario: create order safely'));
    });
});

suite('History Retention', () => {
    test('honors configured limits while normalizing invalid values safely', () => {
        assert.strictEqual(normalizeHistoryLimit(10), 10);
        assert.strictEqual(normalizeHistoryLimit(75.9), 75);
        assert.strictEqual(normalizeHistoryLimit(undefined), 50);
        assert.strictEqual(normalizeHistoryLimit(Number.NaN), 50);
        assert.strictEqual(normalizeHistoryLimit(0), 1);
    });
});

suite('Workspace Path Persistence', () => {
    test('stores execution paths relative to the workspace and rehydrates them on demand', () => {
        const root = path.join(path.sep, 'workspace');
        assert.strictEqual(toWorkspaceRelativePath(root, path.join(root, 'features', 'orders.feature:12')), 'features/orders.feature:12');
        assert.strictEqual(toWorkspaceRelativePath(root, root), '.');
        assert.strictEqual(toWorkspaceAbsolutePath(root, 'features/orders.feature:12'), path.join(root, 'features', 'orders.feature:12'));
    });

    test('refuses to persist execution paths outside the workspace', () => {
        assert.throws(() => toWorkspaceRelativePath(path.join(path.sep, 'workspace'), path.join(path.sep, 'outside', 'test.feature')),
            /outside its workspace/);
    });
});
