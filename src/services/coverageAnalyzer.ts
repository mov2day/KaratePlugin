import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { OpenAPIParser } from './openApiParser';
import { logger } from '../utils/logger';

export interface EndpointCoverage {
    path: string;
    method: string;
    operationId?: string;
    covered: boolean;
    testFiles: string[];
    scenarios: string[];
    missingTests: string[];
}

export interface CoverageReport {
    specPath: string;
    specName: string;
    totalEndpoints: number;
    coveredEndpoints: number;
    percentage: number;
    endpoints: EndpointCoverage[];
    uncoveredEndpoints: EndpointCoverage[];
    methodBreakdown: Map<string, { total: number; covered: number }>;
}

/**
 * Analyzes test coverage by comparing OpenAPI specs with Karate feature files
 */
export class CoverageAnalyzer {
    private parser: OpenAPIParser;

    constructor() {
        this.parser = new OpenAPIParser();
    }

    /**
     * Analyze coverage for an OpenAPI spec
     */
    public async analyzeCoverage(specPath: string, workspaceRoot: string): Promise<CoverageReport> {
        try {
            // Parse OpenAPI spec
            const endpoints = await this.parser.parseSpec(specPath);

            // Find all feature files in workspace
            const featureFiles = await this.findFeatureFiles(workspaceRoot);

            // Analyze each endpoint
            const endpointCoverages: EndpointCoverage[] = [];
            const methodBreakdown = new Map<string, { total: number; covered: number }>();

            for (const endpoint of endpoints) {
                const coverage = await this.analyzeEndpoint(endpoint, featureFiles, false);
                endpointCoverages.push(coverage);

                // Update method breakdown
                const method = endpoint.method.toUpperCase();
                if (!methodBreakdown.has(method)) {
                    methodBreakdown.set(method, { total: 0, covered: 0 });
                }
                const stats = methodBreakdown.get(method)!;
                stats.total++;
                if (coverage.covered) {
                    stats.covered++;
                }
            }

            // Calculate overall coverage
            const coveredCount = endpointCoverages.filter(e => e.covered).length;
            const percentage = endpoints.length > 0 ? (coveredCount / endpoints.length) * 100 : 0;

            const report: CoverageReport = {
                specPath,
                specName: path.basename(specPath),
                totalEndpoints: endpoints.length,
                coveredEndpoints: coveredCount,
                percentage,
                endpoints: endpointCoverages,
                uncoveredEndpoints: endpointCoverages.filter(e => !e.covered),
                methodBreakdown
            };

            logger.info(`Coverage analysis complete: ${percentage.toFixed(1)}% (${coveredCount}/${endpoints.length})`);
            return report;

        } catch (error) {
            logger.error('Coverage analysis failed', error as Error);
            throw error;
        }
    }

    /**
     * Analyze coverage for an OpenAPI spec with specific feature files
     */
    public async analyzeCoverageWithFiles(specPath: string, featureFiles: string[], useAI: boolean = false): Promise<CoverageReport> {
        try {
            logger.info(`Analyzing coverage for ${specPath} with ${featureFiles.length} selected feature files`);

            // Parse OpenAPI spec
            const endpoints = await this.parser.parseSpec(specPath);

            // Use the provided feature files instead of auto-discovering
            logger.info(`Using selected feature files: ${featureFiles.join(', ')}`);

            // Analyze each endpoint
            const endpointCoverages: EndpointCoverage[] = [];
            const methodBreakdown = new Map<string, { total: number; covered: number }>();

            for (const endpoint of endpoints) {
                const coverage = await this.analyzeEndpoint(endpoint, featureFiles, useAI);
                endpointCoverages.push(coverage);

                // Update method breakdown
                const method = endpoint.method.toUpperCase();
                if (!methodBreakdown.has(method)) {
                    methodBreakdown.set(method, { total: 0, covered: 0 });
                }
                const stats = methodBreakdown.get(method)!;
                stats.total++;
                if (coverage.covered) {
                    stats.covered++;
                }
            }

            // Calculate overall coverage
            const coveredCount = endpointCoverages.filter(e => e.covered).length;
            const percentage = endpoints.length > 0 ? (coveredCount / endpoints.length) * 100 : 0;

            const report: CoverageReport = {
                specPath,
                specName: path.basename(specPath),
                totalEndpoints: endpoints.length,
                coveredEndpoints: coveredCount,
                percentage,
                endpoints: endpointCoverages,
                uncoveredEndpoints: endpointCoverages.filter(e => !e.covered),
                methodBreakdown
            };

            logger.info(`Coverage analysis complete: ${percentage.toFixed(1)}% (${coveredCount}/${endpoints.length})`);
            return report;

        } catch (error) {
            logger.error('Coverage analysis with selected files failed', error as Error);
            throw error;
        }
    }

    /**
     * Find all feature files in workspace
     */
    private async findFeatureFiles(workspaceRoot: string): Promise<string[]> {
        const pattern = new vscode.RelativePattern(workspaceRoot, '**/*.feature');
        const files = await vscode.workspace.findFiles(pattern);
        return files.map(f => f.fsPath);
    }

    /**
     * Analyze coverage for a single endpoint using Copilot
     */
    private async analyzeEndpoint(endpoint: any, featureFiles: string[], useAI: boolean = false): Promise<EndpointCoverage> {
        const coverage: EndpointCoverage = {
            path: endpoint.path,
            method: endpoint.method.toUpperCase(),
            operationId: endpoint.operationId,
            covered: false,
            testFiles: [],
            scenarios: [],
            missingTests: []
        };

        for (const featureFile of featureFiles) {
            const scenarios = await this.findMatchingScenarios(endpoint, featureFile, useAI);
            if (scenarios.length > 0) {
                coverage.covered = true;
                coverage.testFiles.push(featureFile);
                coverage.scenarios.push(...scenarios);
            }
        }

        // Use AI to analyze what tests are missing — only when AI opted in
        if (useAI && (!coverage.covered || coverage.scenarios.length < 2)) {
            try {
                const { CopilotService } = await import('./copilotService');
                const isAvailable = await CopilotService.isCopilotAvailable();

                if (isAvailable) {
                    const missingTests = await this.analyzeMissingTestsWithAI(endpoint, coverage);
                    coverage.missingTests = missingTests;
                }
            } catch (error) {
                // Fallback to basic analysis
                if (!coverage.covered) {
                    coverage.missingTests.push('Basic success test (200 OK)');
                    coverage.missingTests.push('Error handling test (404, 400, 500)');
                    coverage.missingTests.push('Authentication test');
                }
            }
        } else if (!useAI && (!coverage.covered || coverage.scenarios.length < 2)) {
            // Static suggestions when AI not requested
            if (!coverage.covered) {
                coverage.missingTests.push('Basic success test (200 OK)');
                coverage.missingTests.push('Error handling test (404, 400, 500)');
                coverage.missingTests.push('Authentication test');
            } else {
                coverage.missingTests.push('Additional negative test cases');
                coverage.missingTests.push('Edge case scenarios');
            }
        }

        return coverage;
    }

    /**
     * Use AI (respecting user's provider setting) to analyze missing tests for an endpoint.
     */
    private async analyzeMissingTestsWithAI(endpoint: any, coverage: EndpointCoverage): Promise<string[]> {
        const prompt = `Analyze this API endpoint and identify missing test scenarios:

Endpoint: ${endpoint.method.toUpperCase()} ${endpoint.path}
Operation ID: ${endpoint.operationId || 'N/A'}
Current Test Coverage: ${coverage.scenarios.length} scenario(s)
Existing Scenarios: ${coverage.scenarios.join(', ') || 'None'}

STRICT REQUIREMENTS:
- List ONLY missing test scenarios
- Use Karate DSL best practices
- NO explanations or numbering
- One scenario per line

Focus on:
- Success cases (200, 201, 204)
- Client errors (400, 401, 403, 404)
- Server errors (500, 503)
- Edge cases (empty data, invalid input, boundary conditions)
- Authentication tests`;

        try {
            // Try AIProviderRegistry first (respects user's provider setting)
            const { AIProviderRegistry } = await import('./ai/AIProviderRegistry');
            const registry = AIProviderRegistry.getInstance();
            const response = await registry.complete(prompt, { maxTokens: 2048, temperature: 0.3 });

            if (response) {
                const scenarios = response
                    .split('\n')
                    .map(line => line.trim())
                    .filter(line => line && !line.startsWith('#') && !line.startsWith('//'))
                    .slice(0, 10);
                return scenarios.length > 0 ? scenarios : ['Comprehensive test coverage needed'];
            }
        } catch (error: any) {
            if (error?.name === 'AISkippedError') {
                logger.info('AI skipped for coverage analysis');
                return ['Basic success test', 'Error handling test'];
            }
            // Fall through to CopilotService as backup
        }

        try {
            const { CopilotService } = await import('./copilotService');
            const { ContextBuilder } = await import('../utils/contextBuilder');
            const workspace = await ContextBuilder.buildWorkspaceContext();
            const existingFeatures = workspace.featureFiles.slice(0, 2);

            const response = await CopilotService.enhanceTestWithFileContext(
                '',
                prompt,
                'coverage',
                existingFeatures
            );

            const scenarios = response
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#') && !line.startsWith('//'))
                .slice(0, 10);

            return scenarios.length > 0 ? scenarios : ['Comprehensive test coverage needed'];
        } catch (error) {
            logger.error('AI analysis failed for coverage', error as Error);
            return ['Basic success test', 'Error handling test'];
        }
    }

    /**
     * Find scenarios in a feature file that test the given endpoint
     * Enhanced with better matching logic
     */
    private async findMatchingScenarios(endpoint: any, featureFile: string, useAI: boolean): Promise<string[]> {
        try {
            const content = fs.readFileSync(featureFile, 'utf-8');
            const scenarios: string[] = [];

            // Extract path segments for matching
            const pathSegments = endpoint.path.split('/').filter((s: string) => s && !s.startsWith('{'));
            const method = endpoint.method.toUpperCase();

            // Split content into scenarios
            const scenarioMatches = content.matchAll(/Scenario:\s*(.+)/g);

            for (const match of scenarioMatches) {
                const scenarioName = match[1];
                const scenarioIndex = match.index!;

                // Get scenario content (from this scenario to next or end)
                const nextScenario = content.indexOf('Scenario:', scenarioIndex + 1);
                const scenarioContent = nextScenario > 0
                    ? content.substring(scenarioIndex, nextScenario)
                    : content.substring(scenarioIndex);

                // Check if scenario tests this endpoint
                if (await this.scenarioMatchesEndpoint(scenarioContent, endpoint, pathSegments, method, useAI)) {
                    scenarios.push(scenarioName);
                }
            }

            return scenarios;
        } catch (error) {
            logger.error(`Failed to analyze feature file: ${featureFile}`, error as Error);
            return [];
        }
    }

    /**
     * Check if a scenario tests the given endpoint — 3-tier matching strategy.
     *
     * Tier 1: operationId match in scenario name or comments
     * Tier 2: method + ALL non-parameter path segments match
     * Tier 3: AI-assisted match (gated on AI availability, cached per session)
     */
    private aiMatchCache = new Map<string, boolean>();

    private async scenarioMatchesEndpoint(
        scenarioContent: string,
        endpoint: any,
        pathSegments: string[],
        method: string,
        useAI: boolean
    ): Promise<boolean> {
        // Tier 1 — operationId match (highest confidence)
        if (endpoint.operationId) {
            const opIdRegex = new RegExp(endpoint.operationId, 'i');
            if (opIdRegex.test(scenarioContent)) {
                return true;
            }
        }

        // Check for method match (required for Tier 2)
        const methodMatch = new RegExp(`method\\s+${method}`, 'i').test(scenarioContent);

        // Tier 2 — method + ALL non-parameter path segments
        if (methodMatch && pathSegments.length > 0) {
            let allMatch = true;
            for (const segment of pathSegments) {
                const segmentRegex = new RegExp(segment, 'i');
                if (!segmentRegex.test(scenarioContent)) {
                    allMatch = false;
                    break;
                }
            }
            if (allMatch) {
                return true;
            }
        }

        // Also check path parameter names as partial evidence
        if (methodMatch) {
            const pathParamMatches = endpoint.path.match(/\{([^}]+)\}/g);
            if (pathParamMatches) {
                for (const param of pathParamMatches) {
                    const paramName = param.replace(/[{}]/g, '');
                    if (scenarioContent.includes(paramName)) {
                        return true;
                    }
                }
            }
        }

        // Tier 3 — AI-assisted match (optional, cached)
        if (!useAI) {
            return false;
        }

        const cacheKey = `${method}:${endpoint.path}:${scenarioContent.substring(0, 100)}`;
        if (this.aiMatchCache.has(cacheKey)) {
            return this.aiMatchCache.get(cacheKey)!;
        }

        try {
            const { AIProviderRegistry } = await import('./ai/AIProviderRegistry');
            const registry = AIProviderRegistry.getInstance();
            const isAvailable = await registry.isAnyAvailable();

            if (isAvailable) {
                const prompt = `Does this Karate test scenario test the endpoint ${method} ${endpoint.path}?

Scenario content (first 300 chars):
${scenarioContent.substring(0, 300)}

Answer ONLY "yes" or "no".`;

                const response = await registry.complete(prompt, {
                    maxTokens: 10,
                    temperature: 0
                });

                const isMatch = response.trim().toLowerCase().startsWith('yes');
                this.aiMatchCache.set(cacheKey, isMatch);
                return isMatch;
            }
        } catch {
            // AI unavailable — fall through
        }

        return false;
    }

    /**
     * Get coverage statistics
     */
    public getCoverageStats(report: CoverageReport): {
        excellent: number;
        good: number;
        poor: number;
        none: number;
    } {
        const excellent = report.endpoints.filter(e => e.scenarios.length >= 3).length;
        const good = report.endpoints.filter(e => e.scenarios.length >= 1 && e.scenarios.length < 3).length;
        const poor = 0; // Could add logic for partial coverage
        const none = report.uncoveredEndpoints.length;

        return { excellent, good, poor, none };
    }

    /**
     * Export coverage report to JSON
     */
    public exportToJson(report: CoverageReport): string {
        return JSON.stringify({
            specName: report.specName,
            timestamp: new Date().toISOString(),
            coverage: {
                percentage: report.percentage,
                covered: report.coveredEndpoints,
                total: report.totalEndpoints
            },
            endpoints: report.endpoints.map(e => ({
                path: e.path,
                method: e.method,
                covered: e.covered,
                scenarios: e.scenarios.length,
                testFiles: e.testFiles.length
            })),
            methodBreakdown: Array.from(report.methodBreakdown.entries()).map(([method, stats]) => ({
                method,
                total: stats.total,
                covered: stats.covered,
                percentage: stats.total > 0 ? (stats.covered / stats.total) * 100 : 0
            }))
        }, null, 2);
    }

    /**
     * Export coverage report to HTML
     */
    public exportToHtml(report: CoverageReport): string {
        const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Test Coverage Report - ${report.specName}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; }
        h1 { color: #333; border-bottom: 3px solid #4CAF50; padding-bottom: 10px; }
        .summary { display: flex; gap: 20px; margin: 30px 0; }
        .summary-card { flex: 1; padding: 20px; border-radius: 8px; text-align: center; }
        .summary-card.excellent { background: #4CAF50; color: white; }
        .summary-card.good { background: #8BC34A; color: white; }
        .summary-card.warning { background: #FFC107; color: white; }
        .percentage { font-size: 48px; font-weight: bold; }
        .label { font-size: 14px; margin-top: 10px; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
        th { background: #f5f5f5; font-weight: bold; }
        .covered { color: #4CAF50; }
        .uncovered { color: #f44336; }
        .method { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; }
        .method.GET { background: #2196F3; color: white; }
        .method.POST { background: #4CAF50; color: white; }
        .method.PUT { background: #FF9800; color: white; }
        .method.DELETE { background: #f44336; color: white; }
        .progress-bar { height: 30px; background: #ddd; border-radius: 15px; overflow: hidden; margin: 20px 0; }
        .progress-fill { height: 100%; background: linear-gradient(90deg, #4CAF50, #8BC34A); transition: width 0.3s; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Test Coverage Report</h1>
        <p><strong>Specification:</strong> ${report.specName}</p>
        <p><strong>Generated:</strong> ${new Date().toLocaleString()}</p>
        
        <div class="summary">
            <div class="summary-card excellent">
                <div class="percentage">${report.percentage.toFixed(1)}%</div>
                <div class="label">Overall Coverage</div>
            </div>
            <div class="summary-card good">
                <div class="percentage">${report.coveredEndpoints}</div>
                <div class="label">Endpoints Covered</div>
            </div>
            <div class="summary-card warning">
                <div class="percentage">${report.totalEndpoints}</div>
                <div class="label">Total Endpoints</div>
            </div>
        </div>
        
        <div class="progress-bar">
            <div class="progress-fill" style="width: ${report.percentage}%"></div>
        </div>
        
        <h2>Endpoint Coverage</h2>
        <table>
            <thead>
                <tr>
                    <th>Method</th>
                    <th>Path</th>
                    <th>Status</th>
                    <th>Test Scenarios</th>
                    <th>Test Files</th>
                </tr>
            </thead>
            <tbody>
                ${report.endpoints.map(e => `
                    <tr>
                        <td><span class="method ${e.method}">${e.method}</span></td>
                        <td>${e.path}</td>
                        <td class="${e.covered ? 'covered' : 'uncovered'}">
                            ${e.covered ? '✅ Covered' : '❌ Not Covered'}
                        </td>
                        <td>${e.scenarios.length}</td>
                        <td>${e.testFiles.length}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
        
        <h2>Method Breakdown</h2>
        <table>
            <thead>
                <tr>
                    <th>HTTP Method</th>
                    <th>Total</th>
                    <th>Covered</th>
                    <th>Coverage %</th>
                </tr>
            </thead>
            <tbody>
                ${Array.from(report.methodBreakdown.entries()).map(([method, stats]) => `
                    <tr>
                        <td><span class="method ${method}">${method}</span></td>
                        <td>${stats.total}</td>
                        <td>${stats.covered}</td>
                        <td>${stats.total > 0 ? ((stats.covered / stats.total) * 100).toFixed(1) : 0}%</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    </div>
</body>
</html>
        `;

        return html;
    }
}
