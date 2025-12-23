import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class FileUtils {
    /**
     * Ensure directory exists, create if it doesn't
     */
    static ensureDirectoryExists(dirPath: string): void {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    }

    /**
     * Write content to file
     */
    static writeFile(filePath: string, content: string): void {
        const dir = path.dirname(filePath);
        this.ensureDirectoryExists(dir);
        fs.writeFileSync(filePath, content, 'utf-8');
    }

    /**
     * Read file content
     */
    static readFile(filePath: string): string {
        return fs.readFileSync(filePath, 'utf-8');
    }

    /**
     * Generate unique filename if file already exists
     */
    static getUniqueFilename(filePath: string): string {
        if (!fs.existsSync(filePath)) {
            return filePath;
        }

        const dir = path.dirname(filePath);
        const ext = path.extname(filePath);
        const basename = path.basename(filePath, ext);

        let counter = 1;
        let newPath = path.join(dir, `${basename}_${counter}${ext}`);

        while (fs.existsSync(newPath)) {
            counter++;
            newPath = path.join(dir, `${basename}_${counter}${ext}`);
        }

        return newPath;
    }

    /**
     * Get workspace root path
     */
    static getWorkspaceRoot(): string | undefined {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            return workspaceFolders[0].uri.fsPath;
        }
        return undefined;
    }

    /**
     * Resolve output path from configuration
     */
    static resolveOutputPath(relativePath?: string): string {
        const workspaceRoot = this.getWorkspaceRoot();
        if (!workspaceRoot) {
            throw new Error('No workspace folder is open');
        }

        const config = vscode.workspace.getConfiguration('karateDsl');
        const configuredPath = relativePath || config.get<string>('outputPath', 'src/test/karate');

        return path.join(workspaceRoot, configuredPath);
    }
}
