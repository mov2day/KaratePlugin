import * as crypto from 'crypto';
import * as http from 'http';
import * as vscode from 'vscode';
import { logger } from '../../utils/logger';
import { KarateMcpToolService, KarateMcpToolOutcome } from './KarateMcpToolService';

interface JsonRpcRequest {
    jsonrpc: string;
    id?: string | number | null;
    method: string;
    params?: any;
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: string | number | null;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}

interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
}

/**
 * Extension-managed MCP host exposing Karate tools over HTTP JSON-RPC with SSE compatibility endpoints.
 */
export class KarateMcpHostService implements vscode.Disposable {
    private static readonly TOKEN_KEY = 'karateDsl.mcp.token';
    private static readonly SERVER_NAME = 'karate-dsl-mcp';
    private static readonly SERVER_VERSION = '1.5.0';

    private server: http.Server | undefined;
    private readonly sseClients = new Set<http.ServerResponse>();
    private readonly toolService: KarateMcpToolService;
    private runningEndpointKey: string | undefined;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly extensionPath: string
    ) {
        this.toolService = new KarateMcpToolService(context, extensionPath);
    }

    async startIfEnabled(): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('karateDsl');
            const enabled = config.get<boolean>('mcp.enabled', false);
            if (!enabled) {
                this.stop();
                return;
            }
            await this.start();
        } catch (error) {
            logger.error('KarateMcpHostService: failed to start', error as Error);
            vscode.window.showErrorMessage(`Karate MCP host failed to start: ${(error as Error).message}`);
        }
    }

    async start(): Promise<void> {
        await this.ensureToken();
        const { host, port } = this.getHostConfig();
        const endpointKey = `${host}:${port}`;

        if (this.server && this.runningEndpointKey === endpointKey) {
            return;
        }
        if (this.server && this.runningEndpointKey !== endpointKey) {
            this.stop();
        }

        this.server = http.createServer((req, res) => {
            void this.handleRequest(req, res);
        });

        await new Promise<void>((resolve, reject) => {
            this.server!.once('error', reject);
            this.server!.listen(port, host, () => {
                this.server?.off('error', reject);
                resolve();
            });
        });

        this.runningEndpointKey = endpointKey;
        logger.info(`KarateMcpHostService: listening on http://${host}:${port}/mcp`);
    }

    stop(): void {
        if (!this.server) {
            return;
        }

        for (const client of this.sseClients) {
            try {
                client.end();
            } catch {
                // Ignore best-effort close
            }
        }
        this.sseClients.clear();

        this.server.close();
        this.server = undefined;
        this.runningEndpointKey = undefined;
        logger.info('KarateMcpHostService: stopped');
    }

    isRunning(): boolean {
        return !!this.server;
    }

    async rotateToken(): Promise<string> {
        const token = this.generateToken();
        await this.context.secrets.store(KarateMcpHostService.TOKEN_KEY, token);
        return token;
    }

    async getConnectionSnippet(includeToken = true): Promise<string> {
        const { host, port } = this.getHostConfig();
        const token = includeToken ? await this.ensureToken() : '<token>';
        const snippet = {
            mcpServers: {
                'karate-dsl': {
                    transport: 'streamable_http',
                    url: `http://${host}:${port}/mcp`,
                    sseUrl: `http://${host}:${port}/sse`,
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            }
        };
        return JSON.stringify(snippet, null, 2);
    }

    async hasTokenAuthEnabled(): Promise<boolean> {
        const config = vscode.workspace.getConfiguration('karateDsl');
        return config.get<boolean>('mcp.tokenAuthEnabled', true);
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const method = req.method || 'GET';
        const url = req.url || '/';

        if (method === 'GET' && url === '/health') {
            this.writeJson(res, 200, {
                status: 'ok',
                service: KarateMcpHostService.SERVER_NAME,
                running: true
            });
            return;
        }

        const requiresAuth = url === '/mcp' || url === '/sse' || url === '/mcp/sse' || url === '/sse/messages';
        if (requiresAuth && !(await this.isAuthorized(req))) {
            this.writeJson(res, 401, { error: 'Unauthorized' });
            return;
        }

        if (method === 'GET' && (url === '/sse' || url === '/mcp/sse')) {
            this.handleSseConnect(res);
            return;
        }

        if (method === 'POST' && (url === '/mcp' || url === '/sse/messages')) {
            const request = await this.readJsonRequest(req);
            if (!request) {
                this.writeJson(res, 400, { error: 'Invalid JSON-RPC payload' });
                return;
            }

            const response = await this.handleJsonRpc(request);
            if (!response) {
                res.writeHead(202);
                res.end();
                return;
            }

            const accept = req.headers.accept || '';
            if (accept.includes('text/event-stream') || url === '/sse/messages') {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });
                res.write(`event: message\n`);
                res.write(`data: ${JSON.stringify(response)}\n\n`);
                res.end();
            } else {
                this.writeJson(res, 200, response);
            }
            return;
        }

        this.writeJson(res, 404, { error: 'Not Found' });
    }

    private async handleJsonRpc(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
        const id = request.id ?? null;

        if (request.method === 'notifications/initialized') {
            return null;
        }

        if (request.method === 'initialize') {
            const requestedVersion = typeof request.params?.protocolVersion === 'string'
                ? request.params.protocolVersion
                : '2024-11-05';
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion: requestedVersion,
                    capabilities: {
                        tools: {
                            listChanged: false
                        }
                    },
                    serverInfo: {
                        name: KarateMcpHostService.SERVER_NAME,
                        version: KarateMcpHostService.SERVER_VERSION
                    },
                    instructions: 'Karate MCP server for generation, coverage, repair, flakiness, and execution tools.'
                }
            };
        }

        if (request.method === 'ping') {
            return {
                jsonrpc: '2.0',
                id,
                result: {}
            };
        }

        if (request.method === 'tools/list') {
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    tools: this.getToolDefinitions()
                }
            };
        }

        if (request.method === 'tools/call') {
            const toolName = request.params?.name;
            const args = (request.params?.arguments && typeof request.params.arguments === 'object')
                ? request.params.arguments as Record<string, unknown>
                : {};

            if (typeof toolName !== 'string' || !toolName.trim()) {
                return {
                    jsonrpc: '2.0',
                    id,
                    error: {
                        code: -32602,
                        message: 'Invalid params: missing tool name'
                    }
                };
            }

            try {
                const outcome = await this.callTool(toolName.trim(), args);
                this.broadcastSse('tool_result', {
                    name: toolName,
                    ok: outcome.ok
                });

                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        content: [
                            {
                                type: 'text',
                                text: outcome.text
                            }
                        ],
                        structuredContent: outcome.data,
                        isError: !outcome.ok
                    }
                };
            } catch (error) {
                return {
                    jsonrpc: '2.0',
                    id,
                    error: {
                        code: -32603,
                        message: 'Tool execution failed',
                        data: {
                            details: (error as Error).message
                        }
                    }
                };
            }
        }

        return {
            jsonrpc: '2.0',
            id,
            error: {
                code: -32601,
                message: `Method not found: ${request.method}`
            }
        };
    }

    private async callTool(name: string, args: Record<string, unknown>): Promise<KarateMcpToolOutcome> {
        switch (name) {
            case 'generate_tests':
                return this.toolService.generateTests(args);
            case 'check_coverage':
                return this.toolService.checkCoverage(args);
            case 'repair_test':
                return this.toolService.repairTest(args);
            case 'list_flaky':
                return this.toolService.listFlaky(args);
            case 'run_feature':
                return this.toolService.runFeature(args);
            default:
                return {
                    ok: false,
                    text: `Unknown tool: ${name}`,
                    data: { error: `Unknown tool: ${name}` }
                };
        }
    }

    private getToolDefinitions(): McpToolDefinition[] {
        return [
            {
                name: 'generate_tests',
                description: 'Generate Karate feature content from an OpenAPI specification without writing files.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        spec_path: { type: 'string', description: 'Workspace-relative or absolute path to OpenAPI spec file.' },
                        options: {
                            type: 'object',
                            properties: {
                                scenario_types: { type: 'array', items: { type: 'string' } },
                                http_methods: { type: 'array', items: { type: 'string' } },
                                structuring_strategy: { type: 'string', enum: ['flat', 'domain', 'method'] },
                                include_background: { type: 'boolean' }
                            },
                            additionalProperties: false
                        }
                    },
                    required: ['spec_path'],
                    additionalProperties: false
                },
                outputSchema: {
                    type: 'object',
                    properties: {
                        specPath: { type: 'string' },
                        totalEndpoints: { type: 'number' },
                        files: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    fileName: { type: 'string' },
                                    content: { type: 'string' }
                                },
                                required: ['fileName', 'content']
                            }
                        }
                    },
                    required: ['files']
                }
            },
            {
                name: 'check_coverage',
                description: 'Compare OpenAPI endpoints against feature files and return coverage breakdown.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        spec_path: { type: 'string' },
                        feature_dir: { type: 'string' }
                    },
                    required: ['spec_path', 'feature_dir'],
                    additionalProperties: false
                },
                outputSchema: {
                    type: 'object',
                    properties: {
                        percent: { type: 'number' },
                        tested: { type: 'array', items: { type: 'string' } },
                        untested: { type: 'array', items: { type: 'string' } }
                    },
                    required: ['percent', 'tested', 'untested']
                }
            },
            {
                name: 'repair_test',
                description: 'Generate a scenario repair patch from a failing error; optionally apply it.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        feature_path: { type: 'string' },
                        scenario_name: { type: 'string' },
                        error_message: { type: 'string' },
                        ci_run_id: { type: 'string' },
                        apply: { type: 'boolean' }
                    },
                    required: ['feature_path', 'scenario_name', 'error_message'],
                    additionalProperties: false
                },
                outputSchema: {
                    type: 'object',
                    properties: {
                        diff: { type: 'string' },
                        patch: { type: 'string' },
                        confidence: { type: 'number' },
                        applied: { type: 'boolean' }
                    },
                    required: ['diff', 'patch', 'confidence', 'applied']
                }
            },
            {
                name: 'list_flaky',
                description: 'Rank flaky scenarios with score, tier, trend, and fix suggestions.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        feature_dir: { type: 'string' },
                        min_runs: { type: 'number' }
                    },
                    required: ['feature_dir'],
                    additionalProperties: false
                },
                outputSchema: {
                    type: 'object',
                    properties: {
                        scenarios: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    featurePath: { type: 'string' },
                                    scenarioName: { type: 'string' },
                                    score: { type: 'number' },
                                    tier: { type: 'string', enum: ['stable', 'watch', 'flaky', 'broken'] },
                                    trend: { type: 'string' },
                                    suggestedFix: { type: 'string' }
                                },
                                required: ['featurePath', 'scenarioName', 'score', 'tier', 'trend']
                            }
                        }
                    },
                    required: ['scenarios']
                }
            },
            {
                name: 'run_feature',
                description: 'Run Karate features using CLI JAR backend and return parsed execution results.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        feature_path: { type: 'string' },
                        feature_dir: { type: 'string' },
                        tags: { type: 'array', items: { type: 'string' } }
                    },
                    additionalProperties: false
                },
                outputSchema: {
                    type: 'object',
                    properties: {
                        status: { type: 'string' },
                        summary: { type: 'object' },
                        features: { type: 'array' }
                    },
                    required: ['status', 'summary', 'features']
                }
            }
        ];
    }

    private async readJsonRequest(req: http.IncomingMessage): Promise<JsonRpcRequest | null> {
        return new Promise(resolve => {
            let body = '';
            req.on('data', chunk => {
                body += chunk;
                if (body.length > 5_000_000) {
                    req.destroy();
                }
            });
            req.on('end', () => {
                try {
                    if (!body.trim()) {
                        resolve(null);
                        return;
                    }
                    const parsed = JSON.parse(body) as JsonRpcRequest;
                    if (!parsed || parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
                        resolve(null);
                        return;
                    }
                    resolve(parsed);
                } catch {
                    resolve(null);
                }
            });
            req.on('error', () => resolve(null));
        });
    }

    private handleSseConnect(res: http.ServerResponse): void {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
        });
        this.sseClients.add(res);
        res.write(`event: ready\n`);
        res.write(`data: {"message":"connected"}\n\n`);
        res.on('close', () => {
            this.sseClients.delete(res);
        });
    }

    private broadcastSse(event: string, payload: unknown): void {
        const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
        for (const client of this.sseClients) {
            try {
                client.write(data);
            } catch {
                this.sseClients.delete(client);
            }
        }
    }

    private writeJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    }

    private getHostConfig(): { host: string; port: number } {
        const config = vscode.workspace.getConfiguration('karateDsl');
        const host = config.get<string>('mcp.host', '127.0.0.1') || '127.0.0.1';
        const port = config.get<number>('mcp.port', 47393) || 47393;
        return { host, port };
    }

    private async isAuthorized(req: http.IncomingMessage): Promise<boolean> {
        const enabled = await this.hasTokenAuthEnabled();
        if (!enabled) {
            return true;
        }

        const authHeader = req.headers.authorization || '';
        if (!authHeader.startsWith('Bearer ')) {
            return false;
        }

        const expected = await this.ensureToken();
        const actual = authHeader.substring('Bearer '.length).trim();
        return expected === actual;
    }

    private async ensureToken(): Promise<string> {
        let token = await this.context.secrets.get(KarateMcpHostService.TOKEN_KEY);
        if (!token) {
            token = this.generateToken();
            await this.context.secrets.store(KarateMcpHostService.TOKEN_KEY, token);
        }
        return token;
    }

    private generateToken(): string {
        return crypto.randomBytes(24).toString('hex');
    }

    dispose(): void {
        this.stop();
    }
}
