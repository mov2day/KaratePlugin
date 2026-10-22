import * as vscode from 'vscode';
import type { GenerationSummary } from '../pipeline/Summary';

let channel: vscode.OutputChannel | undefined;

/** Dedicated output channel for generation reports. */
export function generationChannel(): vscode.OutputChannel {
    channel ??= vscode.window.createOutputChannel('Karate Generation');
    return channel;
}

export function writeSummaryDetails(summary: GenerationSummary, title?: string): void {
    const out = generationChannel();
    out.appendLine(`=== ${title ?? 'Karate generation'} ${new Date().toISOString()} ===`);
    out.appendLine(summary.headline);
    for (const line of summary.details) {out.appendLine(line);}
    out.appendLine('');
}

/** Notify with the headline; details are always written to the output channel; "Show details" reveals it. Not awaited by callers. */
export function reportSummary(summary: GenerationSummary, title?: string, openPath?: string): Thenable<void> {
    writeSummaryDetails(summary, title);
    const show = summary.level === 'warning' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const buttons = openPath ? ['Open File', 'Show details'] : ['Show details'];
    return show(summary.headline, ...buttons).then(async choice => {
        if (choice === 'Show details') {generationChannel().show(true);}
        if (choice === 'Open File' && openPath) {
            const doc = await vscode.workspace.openTextDocument(openPath);
            await vscode.window.showTextDocument(doc);
        }
    });
}
