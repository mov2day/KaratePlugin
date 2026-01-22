import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

export interface SkillMetadata {
    name: string;
    description: string;
    path: string;
}

/**
 * Service to manage Agent Skills integration
 * Detects, loads, and provides context about available Karate skills
 */
export class AgentSkillsService {
    private static skillsCache: SkillMetadata[] | null = null;
    private static isSupported: boolean | null = null;

    /**
     * Check if Agent Skills are supported and enabled
     */
    static async isAgentSkillsAvailable(): Promise<boolean> {
        // Check cached result
        if (this.isSupported !== null) {
            return this.isSupported;
        }

        try {
            // Check VS Code version (requires 1.108+)
            const vscodeVersion = vscode.version;
            const [major, minor] = vscodeVersion.split('.').map(Number);

            if (major < 1 || (major === 1 && minor < 108)) {
                logger.info('Agent Skills require VS Code 1.108+, current version: ' + vscodeVersion);
                this.isSupported = false;
                return false;
            }

            // Check if user has enabled Agent Skills in extension settings
            const config = vscode.workspace.getConfiguration('karateDsl');
            const enabled = config.get<boolean>('agentSkills.enabled', true);

            if (!enabled) {
                logger.info('Agent Skills disabled in settings');
                this.isSupported = false;
                return false;
            }

            // Check if skills directory exists
            const skillsExist = await this.skillsDirectoryExists();

            this.isSupported = skillsExist;
            logger.info(`Agent Skills available: ${this.isSupported}`);
            return this.isSupported;

        } catch (error) {
            logger.error('Error checking Agent Skills availability', error as Error);
            this.isSupported = false;
            return false;
        }
    }

    /**
     * Check if .github/skills directory exists
     */
    private static async skillsDirectoryExists(): Promise<boolean> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return false;
        }

        const skillsPath = path.join(workspaceFolders[0].uri.fsPath, '.github', 'skills');
        return fs.existsSync(skillsPath);
    }

    /**
     * Get all available Agent Skills
     */
    static async getAvailableSkills(): Promise<SkillMetadata[]> {
        // Return cached skills if available
        if (this.skillsCache !== null) {
            return this.skillsCache;
        }

        const skills: SkillMetadata[] = [];

        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                return skills;
            }

            const skillsPath = path.join(workspaceFolders[0].uri.fsPath, '.github', 'skills');

            if (!fs.existsSync(skillsPath)) {
                return skills;
            }

            // Read all subdirectories in .github/skills
            const entries = fs.readdirSync(skillsPath, { withFileTypes: true });

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const skillPath = path.join(skillsPath, entry.name);
                    const skillFile = path.join(skillPath, 'SKILL.md');

                    if (fs.existsSync(skillFile)) {
                        const metadata = await this.parseSkillMetadata(skillFile);
                        if (metadata) {
                            skills.push({
                                ...metadata,
                                path: skillFile
                            });
                        }
                    }
                }
            }

            this.skillsCache = skills;
            logger.info(`Found ${skills.length} Agent Skills`);
            return skills;

        } catch (error) {
            logger.error('Error loading Agent Skills', error as Error);
            return skills;
        }
    }

    /**
     * Parse SKILL.md frontmatter to extract metadata
     */
    private static async parseSkillMetadata(skillPath: string): Promise<SkillMetadata | null> {
        try {
            const content = fs.readFileSync(skillPath, 'utf-8');

            // Parse YAML frontmatter
            const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
            if (!frontmatterMatch) {
                return null;
            }

            const frontmatter = frontmatterMatch[1];
            const nameMatch = frontmatter.match(/name:\s*(.+)/);
            const descMatch = frontmatter.match(/description:\s*(.+)/);

            if (!nameMatch || !descMatch) {
                return null;
            }

            return {
                name: nameMatch[1].trim(),
                description: descMatch[1].trim(),
                path: skillPath
            };

        } catch (error) {
            logger.error(`Error parsing skill metadata from ${skillPath}`, error as Error);
            return null;
        }
    }

    /**
     * Get relevant skills based on operation context
     */
    static async suggestRelevantSkills(context: {
        type: 'openapi' | 'postman' | 'confluence' | 'coverage' | 'general';
        hasSpec?: boolean;
        hasCollection?: boolean;
    }): Promise<string[]> {
        const skills = await this.getAvailableSkills();
        const relevant: string[] = [];

        switch (context.type) {
            case 'openapi':
                relevant.push('karate-test-generation', 'karate-api-testing', 'openapi-to-karate', 'karate-formatting-style');
                break;
            case 'postman':
                relevant.push('karate-test-generation', 'karate-api-testing', 'postman-to-karate', 'karate-formatting-style');
                break;
            case 'confluence':
                relevant.push('karate-test-generation', 'karate-api-testing', 'karate-formatting-style');
                break;
            case 'coverage':
                relevant.push('karate-test-generation', 'karate-api-testing', 'karate-advanced-patterns', 'karate-formatting-style');
                break;
            case 'general':
                relevant.push('karate-test-generation', 'karate-api-testing', 'karate-formatting-style');
                break;
        }

        // Filter to only include skills that actually exist
        const existingSkills = skills.map(s => s.name);
        return relevant.filter(name => existingSkills.includes(name));
    }

    /**
     * Build skill context string for Copilot prompt
     */
    static buildSkillContext(skillNames: string[]): string {
        if (skillNames.length === 0) {
            return '';
        }

        return `

AVAILABLE AGENT SKILLS:
You have access to specialized knowledge about Karate testing through the following skills:
${skillNames.map(name => `- ${name}: Refer to .github/skills/${name}/SKILL.md for guidance`).join('\n')}

Use these skills to generate accurate, best-practice Karate tests based on official documentation.
`;
    }

    /**
     * Get skill reference for prompts (shortened version)
     */
    static getSkillReference(skillName: string): string {
        return `Refer to the '${skillName}' skill for guidance.`;
    }

    /**
     * Clear skills cache (useful when skills are updated)
     */
    static clearCache(): void {
        this.skillsCache = null;
        this.isSupported = null;
        logger.info('Agent Skills cache cleared');
    }

    /**
     * Get status message for status bar
     */
    static async getStatusMessage(): Promise<string> {
        const available = await this.isAgentSkillsAvailable();
        if (!available) {
            return 'Agent Skills: Not Available';
        }

        const skills = await this.getAvailableSkills();
        return `Agent Skills: ${skills.length} Active`;
    }
}
