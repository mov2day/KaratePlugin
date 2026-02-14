import * as fs from 'fs';
import { CapturedRequest, HarFile, HarEntry, HarFilterOptions, harEntryToCapturedRequest } from './CapturedRequest';
import { logger } from '../../utils/logger';

/**
 * Import HTTP requests from HAR (HTTP Archive) files
 * Supports HAR 1.2 format exported from browser DevTools or Charles Proxy
 */
export class HarImporter {

    /**
     * Import requests from a HAR file
     */
    static async importFromFile(
        harPath: string,
        options?: HarFilterOptions
    ): Promise<CapturedRequest[]> {
        try {
            const content = fs.readFileSync(harPath, 'utf-8');
            return this.parseHar(content, options);
        } catch (error) {
            logger.error(`Failed to read HAR file: ${harPath}`, error as Error);
            throw new Error(`Failed to read HAR file: ${(error as Error).message}`);
        }
    }

    /**
     * Import requests from HAR content string
     */
    static async importFromContent(
        content: string,
        options?: HarFilterOptions
    ): Promise<CapturedRequest[]> {
        return this.parseHar(content, options);
    }

    /**
     * Parse HAR content and convert to CapturedRequest format
     */
    private static parseHar(content: string, options?: HarFilterOptions): CapturedRequest[] {
        let harFile: HarFile;

        try {
            harFile = JSON.parse(content);
        } catch (error) {
            throw new Error('Invalid HAR file: Could not parse JSON');
        }

        // Validate HAR structure
        if (!harFile.log || !harFile.log.entries) {
            throw new Error('Invalid HAR file: Missing log.entries');
        }

        logger.info(`Parsing HAR file with ${harFile.log.entries.length} entries`);

        // Filter entries if options provided
        let entries = harFile.log.entries;
        if (options) {
            entries = this.filterEntries(entries, options);
            logger.info(`After filtering: ${entries.length} entries`);
        }

        // Convert entries to CapturedRequest format
        const requests: CapturedRequest[] = [];
        for (const entry of entries) {
            try {
                const captured = harEntryToCapturedRequest(entry);
                requests.push(captured);
            } catch (error) {
                logger.warn(`Failed to convert HAR entry: ${error}`);
            }
        }

        // Sort by timestamp
        requests.sort((a, b) => a.timestamp - b.timestamp);

        logger.info(`Imported ${requests.length} requests from HAR`);
        return requests;
    }

    /**
     * Filter HAR entries based on options
     */
    static filterEntries(entries: HarEntry[], options: HarFilterOptions): HarEntry[] {
        return entries.filter(entry => {
            const url = new URL(entry.request.url);

            // Filter by domain
            if (options.includeDomains && options.includeDomains.length > 0) {
                if (!options.includeDomains.some(d => url.hostname.includes(d))) {
                    return false;
                }
            }

            if (options.excludeDomains && options.excludeDomains.length > 0) {
                if (options.excludeDomains.some(d => url.hostname.includes(d))) {
                    return false;
                }
            }

            // Filter by path
            if (options.includePaths && options.includePaths.length > 0) {
                if (!options.includePaths.some(p => url.pathname.includes(p))) {
                    return false;
                }
            }

            if (options.excludePaths && options.excludePaths.length > 0) {
                if (options.excludePaths.some(p => url.pathname.includes(p))) {
                    return false;
                }
            }

            // Filter by method
            if (options.methods && options.methods.length > 0) {
                if (!options.methods.includes(entry.request.method.toUpperCase())) {
                    return false;
                }
            }

            // Filter by status code
            if (options.minStatus !== undefined) {
                if (entry.response.status < options.minStatus) {
                    return false;
                }
            }

            if (options.maxStatus !== undefined) {
                if (entry.response.status > options.maxStatus) {
                    return false;
                }
            }

            return true;
        });
    }

    /**
     * Extract unique domains from HAR entries
     */
    static extractDomains(entries: HarEntry[]): string[] {
        const domains = new Set<string>();

        for (const entry of entries) {
            try {
                const url = new URL(entry.request.url);
                domains.add(url.hostname);
            } catch {
                // Skip invalid URLs
            }
        }

        return Array.from(domains).sort();
    }

    /**
     * Extract unique paths from HAR entries
     */
    static extractPaths(entries: HarEntry[]): string[] {
        const paths = new Set<string>();

        for (const entry of entries) {
            try {
                const url = new URL(entry.request.url);
                // Get base path (remove query string and specific IDs)
                const basePath = url.pathname
                    .replace(/\/[0-9a-f-]{8,36}/gi, '/{id}')  // Replace UUIDs
                    .replace(/\/\d+/g, '/{id}');               // Replace numeric IDs
                paths.add(basePath);
            } catch {
                // Skip invalid URLs
            }
        }

        return Array.from(paths).sort();
    }

    /**
     * Validate HAR file structure without importing
     */
    static validateHarFile(harPath: string): { valid: boolean; entryCount: number; error?: string } {
        try {
            const content = fs.readFileSync(harPath, 'utf-8');
            const harFile: HarFile = JSON.parse(content);

            if (!harFile.log || !harFile.log.entries) {
                return { valid: false, entryCount: 0, error: 'Missing log.entries' };
            }

            return { valid: true, entryCount: harFile.log.entries.length };
        } catch (error) {
            return { valid: false, entryCount: 0, error: (error as Error).message };
        }
    }
}
