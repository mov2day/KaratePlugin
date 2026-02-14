import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { SessionProxy } from './SessionProxy';
import { HarImporter } from './HarImporter';
import {
    CapturedRequest,
    RecordingSession,
    HarFilterOptions,
    generateSessionId
} from './CapturedRequest';
import { logger } from '../../utils/logger';

/**
 * Main orchestrator for session recording
 * Manages proxy server, HAR imports, and coordinates with synthesis
 */
export class SessionRecorderService extends EventEmitter {
    private static instance: SessionRecorderService | null = null;

    private proxy: SessionProxy;
    private outputChannel: vscode.OutputChannel;
    private statusBarItem: vscode.StatusBarItem;
    private currentSession: RecordingSession | null = null;

    private constructor() {
        super();
        this.proxy = new SessionProxy();
        this.outputChannel = vscode.window.createOutputChannel('Karate Session Recorder');
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

        // Listen to proxy events
        this.proxy.on('request', (request: CapturedRequest) => {
            // Add request to current session in real-time
            if (this.currentSession && this.currentSession.status === 'recording') {
                this.currentSession.requests.push(request);
            }
            this.logRequest(request);
            this.emit('request', request);
        });

        this.proxy.on('error', (error: Error) => {
            this.log(`❌ Proxy error: ${error.message}`);
            this.emit('error', error);
        });
    }

    /**
     * Get singleton instance
     */
    static getInstance(): SessionRecorderService {
        if (!SessionRecorderService.instance) {
            SessionRecorderService.instance = new SessionRecorderService();
        }
        return SessionRecorderService.instance;
    }

    /**
     * Start a new recording session
     */
    async startRecording(): Promise<RecordingSession> {
        if (this.currentSession && this.currentSession.status === 'recording') {
            throw new Error('A recording session is already active');
        }

        // Get preferred port from settings
        const preferredPort = vscode.workspace
            .getConfiguration('karateDsl.session')
            .get<number>('proxyPort', 8081);

        // Start proxy
        const port = await this.proxy.start(preferredPort);

        // Create new session
        this.currentSession = {
            id: generateSessionId(),
            startTime: Date.now(),
            requests: [],
            proxyPort: port,
            status: 'recording'
        };

        // Update UI
        this.updateStatusBar();
        this.showOutputChannel();

        this.log(`🔴 Recording started on port ${port}`);
        this.log(`Configure your HTTP client to use proxy: http://localhost:${port}`);
        this.log('');
        this.log('⚠️ Note: HTTPS requests show connection info only (encrypted content cannot be captured).');
        this.log('💡 Tip: For full request/response capture, use HTTP or import a HAR file from browser DevTools.');
        this.log('---------------------------------------------------');

        // Show notification with proxy info
        vscode.window.showInformationMessage(
            `Recording started! Proxy: http://localhost:${port} (HTTPS captures connection info only)`,
            'Copy Proxy URL',
            'Learn More'
        ).then(selection => {
            if (selection === 'Copy Proxy URL') {
                vscode.env.clipboard.writeText(`http://localhost:${port}`);
                vscode.window.showInformationMessage('Proxy URL copied to clipboard');
            } else if (selection === 'Learn More') {
                vscode.window.showInformationMessage(
                    'For full HTTPS request/response capture, use "Import HAR File" from browser DevTools. The proxy can only capture HTTP requests fully and HTTPS connection metadata.'
                );
            }
        });

        this.emit('started', this.currentSession);
        return this.currentSession;
    }

    /**
     * Stop the current recording session
     */
    async stopRecording(): Promise<CapturedRequest[]> {
        if (!this.currentSession || this.currentSession.status !== 'recording') {
            throw new Error('No active recording session');
        }

        // Stop proxy and get captured requests
        const requests = await this.proxy.stop();

        // Update session
        this.currentSession.endTime = Date.now();
        this.currentSession.requests = requests;
        this.currentSession.status = 'stopped';

        // Update UI
        this.updateStatusBar();

        const duration = Math.round((this.currentSession.endTime - this.currentSession.startTime) / 1000);
        this.log('---------------------------------------------------');
        this.log(`⏹️ Recording stopped. Duration: ${duration}s`);
        this.log(`📊 Captured ${requests.length} requests`);

        vscode.window.showInformationMessage(
            `Recording stopped. Captured ${requests.length} requests.`,
            'Synthesize to Karate'
        ).then(selection => {
            if (selection === 'Synthesize to Karate') {
                vscode.commands.executeCommand('karate-dsl.synthesizeSession');
            }
        });

        this.emit('stopped', requests);
        return requests;
    }

    /**
     * Import requests from HAR file
     */
    async importHarFile(): Promise<CapturedRequest[]> {
        // Show file picker
        const fileUri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'HAR Files': ['har'],
                'All Files': ['*']
            },
            title: 'Select HAR File to Import'
        });

        if (!fileUri || fileUri.length === 0) {
            return [];
        }

        const harPath = fileUri[0].fsPath;

        // Validate file first
        const validation = HarImporter.validateHarFile(harPath);
        if (!validation.valid) {
            throw new Error(`Invalid HAR file: ${validation.error}`);
        }

        // Ask for filtering options
        const filterChoice = await vscode.window.showQuickPick([
            { label: 'Import All Requests', value: 'all' },
            { label: 'Filter by Domain...', value: 'domain' },
            { label: 'Filter by Path...', value: 'path' },
            { label: 'Advanced Filters...', value: 'advanced' }
        ], {
            placeHolder: `Found ${validation.entryCount} requests. How would you like to import?`
        });

        if (!filterChoice) {
            return [];
        }

        let options: HarFilterOptions | undefined;

        if (filterChoice.value === 'domain') {
            // Get unique domains and let user select
            const content = require('fs').readFileSync(harPath, 'utf-8');
            const harFile = JSON.parse(content);
            const domains = HarImporter.extractDomains(harFile.log.entries);

            const selectedDomains = await vscode.window.showQuickPick(
                domains.map(d => ({ label: d, picked: false })),
                {
                    canPickMany: true,
                    placeHolder: 'Select domains to include'
                }
            );

            if (selectedDomains && selectedDomains.length > 0) {
                options = { includeDomains: selectedDomains.map(d => d.label) };
            }
        } else if (filterChoice.value === 'path') {
            const pathPattern = await vscode.window.showInputBox({
                prompt: 'Enter path pattern to include (e.g., /api/)',
                placeHolder: '/api/'
            });

            if (pathPattern) {
                options = { includePaths: [pathPattern] };
            }
        } else if (filterChoice.value === 'advanced') {
            // Show advanced filter dialog
            options = await this.showAdvancedFilterDialog();
        }

        // Import with filters
        const requests = await HarImporter.importFromFile(harPath, options);

        // Create a session for the imported requests
        this.currentSession = {
            id: generateSessionId(),
            startTime: requests.length > 0 ? requests[0].timestamp : Date.now(),
            endTime: requests.length > 0 ? requests[requests.length - 1].timestamp : Date.now(),
            requests,
            status: 'stopped'
        };

        this.showOutputChannel();
        this.log(`📥 Imported ${requests.length} requests from HAR file`);
        this.log(`Source: ${harPath}`);

        for (const req of requests) {
            this.logRequest(req);
        }

        vscode.window.showInformationMessage(
            `Imported ${requests.length} requests from HAR file.`,
            'Synthesize to Karate'
        ).then(selection => {
            if (selection === 'Synthesize to Karate') {
                vscode.commands.executeCommand('karate-dsl.synthesizeSession');
            }
        });

        this.emit('imported', requests);
        return requests;
    }

    /**
     * Get current session requests
     */
    getSessionRequests(): CapturedRequest[] {
        return this.currentSession?.requests || [];
    }

    /**
     * Get current session
     */
    getCurrentSession(): RecordingSession | null {
        return this.currentSession;
    }

    /**
     * Check if currently recording
     */
    isRecording(): boolean {
        return this.currentSession?.status === 'recording';
    }

    /**
     * Show the output channel
     */
    showOutputChannel(): void {
        this.outputChannel.show(true);
    }

    /**
     * Log a message to the output channel
     */
    private log(message: string): void {
        const timestamp = new Date().toLocaleTimeString();
        this.outputChannel.appendLine(`[${timestamp}] ${message}`);
    }

    /**
     * Log a captured request
     */
    private logRequest(request: CapturedRequest): void {
        const method = request.method.padEnd(7);
        const status = request.response?.status || '---';
        const duration = request.response?.duration
            ? `${request.response.duration}ms`
            : '---';

        this.log(`${method} ${request.url}`);
        this.log(`  → Status: ${status} | Duration: ${duration}`);

        if (request.body) {
            const bodyPreview = request.body.length > 100
                ? request.body.substring(0, 100) + '...'
                : request.body;
            this.log(`  → Body: ${bodyPreview}`);
        }
    }

    /**
     * Update status bar item
     */
    private updateStatusBar(): void {
        if (this.isRecording()) {
            this.statusBarItem.text = `$(record) Recording on :${this.currentSession?.proxyPort}`;
            this.statusBarItem.tooltip = 'Click to stop recording';
            this.statusBarItem.command = 'karate-dsl.stopRecording';
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            this.statusBarItem.show();
        } else {
            this.statusBarItem.hide();
        }
    }

    /**
     * Show advanced filter dialog
     */
    private async showAdvancedFilterDialog(): Promise<HarFilterOptions | undefined> {
        // Domain filter
        const includeDomains = await vscode.window.showInputBox({
            prompt: 'Domains to include (comma-separated, leave empty for all)',
            placeHolder: 'api.example.com, backend.example.com'
        });

        // Method filter
        const methods = await vscode.window.showQuickPick(
            ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].map(m => ({ label: m })),
            {
                canPickMany: true,
                placeHolder: 'Select HTTP methods to include (leave empty for all)'
            }
        );

        // Status filter
        const statusFilter = await vscode.window.showQuickPick([
            { label: 'All Status Codes', value: 'all' },
            { label: 'Success Only (2xx)', value: 'success' },
            { label: 'Success and Redirects (2xx-3xx)', value: 'success-redirect' }
        ], {
            placeHolder: 'Filter by status code'
        });

        const options: HarFilterOptions = {};

        if (includeDomains) {
            options.includeDomains = includeDomains.split(',').map(d => d.trim());
        }

        if (methods && methods.length > 0) {
            options.methods = methods.map(m => m.label);
        }

        if (statusFilter) {
            switch (statusFilter.value) {
                case 'success':
                    options.minStatus = 200;
                    options.maxStatus = 299;
                    break;
                case 'success-redirect':
                    options.minStatus = 200;
                    options.maxStatus = 399;
                    break;
            }
        }

        return Object.keys(options).length > 0 ? options : undefined;
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        if (this.proxy.isActive()) {
            this.proxy.stop();
        }
        this.outputChannel.dispose();
        this.statusBarItem.dispose();
    }
}
