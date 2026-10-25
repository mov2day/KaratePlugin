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
    const realRoot = fs.realpathSync(root);
    const confined = (p: string): string => {
        const resolved = path.resolve(p);
        const relative = path.relative(root, resolved);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error(`Refusing filesystem access outside workspace root: ${p}`);
        }
        return resolved;
    };
    const insideRealRoot = (candidate: string): boolean => {
        const relative = path.relative(realRoot, candidate);
        return relative === '' || !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
    };
    const rejectEscapedWrite = (target: string, resolved: string): never => {
        throw new Error(`Refusing filesystem write outside real workspace root: ${target} resolves through ${resolved}`);
    };
    /** Resolve the deepest existing target ancestor before creating anything, then recheck each created directory. */
    const ensureSafeWritePath = (target: string): void => {
        // existsSync follows links and returns false for a dangling link. lstat every existing
        // path component so a dangling link cannot turn into an escape during mkdir/write.
        const relativeParts = path.relative(root, target).split(path.sep).filter(Boolean);
        let inspected = root;
        for (const part of relativeParts) {
            inspected = path.join(inspected, part);
            try {
                const stat = fs.lstatSync(inspected);
                if (stat.isSymbolicLink()) {
                    const linked = path.resolve(path.dirname(inspected), fs.readlinkSync(inspected));
                    if (!insideRealRoot(linked)) {rejectEscapedWrite(target, linked);}
                }
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {throw e;}
            }
        }
        if (fs.existsSync(target)) {
            const realTarget = fs.realpathSync(target);
            if (!insideRealRoot(realTarget)) {rejectEscapedWrite(target, realTarget);}
        }
        const parent = path.dirname(target);
        let existing = parent;
        while (!fs.existsSync(existing)) {
            const parent = path.dirname(existing);
            if (parent === existing) {rejectEscapedWrite(target, existing);}
            existing = parent;
        }
        const realExisting = fs.realpathSync(existing);
        if (!insideRealRoot(realExisting)) {rejectEscapedWrite(target, realExisting);}

        let cursor = existing;
        const missing = path.relative(existing, parent).split(path.sep).filter(Boolean);
        for (const segment of missing) {
            cursor = path.join(cursor, segment);
            fs.mkdirSync(cursor);
            const realCursor = fs.realpathSync(cursor);
            if (!insideRealRoot(realCursor)) {rejectEscapedWrite(target, realCursor);}
        }
    };
    return {
        exists: p => fs.existsSync(confined(p)),
        read: p => fs.readFileSync(confined(p), 'utf8'),
        list: p => fs.readdirSync(confined(p)),
        write: (p, content) => {
            const safe = confined(p);
            ensureSafeWritePath(safe);
            fs.writeFileSync(safe, content, 'utf8');
        }
    };
}
