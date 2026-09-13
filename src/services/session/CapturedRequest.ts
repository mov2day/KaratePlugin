/**
 * Type definitions for captured HTTP request/response data
 * Used by SessionRecorder and HarImporter
 */

/**
 * Captured HTTP request with full details
 */
export interface CapturedRequest {
    id: string;                         // Unique identifier for this request
    timestamp: number;                  // Unix timestamp when request was captured
    method: string;                     // HTTP method (GET, POST, PUT, DELETE, etc.)
    url: string;                        // Full URL including query string
    path: string;                       // URL path without host
    host: string;                       // Host/domain
    headers: Record<string, string>;    // Request headers
    body?: string;                      // Request body (if any)
    response?: CapturedResponse;        // Response data (if available)
}

/**
 * Captured HTTP response
 */
export interface CapturedResponse {
    status: number;                     // HTTP status code
    statusText?: string;                // Status message
    headers: Record<string, string>;    // Response headers
    body?: string;                      // Response body
    duration: number;                   // Response time in milliseconds
}

/**
 * Session recording state
 */
export interface RecordingSession {
    id: string;                         // Session identifier
    startTime: number;                  // When recording started
    endTime?: number;                   // When recording ended
    requests: CapturedRequest[];        // Captured requests
    proxyPort?: number;                 // Port the proxy is running on
    status: 'recording' | 'stopped' | 'synthesizing';
}

/**
 * HAR (HTTP Archive) Entry - subset of HAR 1.2 spec
 */
export interface HarEntry {
    startedDateTime: string;
    time: number;
    request: {
        method: string;
        url: string;
        headers: Array<{ name: string; value: string }>;
        postData?: {
            mimeType: string;
            text?: string;
            params?: Array<{ name: string; value: string }>;
        };
    };
    response: {
        status: number;
        statusText: string;
        headers: Array<{ name: string; value: string }>;
        content: {
            size: number;
            mimeType: string;
            text?: string;
            encoding?: string;
        };
    };
    timings: {
        wait: number;
        receive: number;
    };
}

/**
 * HAR file structure
 */
export interface HarFile {
    log: {
        version: string;
        creator: {
            name: string;
            version: string;
        };
        entries: HarEntry[];
    };
}

/**
 * Filter options for HAR import
 */
export interface HarFilterOptions {
    includeDomains?: string[];          // Only include these domains
    excludeDomains?: string[];          // Exclude these domains
    includePaths?: string[];            // Path patterns to include
    excludePaths?: string[];            // Path patterns to exclude
    methods?: string[];                 // Only include these methods
    minStatus?: number;                 // Minimum status code
    maxStatus?: number;                 // Maximum status code
}

/**
 * Resource lifecycle detection result
 */
export interface ResourceLifecycle {
    resourceType: string;               // e.g., 'orders', 'users'
    basePath: string;                   // e.g., '/api/orders'
    createRequest?: CapturedRequest;    // POST request that creates
    readRequests: CapturedRequest[];    // GET requests that read
    updateRequests: CapturedRequest[];  // PUT/PATCH requests
    deleteRequest?: CapturedRequest;    // DELETE request
    idField: string;                    // Field containing the ID (e.g., 'id', 'orderId')
    extractedIds: Map<string, string>;  // Mapping of request IDs to extracted values
}

/**
 * Convert HAR entry to CapturedRequest format
 */
export function harEntryToCapturedRequest(entry: HarEntry): CapturedRequest {
    const url = new URL(entry.request.url);
    const timestamp = new Date(entry.startedDateTime).getTime();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !Number.isFinite(timestamp) || typeof entry.request.method !== 'string') throw new Error('Invalid HAR request URL, time, or method.');

    // Convert headers array to object
    const requestHeaders: Record<string, string> = Object.create(null);
    for (const header of entry.request.headers || []) {
        requestHeaders[header.name] = header.value;
    }

    const responseHeaders: Record<string, string> = Object.create(null);
    for (const header of entry.response.headers || []) {
        responseHeaders[header.name] = header.value;
    }
    if (!Object.keys(responseHeaders).some(key => key.toLowerCase() === 'content-type') && entry.response.content?.mimeType) responseHeaders['content-type'] = entry.response.content.mimeType;

    return {
        id: `har-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        timestamp,
        method: entry.request.method.toUpperCase(),
        url: entry.request.url,
        path: url.pathname + url.search,
        host: url.host,
        headers: requestHeaders,
        body: entry.request.postData?.text,
        response: entry.response.status >= 100 && entry.response.status <= 599 ? {
            status: entry.response.status,
            statusText: entry.response.statusText,
            headers: responseHeaders,
            body: entry.response.content?.encoding === 'base64' && typeof entry.response.content.text === 'string'
                ? Buffer.from(entry.response.content.text, 'base64').toString('utf8') : entry.response.content?.text,
            duration: entry.time
        } : undefined
    };
}

/**
 * Generate a unique request ID
 */
export function generateRequestId(): string {
    return `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Generate a unique session ID
 */
export function generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
