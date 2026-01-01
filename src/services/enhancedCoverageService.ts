import * as vscode from 'vscode';
import * as path from 'path';
import { CoverageAnalyzer, CoverageReport } from './coverageAnalyzer';
import { CopilotService } from './copilotService';
import { logger } from '../utils/logger';

export interface EnhancedCoverageReport extends CoverageReport {
    copilotInsights?: {
        coveragePercentage: number;
        quality: 'excellent' | 'good' | 'fair' | 'poor';
        priorityEndpoints: Array<{ path: string; method: string; reason: string }>;
        recommendations: string[];
        riskAssessment: string;
    };
}

/**
 * Enhanced coverage service with multi-spec and Copilot support
 */
export class EnhancedCoverageService {
    private analyzer: CoverageAnalyzer;

    constructor() {
        this.analyzer = new CoverageAnalyzer();
    }

    /**
     * Analyze coverage for multiple specs and feature directories
     */
    public async analyzeMultipleSpecs(
        specPaths: string[],
        featureFiles: string[],
        useCopilot: boolean
    ): Promise<EnhancedCoverageReport> {
        logger.info(`Analyzing ${specPaths.length} spec(s) with ${featureFiles.length} feature file(s)`);

        // Analyze each spec
        const reports: CoverageReport[] = [];
        for (const specPath of specPaths) {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';
            const report = await this.analyzer.analyzeCoverage(specPath, workspaceRoot);
            reports.push(report);
        }

        // Combine reports
        const combinedReport = this.combineReports(reports);

        // Enhance with Copilot if requested
        if (useCopilot) {
            try {
                const isAvailable = await CopilotService.isCopilotAvailable();
                if (isAvailable) {
                    logger.info('Enhancing coverage report with Copilot...');
                    return await this.enhanceWithCopilot(combinedReport, featureFiles);
                }
            } catch (error) {
                logger.warn('Copilot enhancement failed, using basic report', error as Error);
            }
        }

        return combinedReport;
    }

    /**
     * Combine multiple coverage reports into one
     */
    private combineReports(reports: CoverageReport[]): EnhancedCoverageReport {
        if (reports.length === 0) {
            throw new Error('No reports to combine');
        }

        if (reports.length === 1) {
            return reports[0];
        }

        // Combine all endpoints
        const allEndpoints = reports.flatMap(r => r.endpoints);
        const coveredCount = allEndpoints.filter(e => e.covered).length;
        const totalCount = allEndpoints.length;
        const percentage = totalCount > 0 ? (coveredCount / totalCount) * 100 : 0;

        // Combine method breakdown
        const methodBreakdown = new Map<string, { total: number; covered: number }>();
        for (const report of reports) {
            for (const [method, stats] of report.methodBreakdown) {
                if (!methodBreakdown.has(method)) {
                    methodBreakdown.set(method, { total: 0, covered: 0 });
                }
                const existing = methodBreakdown.get(method)!;
                existing.total += stats.total;
                existing.covered += stats.covered;
            }
        }

        return {
            specPath: `Combined (${reports.length} specs)`,
            specName: `${reports.length} Specifications`,
            totalEndpoints: totalCount,
            coveredEndpoints: coveredCount,
            percentage,
            endpoints: allEndpoints,
            uncoveredEndpoints: allEndpoints.filter(e => !e.covered),
            methodBreakdown
        };
    }

    /**
     * Enhance coverage report with Copilot insights
     */
    private async enhanceWithCopilot(
        report: EnhancedCoverageReport,
        featureFiles: string[]
    ): Promise<EnhancedCoverageReport> {
        // Create summary for Copilot
        const summary = {
            totalEndpoints: report.totalEndpoints,
            coveredEndpoints: report.coveredEndpoints,
            uncoveredEndpoints: report.uncoveredEndpoints.length,
            featureFileCount: featureFiles.length,
            endpoints: report.endpoints.map(e => ({
                path: e.path,
                method: e.method,
                covered: e.covered,
                scenarioCount: e.scenarios.length,
                missingTests: e.missingTests
            })),
            methodBreakdown: Array.from(report.methodBreakdown.entries()).map(([method, stats]) => ({
                method,
                total: stats.total,
                covered: stats.covered,
                percentage: stats.total > 0 ? (stats.covered / stats.total) * 100 : 0
            }))
        };

        const prompt = `
Analyze this API test coverage data and provide detailed insights:

${JSON.stringify(summary, null, 2)}

Please analyze:
1. Calculate the ACCURATE coverage percentage based on the data
2. Assess coverage quality (excellent: >90%, good: 70-90%, fair: 50-70%, poor: <50%)
3. Identify top 5 priority endpoints that need tests (focus on high-risk, frequently used, or complex endpoints)
4. Provide specific recommendations for improving coverage
5. Assess risk of uncovered endpoints

Return ONLY valid JSON with this exact structure (no markdown, no code blocks):
{
  "coveragePercentage": <number>,
  "quality": "<excellent|good|fair|poor>",
  "priorityEndpoints": [
    { "path": "<string>", "method": "<string>", "reason": "<string>" }
  ],
  "recommendations": ["<string>"],
  "riskAssessment": "<string>"
}
`;

        try {
            const response = await CopilotService.enhanceKarateTest('', prompt, {
                type: 'openapi',
                openApiSpec: JSON.stringify(summary)
            });

            // Clean response (remove markdown code blocks if present)
            let cleanedResponse = response.trim();
            if (cleanedResponse.startsWith('```')) {
                cleanedResponse = cleanedResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '');
            }

            // Parse Copilot response
            const insights = JSON.parse(cleanedResponse);

            // Validate insights
            if (typeof insights.coveragePercentage !== 'number') {
                throw new Error('Invalid coverage percentage from Copilot');
            }

            // Update report with Copilot insights
            report.copilotInsights = insights;
            report.percentage = insights.coveragePercentage;

            logger.info(`Copilot analysis complete: ${insights.quality} quality, ${insights.coveragePercentage.toFixed(1)}% coverage`);

            return report;
        } catch (error) {
            logger.error('Failed to parse Copilot insights', error as Error);
            // Return original report if Copilot enhancement fails
            return report;
        }
    }

    /**
     * Export enhanced report to HTML with Copilot insights
     */
    public exportToHtmlWithInsights(report: EnhancedCoverageReport): string {
        let html = this.analyzer.exportToHtml(report);

        // Add Copilot insights section if available
        if (report.copilotInsights) {
            const insights = report.copilotInsights;
            const insightsHtml = `
        <div class="copilot-insights" style="margin-top: 30px; padding: 20px; background: #f0f7ff; border-left: 4px solid #2196F3; border-radius: 4px;">
            <h2>🤖 Copilot Insights</h2>
            
            <div style="margin: 20px 0;">
                <h3>Coverage Quality: <span style="color: ${this.getQualityColor(insights.quality)}">${insights.quality.toUpperCase()}</span></h3>
                <p><strong>Copilot-Computed Coverage:</strong> ${insights.coveragePercentage.toFixed(1)}%</p>
            </div>

            <div style="margin: 20px 0;">
                <h3>Priority Endpoints Needing Tests</h3>
                <ol>
                    ${insights.priorityEndpoints.map(ep => `
                        <li>
                            <strong>${ep.method} ${ep.path}</strong><br/>
                            <em>${ep.reason}</em>
                        </li>
                    `).join('')}
                </ol>
            </div>

            <div style="margin: 20px 0;">
                <h3>Recommendations</h3>
                <ul>
                    ${insights.recommendations.map(rec => `<li>${rec}</li>`).join('')}
                </ul>
            </div>

            <div style="margin: 20px 0;">
                <h3>Risk Assessment</h3>
                <p>${insights.riskAssessment}</p>
            </div>
        </div>
            `;

            // Insert before closing body tag
            html = html.replace('</body>', insightsHtml + '</body>');
        }

        return html;
    }

    private getQualityColor(quality: string): string {
        switch (quality) {
            case 'excellent': return '#4CAF50';
            case 'good': return '#8BC34A';
            case 'fair': return '#FFC107';
            case 'poor': return '#f44336';
            default: return '#666';
        }
    }
}
