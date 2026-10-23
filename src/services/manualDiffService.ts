import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { OpenAPIParser } from './openApiParser';
import { logger } from '../utils/logger';
import { runGate } from '../generation/quality/QualityGate';
import { HEADER_RE, OutputWriter, sha256, splitHeader } from '../generation/write/OutputWriter';
import { findScenarioRanges, markScenariosDeprecated, replaceScenarios } from './specDiffMatch';

/**
 * Service for comparing two OpenAPI spec versions and updating feature files
 */
export class ManualDiffService {

    private hasConsistentGeneratedHeader(content: string): boolean {
        const parsed = splitHeader(content);
        return HEADER_RE.test(content) && parsed.headerHash === sha256(parsed.body);
    }

    /** Route a proposal through OutputWriter so user files always retain their original path. */
    private writeGeneratedSibling(featureFilePath: string, content: string, endpoint: any): string {
        const dir = path.dirname(featureFilePath);
        const fsApi = {
            exists: (p: string) => fs.existsSync(path.join(dir, p)), read: (p: string) => fs.readFileSync(path.join(dir, p), 'utf8'),
            list: (p: string) => fs.readdirSync(path.join(dir, p)), write: (p: string, text: string) => fs.writeFileSync(path.join(dir, p), text, 'utf8')
        };
        const hashes = new Map<string, string>();
        const report = OutputWriter.write([{ path: path.basename(featureFilePath), content, owner: 'generated', source: `${endpoint.method} ${endpoint.path}`, forceSideBySide: true }], fsApi, { get: p => hashes.get(p), set: (p, h) => hashes.set(p, h) }, { generatorVersion: 'manual-diff', workspaceRoot: dir });
        return path.join(dir, report.sideBySide[0].generatedPath);
    }

    /** Preserve existing quality debt; a spec update is blocked only by newly introduced errors. */
    private hasNewGateErrors(before: string, after: string): boolean {
        const key = (f: { ruleId: string; message: string }) => `${f.ruleId}|${f.message.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ')}`;
        const budget = new Map<string, number>();
        for (const finding of runGate(before).findings.filter(f => f.severity === 'error')) {const k = key(finding); budget.set(k, (budget.get(k) ?? 0) + 1);}
        for (const finding of runGate(after).findings.filter(f => f.severity === 'error')) {const k = key(finding); const left = budget.get(k) ?? 0; if (left) {budget.set(k, left - 1);} else {return true;}}
        return false;
    }

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
        if (this.hasNewGateErrors(content, result.content)) {
            const gate = runGate(result.content);
            throw new Error(`Generated scenario rejected by quality gate: ${gate.findings.filter(f => f.severity === 'error').map(f => f.ruleId).join(', ')}`);
        }
        if (!this.hasConsistentGeneratedHeader(content)) {
            const sibling = this.writeGeneratedSibling(featureFilePath, result.content, endpoint);
            logger.info(`Kept user-edited ${featureFilePath}; wrote generated proposal to ${sibling}`);
            return;
        }
        const dir = path.dirname(featureFilePath);
        const body = splitHeader(result.content).body;
        const fsApi = { exists: (p: string) => fs.existsSync(path.join(dir, p)), read: (p: string) => fs.readFileSync(path.join(dir, p), 'utf8'), list: (p: string) => fs.readdirSync(path.join(dir, p)), write: (p: string, text: string) => fs.writeFileSync(path.join(dir, p), text, 'utf8') };
        OutputWriter.write([{ path: path.basename(featureFilePath), content: body, owner: 'generated', source: `${endpoint.method} ${endpoint.path}` }], fsApi, { get: () => undefined, set: () => undefined }, { generatorVersion: 'manual-diff', workspaceRoot: dir });
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
            if (this.hasConsistentGeneratedHeader(content)) {
                const dir = path.dirname(featureFilePath);
                const fsApi = { exists: (p: string) => fs.existsSync(path.join(dir, p)), read: (p: string) => fs.readFileSync(path.join(dir, p), 'utf8'), list: (p: string) => fs.readdirSync(path.join(dir, p)), write: (p: string, text: string) => fs.writeFileSync(path.join(dir, p), text, 'utf8') };
                OutputWriter.write([{ path: path.basename(featureFilePath), content: splitHeader(result.content).body, owner: 'generated', source: `${endpoint.method} ${endpoint.path}` }], fsApi, { get: () => undefined, set: () => undefined }, { generatorVersion: 'manual-diff', workspaceRoot: dir });
            } else {fs.writeFileSync(featureFilePath, result.content, 'utf-8');}
            logger.info(`Marked ${result.marked} scenario(s) as deprecated in ${featureFilePath}`);
        }
    }
}
