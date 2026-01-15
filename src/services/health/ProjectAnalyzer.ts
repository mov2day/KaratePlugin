import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ProjectHealthStats, FileStats, DependencyEdge } from './types';

export class ProjectAnalyzer {

    public async analyzeWorkspace(): Promise<ProjectHealthStats> {
        const stats: ProjectHealthStats = {
            totalFiles: 0,
            totalScenarios: 0,
            dryScore: 0,
            orphanedFiles: [],
            files: new Map(),
            dependencies: []
        };

        const files = await vscode.workspace.findFiles('**/*.feature', '**/node_modules/**');
        stats.totalFiles = files.length;

        // Pass 1: Parse all files
        for (const file of files) {
            const content = await fs.promises.readFile(file.fsPath, 'utf-8');
            const fileStats = this.parseFile(file.fsPath, content);
            stats.files.set(file.fsPath, fileStats);
            stats.totalScenarios += fileStats.scenarioCount;
        }

        // Pass 2: Resolve Dependencies
        for (const [filePath, fileStats] of stats.files) {
            for (const readCall of fileStats.readCalls) {
                // readCall is likely relative (e.g., 'classpath:common.feature' or './utils.feature')
                // We need to try to resolve it to an absolute path to find the target FileStats
                const resolvedPath = this.resolvePath(filePath, readCall);

                if (resolvedPath && stats.files.has(resolvedPath)) {
                    // It's a valid link in our workspace
                    stats.files.get(resolvedPath)!.importedBy.push(filePath);
                    stats.dependencies.push({ source: filePath, target: resolvedPath });
                }
            }
        }

        // Pass 3: Calc Metrics
        let scenariosWithCalls = 0;
        for (const [filePath, fileStats] of stats.files) {
            if (fileStats.importedBy.length === 0) {
                // Logic for orphans: If it's in a 'common' or 'util' folder AND not used?
                // For now, let's just list everything with 0 imports as "Potential Entry Points or Orphans"
                // Or maybe adhere to strict "Orphan" definition: 
                // If the file DOES NOT have any scenarios (it's a pure reusable file) AND it is not imported -> Orphan.
                if (fileStats.scenarioCount === 0) {
                    stats.orphanedFiles.push(path.basename(filePath));
                }
            }

            if (fileStats.readCalls.length > 0) {
                // This is a naive heuristic for DRY
                scenariosWithCalls += 1; // Count files that reuse code, not scenarios strictly
            }
        }

        // Better DRY Score: Percentage of files that use 'read()' or 'call'
        stats.dryScore = stats.totalFiles > 0 ? Math.round((scenariosWithCalls / stats.totalFiles) * 100) : 100;

        return stats;
    }

    private parseFile(filePath: string, content: string): FileStats {
        const stats: FileStats = {
            path: filePath,
            name: path.basename(filePath),
            scenarioCount: 0,
            readCalls: [],
            importedBy: []
        };

        const lines = content.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('Scenario:') || trimmed.startsWith('Scenario Outline:')) {
                stats.scenarioCount++;
            }

            // Detect read() or call
            // call read('foo.feature')
            // def result = call read('classpath:utils.feature')
            const readMatch = line.match(/read\s*\(\s*['"]([^'"]+)['"]\s*\)/);
            if (readMatch) {
                stats.readCalls.push(readMatch[1]);
            }
        }

        return stats;
    }

    private resolvePath(sourceFile: string, importPath: string): string | null {
        // Handle 'classpath:'
        if (importPath.startsWith('classpath:')) {
            // Need to search workspace for this file. 
            // Simplified: treat as relative from root or assume standard maven layout?
            // Let's try to find a file with that name in the file map (Keys)
            const targetName = path.basename(importPath.replace('classpath:', ''));
            // This is O(N) but N is small
            // Ideally we need the workspace root.
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders) {
                // Try to locate it in standard paths src/test/java, src/test/resources
                // For now, let's look for any file ending with this relative path
                // Doing a simplified check matching filename
            }
            return null; // TODO: Better classpath resolution
        }

        // Relative path
        try {
            const dir = path.dirname(sourceFile);
            const absolute = path.resolve(dir, importPath);
            return absolute;
        } catch (e) {
            return null;
        }
    }
}
