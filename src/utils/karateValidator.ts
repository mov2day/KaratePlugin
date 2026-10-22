import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { runGate } from '../generation/quality/QualityGate';

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
        return runGate(content).findings.map(f => `Line ${f.line}: [${f.ruleId}] ${f.message}`);
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

        return runGate(content).ok;
    }
}
