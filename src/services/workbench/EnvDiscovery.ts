import * as fs from 'fs';
import * as path from 'path';

/** Finds the Karate config directory and the environments a project defines. No vscode dependency. */

const CONVENTIONAL = ['src/test/java', 'src/test/resources', 'src/test/karate', 'src/main/resources', '.'];

function hasConfig(dir: string): boolean {
    return fs.existsSync(path.join(dir, 'karate-config.js'));
}

/**
 * The directory holding karate-config.js: the nearest one above the feature up to the project root, then
 * the conventional locations. Choosing by proximity avoids picking an unrelated config elsewhere in the repo.
 */
export function findConfigDir(featurePath: string, projectRoot: string): string | undefined {
    const root = path.resolve(projectRoot);
    let current = path.dirname(path.resolve(featurePath));
    while (current.startsWith(root)) {
        if (hasConfig(current)) {
            return current;
        }
        if (current === root) {
            break;
        }
        current = path.dirname(current);
    }
    return CONVENTIONAL.map(item => path.join(root, item)).find(hasConfig);
}

export function discoverEnvironments(configDir: string | undefined, fallbackEnv?: string): string[] {
    const found = new Set<string>();
    if (fallbackEnv) {
        found.add(fallbackEnv);
    }
    if (configDir && fs.existsSync(configDir)) {
        for (const name of fs.readdirSync(configDir)) {
            const match = /^karate-config-([\w.-]+)\.js$/.exec(name);
            if (match) {
                found.add(match[1]);
            }
        }
        const main = path.join(configDir, 'karate-config.js');
        if (fs.existsSync(main)) {
            let text = '';
            try {
                text = fs.readFileSync(main, 'utf8').slice(0, 512 * 1024);
            } catch {
                text = '';
            }
            for (const match of text.matchAll(/\benv\s*(?:==|===)\s*['"]([\w.-]+)['"]/g)) {
                found.add(match[1]);
            }
            for (const match of text.matchAll(/\bcase\s+['"]([\w.-]+)['"]\s*:/g)) {
                found.add(match[1]);
            }
        }
    }
    return Array.from(found).sort();
}
