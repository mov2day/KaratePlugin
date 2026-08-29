const path = require('path');
const Module = require('module');
const Mocha = require('mocha');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return {
            workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
            Uri: { file: fsPath => ({ fsPath }) },
            window: { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }) },
            CancellationError: class CancellationError extends Error {}
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const mocha = new Mocha({ ui: 'tdd', color: true });
mocha.addFile(path.resolve(__dirname, '..', 'out', 'test', 'suite', 'executionEngine.test.js'));
mocha.run(failures => {
    Module._load = originalLoad;
    process.exitCode = failures ? 1 : 0;
});
