import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CopilotService } from './copilotService';
import { logger } from '../utils/logger';
import { AffectedTest } from './testImpactAnalyzer';

/**
 * Service for using Copilot to intelligently fix tests when spec changes
 */
export class CopilotTestFixService {

    /**
     * Use Copilot to analyze spec changes and update affected tests
     */
    public async fixTestsWithCopilot(
        oldSpecPath: string,
        newSpecPath: string,
        affectedTests: AffectedTest[]
    ): Promise<{ updated: number; errors: string[] }> {
        const errors: string[] = [];
        let updated = 0;

        // Check if Copilot is available
        const isAvailable = await CopilotService.isCopilotAvailable();
        if (!isAvailable) {
            throw new Error('No AI provider available. Please check your settings.');
        }

        // Read both specs
        const oldSpec = fs.readFileSync(oldSpecPath, 'utf-8');
        const newSpec = fs.readFileSync(newSpecPath, 'utf-8');

        for (const test of affectedTests) {
            try {
                // Read the current test file
                if (!fs.existsSync(test.testPath)) {
                    logger.warn(`Test file not found: ${test.testPath}`);
                    continue;
                }

                const currentTest = fs.readFileSync(test.testPath, 'utf-8');

                // Create a comprehensive prompt for Copilot
                const prompt = this.createCopilotPrompt(
                    oldSpec,
                    newSpec,
                    currentTest,
                    test.endpointChange,
                    test.changeImpact,
                    test.suggestedAction
                );

                // Get Copilot's suggestion
                const updatedTest = await CopilotService.enhanceKarateTest(
                    currentTest,
                    prompt,
                    {
                        type: 'openapi',
                        openApiSpec: newSpec
                    }
                );

                // Write the updated test back
                fs.writeFileSync(test.testPath, updatedTest, 'utf-8');
                logger.info(`Updated test file with Copilot: ${test.testPath}`);
                updated++;

            } catch (error) {
                const errorMsg = `Failed to update ${test.testPath}: ${error}`;
                logger.error(errorMsg, error as Error);
                errors.push(errorMsg);
            }
        }

        return { updated, errors };
    }

    /**
     * Create a detailed prompt for Copilot
     */
    private createCopilotPrompt(
        oldSpec: string,
        newSpec: string,
        currentTest: string,
        endpoint: any,
        impact: string,
        action: string
    ): string {
        return `
# Task: Update Karate Test for OpenAPI Spec Change

## Context
The OpenAPI specification has changed, and this test needs to be updated accordingly.

## Endpoint Affected
- Path: ${endpoint.path}
- Method: ${endpoint.method}
- Operation ID: ${endpoint.operationId || 'N/A'}

## Change Impact Level
${impact}

## Recommended Action
${action}

## Old OpenAPI Spec (Relevant Section)
\`\`\`yaml
${this.extractRelevantSpec(oldSpec, endpoint)}
\`\`\`

## New OpenAPI Spec (Relevant Section)
\`\`\`yaml
${this.extractRelevantSpec(newSpec, endpoint)}
\`\`\`

## Current Test File
\`\`\`gherkin
${currentTest}
\`\`\`

## Instructions
1. Analyze the differences between the old and new OpenAPI specs
2. Identify what changed in the endpoint (parameters, request body, responses, etc.)
3. Update the Karate test to match the new spec
4. Preserve any custom logic or assertions that are still valid
5. Add new test cases for new parameters or response fields
6. Remove or update test cases for removed or changed parameters
7. Ensure the test follows Karate best practices
8. Maintain the existing code style and formatting

## Output
Provide the complete updated Karate test file with all necessary changes applied.
`;
    }

    /**
     * Extract the relevant portion of the spec for a specific endpoint
     */
    private extractRelevantSpec(spec: string, endpoint: any): string {
        // Simple extraction - find the path section
        const lines = spec.split('\n');
        const pathIndex = lines.findIndex(line => line.includes(endpoint.path));

        if (pathIndex === -1) {
            return '(Endpoint not found in spec)';
        }

        // Extract ~30 lines around the endpoint
        const start = Math.max(0, pathIndex - 5);
        const end = Math.min(lines.length, pathIndex + 25);

        return lines.slice(start, end).join('\n');
    }

    /**
     * Analyze a single test file and suggest improvements
     */
    public async analyzeTestFile(
        testFilePath: string,
        specPath: string
    ): Promise<string> {
        const isAvailable = await CopilotService.isCopilotAvailable();
        if (!isAvailable) {
            throw new Error('No AI provider available');
        }

        const testContent = fs.readFileSync(testFilePath, 'utf-8');
        const specContent = fs.readFileSync(specPath, 'utf-8');

        const prompt = `
Analyze this Karate test file and suggest improvements based on the OpenAPI spec.
Look for:
- Missing test cases for endpoints in the spec
- Outdated assertions that don't match the spec
- Missing validation for required fields
- Opportunities to add negative test cases
- Better error handling

OpenAPI Spec:
\`\`\`yaml
${specContent}
\`\`\`

Test File:
\`\`\`gherkin
${testContent}
\`\`\`

Provide a detailed analysis with specific suggestions.
`;

        return await CopilotService.enhanceKarateTest(
            testContent,
            prompt,
            { type: 'openapi', openApiSpec: specContent }
        );
    }
}
