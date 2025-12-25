import * as vscode from 'vscode';
import { generateFromOpenAPI } from './commands/generateFromOpenAPI';
import { generateFromConfluence } from './commands/generateFromConfluence';
import { generateCombined } from './commands/generateCombined';
import { KarateWebviewProvider } from './webview/WebviewProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('Karate DSL Generator extension is now active');

    // Register webview provider
    const webviewProvider = new KarateWebviewProvider(context.extensionUri, context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            KarateWebviewProvider.viewType,
            webviewProvider
        )
    );

    // Register commands (keep for backward compatibility)
    const openApiCommand = vscode.commands.registerCommand(
        'karate-dsl.generateFromOpenAPI',
        () => generateFromOpenAPI(context)
    );

    const confluenceCommand = vscode.commands.registerCommand(
        'karate-dsl.generateFromConfluence',
        () => generateFromConfluence(context)
    );

    const combinedCommand = vscode.commands.registerCommand(
        'karate-dsl.generateCombined',
        () => generateCombined(context)
    );

    // Command to open webview panel
    const openPanelCommand = vscode.commands.registerCommand(
        'karate-dsl.openPanel',
        () => {
            vscode.commands.executeCommand('karateGenerator.mainView.focus');
        }
    );

    context.subscriptions.push(openApiCommand, confluenceCommand, combinedCommand, openPanelCommand);
}

export function deactivate() { }
