const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { fixture } = require('./support/golden.cjs');
const { stub } = require('./support/vscode-stub.cjs');

const out = rel => require('../../out/' + rel);
const repo = path.resolve(__dirname, '..', '..');

const context = () => {
    const state = {};
    return {
        extensionPath: repo,
        extension: { packageJSON: { version: '9.9.9' } },
        workspaceState: { get: (k, d) => state[k] ?? d, update: async (k, v) => { state[k] = v; } },
        globalState: { get: (_k, d) => d, update: async () => {} },
        subscriptions: []
    };
};
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

async function importInto(options, outSub = 'src/test/karate') {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'karate-postman-'));
    stub.workspace.workspaceFolders = [{ uri: { fsPath: ws } }];
    try {
        const { PostmanImportService } = out('services/postmanImportService');
        const outputDir = path.join(ws, outSub);
        const result = await new PostmanImportService(context()).importCollection(
            fixture('postman', 'collection.json'), outputDir,
            { preserveFolders: true, convertScripts: true, includeAuth: true, useCopilot: false, environmentFile: fixture('postman', 'environment.json'), ...options });
        return { ws, outputDir, result, files: walk(ws).map(f => path.relative(ws, f).split(path.sep).join('/')) };
    } finally {
        stub.workspace.workspaceFolders = undefined;
    }
}

module.exports = [
    {
        name: 'postman import: folder path runs the pipeline, honours outputDir and writes config without secrets',
        async run() {
            const r = await importInto({});
            assert.equal(r.result.success, true, r.result.warnings.join('; '));
            assert.equal(r.result.featuresCreated, 1);
            assert.deepEqual(r.result.createdFiles.map(f => path.relative(r.ws, f).split(path.sep).join('/')), ['src/test/karate/pets/pets.feature']);
            assert.ok(r.files.includes('src/test/java/karate-config.js'));
            assert.ok(r.files.includes('src/test/java/common/auth.feature'));
            const all = r.files.map(f => fs.readFileSync(path.join(r.ws, f), 'utf8')).join('\n');
            assert.ok(!all.includes('test-token'));
            assert.ok(!fs.readFileSync(path.join(r.ws, 'src/test/karate/pets/pets.feature'), 'utf8').includes('localhost'));
        }
    },
    {
        name: 'postman import: an explicit outputDir elsewhere in the workspace is used for features',
        async run() {
            const r = await importInto({}, 'tests/api');
            assert.equal(r.result.success, true, r.result.warnings.join('; '));
            assert.ok(r.files.includes('tests/api/pets/pets.feature'), r.files.join(','));
            assert.ok(!r.files.some(f => f.startsWith('src/test/karate/')));
        }
    },
    {
        name: 'postman import: preserveFolders false writes a single collection feature',
        async run() {
            const r = await importInto({ preserveFolders: false });
            assert.equal(r.result.success, true, r.result.warnings.join('; '));
            assert.deepEqual(r.files.filter(f => f.endsWith('.feature') && f.startsWith('src/test/karate')), ['src/test/karate/pet-store-collection.feature']);
        }
    },
    {
        name: 'postman import: includeAuth false drops auth wiring',
        async run() {
            const r = await importInto({ includeAuth: false });
            assert.equal(r.result.success, true, r.result.warnings.join('; '));
            assert.ok(!r.files.includes('src/test/java/common/auth.feature'));
        }
    },
    {
        name: 'postman import: cancellation before generation throws CancellationError and writes nothing',
        async run() {
            const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'karate-postman-'));
            stub.workspace.workspaceFolders = [{ uri: { fsPath: ws } }];
            try {
                const { PostmanImportService } = out('services/postmanImportService');
                await assert.rejects(
                    new PostmanImportService(context()).importCollection(fixture('postman', 'collection.json'), path.join(ws, 'k'), undefined, { isCancellationRequested: true }),
                    e => e instanceof stub.CancellationError
                );
                assert.deepEqual(walk(ws), []);
            } finally {
                stub.workspace.workspaceFolders = undefined;
            }
        }
    }
];
