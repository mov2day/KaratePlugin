import * as assert from 'assert';
import * as vscode from 'vscode';
import { CiFailureExtractor } from '../../services/ci/CiFailureExtractor';
import { GitHubActionsPullIngestor } from '../../services/ci/GitHubActionsPullIngestor';
import { GitHubActionsClient } from '../../services/ci/GitHubActionsClient';

interface MockMemento {
    get<T>(key: string, defaultValue?: T): T;
    update(key: string, value: unknown): Promise<void>;
}

function createMockMemento(): MockMemento {
    const map = new Map<string, unknown>();
    return {
        get<T>(key: string, defaultValue?: T): T {
            return map.has(key) ? (map.get(key) as T) : (defaultValue as T);
        },
        async update(key: string, value: unknown): Promise<void> {
            map.set(key, value);
        }
    };
}

function createStoredZip(fileName: string, content: string): Buffer {
    const name = Buffer.from(fileName, 'utf-8');
    const data = Buffer.from(content, 'utf-8');

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localPart = Buffer.concat([localHeader, name, data]);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(0, 42);

    const centralPart = Buffer.concat([centralHeader, name]);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(centralPart.length, 12);
    eocd.writeUInt32LE(localPart.length, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([localPart, centralPart, eocd]);
}

suite('CI Pull Model', () => {
    test('extracts CIFailurePayload from logs zip', () => {
        const extractor = new CiFailureExtractor();
        const logText = `
Scenario: get pet by id
src/test/karate/pets.feature:42
> GET https://api.example.com/pets/1
status code was: 500, expected: 200
response status: 500
{"error":"boom"}
`;

        const payload = extractor.extract({
            run: {
                id: 7,
                run_attempt: 1,
                name: 'Karate CI'
            },
            jobs: [{
                id: 11,
                name: 'tests',
                conclusion: 'failure',
                steps: [
                    { name: 'run karate', number: 2, conclusion: 'failure' }
                ]
            }],
            artifacts: [],
            logsArchive: createStoredZip('job.log', logText),
            artifactNamePattern: 'karate|junit|test|report'
        });

        assert.ok(payload);
        assert.strictEqual(payload?.featurePath, 'src/test/karate/pets.feature');
        assert.strictEqual(payload?.scenarioName, 'get pet by id');
        assert.ok(payload?.errorMessage.includes('status code was'));
        assert.strictEqual(payload?.httpRequest?.method, 'GET');
        assert.strictEqual(payload?.httpResponse?.status, 500);
    });

    test('dedupes run-id + attempt across poll cycles', async () => {
        const workspaceAny = vscode.workspace as any;
        const originalGetConfiguration = workspaceAny.getConfiguration;
        const originalListFailedRuns = GitHubActionsClient.prototype.listFailedRuns;
        const originalLogRunSummary = GitHubActionsClient.logRunSummary;

        workspaceAny.getConfiguration = () => ({
            get: (key: string, defaultValue: unknown) => {
                const values: Record<string, unknown> = {
                    'ciRepair.github.owner': 'acme',
                    'ciRepair.github.repo': 'karate',
                    'ciRepair.github.workflow': '',
                    'ciRepair.github.branch': 'main',
                    'ciRepair.github.pollIntervalSec': 90,
                    'ciRepair.github.artifactNamePattern': 'karate|junit|test|report',
                    'ciRepair.github.lookbackMinutes': 120
                };
                return key in values ? values[key] : defaultValue;
            }
        });

        (GitHubActionsClient.prototype as any).listFailedRuns = async () => [{
            id: 1001,
            run_attempt: 2,
            updated_at: new Date().toISOString()
        }];
        (GitHubActionsClient as any).logRunSummary = () => {
            // no-op
        };

        const workspaceState = createMockMemento();
        const globalState = createMockMemento();

        const context = {
            workspaceState,
            globalState,
            secrets: {
                get: async () => 'ghp_test_token'
            }
        } as unknown as vscode.ExtensionContext;

        const ingestor = new GitHubActionsPullIngestor(context);
        const payload = {
            source: 'github-actions' as const,
            featurePath: 'src/test/karate/pets.feature',
            scenarioName: 'get pet by id',
            failedStep: 'Then status 200',
            errorMessage: 'status code was: 500, expected: 200',
            timestamp: Date.now(),
            runId: '1001:2'
        };

        let fired = 0;
        ingestor.onFailureReceived(() => {
            fired += 1;
        });

        (ingestor as any).extractPayloadForRun = async () => payload;

        try {
            await ingestor.pollOnce();
            await ingestor.pollOnce();

            assert.strictEqual(fired, 1);

            const stored = workspaceState.get<string[]>('ciRepair.github.processedRuns', []);
            assert.ok(stored.includes('1001:2'));
        } finally {
            workspaceAny.getConfiguration = originalGetConfiguration;
            (GitHubActionsClient.prototype as any).listFailedRuns = originalListFailedRuns;
            (GitHubActionsClient as any).logRunSummary = originalLogRunSummary;
            ingestor.dispose();
        }
    });

    test('does not mark run processed when extraction returns null', async () => {
        const workspaceAny = vscode.workspace as any;
        const originalGetConfiguration = workspaceAny.getConfiguration;
        const originalListFailedRuns = GitHubActionsClient.prototype.listFailedRuns;
        const originalLogRunSummary = GitHubActionsClient.logRunSummary;

        workspaceAny.getConfiguration = () => ({
            get: (key: string, defaultValue: unknown) => {
                const values: Record<string, unknown> = {
                    'ciRepair.github.owner': 'acme',
                    'ciRepair.github.repo': 'karate',
                    'ciRepair.github.workflow': '',
                    'ciRepair.github.branch': 'main',
                    'ciRepair.github.pollIntervalSec': 90,
                    'ciRepair.github.artifactNamePattern': 'karate|junit|test|report',
                    'ciRepair.github.lookbackMinutes': 120
                };
                return key in values ? values[key] : defaultValue;
            }
        });

        (GitHubActionsClient.prototype as any).listFailedRuns = async () => [{
            id: 2002,
            run_attempt: 1,
            updated_at: new Date().toISOString()
        }];
        (GitHubActionsClient as any).logRunSummary = () => {
            // no-op
        };

        const workspaceState = createMockMemento();
        const globalState = createMockMemento();
        const context = {
            workspaceState,
            globalState,
            secrets: {
                get: async () => 'ghp_test_token'
            }
        } as unknown as vscode.ExtensionContext;

        const ingestor = new GitHubActionsPullIngestor(context);
        (ingestor as any).extractPayloadForRun = async () => null;

        try {
            await ingestor.pollOnce();

            const stored = workspaceState.get<string[]>('ciRepair.github.processedRuns', []);
            assert.ok(!stored.includes('2002:1'));
        } finally {
            workspaceAny.getConfiguration = originalGetConfiguration;
            (GitHubActionsClient.prototype as any).listFailedRuns = originalListFailedRuns;
            (GitHubActionsClient as any).logRunSummary = originalLogRunSummary;
            ingestor.dispose();
        }
    });
});
