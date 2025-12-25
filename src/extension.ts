import * as vscode from 'vscode';
import { generateFromOpenAPI } from './commands/generateFromOpenAPI';
import { generateFromConfluence } from './commands/generateFromConfluence';
import { generateCombined } from './commands/generateCombined';
import { KarateWebviewProvider } from './webview/WebviewProvider';
import { logger } from './utils/logger';

export function activate(context: vscode.ExtensionContext) {
    logger.info('Karate DSL Generator extension is now active');

    // Register webview provider
    const webviewProvider = new KarateWebviewProvider(context.extensionUri, context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            KarateWebviewProvider.viewType,
            webviewProvider
        )
    );

    // Command registrations
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

    const openPanelCommand = vscode.commands.registerCommand(
        'karate-dsl.openPanel',
        () => {
            vscode.commands.executeCommand('karateGenerator.mainView.focus');
        }
    );

    const generateFromExplorerCommand = vscode.commands.registerCommand(
        'karate-dsl.generateFromExplorer',
        async (uri: vscode.Uri) => {
            if (!uri) return;
            await vscode.commands.executeCommand('karateGenerator.mainView.focus');
            webviewProvider.postMessageToWebview({
                command: 'preFillSource',
                filePath: uri.fsPath,
                target: 'openapi'
            });
        }
    );

    const learnStyleFromExplorerCommand = vscode.commands.registerCommand(
        'karate-dsl.learnStyleFromExplorer',
        async (uri: vscode.Uri) => {
            if (!uri) return;
            await vscode.commands.executeCommand('karateGenerator.mainView.focus');
            webviewProvider.postMessageToWebview({
                command: 'preFillSource',
                filePath: uri.fsPath,
                target: 'style'
            });
        }
    );

    context.subscriptions.push(
        openApiCommand,
        confluenceCommand,
        combinedCommand,
        openPanelCommand,
        generateFromExplorerCommand,
        learnStyleFromExplorerCommand
    );
}

export function deactivate() { }
