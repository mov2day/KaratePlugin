export interface ProjectHealthStats {
    totalFiles: number;
    totalScenarios: number;
    dryScore: number; // 0-100
    orphanedFiles: string[]; // Files never read by others
    files: Map<string, FileStats>;
    dependencies: DependencyEdge[];
}

export interface FileStats {
    path: string; // Absolute or relative path
    name: string;
    scenarioCount: number;
    readCalls: string[]; // Files this file imports/reads
    importedBy: string[]; // Files that import this file
}

export interface DependencyEdge {
    source: string;
    target: string;
}
