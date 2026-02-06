import * as fs from 'fs';
import * as path from 'path';
import { TestExecutionResult, TestSummary, FeatureResult, ScenarioResult, StepResult } from '../../types';

/**
 * Parses Karate test execution results from JSON reports
 * Supports karate-summary.json and timeline reports
 */
export class ResultParser {
    /**
     * Parse Karate summary JSON file
     * @param summaryPath Path to karate-summary.json
     * @param workingDirectory Project working directory for resolving paths
     */
    static parseKarateSummary(summaryPath: string, workingDirectory: string): TestExecutionResult {
        if (!fs.existsSync(summaryPath)) {
            throw new Error(`Karate summary file not found: ${summaryPath}`);
        }

        const summaryData = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));

        console.log(`[ResultParser] Summary data keys:`, Object.keys(summaryData));
        console.log(`[ResultParser] Feature summary length:`, summaryData.featureSummary?.length || 0);

        const features: FeatureResult[] = [];
        let totalScenarios = 0;
        let passed = 0;
        let failed = 0;
        let skipped = 0;

        //Parse feature results
        if (summaryData.featureSummary && Array.isArray(summaryData.featureSummary)) {
            // Get report directory from summaryPath
            const reportDirectory = path.dirname(summaryPath);
            console.log(`[ResultParser] Using report directory for detailed parsing: ${reportDirectory}`);

            for (const featureData of summaryData.featureSummary) {
                console.log(`[ResultParser] Parsing feature:`, featureData.name, `packageQualifiedName:`, featureData.packageQualifiedName);
                const featureResult = this.parseFeature(featureData, workingDirectory, reportDirectory);
                features.push(featureResult);

                totalScenarios += featureResult.scenarios.length;
                passed += featureResult.passed;
                failed += featureResult.failed;
                skipped += featureResult.skipped;
            }
        }

        const passPercentage = totalScenarios > 0 ? (passed / totalScenarios) * 100 : 0;
        const executionTime = this.formatDuration(summaryData.elapsedTime || 0);

        return {
            id: `exec_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            timestamp: Date.now(),
            options: { type: 'feature', target: '', workingDirectory },
            summary: {
                totalFeatures: features.length,
                totalScenarios,
                passed,
                failed,
                skipped,
                passPercentage: Math.round(passPercentage * 100) / 100,
                executionTime
            },
            features,
            duration: summaryData.elapsedTime || 0,
            status: failed > 0 ? 'failed' : 'success'
        };
    }

    /**
     * Parse individual feature results from Karate JSON
     * Handles both old format (with scenarioResults) and new format (Karate 1.5+ with counts only)
     */
    private static parseFeature(featureData: any, workingDirectory: string, reportDirectory?: string): FeatureResult {
        const scenarios: ScenarioResult[] = [];
        let passed = 0;
        let failed = 0;
        let skipped = 0;

        // Check if we have detailed scenario results (already in featureData)
        if (featureData.scenarioResults && Array.isArray(featureData.scenarioResults)) {
            for (const scenarioData of featureData.scenarioResults) {
                const scenario = this.parseScenario(scenarioData);
                scenarios.push(scenario);

                if (scenario.status === 'passed') passed++;
                else if (scenario.status === 'failed') failed++;
                else if (scenario.status === 'skipped') skipped++;
            }
        }
        // New format (Karate 1.5+) - summary only has counts, need to load detailed file
        else if (reportDirectory && (featureData.passedCount !== undefined || featureData.failedCount !== undefined)) {
            // Try to find the detailed feature JSON file
            const packageQualifiedName = featureData.packageQualifiedName || featureData.name || '';
            const detailedJsonPath = path.join(reportDirectory, `${packageQualifiedName}.karate-json.txt`);

            console.log(`[ResultParser] Looking for detailed feature JSON: ${detailedJsonPath}`);

            if (fs.existsSync(detailedJsonPath)) {
                try {
                    const detailedData = JSON.parse(fs.readFileSync(detailedJsonPath, 'utf-8'));
                    console.log(`[ResultParser] Loaded detailed JSON with ${detailedData.scenarioResults?.length || 0} scenarios`);

                    // Parse detailed scenario results
                    if (detailedData.scenarioResults && Array.isArray(detailedData.scenarioResults)) {
                        for (const scenarioData of detailedData.scenarioResults) {
                            const scenario = this.parseScenario(scenarioData);
                            scenarios.push(scenario);

                            if (scenario.status === 'passed') passed++;
                            else if (scenario.status === 'failed') failed++;
                            else if (scenario.status === 'skipped') skipped++;
                        }
                    }
                } catch (error) {
                    console.error(`[ResultParser] Failed to parse detailed JSON: ${error}`);
                    // Fall back to creating synthetic scenarios
                    this.createSyntheticScenarios(scenarios, featureData);
                    passed = featureData.passedCount || 0;
                    failed = featureData.failedCount || 0;
                    skipped = featureData.skippedCount || 0;
                }
            } else {
                console.log(`[ResultParser] Detailed JSON not found, using summary counts`);
                // Fall back to synthetic scenarios
                this.createSyntheticScenarios(scenarios, featureData);
                passed = featureData.passedCount || 0;
                failed = featureData.failedCount || 0;
                skipped = featureData.skippedCount || 0;
            }
        }

        const relativePath = path.relative(workingDirectory, featureData.packageQualifiedName || featureData.relativePath || featureData.name || '');

        console.log(`[ResultParser] Parsed feature: ${featureData.name}, scenarios: ${scenarios.length}, passed: ${passed}, failed: ${failed}`);

        return {
            name: featureData.name || path.basename(relativePath, '.feature'),
            relativePath: featureData.relativePath || relativePath,
            absolutePath: featureData.packageQualifiedName || '',
            scenarios,
            duration: featureData.durationMillis || 0,
            passed,
            failed,
            skipped,
            status: failed > 0 ? 'failed' : (passed > 0 ? 'passed' : 'skipped')
        };
    }

    /**
     * Create synthetic scenario entries when detailed data is not available
     */
    private static createSyntheticScenarios(scenarios: ScenarioResult[], featureData: any): void {
        const passed = featureData.passedCount || 0;
        const failed = featureData.failedCount || 0;
        const skipped = featureData.skippedCount || 0;

        // Create failed scenarios
        for (let i = 0; i < failed; i++) {
            scenarios.push({
                name: `Scenario ${i + 1}`,
                line: 0,
                status: 'failed',
                steps: [],
                duration: 0,
                tags: []
            });
        }

        // Create passed scenarios
        for (let i = 0; i < passed; i++) {
            scenarios.push({
                name: `Scenario ${failed + i + 1}`,
                line: 0,
                status: 'passed',
                steps: [],
                duration: 0,
                tags: []
            });
        }

        // Create skipped scenarios
        for (let i = 0; i < skipped; i++) {
            scenarios.push({
                name: `Scenario ${failed + passed + i + 1}`,
                line: 0,
                status: 'skipped',
                steps: [],
                duration: 0,
                tags: []
            });
        }
    }

    /**
     * Parse individual scenario results
     */
    private static parseScenario(scenarioData: any): ScenarioResult {
        const steps: StepResult[] = [];

        // Parse step results
        if (scenarioData.stepResults && Array.isArray(scenarioData.stepResults)) {
            for (const stepData of scenarioData.stepResults) {
                steps.push(this.parseStep(stepData));
            }
        }

        // Determine scenario status from steps
        let status: 'passed' | 'failed' | 'skipped' = 'passed';
        if (steps.some(s => s.status === 'failed')) {
            status = 'failed';
        } else if (steps.every(s => s.status === 'skipped')) {
            status = 'skipped';
        }

        console.log(`[ResultParser] Parsed scenario: ${scenarioData.name || 'Unnamed'}, steps: ${steps.length}, status: ${status}`);

        return {
            name: scenarioData.name || 'Unnamed Scenario',
            line: scenarioData.line || 0,
            status,
            steps,
            duration: scenarioData.durationMillis || 0,
            error: scenarioData.error?.message,
            tags: scenarioData.tags || []
        };
    }

    /**
     * Parse individual step results with error messages and logs
     */
    private static parseStep(stepData: any): StepResult {
        const result = stepData.result || {};
        const step = stepData.step || {};

        // Extract error message and log
        const errorMessage = result.errorMessage || undefined;
        const stepLog = stepData.stepLog || undefined;

        //Parse HTTP request/response from step log
        let httpRequest: any | undefined;
        let httpResponse: any | undefined;

        if (stepLog) {
            // Parse HTTP request
            const requestMatch = stepLog.match(/request:\n(.+?)\n\n/s);
            if (requestMatch) {
                const requestBlock = requestMatch[1];
                const methodMatch = requestBlock.match(/>\s+(\w+)\s+(https?:\/\/[^\s]+)/);

                if (methodMatch) {
                    const headers: Record<string, string> = {};
                    const headerMatches = requestBlock.matchAll(/>\s+([^:]+):\s+(.+)/g);
                    for (const match of headerMatches) {
                        if (!match[1].match(/POST|GET|PUT|DELETE|PATCH/)) {
                            headers[match[1].trim()] = match[2].trim();
                        }
                    }

                    // Extract body (JSON after headers)
                    const bodyMatch = requestBlock.match(/\n({.+}|\[.+\])\s*$/s);

                    httpRequest = {
                        method: methodMatch[1],
                        url: methodMatch[2],
                        headers,
                        body: bodyMatch ? bodyMatch[1].trim() : undefined
                    };
                }
            }

            // Parse HTTP response (if present)
            const responseMatch = stepLog.match(/response time=(\d+)[\s\S]+?status=(\d+)/);
            if (responseMatch) {
                httpResponse = {
                    status: parseInt(responseMatch[2]),
                    duration: parseInt(responseMatch[1])
                };
            }
        }

        return {
            keyword: step.prefix || '',  // Given, When, Then, And, *
            text: step.text || '',
            line: step.line || 0,
            status: result.status || 'skipped',
            duration: result.millis || 0,
            errorMessage,
            log: stepLog,
            httpRequest,
            httpResponse
        };
    }

    /**
     * Format duration in milliseconds to human-readable string
     */
    static formatDuration(ms: number): string {
        if (ms < 1000) {
            return `${ms}ms`;
        }

        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) {
            const m = minutes % 60;
            const s = seconds % 60;
            return `${hours}h ${m}m ${s}s`;
        } else if (minutes > 0) {
            const s = seconds % 60;
            return `${minutes}m ${s}s`;
        } else {
            return `${seconds}s`;
        }
    }

    /**
     * Find Karate report directory by recursively searching for karate summary JSON file
     * This is more robust than hardcoding paths since Karate's output structure can vary
     * Note: Karate 1.5+ uses karate-summary-json.txt, older versions use karate-summary.json
     */
    static findReportDirectory(workingDirectory: string): string | null {
        // Start by looking in common build output directories
        const searchRoots = [
            path.join(workingDirectory, 'target'),
            path.join(workingDirectory, 'build'),
            workingDirectory // Also search from root as fallback
        ];

        // Karate 1.5+ changed the filename
        const summaryFilenames = ['karate-summary-json.txt', 'karate-summary.json'];

        console.log(`[ResultParser] Searching for Karate summary in: ${workingDirectory}`);

        for (const searchRoot of searchRoots) {
            if (!fs.existsSync(searchRoot)) {
                continue;
            }

            console.log(`[ResultParser] Searching recursively in: ${searchRoot}`);

            for (const filename of summaryFilenames) {
                const summaryFile = this.findFileRecursive(searchRoot, filename, 5); // Max 5 levels deep

                if (summaryFile) {
                    const reportDir = path.dirname(summaryFile);
                    console.log(`[ResultParser] Found report directory: ${reportDir}`);
                    return reportDir;
                }
            }
        }

        console.log(`[ResultParser] No Karate summary file found in any search location`);
        return null;
    }

    /**
     * Recursively search for a file within a directory
     */
    private static findFileRecursive(dir: string, filename: string, maxDepth: number, currentDepth: number = 0): string | null {
        if (currentDepth > maxDepth) {
            return null;
        }

        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });

            // First check if the file exists in current directory
            for (const entry of entries) {
                if (entry.isFile() && entry.name === filename) {
                    const foundPath = path.join(dir, entry.name);
                    console.log(`[ResultParser] Found ${filename} at: ${foundPath}`);
                    return foundPath;
                }
            }

            // Then search subdirectories
            for (const entry of entries) {
                if (entry.isDirectory() && !entry.name.startsWith('.')) { // Skip hidden directories
                    const subdirPath = path.join(dir, entry.name);
                    const result = this.findFileRecursive(subdirPath, filename, maxDepth, currentDepth + 1);
                    if (result) {
                        return result;
                    }
                }
            }
        } catch (error) {
            // Silently skip directories we can't read
            return null;
        }

        return null;
    }

    /**
     * Find karate summary JSON file in report directory
     * Supports both karate-summary-json.txt (Karate 1.5+) and karate-summary.json (older versions)
     */
    static findSummaryFile(reportDirectory: string): string | null {
        const possibleFilenames = ['karate-summary-json.txt', 'karate-summary.json'];

        console.log(`[ResultParser] Looking for summary file in: ${reportDirectory}`);

        for (const filename of possibleFilenames) {
            const summaryPath = path.join(reportDirectory, filename);
            if (fs.existsSync(summaryPath)) {
                console.log(`[ResultParser] Found summary file: ${summaryPath}`);
                return summaryPath;
            }
        }

        // List files in directory for debugging
        if (fs.existsSync(reportDirectory)) {
            const files = fs.readdirSync(reportDirectory);
            console.log(`[ResultParser] Files in report directory:`, files);
        }

        console.log(`[ResultParser] Summary file not found in: ${reportDirectory}`);
        return null;
    }
}
