import * as vscode from 'vscode';
import type { HashStore } from '../write/OutputWriter';

const KEY = 'karateDsl.generatedHashes';

/** HashStore over workspaceState; call flush() after writing. */
export class WorkspaceHashStore implements HashStore {
    private readonly hashes: Record<string, string>;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.hashes = { ...context.workspaceState.get<Record<string, string>>(KEY, {}) };
    }

    get(path: string): string | undefined {
        return this.hashes[path];
    }

    set(path: string, hash: string): void {
        this.hashes[path] = hash;
    }

    flush(): Thenable<void> {
        return this.context.workspaceState.update(KEY, this.hashes);
    }
}
