import * as vscode from 'vscode';
import {
    KARATE_LANGUAGE_ID,
    OFFICIAL_EXTENSION_ID,
    OFFICIAL_LANGUAGE_ID,
    shouldApplyKarateMode
} from './karateDetection';

/** Switches Karate .feature files to the free `karate-dsl` language mode when the official extension is absent. */
export class KarateLanguageService implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private configCheck: Thenable<boolean> | undefined;

    constructor() {
        this.disposables.push(
            vscode.workspace.onDidOpenTextDocument(doc => void this.consider(doc)),
            vscode.workspace.onDidChangeWorkspaceFolders(() => { this.configCheck = undefined; }),
            vscode.commands.registerCommand('karate-dsl.useKarateLanguage', () => this.forceActiveEditor())
        );
        for (const doc of vscode.workspace.textDocuments) {
            void this.consider(doc);
        }
    }

    private officialInstalled(): boolean {
        return !!vscode.extensions.getExtension(OFFICIAL_EXTENSION_ID);
    }

    private workspaceHasKarateConfig(): Thenable<boolean> {
        if (!this.configCheck) {
            this.configCheck = vscode.workspace
                .findFiles('**/karate-config*.js', '**/node_modules/**', 1)
                .then(files => files.length > 0, () => false);
        }
        return this.configCheck;
    }

    private async consider(doc: vscode.TextDocument): Promise<void> {
        if (doc.uri.scheme !== 'file' || doc.languageId === OFFICIAL_LANGUAGE_ID || doc.languageId === KARATE_LANGUAGE_ID) {
            return;
        }
        if (!doc.fileName.toLowerCase().endsWith('.feature')) {
            return;
        }
        const autoDetect = vscode.workspace.getConfiguration('karateDsl.language', doc.uri).get<boolean>('autoDetect', true);
        const officialInstalled = this.officialInstalled();
        if (!autoDetect || officialInstalled) {
            return;
        }
        const applies = shouldApplyKarateMode({
            fileName: doc.fileName,
            languageId: doc.languageId,
            autoDetect,
            officialInstalled,
            workspaceHasKarateConfig: await this.workspaceHasKarateConfig(),
            text: doc.getText()
        });
        if (applies && !doc.isClosed) {
            await vscode.languages.setTextDocumentLanguage(doc, KARATE_LANGUAGE_ID);
        }
    }

    private async forceActiveEditor(): Promise<void> {
        const doc = vscode.window.activeTextEditor?.document;
        if (!doc) {
            vscode.window.showInformationMessage('Open a Karate .feature file first.');
            return;
        }
        if (doc.languageId !== KARATE_LANGUAGE_ID) {
            await vscode.languages.setTextDocumentLanguage(doc, KARATE_LANGUAGE_ID);
        }
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }
}
