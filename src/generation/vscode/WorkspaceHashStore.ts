import * as vscode from 'vscode';
import type { HashStore } from '../write/OutputWriter';

const KEY = 'karateDsl.generatedHashes';

/** HashStore over workspaceState; call flush() after writing. */
export class WorkspaceHashStore implements HashStore {
    private readonly hashes: Record<string, string>;
    private readonly workspaceState: vscode.Memento | undefined;

    constructor(context: vscode.ExtensionContext) {
        this.workspaceState = context?.workspaceState;
        this.hashes = { ...this.workspaceState?.get<Record<string, string>>(KEY, {}) };
    }

    get(path: string): string | undefined {
        return this.hashes[path];
    }

    set(path: string, hash: string): void {
        this.hashes[path] = hash;
    }

    flush(): Thenable<void> {
        return this.workspaceState ? this.workspaceState.update(KEY, this.hashes) : Promise.resolve();
    }
}
