import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { KarateStyle } from '../types';
import { logger } from '../utils/logger';

/**
 * Resolves workspace-shared Karate style config from settings.
 * Precedence integration is handled by callers.
 */
export class SharedStyleService {
    private static warnedPaths = new Set<string>();

    static loadSharedStyle(): KarateStyle | null {
        const config = vscode.workspace.getConfiguration('karateDsl');
        const rawPath = config.get<string>('generation.sharedStylePath', '').trim();
        if (!rawPath) {
            return null;
        }

        const resolvedPath = this.resolvePath(rawPath);
        if (!resolvedPath) {
            return null;
        }

        if (!fs.existsSync(resolvedPath)) {
            this.warnOnce(resolvedPath, `Shared style file not found: ${resolvedPath}`);
            return null;
        }

        try {
            const text = fs.readFileSync(resolvedPath, 'utf-8');
            const parsed = JSON.parse(text) as Partial<KarateStyle>;
            const validated = this.validate(parsed);
            if (!validated) {
                this.warnOnce(resolvedPath, `Invalid shared style file: ${resolvedPath}`);
                return null;
            }

            logger.info(`SharedStyleService: loaded style from ${resolvedPath}`);
            return validated;
        } catch (error) {
            logger.warn(`SharedStyleService: failed to load ${resolvedPath}`, error as Error);
            this.warnOnce(resolvedPath, `Failed to parse shared style file: ${resolvedPath}`);
            return null;
        }
    }

    private static resolvePath(configPath: string): string | null {
        if (path.isAbsolute(configPath)) {
            return configPath;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            vscode.window.showWarningMessage('Shared style path is set but no workspace is open.');
            return null;
        }

        return path.join(workspaceRoot, configPath);
    }

    private static validate(style: Partial<KarateStyle>): KarateStyle | null {
        if (!style || typeof style !== 'object') {
            return null;
        }

        const indentation = typeof style.indentation === 'string' && style.indentation.length > 0
            ? style.indentation
            : null;
        const variableCase = style.variableCase === 'camelCase' || style.variableCase === 'snake_case'
            ? style.variableCase
            : null;
        const commentStyle = style.commentStyle === 'hash' || style.commentStyle === 'doubleSlash'
            ? style.commentStyle
            : null;
        const lineSpacing = typeof style.lineSpacing === 'number' && style.lineSpacing >= 0
            ? style.lineSpacing
            : null;

        if (!indentation || !variableCase || !commentStyle || lineSpacing === null) {
            return null;
        }

        return {
            indentation,
            variableCase,
            commentStyle,
            lineSpacing
        };
    }

    private static warnOnce(key: string, message: string): void {
        if (this.warnedPaths.has(key)) {
            return;
        }
        this.warnedPaths.add(key);
        vscode.window.showWarningMessage(message);
    }
}

