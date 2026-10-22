import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { OpenAPIParser } from './openApiParser';
import { logger } from '../utils/logger';
import { findScenarioRanges, markScenariosDeprecated, replaceScenarios } from './specDiffMatch';

/**
 * Service for comparing two OpenAPI spec versions and updating feature files
 */
export class ManualDiffService {

    /**
     * Compare two OpenAPI specs and find differences
     */
    public async compareSpecs(
        oldSpecPath: string,
        newSpecPath: string
    ): Promise<{
        added: any[];
        removed: any[];
        modified: any[];
        summary: string;
    }> {
        const parser = new OpenAPIParser();

        const oldEndpoints = await parser.parseSpec(oldSpecPath);
        const newEndpoints = await parser.parseSpec(newSpecPath);

        const oldPaths = new Map(oldEndpoints.map(e => [`${e.method}:${e.path}`, e]));
        const newPaths = new Map(newEndpoints.map(e => [`${e.method}:${e.path}`, e]));

        const added = newEndpoints.filter(e => !oldPaths.has(`${e.method}:${e.path}`));
        const removed = oldEndpoints.filter(e => !newPaths.has(`${e.method}:${e.path}`));
        const modified: any[] = [];

        // Check for modifications
        for (const [key, newEp] of newPaths) {
            const oldEp = oldPaths.get(key);
            if (oldEp) {
                // Simple check: compare operationId or description
                if (oldEp.operationId !== newEp.operationId ||
                    oldEp.description !== newEp.description) {
                    modified.push(newEp);
                }
            }
        }

        const parts: string[] = [];
        if (added.length > 0) parts.push(`${added.length} added`);
        if (removed.length > 0) parts.push(`${removed.length} removed`);
        if (modified.length > 0) parts.push(`${modified.length} modified`);

        return {
            added,
            removed,
            modified,
            summary: parts.join(', ') || 'No changes'
        };
    }

    /**
     * Scan workspace for existing feature files
     */
    public async findFeatureFiles(): Promise<string[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return [];
        }

        const featureFiles: string[] = [];

        for (const folder of workspaceFolders) {
            const pattern = new vscode.RelativePattern(folder, '**/*.feature');
            const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
            featureFiles.push(...files.map(f => f.fsPath));
        }

        return featureFiles;
    }

    /**
     * Match an endpoint to the most appropriate feature file
     */
    public matchEndpointToFeatureFile(
        endpoint: any,
        featureFiles: string[]
    ): string | null {
        // Strategy 1: Look for file with matching path segment
        const pathSegments = endpoint.path.split('/').filter((s: string) => s);

        for (const segment of pathSegments) {
            const match = featureFiles.find(f =>
                path.basename(f, '.feature').toLowerCase().includes(segment.toLowerCase())
            );
            if (match) {
                return match;
            }
        }

        // Strategy 2: Look for file with matching method
        const methodMatch = featureFiles.find(f =>
            path.basename(f, '.feature').toLowerCase().includes(endpoint.method.toLowerCase())
        );
        if (methodMatch) {
            return methodMatch;
        }

        // Strategy 3: Look for file with matching operationId
        if (endpoint.operationId) {
            const opIdMatch = featureFiles.find(f =>
                path.basename(f, '.feature').toLowerCase().includes(endpoint.operationId.toLowerCase())
            );
            if (opIdMatch) {
                return opIdMatch;
            }
        }

        return null;
    }

    /**
     * Find scenario in feature file that matches endpoint
     */
    public findScenarioInFile(
        featureFilePath: string,
        endpoint: any
    ): { found: boolean; startLine: number; endLine: number; content: string } | null {
        if (!fs.existsSync(featureFilePath)) {
            return null;
        }

        const lines = fs.readFileSync(featureFilePath, 'utf-8').split('\n');
        const [first] = findScenarioRanges(lines, endpoint.method, endpoint.path);
        if (!first) {
            return { found: false, startLine: -1, endLine: -1, content: '' };
        }
        return { found: true, startLine: first.startLine, endLine: first.endLine, content: lines.slice(first.startLine, first.endLine + 1).join('\n') };
    }

    /**
     * Replace all scenarios of the endpoint with the new content (append when none exist)
     */
    public async updateFeatureFile(
        featureFilePath: string,
        endpoint: any,
        newScenarioContent: string
    ): Promise<void> {
        const content = fs.readFileSync(featureFilePath, 'utf-8');
        const result = replaceScenarios(content, endpoint.method, endpoint.path, newScenarioContent);
        fs.writeFileSync(featureFilePath, result.content, 'utf-8');
        logger.info(result.replaced > 0
            ? `Replaced ${result.replaced} scenario(s) in ${featureFilePath}`
            : `Added new scenario to ${featureFilePath}`);
    }

    /**
     * Mark all scenarios of a removed endpoint as deprecated (they are kept, not deleted)
     */
    public async removeScenarioFromFile(
        featureFilePath: string,
        endpoint: any
    ): Promise<void> {
        if (!fs.existsSync(featureFilePath)) {
            return;
        }
        const content = fs.readFileSync(featureFilePath, 'utf-8');
        const result = markScenariosDeprecated(content, endpoint.method, endpoint.path, new Date().toISOString());
        if (result.marked > 0) {
            fs.writeFileSync(featureFilePath, result.content, 'utf-8');
            logger.info(`Marked ${result.marked} scenario(s) as deprecated in ${featureFilePath}`);
        }
    }
}
