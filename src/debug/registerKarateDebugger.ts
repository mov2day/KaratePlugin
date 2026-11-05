import * as vscode from 'vscode';
import { DapMessage, DebugLaunch, KarateDebugAdapter } from './KarateDebugAdapter';

export const KARATE_DEBUG_TYPE = 'karate-dsl';

class InlineAdapter implements vscode.DebugAdapter {
    private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
    readonly onDidSendMessage = this.emitter.event;
    private readonly adapter: KarateDebugAdapter;

    constructor(prepare: (feature: string) => Promise<DebugLaunch>) {
        this.adapter = new KarateDebugAdapter(message => this.emitter.fire(message as vscode.DebugProtocolMessage), prepare);
    }

    handleMessage(message: vscode.DebugProtocolMessage): void {
        this.adapter.handleMessage(message as unknown as DapMessage);
    }

    dispose(): void {
        this.adapter.dispose();
        this.emitter.dispose();
    }
}

/** Registers the free Karate step debugger: a debug type, a launch-config resolver and the Debug Feature command. */
export function registerKarateDebugger(prepare: (feature: string) => Promise<DebugLaunch>): vscode.Disposable[] {
    const factory = vscode.debug.registerDebugAdapterDescriptorFactory(KARATE_DEBUG_TYPE, {
        createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(new InlineAdapter(prepare))
    });
    const resolver = vscode.debug.registerDebugConfigurationProvider(KARATE_DEBUG_TYPE, {
        resolveDebugConfiguration(_folder, config) {
            const editor = vscode.window.activeTextEditor;
            if (!config.type) {
                config.type = KARATE_DEBUG_TYPE;
                config.request = 'launch';
                config.name = 'Debug Karate feature';
            }
            if (!config.feature || config.feature === '${file}') {
                if (!editor || !editor.document.fileName.endsWith('.feature')) {
                    vscode.window.showInformationMessage('Open a Karate .feature file to debug it.');
                    return undefined;
                }
                config.feature = editor.document.fileName;
            }
            return config;
        }
    });
    const command = vscode.commands.registerCommand('karate-dsl.debugFeature', async (uri?: vscode.Uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target || !target.fsPath.endsWith('.feature')) {
            vscode.window.showInformationMessage('Open a Karate .feature file to debug it.');
            return;
        }
        await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(target), {
            type: KARATE_DEBUG_TYPE, request: 'launch', name: 'Debug Karate feature', feature: target.fsPath, stopOnEntry: true
        });
    });
    return [factory, resolver, command];
}
