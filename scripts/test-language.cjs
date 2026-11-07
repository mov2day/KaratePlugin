const path = require('path');
const Module = require('module');
const Mocha = require('mocha');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return {};
    }
    return originalLoad.call(this, request, parent, isMain);
};

const mocha = new Mocha({ ui: 'tdd', color: true });
mocha.addFile(path.resolve(__dirname, '..', 'out', 'test', 'suite', 'karateLanguage.test.js'));
mocha.run(failures => {
    Module._load = originalLoad;
    process.exitCode = failures ? 1 : 0;
});
