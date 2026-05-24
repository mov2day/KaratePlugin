import * as http from 'http';
import * as vscode from 'vscode';
import { logger } from '../../utils/logger';

/**
 * CIFailurePayload — structured failure data from CI pipelines.
 */
export interface CIFailurePayload {
    source: 'github-actions' | 'jenkins' | 'gitlab-ci' | 'generic';
    featurePath: string;          // relative to workspace root
    scenarioName: string;
    failedStep: string;
    errorMessage: string;
    httpRequest?: {
        method: string;
        url: string;
        body?: string;
    };
    httpResponse?: {
        status: number;
        body?: string;
        headers?: Record<string, string>;
    };
    timestamp: number;
    runId?: string;               // CI run identifier for grouping
}

/**
 * CIFailureIngestor — localhost webhook server that accepts CI failure payloads
 * and feeds them to the TestRepairService.
 */
export class CIFailureIngestor {
    private server: http.Server | undefined;
    private port: number;

    private readonly _onFailureReceived = new vscode.EventEmitter<CIFailurePayload>();
    readonly onFailureReceived = this._onFailureReceived.event;

    constructor() {
        this.port = this.getPort();
    }

    /**
     * Start the webhook listener.
     */
    start(): void {
        if (this.server) {
            logger.warn('CIFailureIngestor: already running');
            return;
        }

        this.port = this.getPort();

        this.server = http.createServer((req, res) => {
            if (req.method === 'POST' && req.url === '/api/failure') {
                this.handleFailure(req, res);
            } else if (req.method === 'GET' && req.url === '/api/health') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok', version: '1.5.0' }));
            } else {
                res.writeHead(404);
                res.end('Not Found');
            }
        });

        this.server.listen(this.port, '127.0.0.1', () => {
            logger.info(`CIFailureIngestor: listening on http://127.0.0.1:${this.port}`);
            vscode.window.showInformationMessage(
                `CI Repair webhook active on port ${this.port}`
            );
        });

        this.server.on('error', (err: any) => {
            if (err.code === 'EADDRINUSE') {
                logger.error(`CIFailureIngestor: port ${this.port} already in use`);
                vscode.window.showErrorMessage(
                    `CI Repair: Port ${this.port} is in use. Change karateDsl.ciRepair.webhookPort in settings.`
                );
            } else {
                logger.error('CIFailureIngestor: server error', err);
            }
        });
    }

    /**
     * Stop the webhook listener.
     */
    stop(): void {
        if (this.server) {
            this.server.close();
            this.server = undefined;
            logger.info('CIFailureIngestor: stopped');
        }
    }

    /**
     * Check if the ingestor is running.
     */
    isRunning(): boolean {
        return !!this.server;
    }

    private handleFailure(req: http.IncomingMessage, res: http.ServerResponse): void {
        let body = '';

        req.on('data', (chunk) => {
            body += chunk;
            // Limit body size to 1MB
            if (body.length > 1_048_576) {
                res.writeHead(413);
                res.end('Payload Too Large');
                req.destroy();
            }
        });

        req.on('end', () => {
            try {
                const payload = JSON.parse(body) as CIFailurePayload;

                // Validate required fields
                if (!payload.featurePath || !payload.scenarioName || !payload.failedStep || !payload.errorMessage) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'Missing required fields: featurePath, scenarioName, failedStep, errorMessage'
                    }));
                    return;
                }

                // Default source
                if (!payload.source) {
                    payload.source = 'generic';
                }
                if (!payload.timestamp) {
                    payload.timestamp = Date.now();
                }

                logger.info(`CIFailureIngestor: received failure for ${payload.featurePath} :: ${payload.scenarioName}`);

                // Emit event
                this._onFailureReceived.fire(payload);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'accepted', scenario: payload.scenarioName }));

            } catch (error) {
                logger.error('CIFailureIngestor: invalid payload', error as Error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
            }
        });
    }

    private getPort(): number {
        const config = vscode.workspace.getConfiguration('karateDsl');
        return config.get<number>('ciRepair.webhookPort') || 47392;
    }

    dispose(): void {
        this.stop();
        this._onFailureReceived.dispose();
    }
}
