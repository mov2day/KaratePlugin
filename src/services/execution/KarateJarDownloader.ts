import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';

/** Pinned SHA-256 of release jars the extension knows; other versions download unverified (the user chose them). */
export const KNOWN_JAR_SHA256: Record<string, string> = {
    '1.5.0.RC3': 'a685a8c2eae4c1982f5d46071d72a8d98b1212f71774551edb0539c1b6ac3e9a'
};

const MAX_REDIRECTS = 5;

export function karateJarUrl(version: string): string {
    return `https://github.com/karatelabs/karate/releases/download/v${version}/karate-${version}.jar`;
}

/** True only for versions that are safe to place in a URL and file name. */
export function isSafeVersion(version: string): boolean {
    return /^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(version);
}

/**
 * Downloads `url` over https to `dest` via a `.part` file, verifying SHA-256 when given, then renames atomically.
 * Rejects non-https redirects. A failed or mismatched download never leaves `dest` behind.
 */
export function downloadVerified(
    url: string,
    dest: string,
    expectedSha256: string | undefined,
    onProgress?: (downloaded: number, total: number) => void,
    redirects = 0
): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!url.startsWith('https://')) { reject(new Error('Refusing non-https download')); return; }
        const part = `${dest}.part`;
        const fail = (error: Error) => { try { fs.unlinkSync(part); } catch { /* best effort */ } reject(error); };
        https.get(url, response => {
            const status = response.statusCode ?? 0;
            if ([301, 302, 303, 307, 308].includes(status)) {
                response.resume();
                const next = response.headers.location;
                if (!next || redirects >= MAX_REDIRECTS) { fail(new Error('Too many or invalid redirects')); return; }
                downloadVerified(new URL(next, url).toString(), dest, expectedSha256, onProgress, redirects + 1).then(resolve, reject);
                return;
            }
            if (status !== 200) { response.resume(); fail(new Error(`HTTP ${status} downloading ${url}`)); return; }
            const total = parseInt(response.headers['content-length'] || '0', 10);
            const hash = crypto.createHash('sha256');
            const file = fs.createWriteStream(part);
            let downloaded = 0;
            response.on('data', (chunk: Buffer) => {
                downloaded += chunk.length;
                hash.update(chunk);
                onProgress?.(downloaded, total);
            });
            response.on('error', fail);
            file.on('error', fail);
            file.on('finish', () => {
                const actual = hash.digest('hex');
                if (downloaded === 0) { fail(new Error('Downloaded file is empty')); return; }
                if (expectedSha256 && actual !== expectedSha256) {
                    fail(new Error(`SHA-256 mismatch for ${url}: expected ${expectedSha256}, got ${actual}`));
                    return;
                }
                try { fs.renameSync(part, dest); resolve(); } catch (error) { fail(error as Error); }
            });
            response.pipe(file);
        }).on('error', fail);
    });
}
