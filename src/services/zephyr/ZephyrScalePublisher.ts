import axios, { AxiosInstance } from 'axios';
import * as vscode from 'vscode';
import { TestExecutionResult, ScenarioResult } from '../../types';

export const ZEPHYR_TOKEN_KEY = 'karateDsl.zephyr.bearerToken';

export interface ZephyrStatusNames {
    passed: string;
    failed: string;
    skipped: string;
}

export interface ZephyrExecution {
    testCaseKey: string;
    scenarioName: string;
    statusName: string;
    executionTime: number;
    comment: string;
}

export interface ZephyrExecutionBatch {
    executions: ZephyrExecution[];
    duplicateKeys: string[];
    projectMismatches: string[];
}

export interface ZephyrPublishSummary {
    enabled: boolean;
    pushed: number;
    duplicateKeys: string[];
    projectMismatches: string[];
    cycleKey?: string;
    skippedReason?: string;
}

interface ZephyrConfig {
    enabled: boolean;
    baseUrl: string;
    projectKey: string;
    cycleName: string;
    statusNames: ZephyrStatusNames;
}

const DEFAULT_BASE_URL = 'https://eu.api.zephyrscale.smartbear.com/v2';
const DEFAULT_STATUS_NAMES: ZephyrStatusNames = {
    passed: 'Pass',
    failed: 'Fail',
    skipped: 'Not Executed'
};

export function extractZephyrTestCaseKey(tag: unknown): string | undefined {
    const raw = typeof tag === 'string'
        ? tag
        : tag && typeof tag === 'object'
            ? String((tag as { name?: unknown }).name || '')
            : '';
    const match = raw.trim().match(/^@?zephyr-([A-Z][A-Z_0-9]+-T[0-9]+)$/i);
    return match?.[1].toUpperCase();
}

export function mapZephyrStatus(status: ScenarioResult['status'], names: ZephyrStatusNames = DEFAULT_STATUS_NAMES): string {
    if (status === 'failed') {
        return names.failed;
    }
    if (status === 'skipped') {
        return names.skipped;
    }
    return names.passed;
}

export function collectZephyrExecutions(
    result: TestExecutionResult,
    projectKey: string,
    statusNames: ZephyrStatusNames = DEFAULT_STATUS_NAMES
): ZephyrExecutionBatch {
    const seen = new Set<string>();
    const duplicateKeys: string[] = [];
    const projectMismatches: string[] = [];
    const executions: ZephyrExecution[] = [];
    const expectedPrefix = `${projectKey.toUpperCase()}-T`;

    for (const feature of result.features || []) {
        for (const scenario of feature.scenarios || []) {
            const keys = (scenario.tags || [])
                .map(extractZephyrTestCaseKey)
                .filter((key): key is string => Boolean(key));

            for (const testCaseKey of keys) {
                if (!testCaseKey.startsWith(expectedPrefix)) {
                    projectMismatches.push(testCaseKey);
                    continue;
                }
                if (seen.has(testCaseKey)) {
                    duplicateKeys.push(testCaseKey);
                    continue;
                }

                seen.add(testCaseKey);
                executions.push({
                    testCaseKey,
                    scenarioName: scenario.name,
                    statusName: mapZephyrStatus(scenario.status, statusNames),
                    executionTime: Math.max(0, Math.round(scenario.duration || 0)),
                    comment: `Executed by Karate API Test Generator: ${feature.relativePath || feature.name} / ${scenario.name}`
                });
            }
        }
    }

    return {
        executions,
        duplicateKeys: [...new Set(duplicateKeys)],
        projectMismatches: [...new Set(projectMismatches)]
    };
}

export class ZephyrScalePublisher {
    constructor(private context: vscode.ExtensionContext) { }

    async publish(result: TestExecutionResult): Promise<ZephyrPublishSummary> {
        const config = this.readConfig();
        if (!config.enabled) {
            return { enabled: false, pushed: 0, duplicateKeys: [], projectMismatches: [], skippedReason: 'disabled' };
        }

        if (!config.projectKey) {
            throw new Error('Zephyr project key is required when karateDsl.zephyr.enabled is true.');
        }
        if (!config.cycleName) {
            throw new Error('Zephyr cycle name is required when karateDsl.zephyr.enabled is true.');
        }

        const token = await this.context.secrets.get(ZEPHYR_TOKEN_KEY);
        if (!token) {
            throw new Error('Zephyr bearer token is missing. Run "Karate: Set Zephyr Bearer Token".');
        }

        const batch = collectZephyrExecutions(result, config.projectKey, config.statusNames);
        if (batch.executions.length === 0) {
            return {
                enabled: true,
                pushed: 0,
                duplicateKeys: batch.duplicateKeys,
                projectMismatches: batch.projectMismatches,
                skippedReason: 'no tagged scenarios'
            };
        }

        const client = this.createClient(config.baseUrl, token);
        const cycleKey = await this.resolveCycleKey(client, config);
        const actualEndDate = new Date(result.timestamp + result.duration).toISOString();

        for (const execution of batch.executions) {
            await this.postExecution(client, {
                projectKey: config.projectKey,
                testCaseKey: execution.testCaseKey,
                testCycleKey: cycleKey,
                statusName: execution.statusName,
                actualEndDate,
                executionTime: execution.executionTime,
                comment: execution.comment
            });
            await sleep(200);
        }

        return {
            enabled: true,
            pushed: batch.executions.length,
            duplicateKeys: batch.duplicateKeys,
            projectMismatches: batch.projectMismatches,
            cycleKey
        };
    }

    private readConfig(): ZephyrConfig {
        const config = vscode.workspace.getConfiguration('karateDsl');
        return {
            enabled: config.get<boolean>('zephyr.enabled', false),
            baseUrl: (config.get<string>('zephyr.baseUrl', DEFAULT_BASE_URL) || DEFAULT_BASE_URL).replace(/\/+$/, ''),
            projectKey: (config.get<string>('zephyr.projectKey', '') || '').trim().toUpperCase(),
            cycleName: (config.get<string>('zephyr.cycleName', 'Karate Regression') || '').trim(),
            statusNames: {
                passed: config.get<string>('zephyr.status.pass', DEFAULT_STATUS_NAMES.passed) || DEFAULT_STATUS_NAMES.passed,
                failed: config.get<string>('zephyr.status.fail', DEFAULT_STATUS_NAMES.failed) || DEFAULT_STATUS_NAMES.failed,
                skipped: config.get<string>('zephyr.status.skipped', DEFAULT_STATUS_NAMES.skipped) || DEFAULT_STATUS_NAMES.skipped
            }
        };
    }

    private createClient(baseUrl: string, token: string): AxiosInstance {
        return axios.create({
            baseURL: baseUrl,
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });
    }

    private async resolveCycleKey(client: AxiosInstance, config: ZephyrConfig): Promise<string> {
        const existing = await this.findCycleKey(client, config);
        if (existing) {
            return existing;
        }

        try {
            const response = await client.post('/testcycles', {
                projectKey: config.projectKey,
                name: config.cycleName,
                description: `Auto-created by Karate API Test Generator on ${new Date().toISOString()}`
            });
            if (!response.data?.key) {
                throw new Error('Zephyr did not return a test cycle key.');
            }
            return response.data.key;
        } catch (error) {
            const winner = await this.findCycleKey(client, config);
            if (winner) {
                return winner;
            }
            throw new Error(this.describeAxiosError('Failed to resolve Zephyr test cycle', error));
        }
    }

    private async findCycleKey(client: AxiosInstance, config: ZephyrConfig): Promise<string | undefined> {
        // ponytail: first page only; add pagination if a project has more than 1000 active cycles.
        const response = await client.get('/testcycles', {
            params: { projectKey: config.projectKey, maxResults: 1000 }
        });
        const cycles = Array.isArray(response.data?.values) ? response.data.values : [];
        return cycles.find((cycle: { name?: string; key?: string }) => cycle.name === config.cycleName)?.key;
    }

    private async postExecution(client: AxiosInstance, payload: Record<string, unknown>): Promise<void> {
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                await client.post('/testexecutions', payload);
                return;
            } catch (error) {
                if (axios.isAxiosError(error) && error.response?.status === 429 && attempt < 3) {
                    await sleep(1000 * Math.pow(2, attempt));
                    continue;
                }
                throw new Error(this.describeAxiosError(`Failed to push Zephyr execution for ${payload.testCaseKey}`, error));
            }
        }
    }

    private describeAxiosError(prefix: string, error: unknown): string {
        if (axios.isAxiosError(error)) {
            const status = error.response?.status;
            const message = error.response?.data?.message || error.response?.statusText || error.message;
            if (status === 401) {
                return `${prefix}: Zephyr token is invalid or expired.`;
            }
            if (status === 403) {
                return `${prefix}: token lacks permission for this Zephyr project.`;
            }
            if (status === 404) {
                return `${prefix}: Zephyr project, cycle, test case, or status was not found.`;
            }
            return `${prefix}: ${status || 'network'} ${message}`;
        }
        return `${prefix}: ${(error as Error).message || String(error)}`;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
