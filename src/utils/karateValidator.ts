import * as vscode from 'vscode';
import { logger } from '../utils/logger';

/**
 * Validates generated Karate tests for executability
 * Checks for common syntax errors that prevent tests from running
 */
export class KarateValidator {

    /**
     * Validate that generated test is executable
     * Returns array of validation errors (empty if valid)
     */
    static validateFeatureContent(content: string): string[] {
        const errors: string[] = [];
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const lineNum = i + 1;

            // Check for invalid URL + path combination
            if (line.match(/url\s+\w+\s*\+\s*['"`]/)) {
                errors.push(`Line ${lineNum}: Invalid URL syntax - don't combine url and path`);
            }

            // Check for invalid path parameter syntax
            if (line.match(/path\s+['"`]\w+['"`]\s*=/)) {
                errors.push(`Line ${lineNum}: Invalid path parameter - use 'def varName = value' instead`);
            }

            // Check for invalid matcher #present
            if (line.includes('#present')) {
                errors.push(`Line ${lineNum}: Invalid matcher '#present' - use '#notnull' instead`);
            }

            // Check for lowercase HTTP methods (warning only)
            if (line.match(/When\s+method\s+(get|post|put|delete|patch)/)) {
                errors.push(`Line ${lineNum}: HTTP method should be uppercase (GET, POST, etc.)`);
            }

            // Check for missing url in Background
            if (line.startsWith('Background:')) {
                let hasUrl = false;
                for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
                    if (lines[j].includes('* url ') || lines[j].includes('Given url')) {
                        hasUrl = true;
                        break;
                    }
                    if (lines[j].trim().startsWith('Scenario')) {
                        break;
                    }
                }
                if (!hasUrl) {
                    errors.push(`Line ${lineNum}: Background missing 'url' step`);
                }
            }
        }

        return errors;
    }

    /**
     * Validate and show errors to user
     */
    static async validateAndNotify(content: string, source: string): Promise<boolean> {
        const errors = this.validateFeatureContent(content);

        if (errors.length > 0) {
            logger.warn(`Validation found ${errors.length} issues in ${source}`);
            const message = `Generated test has ${errors.length} potential issues:\n${errors.slice(0, 3).join('\n')}`;

            const choice = await vscode.window.showWarningMessage(
                message,
                'View All Issues',
                'Ignore',
                'Fix Automatically'
            );

            if (choice === 'View All Issues') {
                const doc = await vscode.workspace.openTextDocument({
                    content: errors.join('\n'),
                    language: 'plaintext'
                });
                await vscode.window.showTextDocument(doc);
            } else if (choice === 'Fix Automatically') {
                // TODO: Implement auto-fix
                vscode.window.showInformationMessage('Auto-fix coming in next version');
            }

            return errors.length === 0;
        }

        logger.info(`Validation passed for ${source}`);
        return true;
    }

    /**
     * Quick syntax check
     */
    static isValidKarateSyntax(content: string): boolean {
        // Basic checks
        if (!content.includes('Feature:')) {
            return false;
        }

        const criticalErrors = this.validateFeatureContent(content).filter(err =>
            err.includes('Invalid') || err.includes('missing')
        );

        return criticalErrors.length === 0;
    }
}
