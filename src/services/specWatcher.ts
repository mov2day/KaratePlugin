import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { SpecHashManager, SpecMetadata } from './specHashManager';
import { logger } from '../utils/logger';

/**
 * Watches OpenAPI spec files for changes and triggers sync notifications
 */
export class SpecWatcher {
    private watcher: vscode.FileSystemWatcher | undefined;
    private specHashManager: SpecHashManager;
    private onSpecChangedCallback: (specPath: string, metadata: SpecMetadata) => void;
    private pollingInterval: NodeJS.Timeout | undefined;
    private readonly POLL_INTERVAL_MS = 5000; // Check every 5 seconds

    constructor(
        private context: vscode.ExtensionContext,
        onSpecChanged: (specPath: string, metadata: SpecMetadata) => void
    ) {
        this.specHashManager = new SpecHashManager(context);
        this.onSpecChangedCallback = onSpecChanged;
    }

    /**
     * Start watching all OpenAPI spec files in the workspace
     */
    public startWatching(): void {
        // Watch all JSON and YAML files
        this.watcher = vscode.workspace.createFileSystemWatcher(
            '**/*.{json,yaml,yml}'
        );

        this.watcher.onDidChange(async (uri) => {
            await this.handleFileChange(uri);
        });

        this.watcher.onDidDelete(async (uri) => {
            await this.handleFileDelete(uri);
        });

        this.context.subscriptions.push(this.watcher);
        logger.info('SpecWatcher: Started file system watcher');

        // Start polling as backup
        this.startPolling();
    }

    /**
     * Start polling tracked specs for changes (fallback mechanism)
     */
    private startPolling(): void {
        logger.info(`SpecWatcher: Starting polling (every ${this.POLL_INTERVAL_MS / 1000}s)`);

        this.pollingInterval = setInterval(async () => {
            await this.pollTrackedSpecs();
        }, this.POLL_INTERVAL_MS);
    }

    /**
     * Poll all tracked specs for changes
     */
    private async pollTrackedSpecs(): Promise<void> {
        try {
            const trackedSpecs = await this.specHashManager.getTrackedSpecs();

            if (trackedSpecs.length === 0) {
                return;
            }

            logger.info(`SpecWatcher: Polling ${trackedSpecs.length} tracked spec(s)`);

            for (const specPath of trackedSpecs) {
                const metadata = await this.specHashManager.getMetadata(specPath);
                if (!metadata) continue;

                if (!fs.existsSync(specPath)) continue;

                const content = fs.readFileSync(specPath, 'utf-8');
                const currentHash = this.calculateHash(content);

                if (currentHash !== metadata.specHash) {
                    logger.info(`SpecWatcher: [POLLING] Change detected in ${specPath}`);
                    this.onSpecChangedCallback(specPath, metadata);
                }
            }
        } catch (error) {
            logger.error('SpecWatcher: Error during polling', error as Error);
        }
    }

    /**
     * Stop watching for changes
     */
    public stopWatching(): void {
        if (this.watcher) {
            this.watcher.dispose();
            this.watcher = undefined;
            logger.info('SpecWatcher: Stopped file system watcher');
        }

        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = undefined;
            logger.info('SpecWatcher: Stopped polling');
        }
    }

    /**
     * Handle file change event
     */
    private async handleFileChange(uri: vscode.Uri): Promise<void> {
        const filePath = uri.fsPath;

        // Log every file change event
        logger.info(`SpecWatcher: File changed event received: ${filePath}`);

        try {
            // Check if this is a tracked spec
            const metadata = await this.specHashManager.getMetadata(filePath);
            if (!metadata) {
                // Not a tracked spec, ignore
                logger.info(`SpecWatcher: File not tracked, ignoring: ${filePath}`);
                return;
            }

            logger.info(`SpecWatcher: File IS tracked: ${filePath}`);

            // Check if file still exists
            if (!fs.existsSync(filePath)) {
                logger.warn(`SpecWatcher: File no longer exists: ${filePath}`);
                return;
            }

            // Calculate new hash
            const content = fs.readFileSync(filePath, 'utf-8');
            const newHash = this.calculateHash(content);

            logger.info(`SpecWatcher: Old hash: ${metadata.specHash.substring(0, 8)}...`);
            logger.info(`SpecWatcher: New hash: ${newHash.substring(0, 8)}...`);

            // Compare with stored hash
            if (newHash !== metadata.specHash) {
                logger.info(`SpecWatcher: ✅ CHANGE DETECTED in ${filePath}`);
                // Spec has changed!
                this.onSpecChangedCallback(filePath, metadata);
            } else {
                logger.info(`SpecWatcher: No actual content change detected`);
            }
        } catch (error) {
            logger.error(`SpecWatcher: Error handling file change for ${filePath}`, error as Error);
        }
    }

    /**
     * Handle file deletion
     */
    private async handleFileDelete(uri: vscode.Uri): Promise<void> {
        const filePath = uri.fsPath;

        try {
            // Check if this was a tracked spec
            const metadata = await this.specHashManager.getMetadata(filePath);
            if (metadata) {
                logger.info(`SpecWatcher: Tracked spec deleted: ${filePath}`);
                // Remove from tracking
                await this.specHashManager.deleteMetadata(filePath);

                // Optionally notify user
                vscode.window.showWarningMessage(
                    `OpenAPI spec deleted: ${filePath}. Generated tests may be outdated.`
                );
            }
        } catch (error) {
            logger.error(`SpecWatcher: Error handling file deletion for ${filePath}`, error as Error);
        }
    }

    /**
     * Calculate SHA-256 hash of content
     */
    public calculateHash(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    /**
     * Manually check a spec for changes (useful for testing)
     */
    public async checkSpec(specPath: string): Promise<boolean> {
        const metadata = await this.specHashManager.getMetadata(specPath);
        if (!metadata) {
            return false;
        }

        if (!fs.existsSync(specPath)) {
            return false;
        }

        const content = fs.readFileSync(specPath, 'utf-8');
        const currentHash = this.calculateHash(content);

        return currentHash !== metadata.specHash;
    }
}
