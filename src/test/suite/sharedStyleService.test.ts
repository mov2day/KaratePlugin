import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { GenerationService } from '../../services/GenerationService';
import { SharedStyleService } from '../../services/SharedStyleService';
import { KarateStyle } from '../../types';

suite('SharedStyleService + Generation Precedence', () => {
    test('shared style overrides learned local style when both exist', () => {
        const sharedStyle: KarateStyle = {
            indentation: '    ',
            variableCase: 'snake_case',
            commentStyle: 'doubleSlash',
            lineSpacing: 2
        };
        const learnedStyle: KarateStyle = {
            indentation: '  ',
            variableCase: 'camelCase',
            commentStyle: 'hash',
            lineSpacing: 1
        };

        const originalLoadSharedStyle = SharedStyleService.loadSharedStyle;
        (SharedStyleService as any).loadSharedStyle = () => sharedStyle;

        try {
            const service = new GenerationService({} as any, {} as any, {} as any);
            service.setLearnedStyle(learnedStyle);

            let appliedStyle: KarateStyle | null = null;
            const generatorMock = {
                setStyle: (style: KarateStyle) => {
                    appliedStyle = style;
                },
                setTemplate: () => {
                    // no-op
                }
            };

            (service as any).configureGenerator(generatorMock);
            assert.deepStrictEqual(appliedStyle, sharedStyle);
        } finally {
            (SharedStyleService as any).loadSharedStyle = originalLoadSharedStyle;
        }
    });

    test('invalid shared style JSON falls back safely (returns null)', () => {
        const workspaceAny = vscode.workspace as any;
        const windowAny = vscode.window as any;

        const originalGetConfiguration = workspaceAny.getConfiguration;
        const originalShowWarningMessage = windowAny.showWarningMessage;

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karate-shared-style-'));
        const invalidStyleFile = path.join(tempDir, '.karate-style.json');
        fs.writeFileSync(invalidStyleFile, '{ invalid json', 'utf-8');

        workspaceAny.getConfiguration = () => ({
            get: (key: string, defaultValue: unknown) => {
                if (key === 'generation.sharedStylePath') {
                    return invalidStyleFile;
                }
                return defaultValue;
            }
        });
        windowAny.showWarningMessage = () => Promise.resolve(undefined);

        try {
            const loaded = SharedStyleService.loadSharedStyle();
            assert.strictEqual(loaded, null);
        } finally {
            workspaceAny.getConfiguration = originalGetConfiguration;
            windowAny.showWarningMessage = originalShowWarningMessage;
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
