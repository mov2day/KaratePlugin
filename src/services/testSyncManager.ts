import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SpecHashManager, SpecMetadata } from './specHashManager';
import { SpecDiff } from './specDiffAnalyzer';
import { AffectedTest } from './testImpactAnalyzer';
import { KarateGenerator } from './karateGenerator';
import { OpenAPIParser } from './openApiParser';
import { logger } from '../utils/logger';

/**
 * Plan for updating tests based on spec changes
 */
export interface TestUpdatePlan {
    specPath: string;
    diff: SpecDiff;
    affectedTests: AffectedTest[];
    updateStrategy: 'regenerate' | 'patch' | 'manual';
    backupPath?: string;
}

/**
 * Manages synchronization of tests with spec changes
 */
export class TestSyncManager {
    constructor(
        private specHashManager: SpecHashManager,
        private karateGenerator: KarateGenerator
    ) { }

    /**
     * Synchronize tests with updated spec
     */
    public async syncTests(
        specPath: string,
        updatePlan: TestUpdatePlan
    ): Promise<void> {
        try {
            logger.info(`TestSyncManager: Starting sync for ${specPath}`);

            // Create backup
            const backupDir = await this.createBackup(updatePlan.affectedTests);
            updatePlan.backupPath = backupDir;

            logger.info(`TestSyncManager: Backup created at ${backupDir}`);

            // Process affected tests
            let regenerated = 0;
            let deleted = 0;
            let reviewed = 0;

            for (const affected of updatePlan.affectedTests) {
                if (affected.suggestedAction === 'regenerate') {
                    await this.regenerateTest(specPath, affected);
                    regenerated++;
                } else if (affected.suggestedAction === 'delete') {
                    await this.markTestAsDeprecated(affected);
                    deleted++;
                } else if (affected.suggestedAction === 'review') {
                    await this.addReviewComment(affected);
                    reviewed++;
                }
            }

            // Update metadata with new hash
            const newHash = await this.calculateSpecHash(specPath);
            const metadata = await this.specHashManager.getMetadata(specPath);
            if (metadata) {
                metadata.specHash = newHash;
                metadata.lastGenerated = Date.now();
                await this.specHashManager.saveMetadata(metadata);
            }

            logger.info(`TestSyncManager: Sync complete - ${regenerated} regenerated, ${deleted} deleted, ${reviewed} marked for review`);

            // Show summary to user
            vscode.window.showInformationMessage(
                `✅ Tests synchronized! ${regenerated} updated, ${deleted} deprecated, ${reviewed} need review. Backup: ${backupDir}`
            );

        } catch (error) {
            logger.error('TestSyncManager: Error during sync', error as Error);
            vscode.window.showErrorMessage(`Failed to sync tests: ${error}`);
            throw error;
        }
    }

    /**
     * Create backup of affected test files
     */
    private async createBackup(tests: AffectedTest[]): Promise<string> {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = path.join(os.tmpdir(), `karate-backup-${timestamp}`);

        // Create backup directory
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        // Get unique test files
        const uniqueFiles = [...new Set(tests.map(t => t.testPath))];

        // Copy each file to backup
        for (const testPath of uniqueFiles) {
            if (fs.existsSync(testPath)) {
                const fileName = path.basename(testPath);
                const backupPath = path.join(backupDir, fileName);
                fs.copyFileSync(testPath, backupPath);
                logger.info(`TestSyncManager: Backed up ${fileName}`);
            }
        }

        return backupDir;
    }

    /**
     * Regenerate a specific test scenario
     */
    private async regenerateTest(specPath: string, affected: AffectedTest): Promise<void> {
        try {
            logger.info(`TestSyncManager: Regenerating test for ${affected.scenarioName}`);

            // Parse spec
            const parser = new OpenAPIParser();
            const endpoints = await parser.parseSpec(specPath);

            // Find the specific endpoint
            const endpoint = endpoints.find(e =>
                affected.endpointChange &&
                e.path === affected.endpointChange.path &&
                e.method === affected.endpointChange.method
            );

            if (endpoint) {
                // Generate new test content for this endpoint
                const specFileName = path.basename(specPath, path.extname(specPath));
                const feature = this.karateGenerator.generateFromOpenAPI([endpoint], specFileName);
                const newScenarioContent = this.extractScenarioContent(
                    this.karateGenerator.featureToString(feature)
                );

                // Replace old scenario in file
                await this.replaceScenarioInFile(
                    affected.testPath,
                    affected.scenarioName,
                    newScenarioContent
                );

                logger.info(`TestSyncManager: Successfully regenerated ${affected.scenarioName}`);
            }
        } catch (error) {
            logger.error(`TestSyncManager: Error regenerating test ${affected.scenarioName}`, error as Error);
        }
    }

    /**
     * Mark a test as deprecated (for removed endpoints)
     */
    private async markTestAsDeprecated(affected: AffectedTest): Promise<void> {
        try {
            logger.info(`TestSyncManager: Marking test as deprecated: ${affected.scenarioName}`);

            if (!fs.existsSync(affected.testPath)) {
                return;
            }

            const content = fs.readFileSync(affected.testPath, 'utf-8');

            // Add deprecation comment to scenario
            const deprecationComment = `\n  # DEPRECATED: Endpoint removed from spec on ${new Date().toISOString()}\n  # Reason: ${affected.reason}\n`;

            const updatedContent = this.addCommentToScenario(
                content,
                affected.scenarioName,
                deprecationComment
            );

            fs.writeFileSync(affected.testPath, updatedContent, 'utf-8');

            logger.info(`TestSyncManager: Marked ${affected.scenarioName} as deprecated`);
        } catch (error) {
            logger.error(`TestSyncManager: Error marking test as deprecated`, error as Error);
        }
    }

    /**
     * Add review comment to a test
     */
    private async addReviewComment(affected: AffectedTest): Promise<void> {
        try {
            logger.info(`TestSyncManager: Adding review comment to ${affected.scenarioName}`);

            if (!fs.existsSync(affected.testPath)) {
                return;
            }

            const content = fs.readFileSync(affected.testPath, 'utf-8');

            // Add review comment
            const reviewComment = `\n  # TODO: REVIEW REQUIRED - Breaking changes detected\n  # ${affected.reason}\n  # Updated: ${new Date().toISOString()}\n`;

            const updatedContent = this.addCommentToScenario(
                content,
                affected.scenarioName,
                reviewComment
            );

            fs.writeFileSync(affected.testPath, updatedContent, 'utf-8');

            logger.info(`TestSyncManager: Added review comment to ${affected.scenarioName}`);
        } catch (error) {
            logger.error(`TestSyncManager: Error adding review comment`, error as Error);
        }
    }

    /**
     * Extract scenario content from generated feature
     */
    private extractScenarioContent(featureContent: string): string {
        // Extract just the scenario part (skip Feature: and Background:)
        const lines = featureContent.split('\n');
        const scenarioStart = lines.findIndex(line => line.trim().startsWith('Scenario:'));

        if (scenarioStart === -1) {
            return featureContent;
        }

        return lines.slice(scenarioStart).join('\n');
    }

    /**
     * Replace a scenario in a feature file
     */
    private async replaceScenarioInFile(
        filePath: string,
        scenarioName: string,
        newContent: string
    ): Promise<void> {
        if (!fs.existsSync(filePath)) {
            return;
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        // Find scenario start and end
        let scenarioStart = -1;
        let scenarioEnd = -1;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            if (line.startsWith('Scenario:') && line.includes(scenarioName)) {
                scenarioStart = i;
            } else if (scenarioStart !== -1 && (line.startsWith('Scenario:') || line.startsWith('Feature:'))) {
                scenarioEnd = i;
                break;
            }
        }

        if (scenarioStart === -1) {
            logger.warn(`TestSyncManager: Scenario not found: ${scenarioName}`);
            return;
        }

        if (scenarioEnd === -1) {
            scenarioEnd = lines.length;
        }

        // Replace scenario
        const before = lines.slice(0, scenarioStart);
        const after = lines.slice(scenarioEnd);
        const updated = [...before, newContent, ...after].join('\n');

        fs.writeFileSync(filePath, updated, 'utf-8');
    }

    /**
     * Add comment to a scenario
     */
    private addCommentToScenario(
        content: string,
        scenarioName: string,
        comment: string
    ): string {
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('Scenario:') && line.includes(scenarioName)) {
                // Insert comment after scenario line
                lines.splice(i + 1, 0, comment);
                break;
            }
        }

        return lines.join('\n');
    }

    /**
     * Calculate hash of spec file
     */
    private async calculateSpecHash(specPath: string): Promise<string> {
        const crypto = await import('crypto');
        const content = fs.readFileSync(specPath, 'utf-8');
        return crypto.createHash('sha256').update(content).digest('hex');
    }
}
