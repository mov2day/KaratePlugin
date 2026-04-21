import * as vscode from 'vscode';
import { logger } from '../../utils/logger';

/**
 * CIBridgeScripts — generates copy-pasteable integration snippets
 * for connecting CI pipelines to the local webhook.
 */
export class CIBridgeScripts {

    /**
     * Get a curl command for testing the webhook endpoint.
     */
    static getCurlSnippet(port?: number): string {
        const p = port || CIBridgeScripts.getPort();
        return `curl -X POST http://localhost:${p}/api/failure \\
  -H "Content-Type: application/json" \\
  -d '{
    "source": "generic",
    "featurePath": "src/test/karate/api/users.feature",
    "scenarioName": "GET /users returns user list",
    "failedStep": "Then status 200",
    "errorMessage": "status code was: 500, expected: 200",
    "httpRequest": {
      "method": "GET",
      "url": "http://localhost:8080/api/users"
    },
    "httpResponse": {
      "status": 500,
      "body": "{\\\\"error\\\\": \\\\"Internal Server Error\\\\"}"
    },
    "timestamp": ${Date.now()}
  }'`;
    }

    /**
     * Get a GitHub Actions step YAML for the karate-report action.
     */
    static getGitHubActionsStep(): string {
        return `# Add this step after your Karate test step
- name: Report Karate failures to IDE
  if: failure()
  uses: ./.github/actions/karate-report
  with:
    results-path: target/karate-reports/karate-summary-json.txt
    webhook-url: http://localhost:${CIBridgeScripts.getPort()}/api/failure`;
    }

    /**
     * Get a Jenkins pipeline snippet.
     * Uses string concatenation to avoid TypeScript interpreting Groovy template variables.
     */
    static getJenkinsPipelineSnippet(): string {
        const port = CIBridgeScripts.getPort();
        const lines = [
            '// Add this in your post { failure { } } block',
            'post {',
            '    failure {',
            '        script {',
            "            def summary = readFile('target/karate-reports/karate-summary-json.txt')",
            '            def json = readJSON text: summary',
            '            json.featuresPassed.each { feat ->',
            '                feat.scenarioResults.findAll { it.failed }.each { sc ->',
            '                    sh """',
            '                        curl -s -X POST http://localhost:' + port + '/api/failure \\\\',
            "                          -H 'Content-Type: application/json' \\\\",
            '                          -d \'{"source":"jenkins","featurePath":"\'+ feat.relativePath +\'","scenarioName":"\' + sc.name + \'","failedStep":"\'+ sc.failedStep +\'","errorMessage":"\'+ sc.errorMessage +\'","timestamp":\'+ System.currentTimeMillis() +\'}\'',
            '                    """',
            '                }',
            '            }',
            '        }',
            '    }',
            '}'
        ];
        return lines.join('\n');
    }

    /**
     * Show integration guide in a new untitled document.
     */
    static async showIntegrationGuide(): Promise<void> {
        const port = CIBridgeScripts.getPort();
        const content = `# CI Repair Integration Guide

## How It Works
1. Your CI pipeline runs Karate tests
2. On failure, a webhook POST sends structured failure data to your IDE
3. The extension uses AI to suggest and apply fixes

## Quick Test
${CIBridgeScripts.getCurlSnippet(port)}

## GitHub Actions
${CIBridgeScripts.getGitHubActionsStep()}

## Jenkins
${CIBridgeScripts.getJenkinsPipelineSnippet()}

## Webhook Endpoint
- URL: http://localhost:${port}/api/failure
- Method: POST
- Content-Type: application/json
- Health check: GET http://localhost:${port}/api/health
`;
        const doc = await vscode.workspace.openTextDocument({
            content,
            language: 'markdown'
        });
        await vscode.window.showTextDocument(doc);
    }

    private static getPort(): number {
        const config = vscode.workspace.getConfiguration('karateDsl');
        return config.get<number>('ciRepair.webhookPort') || 47392;
    }
}
