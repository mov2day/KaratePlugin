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
