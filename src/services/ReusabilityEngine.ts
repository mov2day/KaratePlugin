import * as path from 'path';

/**
 * Result of the reusability analysis.
 */
export interface ReusabilityResult {
    commonFiles: Array<{
        path: string;             // "common/auth.feature"
        content: string;          // full feature file content
        type: 'auth' | 'setup' | 'headers' | 'data' | 'cleanup' | 'custom';
        callType: 'call' | 'callonce';
    }>;
    modifiedContent: string;      // main feature content rewritten with call/callonce
}

/**
 * Pattern definition for deterministic extraction.
 */
interface ExtractionPattern {
    type: 'auth' | 'setup' | 'headers' | 'data' | 'cleanup';
    /** Regex patterns that identify this pattern in step text */
    detect: RegExp[];
    /** Generated common feature file content */
    featureTemplate: (matchedSteps: string[]) => string;
    /** Injection line that replaces matched steps */
    injection: string;
    callType: 'call' | 'callonce';
    /** Target file path relative to output dir */
    targetFile: string;
}

/**
 * Smart Reusability Engine
 *
 * Two-phase engine that extracts repeated patterns into shared feature files:
 * - Phase A: Template-based extraction (deterministic, runs always)
 * - Phase B: AI-powered deduplication (runs only when Copilot is available)
 */
export class ReusabilityEngine {

    private static readonly PATTERNS: ExtractionPattern[] = [
        {
            type: 'auth',
            detect: [
                /^\s*\*\s*(def|text)\s+.*token/i,
                /^\s*\*\s*header\s+Authorization/i,
                /^\s*\*\s*call\s+.*auth/i,
                /^\s*Given\s+.*\/oauth\/token/i,
                /^\s*Given\s+.*\/auth\/login/i,
                /^\s*\*\s*def\s+auth(Token|Response|Header)/i,
            ],
            featureTemplate: (steps) => [
                'Feature: Authentication Helper',
                '',
                'Scenario: Get Auth Token',
                ...steps.map(s => `  ${s.trim()}`),
                '',
            ].join('\n'),
            injection: "* def authResult = callonce read('common/auth.feature')",
            callType: 'callonce',
            targetFile: 'common/auth.feature',
        },
        {
            type: 'setup',
            detect: [
                /^\s*\*\s*url\s+/i,
                /^\s*\*\s*def\s+baseUrl/i,
                /^\s*\*\s*configure\s+(connectTimeout|readTimeout|ssl|retry)/i,
            ],
            featureTemplate: (steps) => [
                'Feature: Base Setup',
                '',
                'Scenario: Configure Base URL and Settings',
                ...steps.map(s => `  ${s.trim()}`),
                '',
            ].join('\n'),
            injection: "* call read('common/setup.feature')",
            callType: 'call',
            targetFile: 'common/setup.feature',
        },
        {
            type: 'headers',
            detect: [
                /^\s*\*\s*header\s+Content-Type/i,
                /^\s*\*\s*header\s+Accept/i,
                /^\s*\*\s*headers\s+\{/i,
                /^\s*\*\s*def\s+headers\s*=/i,
            ],
            featureTemplate: (steps) => [
                'Feature: Shared Headers',
                '',
                'Scenario: Set Common Headers',
                ...steps.map(s => `  ${s.trim()}`),
                '',
            ].join('\n'),
            injection: "* def headers = call read('common/headers.feature')",
            callType: 'call',
            targetFile: 'common/headers.feature',
        },
        {
            type: 'data',
            detect: [
                /^\s*\*\s*def\s+testData\s*=/i,
                /^\s*\*\s*def\s+payload\s*=/i,
                /^\s*\*\s*def\s+requestBody\s*=/i,
                /^\s*\*\s*table\s+/i,
            ],
            featureTemplate: (steps) => [
                'Feature: Test Data Setup',
                '',
                'Scenario: Create Test Data',
                ...steps.map(s => `  ${s.trim()}`),
                '',
            ].join('\n'),
            injection: "* def data = call read('common/testdata.feature')",
            callType: 'call',
            targetFile: 'common/testdata.feature',
        },
        {
            type: 'cleanup',
            detect: [
                /^\s*\*\s*(Given|When)\s+.*delete/i,
                /^\s*\*\s*call\s+.*cleanup/i,
                /^\s*\*\s*def\s+cleanup/i,
            ],
            featureTemplate: (steps) => [
                'Feature: Cleanup Helper',
                '',
                'Scenario: Cleanup Test Data',
                ...steps.map(s => `  ${s.trim()}`),
                '',
            ].join('\n'),
            injection: "* call read('common/cleanup.feature')",
            callType: 'call',
            targetFile: 'common/cleanup.feature',
        },
    ];

    /**
     * Minimum number of scenarios that must share a pattern to extract it.
     */
    private static readonly MIN_SHARED_SCENARIOS = 2;

    /**
     * Phase A: Deterministic, template-based extraction.
     *
     * Scans feature content for known step patterns (auth, setup, headers, etc.)
     * that appear across multiple scenarios. When found, extracts them into
     * common feature files and rewrites the main content with call/callonce.
     */
    static extract(featureContent: string): ReusabilityResult {
        const result: ReusabilityResult = {
            commonFiles: [],
            modifiedContent: featureContent,
        };

        const lines = featureContent.split('\n');
        const scenarios = this.parseScenarioBlocks(lines);

        if (scenarios.length < this.MIN_SHARED_SCENARIOS) {
            return result;
        }

        for (const pattern of this.PATTERNS) {
            const matchedScenarios = this.findScenariosWithPattern(scenarios, pattern);

            if (matchedScenarios.length >= this.MIN_SHARED_SCENARIOS) {
                // Collect all matched step lines (deduplicated)
                const extractedSteps = this.collectMatchedSteps(matchedScenarios, pattern);

                if (extractedSteps.length === 0) {
                    continue;
                }

                // Create common feature file
                result.commonFiles.push({
                    path: pattern.targetFile,
                    content: pattern.featureTemplate(extractedSteps),
                    type: pattern.type,
                    callType: pattern.callType,
                });

                // Rewrite main content: remove matched steps, inject call
                result.modifiedContent = this.rewriteContent(
                    result.modifiedContent,
                    pattern,
                    extractedSteps
                );
            }
        }

        return result;
    }

    /**
     * Parse feature content into scenario blocks.
     * Each block is { startLine, endLine, steps[] }.
     */
    private static parseScenarioBlocks(lines: string[]): Array<{
        startLine: number;
        endLine: number;
        steps: Array<{ line: number; text: string }>;
    }> {
        const scenarios: Array<{
            startLine: number;
            endLine: number;
            steps: Array<{ line: number; text: string }>;
        }> = [];

        let current: { startLine: number; endLine: number; steps: Array<{ line: number; text: string }> } | null = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            if (trimmed.startsWith('Scenario:') || trimmed.startsWith('Scenario Outline:')) {
                if (current) {
                    current.endLine = i - 1;
                    scenarios.push(current);
                }
                current = { startLine: i, endLine: i, steps: [] };
            } else if (current && (
                trimmed.startsWith('*') ||
                trimmed.startsWith('Given') ||
                trimmed.startsWith('When') ||
                trimmed.startsWith('Then') ||
                trimmed.startsWith('And') ||
                trimmed.startsWith('But')
            )) {
                current.steps.push({ line: i, text: line });
            }
        }

        if (current) {
            current.endLine = lines.length - 1;
            scenarios.push(current);
        }

        return scenarios;
    }

    /**
     * Find scenarios that contain at least one step matching the given pattern.
     */
    private static findScenariosWithPattern(
        scenarios: Array<{ steps: Array<{ line: number; text: string }> }>,
        pattern: ExtractionPattern
    ): Array<{ steps: Array<{ line: number; text: string }> }> {
        return scenarios.filter(scenario =>
            scenario.steps.some(step =>
                pattern.detect.some(regex => regex.test(step.text))
            )
        );
    }

    /**
     * Collect unique matched step texts from all matching scenarios.
     */
    private static collectMatchedSteps(
        scenarios: Array<{ steps: Array<{ line: number; text: string }> }>,
        pattern: ExtractionPattern
    ): string[] {
        const seen = new Set<string>();
        const result: string[] = [];

        for (const scenario of scenarios) {
            for (const step of scenario.steps) {
                if (pattern.detect.some(regex => regex.test(step.text))) {
                    const normalized = step.text.trim();
                    if (!seen.has(normalized)) {
                        seen.add(normalized);
                        result.push(normalized);
                    }
                }
            }
        }

        return result;
    }

    /**
     * Rewrite content: remove extracted steps from scenarios and inject call/callonce.
     */
    private static rewriteContent(
        content: string,
        pattern: ExtractionPattern,
        extractedSteps: string[]
    ): string {
        const lines = content.split('\n');
        const normalizedExtracted = new Set(extractedSteps.map(s => s.trim()));
        const result: string[] = [];
        let injectedForFeature = false;
        let inBackground = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            // Track Background section
            if (trimmed.startsWith('Background:')) {
                inBackground = true;
                result.push(line);

                // Inject call/callonce in Background for setup/auth patterns
                if (pattern.type === 'auth' || pattern.type === 'setup') {
                    result.push(`    ${pattern.injection}`);
                    injectedForFeature = true;
                }
                continue;
            }

            // End of Background when hitting Scenario
            if (trimmed.startsWith('Scenario:') || trimmed.startsWith('Scenario Outline:')) {
                inBackground = false;

                // If no Background existed, inject before the first Scenario
                if (!injectedForFeature && (pattern.type === 'auth' || pattern.type === 'setup')) {
                    // Insert a Background section before this Scenario
                    result.push('  Background:');
                    result.push(`    ${pattern.injection}`);
                    result.push('');
                    injectedForFeature = true;
                }
            }

            // Skip lines that match extracted steps
            if (normalizedExtracted.has(trimmed)) {
                // If this is in a scenario (not Background) and pattern isn't yet injected per-scenario
                if (!inBackground && pattern.type !== 'auth' && pattern.type !== 'setup' && !injectedForFeature) {
                    result.push(`    ${pattern.injection}`);
                    injectedForFeature = true;
                }
                continue; // Remove the line
            }

            result.push(line);
        }

        return result.join('\n');
    }

    /**
     * Build the common/ directory path relative to a given output path.
     */
    static getCommonDir(outputPath: string): string {
        return path.join(path.dirname(outputPath), 'common');
    }
}
