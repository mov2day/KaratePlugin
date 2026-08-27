import * as path from 'path';

/** Converts an execution path to a portable workspace-relative representation. */
export function toWorkspaceRelativePath(workspaceRoot: string, value: string): string {
    if (!path.isAbsolute(value)) return value.replace(/\\/g, '/');
    const relative = path.relative(workspaceRoot, value);
    if (!relative) return '.';
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('Workspace state cannot store a path outside its workspace.');
    }
    return relative.replace(/\\/g, '/');
}

/** Rehydrates an execution-only path from portable workspace state. */
export function toWorkspaceAbsolutePath(workspaceRoot: string, value: string): string {
    return path.isAbsolute(value) ? value : path.resolve(workspaceRoot, value);
}
