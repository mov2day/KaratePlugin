import * as vscode from 'vscode';
import { DiagnosticsManager } from './DiagnosticsManager';
import { LinterRule } from './rules/Rule';
// Rules will be imported here
import { HardcodedUrlRule } from './rules/HardcodedUrlRule';
import { ConsistentIndentationRule } from './rules/ConsistentIndentationRule';
import { KeywordSpacingRule } from './rules/KeywordSpacingRule';
import { DuplicateScenarioRule } from './rules/DuplicateScenarioRule';
import { EmptyScenarioRule } from './rules/EmptyScenarioRule';
import { NamingConventionRule } from './rules/NamingConventionRule';
import { FileNamingRule } from './rules/FileNamingRule';
import { TagPlacementRule } from './rules/TagPlacementRule';
import { AuthenticationTestRule } from './rules/AuthenticationTestRule';
import { HardcodedSecretRule } from './rules/HardcodedSecretRule';

export class KarateLinter {
    private diagnosticsManager: DiagnosticsManager;
    private rules: LinterRule[];
    private disposables: vscode.Disposable[] = [];

    constructor() {
        this.diagnosticsManager = new DiagnosticsManager();
        this.rules = [
            new HardcodedUrlRule(),
            new ConsistentIndentationRule(),
            new KeywordSpacingRule(),
            new DuplicateScenarioRule(),
            new EmptyScenarioRule(),
            new NamingConventionRule(),
            new FileNamingRule(),
            new TagPlacementRule(),
            new AuthenticationTestRule(),
            new HardcodedSecretRule()
        ];

        this.registerListeners();
    }

    private registerListeners() {
        // Lint on open
        vscode.workspace.onDidOpenTextDocument((doc) => {
            this.lintDocument(doc);
        }, null, this.disposables);

        // Lint on change
        vscode.workspace.onDidChangeTextDocument((event) => {
            this.lintDocument(event.document);
        }, null, this.disposables);

        // Lint on save
        vscode.workspace.onDidSaveTextDocument((doc) => {
            this.lintDocument(doc);
        }, null, this.disposables);

        // Initial lint of active editor
        if (vscode.window.activeTextEditor) {
            this.lintDocument(vscode.window.activeTextEditor.document);
        }
    }

    private lintDocument(document: vscode.TextDocument) {
        if (document.languageId !== 'karate' && !document.fileName.endsWith('.feature')) {
            return;
        }

        const config = vscode.workspace.getConfiguration('karate.linter');
        const enabledRules = config.get<Record<string, boolean>>('enabledRules', {});

        const diagnostics: vscode.Diagnostic[] = [];

        for (const rule of this.rules) {
            // Check if rule is disabled in config
            // Config format: { "K001": true, "K002": false }
            // Default to true if not specified
            const isEnabled = enabledRules[rule.id] !== false;

            if (isEnabled) {
                try {
                    const ruleDiagnostics = rule.check(document);
                    diagnostics.push(...ruleDiagnostics);
                } catch (error) {
                    console.error(`Error running rule ${rule.id}:`, error);
                }
            }
        }

        this.diagnosticsManager.updateDiagnostics(document, diagnostics);
    }

    public dispose() {
        this.diagnosticsManager.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}
