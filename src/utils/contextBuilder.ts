import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../utils/logger';

/**
 * Utility for building rich context for Copilot using file attachments and Agent Skills
 */
export class ContextBuilder {
    private static tempFiles: string[] = [];

    /**
     * Create a temporary file from content
     * Useful for non-file content like Confluence HTML or in-memory collections
     */
    static async createTempFileFromContent(
        content: string,
        extension: string
    ): Promise<vscode.Uri> {
        const tempDir = os.tmpdir();
        const filename = `karate-temp-${Date.now()}${extension}`;
        const tempPath = path.join(tempDir, filename);

        fs.writeFileSync(tempPath, content, 'utf-8');
        this.tempFiles.push(tempPath);

        logger.info(`Created temp file: ${tempPath}`);
        return vscode.Uri.file(tempPath);
    }

    /**
     * Build file attachments from file paths
     */
    static async buildFileAttachments(filePaths: string[]): Promise<vscode.Uri[]> {
        const uris: vscode.Uri[] = [];

        for (const filePath of filePaths) {
            if (fs.existsSync(filePath)) {
                uris.push(vscode.Uri.file(filePath));
            } else {
                logger.warn(`File not found: ${filePath}`);
            }
        }

        return uris;
    }

    /**
     * Create file reference string for prompts (#filename syntax)
     */
    static createFileReference(filePath: string): string {
        const basename = path.basename(filePath);
        return `#${basename}`;
    }

    /**
     * Format context with file URIs and skill references
     */
    static formatContextWithSkills(
        fileReferences: string[],
        skillContext: string
    ): string {
        let context = '';

        if (fileReferences.length > 0) {
            context += 'Files attached for context:\n';
            context += fileReferences.map(ref => `- ${ref}`).join('\n');
            context += '\n\n';
        }

        if (skillContext) {
            context += skillContext;
        }

        return context;
    }

    /**
     * Get relevant feature files from workspace
     */
    static async getRelevantFeatureFiles(limit: number = 5): Promise<vscode.Uri[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return [];
        }

        const featureFiles: vscode.Uri[] = [];

        try {
            // Find .feature files
            const pattern = new vscode.RelativePattern(
                workspaceFolders[0],
                '**/*.feature'
            );

            const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', limit);
            featureFiles.push(...files);

        } catch (error) {
            logger.error('Error finding feature files', error as Error);
        }

        return featureFiles;
    }

    /**
     * Clean up temporary files
     */
    static async cleanupTempFiles(): Promise<void> {
        for (const tempFile of this.tempFiles) {
            try {
                if (fs.existsSync(tempFile)) {
                    fs.unlinkSync(tempFile);
                    logger.info(`Deleted temp file: ${tempFile}`);
                }
            } catch (error) {
                logger.error(`Error deleting temp file ${tempFile}`, error as Error);
            }
        }

        this.tempFiles = [];
    }

    /**
     * Build workspace context summary
     */
    static async buildWorkspaceContext(): Promise<{
        featureFiles: vscode.Uri[];
        hasKarateConfig: boolean;
        projectRoot: string;
    }> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return {
                featureFiles: [],
                hasKarateConfig: false,
                projectRoot: ''
            };
        }

        const projectRoot = workspaceFolders[0].uri.fsPath;
        const karateConfigPath = path.join(projectRoot, 'karate-config.js');
        const hasKarateConfig = fs.existsSync(karateConfigPath);

        const featureFiles = await this.getRelevantFeatureFiles(10);

        return {
            featureFiles,
            hasKarateConfig,
            projectRoot
        };
    }
}
