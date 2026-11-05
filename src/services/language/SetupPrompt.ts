import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { KarateCliExecutor } from '../execution/KarateCliExecutor';
import { isKarateText } from './karateDetection';

const STATE_KEY = 'karateDsl.setupPrompt.done';
const BUILD_FILES = ['pom.xml', 'build.gradle', 'build.gradle.kts'];

/**
 * One-time offer to download Karate the first time a Karate feature is opened with nothing runnable set up.
 * Uses the existing consent-and-verify download path; adds no download code of its own.
 */
export function registerSetupPrompt(context: vscode.ExtensionContext): vscode.Disposable {
    let asked = false;
    const consider = async (doc: vscode.TextDocument): Promise<void> => {
        if (asked || doc.uri.scheme !== 'file' || !doc.fileName.toLowerCase().endsWith('.feature')) { return; }
        if (context.globalState.get<boolean>(STATE_KEY)) { return; }
        if (doc.languageId !== 'karate-dsl' && doc.languageId !== 'karate' && !isKarateText(doc.getText())) { return; }
        const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
        if (!folder) { return; }
        // A Maven or Gradle project runs through its own build and does not need the standalone jar.
        if (BUILD_FILES.some(file => fs.existsSync(path.join(folder.uri.fsPath, file)))) { return; }
        const jar = KarateCliExecutor.resolveJar(context.extensionPath, undefined, folder.uri.fsPath);
        if (fs.existsSync(jar.jarPath)) { return; }

        asked = true;
        await context.globalState.update(STATE_KEY, true);
        const choice = await vscode.window.showInformationMessage('Set up Karate to run tests?', 'Set up', 'Not now');
        if (choice === 'Set up') {
            try {
                await KarateCliExecutor.ensureKarateJar(context.extensionPath, undefined, folder.uri.fsPath);
                vscode.window.showInformationMessage('Karate is ready. Use the Run lens above a Feature or Scenario.');
            } catch (error) {
                vscode.window.showWarningMessage((error as Error).message);
            }
        }
    };
    const subscription = vscode.workspace.onDidOpenTextDocument(doc => void consider(doc));
    // Let activation finish before looking at documents that are already open.
    setTimeout(() => vscode.workspace.textDocuments.forEach(doc => void consider(doc)), 3000);
    return subscription;
}
