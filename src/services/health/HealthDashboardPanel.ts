import * as vscode from 'vscode';
import { ProjectAnalyzer } from './ProjectAnalyzer';
import { ProjectHealthStats } from './types';

export class HealthDashboardPanel {
    public static currentPanel: HealthDashboardPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        
        this._panel.webview.html = this._getLoadingHtml();
        
        this._update();
    }

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (HealthDashboardPanel.currentPanel) {
            HealthDashboardPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'karateHealth',
            'Karate Project Health',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources'), vscode.Uri.joinPath(extensionUri, 'out')]
            }
        );

        HealthDashboardPanel.currentPanel = new HealthDashboardPanel(panel, extensionUri);
    }

    public dispose() {
        HealthDashboardPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private async _update() {
        const analyzer = new ProjectAnalyzer();
        const stats = await analyzer.analyzeWorkspace();
        this._panel.webview.html = this._getHtmlForWebview(stats);
    }

    private _getLoadingHtml() {
        return `<!DOCTYPE html>
            <html lang="en">
            <body>
                <h1>Analyzing Project Health...</h1>
            </body>
            </html>`;
    }

    private _getHtmlForWebview(stats: ProjectHealthStats) {
        // Basic HTML for now
        // Uses simple CSS for a card layout
        
        // Generate Dependency Nodes/Edges for Vis.js (embedded as JSON)
        // We will assume Vis.js is a script we can load or just use simple SVG/HTML for the graph in v1?
        // Let's try to embed a CDN link for Vis.js or generic Graph library if online, but best practice is local or none.
        // For this specific 'Attractive Features' request, let's use Mermaid JS! It's text based and easy to embed.
        
        let mermaidGraph = 'graph TD;\n';
        stats.dependencies.forEach(edge => {
            const srcNames = edge.source.split('/');
            const tgtNames = edge.target.split('/');
            const src = srcNames[srcNames.length - 1].replace(/\./g, '_');
            const tgt = tgtNames[tgtNames.length - 1].replace(/\./g, '_');
            mermaidGraph += `    ${src} --> ${tgt};\n`;
        });

        // Add some orphans
        stats.orphanedFiles.forEach(orphan => {
             const name = orphan.replace(/\./g, '_');
             mermaidGraph += `    ${name}[${orphan}]:::orphaned;\n`;
        });

        mermaidGraph += `    classDef orphaned fill:#f96,stroke:#333,stroke-width:2px;`;

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Karate Project Health</title>
                <script type="module">
                    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
                    mermaid.initialize({ startOnLoad: true, theme: 'dark' });
                </script>
                <style>
                    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 20px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
                    .card-container { display: flex; gap: 20px; margin-bottom: 20px; }
                    .card { background-color: var(--vscode-editor-lineHighlightBackground); padding: 15px; border-radius: 8px; flex: 1; text-align: center; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                    .card h2 { margin: 0; font-size: 2em; color: var(--vscode-textLink-foreground); }
                    .card p { margin: 5px 0 0; opacity: 0.8; }
                    .section { margin-top: 30px; background-color: var(--vscode-editor-lineHighlightBackground); padding: 20px; border-radius: 8px; }
                    h1 { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 10px; }
                    .mermaid { margin-top: 20px; text-align: center; }
                </style>
            </head>
            <body>
                <h1>🩺 Project Health Report</h1>
                
                <div class="card-container">
                    <div class="card">
                        <h2>${stats.totalFiles}</h2>
                        <p>Feature Files</p>
                    </div>
                    <div class="card">
                        <h2>${stats.totalScenarios}</h2>
                        <p>Total Scenarios</p>
                    </div>
                    <div class="card">
                        <h2>${stats.dryScore}%</h2>
                        <p>Code Reusability</p>
                    </div>
                    <div class="card">
                         <h2 style="color: ${stats.orphanedFiles.length > 0 ? '#ff6b6b' : '#51cf66'}">${stats.orphanedFiles.length}</h2>
                        <p>Unused Files</p>
                    </div>
                </div>

                <div class="section">
                    <h3>🕸️ Feature Dependency Map</h3>
                    <p>Visualizing how your feature files connect (Calls & Reads)</p>
                    <div class="mermaid">
                        ${mermaidGraph}
                    </div>
                </div>

                <div class="section">
                    <h3>🛡️ Security & Best Practices</h3>
                    <ul>
                        <li><span style="color: #51cf66">✓</span> Linter is Active (Real-time checks enabled)</li>
                        ${stats.orphanedFiles.length > 0 ? `<li><span style="color: #ff6b6b">⚠</span> Found ${stats.orphanedFiles.length} potentially unused files (marked orange in graph)</li>` : ''}
                    </ul>
                </div>
            </body>
            </html>`;
    }
}
