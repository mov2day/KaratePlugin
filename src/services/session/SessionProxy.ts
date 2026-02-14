import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as url from 'url';
import { EventEmitter } from 'events';
import { Duplex } from 'stream';
import { CapturedRequest, CapturedResponse, generateRequestId } from './CapturedRequest';
import { logger } from '../../utils/logger';

/**
 * HTTP Proxy server for capturing API requests
 * Acts as a man-in-the-middle to intercept and log HTTP traffic
 */
export class SessionProxy extends EventEmitter {
    private server: http.Server | null = null;
    private port: number = 8081;
    private isRunning: boolean = false;
    private capturedRequests: CapturedRequest[] = [];

    // Port range to try
    private static readonly PORT_RANGE_START = 8081;
    private static readonly PORT_RANGE_END = 8099;

    constructor() {
        super();
    }

    /**
     * Start the proxy server
     */
    async start(preferredPort?: number): Promise<number> {
        if (this.isRunning) {
            throw new Error('Proxy is already running');
        }

        const startPort = preferredPort || SessionProxy.PORT_RANGE_START;
        this.port = await this.findAvailablePort(startPort);

        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                this.handleRequest(req, res);
            });

            // Handle CONNECT method for HTTPS tunneling
            this.server.on('connect', (req, socket: Duplex, head) => {
                this.handleConnect(req, socket, head);
            });

            this.server.on('error', (err) => {
                logger.error('Proxy server error', err);
                this.emit('error', err);
                reject(err);
            });

            this.server.listen(this.port, () => {
                this.isRunning = true;
                logger.info(`Session proxy started on port ${this.port}`);
                this.emit('started', this.port);
                resolve(this.port);
            });
        });
    }

    /**
     * Stop the proxy server
     */
    async stop(): Promise<CapturedRequest[]> {
        if (!this.isRunning || !this.server) {
            return this.capturedRequests;
        }

        return new Promise((resolve) => {
            this.server!.close(() => {
                this.isRunning = false;
                logger.info(`Session proxy stopped. Captured ${this.capturedRequests.length} requests`);
                this.emit('stopped', this.capturedRequests);
                resolve(this.capturedRequests);
            });
        });
    }

    /**
     * Get all captured requests
     */
    getRequests(): CapturedRequest[] {
        return [...this.capturedRequests];
    }

    /**
     * Clear captured requests
     */
    clearRequests(): void {
        this.capturedRequests = [];
    }

    /**
     * Check if proxy is running
     */
    isActive(): boolean {
        return this.isRunning;
    }

    /**
     * Get the current port
     */
    getPort(): number {
        return this.port;
    }

    /**
     * Handle HTTP requests
     */
    private handleRequest(clientReq: http.IncomingMessage, clientRes: http.ServerResponse): void {
        const startTime = Date.now();
        const requestId = generateRequestId();

        // Parse the target URL
        const targetUrl = clientReq.url || '/';
        let parsedUrl: url.URL;

        try {
            // Handle both absolute and relative URLs
            if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) {
                parsedUrl = new url.URL(targetUrl);
            } else {
                // Relative URL - use Host header
                const host = clientReq.headers.host || 'localhost';
                parsedUrl = new url.URL(targetUrl, `http://${host}`);
            }
        } catch (error) {
            logger.error(`Failed to parse URL: ${targetUrl}`, error as Error);
            clientRes.writeHead(400, { 'Content-Type': 'text/plain' });
            clientRes.end('Bad Request: Invalid URL');
            return;
        }

        // Capture request headers
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(clientReq.headers)) {
            if (value) {
                headers[key] = Array.isArray(value) ? value.join(', ') : value;
            }
        }

        // Remove proxy-specific headers
        delete headers['proxy-connection'];
        delete headers['proxy-authorization'];

        // Collect request body
        let requestBody = '';
        clientReq.on('data', (chunk) => {
            requestBody += chunk.toString();
        });

        clientReq.on('end', () => {
            // Create captured request
            const captured: CapturedRequest = {
                id: requestId,
                timestamp: startTime,
                method: clientReq.method || 'GET',
                url: parsedUrl.href,
                path: parsedUrl.pathname + parsedUrl.search,
                host: parsedUrl.host,
                headers,
                body: requestBody || undefined
            };

            // Forward request to target server
            const options: http.RequestOptions = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                method: clientReq.method,
                headers
            };

            const protocol = parsedUrl.protocol === 'https:' ? https : http;

            const proxyReq = protocol.request(options, (proxyRes) => {
                // Capture response headers
                const responseHeaders: Record<string, string> = {};
                for (const [key, value] of Object.entries(proxyRes.headers)) {
                    if (value) {
                        responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
                    }
                }

                // Collect response body
                let responseBody = '';
                proxyRes.on('data', (chunk) => {
                    responseBody += chunk.toString();
                });

                proxyRes.on('end', () => {
                    const duration = Date.now() - startTime;

                    // Add response to captured request
                    captured.response = {
                        status: proxyRes.statusCode || 0,
                        statusText: proxyRes.statusMessage,
                        headers: responseHeaders,
                        body: responseBody || undefined,
                        duration
                    };

                    // Store captured request
                    this.capturedRequests.push(captured);
                    this.emit('request', captured);

                    logger.info(`[CAPTURED] ${captured.method} ${captured.url} - ${captured.response.status} (${duration}ms)`);
                });

                // Forward response to client
                clientRes.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
                proxyRes.pipe(clientRes);
            });

            proxyReq.on('error', (error) => {
                logger.error(`Proxy request error: ${error.message}`);

                // Store failed request
                captured.response = {
                    status: 0,
                    statusText: error.message,
                    headers: {},
                    duration: Date.now() - startTime
                };
                this.capturedRequests.push(captured);

                clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
                clientRes.end(`Proxy Error: ${error.message}`);
            });

            // Send request body
            if (requestBody) {
                proxyReq.write(requestBody);
            }
            proxyReq.end();
        });
    }

    /**
     * Handle HTTPS CONNECT tunneling
     * Note: We can't decrypt HTTPS traffic without SSL termination,
     * but we capture the connection info to show which hosts were accessed
     */
    private handleConnect(req: http.IncomingMessage, clientSocket: Duplex, head: Buffer): void {
        const [hostname, port] = (req.url || '').split(':');
        const targetPort = parseInt(port, 10) || 443;
        const requestId = generateRequestId();
        const startTime = Date.now();

        logger.info(`[CONNECT] Tunneling to ${hostname}:${targetPort}`);

        // Capture HTTPS tunnel info as a request entry
        const captured: CapturedRequest = {
            id: requestId,
            timestamp: startTime,
            method: 'CONNECT',
            url: `https://${hostname}:${targetPort}`,
            path: '/',
            host: `${hostname}:${targetPort}`,
            headers: {},
            body: undefined
        };

        const serverSocket = net.connect(targetPort, hostname, () => {
            // Connection successful - update captured request with success status
            captured.response = {
                status: 200,
                statusText: 'Connection Established',
                headers: {},
                body: undefined,
                duration: Date.now() - startTime
            };

            // Store the captured tunnel request
            this.capturedRequests.push(captured);
            this.emit('request', captured);

            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            serverSocket.write(head);

            // Bi-directional piping
            serverSocket.pipe(clientSocket);
            clientSocket.pipe(serverSocket);
        });

        serverSocket.on('error', (err) => {
            logger.error(`CONNECT tunnel error: ${err.message}`);

            // Capture the failed connection attempt
            captured.response = {
                status: 502,
                statusText: 'Bad Gateway',
                headers: {},
                body: `Tunnel Error: ${err.message}`,
                duration: Date.now() - startTime
            };

            this.capturedRequests.push(captured);
            this.emit('request', captured);

            clientSocket.destroy();
        });

        clientSocket.on('error', (err) => {
            logger.error(`Client socket error: ${err.message}`);
            serverSocket.end();
        });
    }

    /**
     * Find an available port in the configured range
     */
    private async findAvailablePort(startPort: number): Promise<number> {
        for (let port = startPort; port <= SessionProxy.PORT_RANGE_END; port++) {
            if (await this.isPortAvailable(port)) {
                return port;
            }
        }
        throw new Error(`No available ports in range ${startPort}-${SessionProxy.PORT_RANGE_END}`);
    }

    /**
     * Check if a port is available
     */
    private isPortAvailable(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const server = net.createServer();

            server.once('error', () => {
                resolve(false);
            });

            server.once('listening', () => {
                server.close();
                resolve(true);
            });

            server.listen(port);
        });
    }
}
