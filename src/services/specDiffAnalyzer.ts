import { OpenAPIParser } from './openApiParser';
import { logger } from '../utils/logger';
import * as path from 'path';

/**
 * Details about a specific change in an endpoint
 */
export interface ChangeDetail {
    field: string;                 // e.g., "requestBody", "responses.200"
    oldValue: any;
    newValue: any;
    isBreaking: boolean;
}

/**
 * Information about an endpoint change
 */
export interface EndpointChange {
    path: string;
    method: string;
    changeType: 'added' | 'removed' | 'modified';
    details: ChangeDetail[];
}

/**
 * Breaking change information
 */
export interface BreakingChange {
    endpoint: string;
    description: string;
    severity: 'high' | 'medium' | 'low';
    recommendation: string;
}

/**
 * Complete diff analysis result
 */
export interface SpecDiff {
    added: EndpointChange[];       // New endpoints
    removed: EndpointChange[];     // Deleted endpoints
    modified: EndpointChange[];    // Changed endpoints
    breaking: BreakingChange[];    // Breaking changes
    summary: string;               // Human-readable summary
}

/**
 * Analyzes differences between two versions of an OpenAPI spec
 */
export class SpecDiffAnalyzer {

    /**
     * Analyze differences between old and new spec
     */
    public async analyzeDiff(
        oldSpecPath: string,
        newSpecPath: string
    ): Promise<SpecDiff> {
        try {
            const parser = new OpenAPIParser();

            // Parse both versions
            const oldEndpoints = await parser.parseSpec(oldSpecPath);
            const newEndpoints = await parser.parseSpec(newSpecPath);

            // Create endpoint maps for comparison
            const oldMap = this.createEndpointMap(oldEndpoints);
            const newMap = this.createEndpointMap(newEndpoints);

            const diff: SpecDiff = {
                added: [],
                removed: [],
                modified: [],
                breaking: [],
                summary: ''
            };

            // Find added endpoints
            for (const [key, endpoint] of newMap) {
                if (!oldMap.has(key)) {
                    diff.added.push({
                        path: endpoint.path,
                        method: endpoint.method,
                        changeType: 'added',
                        details: []
                    });
                }
            }

            // Find removed endpoints
            for (const [key, endpoint] of oldMap) {
                if (!newMap.has(key)) {
                    diff.removed.push({
                        path: endpoint.path,
                        method: endpoint.method,
                        changeType: 'removed',
                        details: []
                    });

                    // Removed endpoints are breaking changes
                    diff.breaking.push({
                        endpoint: `${endpoint.method} ${endpoint.path}`,
                        description: 'Endpoint removed from specification',
                        severity: 'high',
                        recommendation: 'Remove corresponding tests or mark as deprecated'
                    });
                }
            }

            // Find modified endpoints
            for (const [key, newEndpoint] of newMap) {
                const oldEndpoint = oldMap.get(key);
                if (oldEndpoint) {
                    const changes = this.compareEndpoints(oldEndpoint, newEndpoint);
                    if (changes.length > 0) {
                        diff.modified.push({
                            path: newEndpoint.path,
                            method: newEndpoint.method,
                            changeType: 'modified',
                            details: changes
                        });

                        // Check for breaking changes
                        const breaking = changes.filter(c => c.isBreaking);
                        if (breaking.length > 0) {
                            diff.breaking.push({
                                endpoint: `${newEndpoint.method} ${newEndpoint.path}`,
                                description: this.describeBreakingChanges(breaking),
                                severity: this.calculateSeverity(breaking),
                                recommendation: 'Review and update tests to match new contract'
                            });
                        }
                    }
                }
            }

            diff.summary = this.generateSummary(diff);

            logger.info(`SpecDiffAnalyzer: Analyzed diff for ${path.basename(newSpecPath)}: ${diff.summary}`);

            return diff;
        } catch (error) {
            logger.error('SpecDiffAnalyzer: Error analyzing diff', error as Error);
            throw error;
        }
    }

    /**
     * Create a map of endpoints for easy comparison
     */
    private createEndpointMap(endpoints: any[]): Map<string, any> {
        const map = new Map();
        for (const endpoint of endpoints) {
            const key = `${endpoint.method}:${endpoint.path}`;
            map.set(key, endpoint);
        }
        return map;
    }

    /**
     * Compare two endpoint versions and identify changes
     */
    private compareEndpoints(oldEp: any, newEp: any): ChangeDetail[] {
        const changes: ChangeDetail[] = [];

        // Compare request body
        const oldBodyStr = JSON.stringify(oldEp.requestBody || {});
        const newBodyStr = JSON.stringify(newEp.requestBody || {});
        if (oldBodyStr !== newBodyStr) {
            changes.push({
                field: 'requestBody',
                oldValue: oldEp.requestBody,
                newValue: newEp.requestBody,
                isBreaking: this.isRequestBodyBreaking(oldEp.requestBody, newEp.requestBody)
            });
        }

        // Compare responses
        const oldRespStr = JSON.stringify(oldEp.responses || {});
        const newRespStr = JSON.stringify(newEp.responses || {});
        if (oldRespStr !== newRespStr) {
            changes.push({
                field: 'responses',
                oldValue: oldEp.responses,
                newValue: newEp.responses,
                isBreaking: this.isResponseBreaking(oldEp.responses, newEp.responses)
            });
        }

        // Compare parameters
        const oldParamsStr = JSON.stringify(oldEp.parameters || []);
        const newParamsStr = JSON.stringify(newEp.parameters || []);
        if (oldParamsStr !== newParamsStr) {
            changes.push({
                field: 'parameters',
                oldValue: oldEp.parameters,
                newValue: newEp.parameters,
                isBreaking: this.isParameterBreaking(oldEp.parameters, newEp.parameters)
            });
        }

        // Compare description (non-breaking)
        if (oldEp.description !== newEp.description) {
            changes.push({
                field: 'description',
                oldValue: oldEp.description,
                newValue: newEp.description,
                isBreaking: false
            });
        }

        return changes;
    }

    /**
     * Check if request body change is breaking
     */
    private isRequestBodyBreaking(oldBody: any, newBody: any): boolean {
        if (!oldBody && newBody) {
            // Adding required request body is breaking
            return newBody.required === true;
        }

        if (oldBody && !newBody) {
            // Removing request body is breaking
            return true;
        }

        // Check if required fields were added
        const oldRequired = oldBody?.schema?.required || [];
        const newRequired = newBody?.schema?.required || [];

        // New required fields = breaking
        const addedRequired = newRequired.filter((r: string) => !oldRequired.includes(r));
        return addedRequired.length > 0;
    }

    /**
     * Check if response change is breaking
     */
    private isResponseBreaking(oldResp: any, newResp: any): boolean {
        // Removing a success response code is breaking
        const oldCodes = Object.keys(oldResp || {});
        const newCodes = Object.keys(newResp || {});

        const removedCodes = oldCodes.filter(code => !newCodes.includes(code));
        const hasRemovedSuccess = removedCodes.some(code => code.startsWith('2'));

        if (hasRemovedSuccess) {
            return true;
        }

        // Changing response schema significantly is breaking
        // (Simplified - in real implementation, would do deep schema comparison)
        return false;
    }

    /**
     * Check if parameter change is breaking
     */
    private isParameterBreaking(oldParams: any[], newParams: any[]): boolean {
        if (!oldParams) oldParams = [];
        if (!newParams) newParams = [];

        // Check if required parameters were added
        const oldRequired = oldParams.filter(p => p.required).map(p => p.name);
        const newRequired = newParams.filter(p => p.required).map(p => p.name);

        const addedRequired = newRequired.filter(name => !oldRequired.includes(name));
        if (addedRequired.length > 0) {
            return true;
        }

        // Check if parameters were removed
        const oldNames = oldParams.map(p => p.name);
        const newNames = newParams.map(p => p.name);

        const removedParams = oldNames.filter(name => !newNames.includes(name));
        return removedParams.length > 0;
    }

    /**
     * Describe breaking changes in human-readable format
     */
    private describeBreakingChanges(changes: ChangeDetail[]): string {
        const descriptions: string[] = [];

        for (const change of changes) {
            if (change.field === 'requestBody') {
                descriptions.push('Request body schema changed');
            } else if (change.field === 'responses') {
                descriptions.push('Response schema changed');
            } else if (change.field === 'parameters') {
                descriptions.push('Required parameters changed');
            }
        }

        return descriptions.join(', ') || 'Endpoint contract modified';
    }

    /**
     * Calculate severity of breaking changes
     */
    private calculateSeverity(changes: ChangeDetail[]): 'high' | 'medium' | 'low' {
        // High severity if request body or parameters changed
        const hasRequestChange = changes.some(c =>
            c.field === 'requestBody' || c.field === 'parameters'
        );

        if (hasRequestChange) {
            return 'high';
        }

        // Medium severity if responses changed
        const hasResponseChange = changes.some(c => c.field === 'responses');
        if (hasResponseChange) {
            return 'medium';
        }

        return 'low';
    }

    /**
     * Generate human-readable summary
     */
    private generateSummary(diff: SpecDiff): string {
        const parts: string[] = [];

        if (diff.added.length > 0) {
            parts.push(`${diff.added.length} endpoint${diff.added.length > 1 ? 's' : ''} added`);
        }
        if (diff.removed.length > 0) {
            parts.push(`${diff.removed.length} endpoint${diff.removed.length > 1 ? 's' : ''} removed`);
        }
        if (diff.modified.length > 0) {
            parts.push(`${diff.modified.length} endpoint${diff.modified.length > 1 ? 's' : ''} modified`);
        }
        if (diff.breaking.length > 0) {
            parts.push(`${diff.breaking.length} breaking change${diff.breaking.length > 1 ? 's' : ''}`);
        }

        return parts.length > 0 ? parts.join(', ') : 'No changes detected';
    }
}
