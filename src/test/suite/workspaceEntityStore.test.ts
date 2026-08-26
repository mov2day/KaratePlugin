import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ScenarioLocator } from '../../services/ci/ScenarioLocator';
import { WorkspaceEntityStore } from '../../services/workspace/WorkspaceEntityStore';
import { QualityWorkflowService } from '../../services/workspace/QualityWorkflowService';

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
        assert.strictEqual(store.list<{ id: string }>('runs')[0].id, 'legacy-run');
        assert.strictEqual(store.migrateLegacyHistory().migrated, 1);
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
