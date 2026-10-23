import * as fs from 'fs';
import * as path from 'path';
import type { WritableFs } from '../write/OutputWriter';

/** Real file system for the generation pipeline (vscode-side glue). */
export const nodeFs: WritableFs = {
    exists: p => fs.existsSync(p),
    read: p => fs.readFileSync(p, 'utf8'),
    list: dir => fs.readdirSync(dir),
    write: (p, content) => {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, 'utf8');
    }
};

/** A Node fs adapter that rejects reads/writes escaping a known workspace root. */
export function workspaceNodeFs(workspaceRoot: string): WritableFs {
    const root = path.resolve(workspaceRoot);
    const confined = (p: string): string => {
        const resolved = path.resolve(p);
        const relative = path.relative(root, resolved);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error(`Refusing filesystem access outside workspace root: ${p}`);
        }
        return resolved;
    };
    return {
        exists: p => fs.existsSync(confined(p)),
        read: p => fs.readFileSync(confined(p), 'utf8'),
        list: p => fs.readdirSync(confined(p)),
        write: (p, content) => {
            const safe = confined(p);
            fs.mkdirSync(path.dirname(safe), { recursive: true });
            fs.writeFileSync(safe, content, 'utf8');
        }
    };
}
