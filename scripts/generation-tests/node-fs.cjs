const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mod = () => require('../../out/generation/vscode/NodeFs');

module.exports = [{
    name: 'node fs: a symlinked output directory escaping the workspace is rejected',
    run() {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'karate-node-fs-workspace-'));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'karate-node-fs-outside-'));
        try {
            try {
                fs.symlinkSync(outside, path.join(workspace, 'linked'), 'dir');
            } catch (error) {
                if (error && ['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {return;}
                throw error;
            }
            assert.throws(
                () => mod().workspaceNodeFs(workspace).write(path.join(workspace, 'linked', 'escaped.feature'), 'Feature: escaped\n'),
                /Refusing filesystem write outside real workspace root/
            );
            assert.equal(fs.existsSync(path.join(outside, 'escaped.feature')), false);
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
            fs.rmSync(outside, { recursive: true, force: true });
        }
    }
}];
