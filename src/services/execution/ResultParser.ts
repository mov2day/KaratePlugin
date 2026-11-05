import * as fs from 'fs';
import * as path from 'path';
import { TestExecutionResult, TestSummary, FeatureResult, ScenarioResult, StepResult } from '../../types';
import { logger } from '../../utils/logger';

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

        logger.info(`[ResultParser] Summary data keys: ${Object.keys(summaryData).join(', ')}`);
        logger.info(`[ResultParser] Feature summary length: ${summaryData.featureSummary?.length || 0}`);

        const features: FeatureResult[] = [];
        let totalScenarios = 0;
        let passed = 0;
        let failed = 0;
        let skipped = 0;

        //Parse feature results
        if (summaryData.featureSummary && Array.isArray(summaryData.featureSummary)) {
            // Get report directory from summaryPath
            const reportDirectory = path.dirname(summaryPath);
            logger.info(`[ResultParser] Using report directory for detailed parsing: ${reportDirectory}`);

            for (const featureData of summaryData.featureSummary) {
                logger.info(`[ResultParser] Parsing feature: ${featureData.name} packageQualifiedName: ${featureData.packageQualifiedName}`);
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

            logger.info(`[ResultParser] Looking for detailed feature JSON: ${detailedJsonPath}`);

            if (fs.existsSync(detailedJsonPath)) {
                try {
                    const detailedData = JSON.parse(fs.readFileSync(detailedJsonPath, 'utf-8'));
                    logger.info(`[ResultParser] Loaded detailed JSON with ${detailedData.scenarioResults?.length || 0} scenarios`);

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
                    logger.error(`[ResultParser] Failed to parse detailed JSON: ${error}`);
                    // Fall back to creating synthetic scenarios
                    this.createSyntheticScenarios(scenarios, featureData);
                    passed = featureData.passedCount || 0;
                    failed = featureData.failedCount || 0;
                    skipped = featureData.skippedCount || 0;
                }
            } else {
                logger.info(`[ResultParser] Detailed JSON not found, using summary counts`);
                // Fall back to synthetic scenarios
                this.createSyntheticScenarios(scenarios, featureData);
                passed = featureData.passedCount || 0;
                failed = featureData.failedCount || 0;
                skipped = featureData.skippedCount || 0;
            }
        }

        const reportedPath = featureData.relativePath || '';
        const relativePath = reportedPath || `${String(featureData.packageQualifiedName || featureData.name || '').replace(/\./g, path.sep)}.feature`;
        const absolutePath = path.resolve(workingDirectory, relativePath);

        logger.info(`[ResultParser] Parsed feature: ${featureData.name}, scenarios: ${scenarios.length}, passed: ${passed}, failed: ${failed}`);

        return {
            name: featureData.name || path.basename(relativePath, '.feature'),
            relativePath: featureData.relativePath || relativePath,
            absolutePath,
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

        logger.info(`[ResultParser] Parsed scenario: ${scenarioData.name || 'Unnamed'} steps: ${steps.length} status: ${status}`);

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
     * Finds a `cucumber-json` report folder (Karate 2 with `-f cucumber:json`) written after `minimumModifiedTime`.
     */
    static findCucumberJsonDirectory(workingDirectory: string, minimumModifiedTime: number = 0): string | null {
        const walk = (dir: string, depth: number): string | null => {
            if (depth > 6) { return null; }
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
            for (const entry of entries) {
                if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') { continue; }
                const full = path.join(dir, entry.name);
                if (entry.name === 'cucumber-json') {
                    const fresh = fs.readdirSync(full).some(file => file.endsWith('.json') && fs.statSync(path.join(full, file)).mtimeMs + 1000 >= minimumModifiedTime);
                    if (fresh) { return full; }
                }
                const found = walk(full, depth + 1);
                if (found) { return found; }
            }
            return null;
        };
        for (const root of [path.join(workingDirectory, 'target'), path.join(workingDirectory, 'build'), workingDirectory]) {
            if (fs.existsSync(root)) {
                const found = path.basename(root) === 'cucumber-json' ? root : walk(root, 0);
                if (found) { return found; }
            }
        }
        return null;
    }

    /** Resolves a Cucumber JSON `uri` (often classpath-relative) to the real file when it can. */
    private static resolveFeaturePath(uri: string, workingDirectory: string): string {
        const clean = uri.replace(/^classpath:/, '').replace(/^file:\/*/, '/');
        if (path.isAbsolute(clean) && fs.existsSync(clean)) { return clean; }
        const direct = path.resolve(workingDirectory, clean);
        if (fs.existsSync(direct)) { return direct; }
        for (const root of ['src/test/resources', 'src/test/java', 'src/test/karate', 'src/test', 'src/main/resources', 'test', 'tests']) {
            const candidate = path.resolve(workingDirectory, root, clean);
            if (fs.existsSync(candidate)) { return candidate; }
        }
        return direct;
    }

    /** Parses Karate 2 Cucumber JSON (`-f cucumber:json`) into the same result shape as the Karate 1 summary. */
    static parseCucumberJson(directory: string, workingDirectory: string): TestExecutionResult {
        const features: FeatureResult[] = [];
        for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
            let parsed: unknown;
            try { parsed = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf-8')); } catch { continue; }
            for (const featureData of (Array.isArray(parsed) ? parsed : [parsed]) as any[]) {
                if (!featureData || !Array.isArray(featureData.elements)) { continue; }
                const scenarios: ScenarioResult[] = [];
                for (const element of featureData.elements) {
                    if (element.type === 'background') { continue; }
                    const steps: StepResult[] = (element.steps || []).map((step: any): StepResult => {
                        const status = step.result?.status === 'passed' ? 'passed' : step.result?.status === 'failed' ? 'failed' : 'skipped';
                        return {
                            keyword: String(step.keyword || '').trim(),
                            text: step.name || '',
                            line: step.line || 0,
                            status,
                            duration: Math.round((step.result?.duration || 0) / 1e6),
                            errorMessage: step.result?.error_message || undefined
                        };
                    });
                    const failedStep = steps.find(step => step.status === 'failed');
                    const status: ScenarioResult['status'] = failedStep ? 'failed' : (steps.length > 0 && steps.every(step => step.status === 'skipped') ? 'skipped' : 'passed');
                    scenarios.push({
                        name: element.name || 'Unnamed Scenario',
                        line: element.line || 0,
                        status,
                        steps,
                        duration: steps.reduce((sum, step) => sum + step.duration, 0),
                        error: failedStep?.errorMessage,
                        tags: (element.tags || []).map((tag: any) => String(tag.name || tag))
                    });
                }
                const passed = scenarios.filter(s => s.status === 'passed').length;
                const failed = scenarios.filter(s => s.status === 'failed').length;
                const skipped = scenarios.filter(s => s.status === 'skipped').length;
                const absolutePath = this.resolveFeaturePath(String(featureData.uri || ''), workingDirectory);
                features.push({
                    name: featureData.name || path.basename(absolutePath, '.feature'),
                    relativePath: path.relative(workingDirectory, absolutePath) || String(featureData.uri || ''),
                    absolutePath,
                    scenarios,
                    duration: scenarios.reduce((sum, s) => sum + s.duration, 0),
                    passed,
                    failed,
                    skipped,
                    status: failed > 0 ? 'failed' : (passed > 0 ? 'passed' : 'skipped')
                });
            }
        }
        const totalScenarios = features.reduce((sum, f) => sum + f.scenarios.length, 0);
        const passed = features.reduce((sum, f) => sum + f.passed, 0);
        const failed = features.reduce((sum, f) => sum + f.failed, 0);
        const skipped = features.reduce((sum, f) => sum + f.skipped, 0);
        const duration = features.reduce((sum, f) => sum + f.duration, 0);
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
                passPercentage: totalScenarios > 0 ? Math.round((passed / totalScenarios) * 10000) / 100 : 0,
                executionTime: this.formatDuration(duration)
            },
            features,
            duration,
            status: failed > 0 ? 'failed' : 'success'
        };
    }

    /**
     * Find Karate report directory by recursively searching for karate summary JSON file
     * This is more robust than hardcoding paths since Karate's output structure can vary
     * Note: Karate 1.5+ uses karate-summary-json.txt, older versions use karate-summary.json
     */
    static findReportDirectory(workingDirectory: string, minimumModifiedTime: number = 0): string | null {
        // Start by looking in common build output directories
        const searchRoots = [
            path.join(workingDirectory, 'target'),
            path.join(workingDirectory, 'build'),
            workingDirectory // Also search from root as fallback
        ];

        // Karate 1.5+ changed the filename
        const summaryFilenames = ['karate-summary-json.txt', 'karate-summary.json'];

        logger.info(`[ResultParser] Searching for Karate summary in: ${workingDirectory}`);

        for (const searchRoot of searchRoots) {
            if (!fs.existsSync(searchRoot)) {
                continue;
            }

            logger.info(`[ResultParser] Searching recursively in: ${searchRoot}`);

            for (const filename of summaryFilenames) {
                const summaryFile = this.findFileRecursive(searchRoot, filename, 5, 0, minimumModifiedTime); // Max 5 levels deep

                if (summaryFile) {
                    const reportDir = path.dirname(summaryFile);
                    logger.info(`[ResultParser] Found report directory: ${reportDir}`);
                    return reportDir;
                }
            }
        }

        logger.info(`[ResultParser] No Karate summary file found in any search location`);
        return null;
    }

    /**
     * Recursively search for a file within a directory
     */
    private static findFileRecursive(dir: string, filename: string, maxDepth: number, currentDepth: number = 0, minimumModifiedTime: number = 0): string | null {
        if (currentDepth > maxDepth) {
            return null;
        }

        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });

            // First check if the file exists in current directory
            for (const entry of entries) {
                if (entry.isFile() && entry.name === filename) {
                    const foundPath = path.join(dir, entry.name);
                    if (fs.statSync(foundPath).mtimeMs + 1000 < minimumModifiedTime) continue;
                    logger.info(`[ResultParser] Found ${filename} at: ${foundPath}`);
                    return foundPath;
                }
            }

            // Then search subdirectories
            for (const entry of entries) {
                if (entry.isDirectory() && !entry.name.startsWith('.')) { // Skip hidden directories
                    const subdirPath = path.join(dir, entry.name);
                    const result = this.findFileRecursive(subdirPath, filename, maxDepth, currentDepth + 1, minimumModifiedTime);
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

        logger.info(`[ResultParser] Looking for summary file in: ${reportDirectory}`);

        for (const filename of possibleFilenames) {
            const summaryPath = path.join(reportDirectory, filename);
            if (fs.existsSync(summaryPath)) {
                logger.info(`[ResultParser] Found summary file: ${summaryPath}`);
                return summaryPath;
            }
        }

        // List files in directory for debugging
        if (fs.existsSync(reportDirectory)) {
            const files = fs.readdirSync(reportDirectory);
            logger.info(`[ResultParser] Files in report directory: ${files.join(', ')}`);
        }

        logger.info(`[ResultParser] Summary file not found in: ${reportDirectory}`);
        return null;
    }
}
