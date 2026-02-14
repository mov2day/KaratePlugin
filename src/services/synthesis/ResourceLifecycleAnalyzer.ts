import { CapturedRequest, ResourceLifecycle } from '../session/CapturedRequest';
import { logger } from '../../utils/logger';

/**
 * Analyzes captured requests to identify resource lifecycles
 * and automatically link variables between requests
 */
export class ResourceLifecycleAnalyzer {

    // Common ID field patterns
    private static readonly ID_PATTERNS = [
        'id', 'Id', 'ID', '_id',
        'orderId', 'userId', 'productId', 'customerId', 'itemId',
        'uuid', 'guid', 'key', 'reference', 'ref'
    ];

    // Regex patterns for path IDs
    private static readonly PATH_ID_REGEX = /\/([0-9a-f-]{8,36}|\d+)(?:\/|$)/gi;

    /**
     * Analyze requests and identify resource lifecycles
     */
    static analyze(requests: CapturedRequest[]): ResourceLifecycle[] {
        const lifecycles: ResourceLifecycle[] = [];

        // Group requests by base path
        const pathGroups = this.groupByBasePath(requests);

        for (const [basePath, groupedRequests] of pathGroups) {
            const lifecycle = this.analyzePathGroup(basePath, groupedRequests);
            if (lifecycle) {
                lifecycles.push(lifecycle);
            }
        }

        logger.info(`Identified ${lifecycles.length} resource lifecycles`);
        return lifecycles;
    }

    /**
     * Group requests by their base resource path
     */
    private static groupByBasePath(requests: CapturedRequest[]): Map<string, CapturedRequest[]> {
        const groups = new Map<string, CapturedRequest[]>();

        for (const request of requests) {
            const basePath = this.extractBasePath(request.path);

            if (!groups.has(basePath)) {
                groups.set(basePath, []);
            }
            groups.get(basePath)!.push(request);
        }

        return groups;
    }

    /**
     * Extract base resource path, removing IDs
     * /api/orders/123 -> /api/orders
     */
    private static extractBasePath(path: string): string {
        // Remove query string
        const pathWithoutQuery = path.split('?')[0];

        // Remove trailing slash
        let cleanPath = pathWithoutQuery.replace(/\/$/, '');

        // Remove UUID patterns
        cleanPath = cleanPath.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '');

        // Remove numeric IDs (but preserve version numbers like /v1/)
        cleanPath = cleanPath.replace(/\/(?!v\d+)(\d+)(?=\/|$)/g, '');

        // Clean up double slashes
        cleanPath = cleanPath.replace(/\/+/g, '/').replace(/\/$/, '');

        return cleanPath || '/';
    }

    /**
     * Analyze a group of requests for the same base path
     */
    private static analyzePathGroup(
        basePath: string,
        requests: CapturedRequest[]
    ): ResourceLifecycle | null {
        // Sort by timestamp
        const sorted = [...requests].sort((a, b) => a.timestamp - b.timestamp);

        const lifecycle: ResourceLifecycle = {
            resourceType: this.extractResourceType(basePath),
            basePath,
            readRequests: [],
            updateRequests: [],
            idField: 'id',
            extractedIds: new Map()
        };

        // Find POST (create) requests
        const postRequests = sorted.filter(r => r.method === 'POST');
        const getRequests = sorted.filter(r => r.method === 'GET');
        const putRequests = sorted.filter(r => r.method === 'PUT' || r.method === 'PATCH');
        const deleteRequests = sorted.filter(r => r.method === 'DELETE');

        if (postRequests.length === 0 && getRequests.length === 0) {
            return null; // Not a meaningful lifecycle
        }

        // Analyze POST requests for ID extraction
        for (const post of postRequests) {
            if (post.response?.body) {
                const extractedId = this.extractIdFromResponse(post.response.body);
                if (extractedId) {
                    lifecycle.createRequest = post;
                    lifecycle.extractedIds.set(post.id, extractedId.value);
                    lifecycle.idField = extractedId.field;

                    logger.info(`Extracted ${extractedId.field}=${extractedId.value} from POST response`);
                    break; // Use first successful extraction
                }
            }
        }

        // Link GET requests that use the extracted ID
        for (const get of getRequests) {
            const pathId = this.extractIdFromPath(get.path);
            if (pathId) {
                // Check if this ID matches any extracted ID
                for (const [requestId, extractedId] of lifecycle.extractedIds) {
                    if (pathId === extractedId) {
                        lifecycle.readRequests.push(get);
                        logger.info(`Linked GET ${get.path} to POST response ID`);
                        break;
                    }
                }
            } else {
                // GET without ID in path (list endpoint)
                lifecycle.readRequests.push(get);
            }
        }

        // Link PUT/PATCH requests
        for (const update of putRequests) {
            const pathId = this.extractIdFromPath(update.path);
            if (pathId) {
                for (const [, extractedId] of lifecycle.extractedIds) {
                    if (pathId === extractedId) {
                        lifecycle.updateRequests.push(update);
                        break;
                    }
                }
            }
        }

        // Link DELETE requests
        for (const del of deleteRequests) {
            const pathId = this.extractIdFromPath(del.path);
            if (pathId) {
                for (const [, extractedId] of lifecycle.extractedIds) {
                    if (pathId === extractedId) {
                        lifecycle.deleteRequest = del;
                        break;
                    }
                }
            }
        }

        return lifecycle;
    }

    /**
     * Extract resource type from path
     * /api/v1/orders -> orders
     */
    private static extractResourceType(path: string): string {
        const parts = path.split('/').filter(p => p && !p.match(/^v\d+$/));
        return parts[parts.length - 1] || 'resource';
    }

    /**
     * Extract ID from response body
     */
    private static extractIdFromResponse(body: string): { field: string; value: string } | null {
        try {
            const json = JSON.parse(body);

            // Check for direct ID fields
            for (const pattern of this.ID_PATTERNS) {
                if (json[pattern] !== undefined && json[pattern] !== null) {
                    return { field: pattern, value: String(json[pattern]) };
                }
            }

            // Check nested data object
            if (json.data && typeof json.data === 'object') {
                for (const pattern of this.ID_PATTERNS) {
                    if (json.data[pattern] !== undefined && json.data[pattern] !== null) {
                        return { field: `data.${pattern}`, value: String(json.data[pattern]) };
                    }
                }
            }

            // Check for resource-specific IDs (e.g., response.order.id)
            for (const key of Object.keys(json)) {
                if (typeof json[key] === 'object' && json[key] !== null) {
                    for (const pattern of this.ID_PATTERNS) {
                        if (json[key][pattern] !== undefined) {
                            return { field: `${key}.${pattern}`, value: String(json[key][pattern]) };
                        }
                    }
                }
            }

        } catch {
            // Not JSON, ignore
        }

        return null;
    }

    /**
     * Extract ID from URL path
     */
    private static extractIdFromPath(path: string): string | null {
        // Remove query string
        const cleanPath = path.split('?')[0];

        // Try to find UUID
        const uuidMatch = cleanPath.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i);
        if (uuidMatch) {
            return uuidMatch[1];
        }

        // Try to find numeric ID at the end of path
        const numericMatch = cleanPath.match(/\/(\d+)(?:\/|$)/);
        if (numericMatch) {
            return numericMatch[1];
        }

        return null;
    }

    /**
     * Generate Karate DSL from analyzed lifecycles
     */
    static generateKarate(
        requests: CapturedRequest[],
        lifecycles: ResourceLifecycle[]
    ): string {
        const lines: string[] = [];
        const processedIds = new Set<string>();

        // Header
        lines.push('Feature: Recorded API Session');
        lines.push('');

        // Generate scenarios for each lifecycle
        for (const lifecycle of lifecycles) {
            if (lifecycle.createRequest || lifecycle.readRequests.length > 0) {
                lines.push(`  # Resource Lifecycle: ${lifecycle.resourceType}`);
                lines.push('');

                const scenarioLines = this.generateLifecycleScenario(lifecycle);
                lines.push(...scenarioLines);
                lines.push('');

                // Mark these requests as processed
                if (lifecycle.createRequest) {
                    processedIds.add(lifecycle.createRequest.id);
                }
                lifecycle.readRequests.forEach(r => processedIds.add(r.id));
                lifecycle.updateRequests.forEach(r => processedIds.add(r.id));
                if (lifecycle.deleteRequest) {
                    processedIds.add(lifecycle.deleteRequest.id);
                }
            }
        }

        // Generate scenarios for unlinked requests
        const unlinkedRequests = requests.filter(r => !processedIds.has(r.id));
        for (const request of unlinkedRequests) {
            lines.push(this.generateSingleRequestScenario(request));
            lines.push('');
        }

        return lines.join('\n');
    }

    /**
     * Generate scenario for a complete resource lifecycle
     */
    private static generateLifecycleScenario(lifecycle: ResourceLifecycle): string[] {
        const lines: string[] = [];
        const resourceName = lifecycle.resourceType.charAt(0).toUpperCase() + lifecycle.resourceType.slice(1);

        lines.push(`  Scenario: ${resourceName} lifecycle`);

        // Create request (POST)
        if (lifecycle.createRequest) {
            const req = lifecycle.createRequest;
            lines.push(`    # Create ${lifecycle.resourceType}`);
            lines.push(`    Given url '${req.host}'`);
            lines.push(`    And path '${this.formatPath(req.path)}'`);

            if (req.body) {
                lines.push(`    And request`);
                lines.push(`    """`);
                lines.push(`    ${this.formatBody(req.body)}`);
                lines.push(`    """`);
            }

            lines.push(`    When method POST`);
            lines.push(`    Then status ${req.response?.status || 201}`);

            // Extract ID from response
            if (lifecycle.extractedIds.size > 0) {
                lines.push(`    * def ${lifecycle.idField.replace('.', '_')} = response.${lifecycle.idField}`);
            }
            lines.push('');
        }

        // Read requests (GET)
        for (const req of lifecycle.readRequests) {
            const pathId = this.extractIdFromPath(req.path);
            lines.push(`    # Read ${lifecycle.resourceType}`);
            lines.push(`    Given url '${req.host}'`);

            if (pathId && lifecycle.extractedIds.size > 0) {
                // Use extracted variable
                const varName = lifecycle.idField.replace('.', '_');
                const pathWithVar = req.path.replace(pathId, `' + ${varName} + '`);
                lines.push(`    And path '${pathWithVar}'`);
            } else {
                lines.push(`    And path '${this.formatPath(req.path)}'`);
            }

            lines.push(`    When method GET`);
            lines.push(`    Then status ${req.response?.status || 200}`);
            lines.push('');
        }

        // Update requests (PUT/PATCH)
        for (const req of lifecycle.updateRequests) {
            const pathId = this.extractIdFromPath(req.path);
            lines.push(`    # Update ${lifecycle.resourceType}`);
            lines.push(`    Given url '${req.host}'`);

            if (pathId && lifecycle.extractedIds.size > 0) {
                const varName = lifecycle.idField.replace('.', '_');
                const pathWithVar = req.path.replace(pathId, `' + ${varName} + '`);
                lines.push(`    And path '${pathWithVar}'`);
            } else {
                lines.push(`    And path '${this.formatPath(req.path)}'`);
            }

            if (req.body) {
                lines.push(`    And request`);
                lines.push(`    """`);
                lines.push(`    ${this.formatBody(req.body)}`);
                lines.push(`    """`);
            }

            lines.push(`    When method ${req.method}`);
            lines.push(`    Then status ${req.response?.status || 200}`);
            lines.push('');
        }

        // Delete request
        if (lifecycle.deleteRequest) {
            const req = lifecycle.deleteRequest;
            const pathId = this.extractIdFromPath(req.path);
            lines.push(`    # Delete ${lifecycle.resourceType}`);
            lines.push(`    Given url '${req.host}'`);

            if (pathId && lifecycle.extractedIds.size > 0) {
                const varName = lifecycle.idField.replace('.', '_');
                const pathWithVar = req.path.replace(pathId, `' + ${varName} + '`);
                lines.push(`    And path '${pathWithVar}'`);
            } else {
                lines.push(`    And path '${this.formatPath(req.path)}'`);
            }

            lines.push(`    When method DELETE`);
            lines.push(`    Then status ${req.response?.status || 204}`);
        }

        return lines;
    }

    /**
     * Generate scenario for a single unlinked request
     */
    private static generateSingleRequestScenario(request: CapturedRequest): string {
        const lines: string[] = [];

        lines.push(`  Scenario: ${request.method} ${request.path.split('?')[0]}`);
        lines.push(`    Given url '${request.host}'`);
        lines.push(`    And path '${this.formatPath(request.path)}'`);

        // Add headers (skip common ones)
        const skipHeaders = ['host', 'content-length', 'connection', 'accept-encoding'];
        for (const [key, value] of Object.entries(request.headers)) {
            if (!skipHeaders.includes(key.toLowerCase())) {
                lines.push(`    And header ${key} = '${value}'`);
            }
        }

        if (request.body) {
            lines.push(`    And request`);
            lines.push(`    """`);
            lines.push(`    ${this.formatBody(request.body)}`);
            lines.push(`    """`);
        }

        lines.push(`    When method ${request.method}`);
        lines.push(`    Then status ${request.response?.status || 200}`);

        return lines.join('\n');
    }

    /**
     * Format path for Karate
     */
    private static formatPath(path: string): string {
        // Remove leading slash and split by /
        const parts = path.replace(/^\//, '').split('/');
        return parts.map(p => `'${p}'`).join(', ');
    }

    /**
     * Format body for Karate
     */
    private static formatBody(body: string): string {
        try {
            // Pretty print JSON
            const json = JSON.parse(body);
            return JSON.stringify(json, null, 2);
        } catch {
            return body;
        }
    }
}
