import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BuildToolExecutor } from '../../services/execution/BuildToolExecutor';
import { ConfigDiscovery } from '../../services/execution/ConfigDiscovery';
import { buildKarateArguments, scenarioLineFromEditorLine } from '../../services/execution/ExecutionArguments';
import { ExecutionRuntimeSettings } from '../../services/execution/ExecutionSettings';
import { ProjectExecutionResolver } from '../../services/execution/ProjectExecutionResolver';
import { ResultParser } from '../../services/execution/ResultParser';
import { TestExecutionOptions } from '../../types';

const defaults: ExecutionRuntimeSettings = {
    defaultBuildTool: 'auto',
    runnerClass: '',
    runnerMethod: '',
    configPath: '',
    systemProperties: {},
    jvmArgs: [],
    karateArgs: [],
    additionalClasspath: [],
    jarPath: '',
    karateVersion: '',
    mavenGoal: 'test',
    gradleTask: 'test'
};

suite('Execution engine', () => {
    let root: string;

    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'karate-execution-engine-'));
    });

    teardown(() => fs.rmSync(root, { recursive: true, force: true }));

    test('uses CLI for a simple feature-only project', () => {
        const feature = path.join(root, 'features', 'simple.feature');
        fs.mkdirSync(path.dirname(feature), { recursive: true });
        fs.writeFileSync(feature, 'Feature: simple\nScenario: works\n* match 1 == 1\n');
        const project = ProjectExecutionResolver.resolve({ type: 'feature', target: feature, buildTool: 'auto' }, root);
        assert.strictEqual(project.strategy, 'cli');
        assert.strictEqual(project.projectRoot, root);
    });

    test('finds the nearest Maven module from a nested feature', () => {
        const moduleRoot = path.join(root, 'services', 'orders');
        const feature = path.join(moduleRoot, 'src', 'test', 'java', 'orders', 'orders.feature');
        fs.mkdirSync(path.dirname(feature), { recursive: true });
        fs.writeFileSync(path.join(moduleRoot, 'pom.xml'), '<project/>');
        fs.writeFileSync(feature, 'Feature: orders');
        const project = ProjectExecutionResolver.resolve({ type: 'feature', target: feature, buildTool: 'auto' }, root);
        assert.strictEqual(project.strategy, 'maven');
        assert.strictEqual(project.projectRoot, moduleRoot);
    });

    test('rejects an explicit build tool when its build file is absent', () => {
        const feature = path.join(root, 'simple.feature');
        fs.writeFileSync(feature, 'Feature: simple');
        assert.throws(
            () => ProjectExecutionResolver.resolve({ type: 'feature', target: feature, buildTool: 'gradle' }, root),
            /No Gradle build file/
        );
    });

    test('rejects targets spanning independent build modules', () => {
        const first = path.join(root, 'first');
        const second = path.join(root, 'second');
        fs.mkdirSync(first, { recursive: true });
        fs.mkdirSync(second, { recursive: true });
        fs.writeFileSync(path.join(first, 'pom.xml'), '<project/>');
        fs.writeFileSync(path.join(second, 'pom.xml'), '<project/>');
        const firstFeature = path.join(first, 'first.feature');
        const secondFeature = path.join(second, 'second.feature');
        fs.writeFileSync(firstFeature, 'Feature: first');
        fs.writeFileSync(secondFeature, 'Feature: second');
        assert.throws(
            () => ProjectExecutionResolver.resolve({ type: 'features', target: [firstFeature, secondFeature], buildTool: 'auto' }, root),
            /different build modules/
        );
    });

    test('discovers the declared Java package for a custom runner', () => {
        const javaRoot = path.join(root, 'src', 'test', 'java', 'com', 'acme');
        fs.mkdirSync(javaRoot, { recursive: true });
        fs.writeFileSync(path.join(javaRoot, 'CustomRunner.java'), `package com.acme;
import com.intuit.karate.junit5.Karate;
class CustomRunner { @Karate.Test Karate tests() { return Karate.run("classpath:"); } }
`);
        assert.deepStrictEqual(ConfigDiscovery.findRunnerClasses(root), ['com.acme.CustomRunner']);
    });

    test('preserves the exact scenario line including Windows-style drive prefixes', () => {
        const args = buildKarateArguments({
            type: 'scenario',
            target: 'C:\\work folder\\users.feature',
            scenarioLine: 27
        });
        assert.deepStrictEqual(args, ['C:\\work folder\\users.feature:27']);
        assert.strictEqual(scenarioLineFromEditorLine(26), 27);
    });

    test('falls back to CLI for an auto-discovered build without a Karate runner', () => {
        fs.writeFileSync(path.join(root, 'pom.xml'), '<project/>');
        const feature = path.join(root, 'simple.feature');
        fs.writeFileSync(feature, 'Feature: simple');
        const discovered = ProjectExecutionResolver.resolve({ type: 'feature', target: feature, buildTool: 'auto' }, root);
        const runnable = ProjectExecutionResolver.chooseRunnableStrategy(discovered, 'auto', 0);
        assert.strictEqual(runnable.strategy, 'cli');
    });

    test('builds Gradle tags, target, runner class, and method together', () => {
        fs.writeFileSync(path.join(root, 'build.gradle'), 'test { useJUnitPlatform() }');
        const options: TestExecutionOptions = { type: 'tags', target: path.join(root, 'features'), tags: ['smoke'], buildTool: 'gradle' };
        const project = ProjectExecutionResolver.resolve(options, root, { runnerClass: 'com.acme.Suite', runnerMethod: 'api' });
        const plan = BuildToolExecutor.buildGradlePlan(options, project, defaults, path.join(root, 'reports'));
        assert.deepStrictEqual(plan.args.slice(0, 3), ['test', '--tests', 'com.acme.Suite.api']);
        assert.ok(plan.args.some(arg => arg.startsWith('-Dkarate.options=') && arg.includes('--tags @smoke') && arg.includes('features')));
    });

    test('builds Maven runner and karate.options overrides as single arguments', () => {
        fs.writeFileSync(path.join(root, 'pom.xml'), '<project/>');
        const feature = path.join(root, 'src', 'test', 'java', 'happy path.feature');
        const options: TestExecutionOptions = { type: 'scenario', target: feature, scenarioLine: 9, buildTool: 'maven' };
        const project = ProjectExecutionResolver.resolve(options, root, { runnerClass: 'com.acme.CustomRunner', runnerMethod: 'smoke' });
        const plan = BuildToolExecutor.buildMavenPlan(options, project, defaults, path.join(root, 'reports'));
        assert.ok(plan.args.includes('-Dtest=com.acme.CustomRunner#smoke'));
        assert.ok(plan.args.some(arg => arg.startsWith('-Dkarate.options=') && arg.includes('happy path.feature:9')));
    });

    test('ignores stale reports and maps reported feature paths back to absolute files', () => {
        const reportDir = path.join(root, 'reports', 'karate-reports');
        fs.mkdirSync(reportDir, { recursive: true });
        const summaryPath = path.join(reportDir, 'karate-summary-json.txt');
        fs.writeFileSync(summaryPath, JSON.stringify({
            elapsedTime: 12,
            featureSummary: [{
                name: 'users',
                relativePath: 'features/users.feature',
                packageQualifiedName: 'features.users',
                passedCount: 1,
                failedCount: 0,
                skippedCount: 0
            }]
        }));
        const old = new Date(Date.now() - 60_000);
        fs.utimesSync(summaryPath, old, old);
        assert.strictEqual(ResultParser.findReportDirectory(path.join(root, 'reports'), Date.now()), null);
        fs.utimesSync(summaryPath, new Date(), new Date());
        assert.strictEqual(ResultParser.findReportDirectory(path.join(root, 'reports'), Date.now() - 1000), reportDir);
        const parsed = ResultParser.parseKarateSummary(summaryPath, root);
        assert.strictEqual(parsed.features![0].absolutePath, path.join(root, 'features', 'users.feature'));
    });
});
