import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { OpenAPIParser } from './openApiParser';
import { logger } from '../utils/logger';

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

        const content = fs.readFileSync(featureFilePath, 'utf-8');
        const lines = content.split('\n');

        // Look for scenario with matching path
        const pathPattern = endpoint.path.replace(/\{[^}]+\}/g, '.*'); // Replace path params with wildcard
        const scenarioPattern = new RegExp(`Scenario:.*${endpoint.method}.*${pathPattern}`, 'i');

        for (let i = 0; i < lines.length; i++) {
            if (scenarioPattern.test(lines[i])) {
                // Found the scenario, find its end
                let endLine = i + 1;
                while (endLine < lines.length &&
                    !lines[endLine].trim().startsWith('Scenario:') &&
                    !lines[endLine].trim().startsWith('Feature:')) {
                    endLine++;
                }

                return {
                    found: true,
                    startLine: i,
                    endLine: endLine - 1,
                    content: lines.slice(i, endLine).join('\n')
                };
            }
        }

        return { found: false, startLine: -1, endLine: -1, content: '' };
    }

    /**
     * Update or add scenario in feature file
     */
    public async updateFeatureFile(
        featureFilePath: string,
        endpoint: any,
        newScenarioContent: string
    ): Promise<void> {
        const scenario = this.findScenarioInFile(featureFilePath, endpoint);

        if (!scenario) {
            // Append new scenario
            const content = fs.readFileSync(featureFilePath, 'utf-8');
            const updatedContent = content + '\n\n' + newScenarioContent;
            fs.writeFileSync(featureFilePath, updatedContent, 'utf-8');
            logger.info(`Added new scenario to ${featureFilePath}`);
        } else if (scenario.found) {
            // Replace existing scenario
            const content = fs.readFileSync(featureFilePath, 'utf-8');
            const lines = content.split('\n');

            const before = lines.slice(0, scenario.startLine);
            const after = lines.slice(scenario.endLine + 1);

            const updated = [...before, newScenarioContent, ...after].join('\n');
            fs.writeFileSync(featureFilePath, updated, 'utf-8');
            logger.info(`Updated scenario in ${featureFilePath}`);
        } else {
            // Append new scenario
            const content = fs.readFileSync(featureFilePath, 'utf-8');
            const updatedContent = content + '\n\n' + newScenarioContent;
            fs.writeFileSync(featureFilePath, updatedContent, 'utf-8');
            logger.info(`Added new scenario to ${featureFilePath}`);
        }
    }

    /**
     * Remove scenario from feature file
     */
    public async removeScenarioFromFile(
        featureFilePath: string,
        endpoint: any
    ): Promise<void> {
        const scenario = this.findScenarioInFile(featureFilePath, endpoint);

        if (scenario && scenario.found) {
            const content = fs.readFileSync(featureFilePath, 'utf-8');
            const lines = content.split('\n');

            // Add deprecation comment instead of removing
            const deprecationComment = `  # DEPRECATED: Endpoint removed from spec on ${new Date().toISOString()}`;
            lines.splice(scenario.startLine + 1, 0, deprecationComment);

            fs.writeFileSync(featureFilePath, lines.join('\n'), 'utf-8');
            logger.info(`Marked scenario as deprecated in ${featureFilePath}`);
        }
    }
}
