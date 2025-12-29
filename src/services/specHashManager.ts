import * as vscode from 'vscode';

/**
 * Metadata about an OpenAPI specification and its generated tests
 */
export interface SpecMetadata {
    specPath: string;              // Absolute path to OpenAPI spec
    specHash: string;              // SHA-256 hash of spec content
    generatedTests: string[];      // Paths to generated test files
    lastGenerated: number;         // Timestamp
    endpoints: EndpointInfo[];     // Cached endpoint information
    version: string;               // OpenAPI version (2.0, 3.0, 3.1)
}

/**
 * Information about a specific endpoint in the spec
 */
export interface EndpointInfo {
    path: string;                  // e.g., "/users/{id}"
    method: string;                // GET, POST, etc.
    operationId?: string;          // OpenAPI operationId
    testScenarioName: string;      // Generated scenario name
    testFilePath: string;          // Which .feature file contains this test
}

/**
 * Manages storage and retrieval of OpenAPI spec metadata
 * Tracks spec hashes to detect changes
 */
export class SpecHashManager {
    private readonly STORAGE_KEY = 'karate.specMetadata';

    constructor(private context: vscode.ExtensionContext) { }

    /**
     * Save metadata for a spec file
     */
    public async saveMetadata(metadata: SpecMetadata): Promise<void> {
        const allMetadata = await this.getAllMetadata();
        allMetadata[metadata.specPath] = metadata;
        await this.context.workspaceState.update(this.STORAGE_KEY, allMetadata);
    }

    /**
     * Get metadata for a specific spec file
     */
    public async getMetadata(specPath: string): Promise<SpecMetadata | undefined> {
        const allMetadata = await this.getAllMetadata();
        return allMetadata[specPath];
    }

    /**
     * Get all tracked spec metadata
     */
    public async getAllMetadata(): Promise<Record<string, SpecMetadata>> {
        return this.context.workspaceState.get(this.STORAGE_KEY, {});
    }

    /**
     * Delete metadata for a spec file
     */
    public async deleteMetadata(specPath: string): Promise<void> {
        const allMetadata = await this.getAllMetadata();
        delete allMetadata[specPath];
        await this.context.workspaceState.update(this.STORAGE_KEY, allMetadata);
    }

    /**
     * Check if a spec file is being tracked
     */
    public async isTracked(specPath: string): Promise<boolean> {
        const metadata = await this.getMetadata(specPath);
        return metadata !== undefined;
    }

    /**
     * Get all tracked spec paths
     */
    public async getTrackedSpecs(): Promise<string[]> {
        const allMetadata = await this.getAllMetadata();
        return Object.keys(allMetadata);
    }

    /**
     * Update the hash for a spec (after regeneration)
     */
    public async updateHash(specPath: string, newHash: string): Promise<void> {
        const metadata = await this.getMetadata(specPath);
        if (metadata) {
            metadata.specHash = newHash;
            metadata.lastGenerated = Date.now();
            await this.saveMetadata(metadata);
        }
    }
}
