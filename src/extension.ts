import * as vscode from 'vscode';
import { generateFromOpenAPI } from './commands/generateFromOpenAPI';
import { generateFromConfluence } from './commands/generateFromConfluence';
import { generateCombined } from './commands/generateCombined';

export function activate(context: vscode.ExtensionContext) {
    console.log('Karate DSL Generator extension is now active');

    // Register commands
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

    context.subscriptions.push(openApiCommand, confluenceCommand, combinedCommand);
}

export function deactivate() {
    console.log('Karate DSL Generator extension is now deactivated');
}
