// Minimal `vscode` stub so compiled extension classes can load under plain node.
const Module = require('module');
const stub = {
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }), workspaceFolders: undefined },
    Uri: { file: fsPath => ({ fsPath }) },
    window: { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }) },
    CancellationError: class CancellationError extends Error {}
};
let original;
function install() {
    if (original) return;
    original = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') return stub;
        return original.call(this, request, parent, isMain);
    };
}
function uninstall() { if (original) { Module._load = original; original = undefined; } }
module.exports = { install, uninstall, stub };
