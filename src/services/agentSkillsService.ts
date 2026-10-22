import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { appendUserSkills, DEFAULT_TOTAL_BUDGET, loadSkillPack, SkillPack, USER_SKILL_ALLOWANCE } from '../generation/ai/SkillPack';
import type { UserSkill } from '../generation/ai/SkillPack';
import type { FsLike } from '../generation/config/ProjectDiscovery';
import type { SourceKind } from '../generation/model/TestModel';
import type { AITask } from './ai/AIProvider';

export type SkillContextType = 'openapi' | 'postman' | 'confluence' | 'combined' | 'coverage' | 'general';

const CONTEXT_TO_QUERY: Record<SkillContextType, { mode: SourceKind; task: AITask }> = {
    openapi: { mode: 'openapi', task: 'generate-openapi' },
    postman: { mode: 'postman', task: 'generate-postman' },
    confluence: { mode: 'confluence', task: 'generate-requirements' },
    combined: { mode: 'combined', task: 'generate-requirements' },
    coverage: { mode: 'openapi', task: 'analyze-coverage' },
    general: { mode: 'openapi', task: 'general' }
};

const nodeFs: FsLike = {
    exists: p => fs.existsSync(p),
    read: p => fs.readFileSync(p, 'utf-8'),
    list: d => fs.readdirSync(d)
};

export interface SkillMetadata {
    name: string;
    description: string;
    path: string;
}

/**
 * Service to manage Agent Skills integration
 * Loads bundled skills from extension's skills/ directory and workspace .github/skills/
 */
export class AgentSkillsService {
    private static skillsCache: SkillMetadata[] | null = null;
    private static skillContentCache: Map<string, string> = new Map();
    private static isSupported: boolean | null = null;
    private static extensionPath: string = '';
    /** Pack skills use DEFAULT_TOTAL_BUDGET; the user's workspace skills get a separate USER_SKILL_ALLOWANCE after them. */
    private static pack: SkillPack | null | undefined;

    /**
     * Set the extension path (called once during activation)
     */
    static setExtensionPath(extPath: string): void {
        this.extensionPath = extPath;
        logger.info(`AgentSkillsService: extension path set to ${extPath}`);
    }

    /**
     * Check if Agent Skills are supported and enabled
     */
    static async isAgentSkillsAvailable(): Promise<boolean> {
        // Check cached result
        if (this.isSupported !== null) {
            return this.isSupported;
        }

        try {
            // Check if user has enabled Agent Skills in extension settings
            const config = vscode.workspace.getConfiguration('karateDsl');
            const enabled = config.get<boolean>('agentSkills.enabled', true);

            if (!enabled) {
                logger.info('Agent Skills disabled in settings');
                this.isSupported = false;
                return false;
            }

            // Bundled skills are always available if extension path is set
            if (this.extensionPath) {
                const bundledPath = path.join(this.extensionPath, 'skills');
                if (fs.existsSync(bundledPath)) {
                    this.isSupported = true;
                    logger.info('Agent Skills available (bundled skills found)');
                    return true;
                }
            }

            // Fallback: check workspace .github/skills
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
     * Check if .github/skills directory exists in workspace
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
     * Get all available Agent Skills (bundled + workspace)
     */
    static async getAvailableSkills(): Promise<SkillMetadata[]> {
        // Return cached skills if available
        if (this.skillsCache !== null) {
            return this.skillsCache;
        }

        const skills: SkillMetadata[] = [];

        try {
            // 1. Load bundled skills from extension's skills/ directory
            if (this.extensionPath) {
                const bundledPath = path.join(this.extensionPath, 'skills');
                if (fs.existsSync(bundledPath)) {
                    const bundledSkills = await this.loadSkillsFromDirectory(bundledPath);
                    skills.push(...bundledSkills);
                    logger.info(`Loaded ${bundledSkills.length} bundled skills`);
                }
            }

            // 2. Load workspace skills from .github/skills/
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders.length > 0) {
                const workspaceSkillsPath = path.join(workspaceFolders[0].uri.fsPath, '.github', 'skills');
                if (fs.existsSync(workspaceSkillsPath)) {
                    const workspaceSkills = await this.loadSkillsFromDirectory(workspaceSkillsPath);
                    // Only add workspace skills that don't overlap with bundled ones
                    const bundledNames = new Set(skills.map(s => s.name));
                    for (const ws of workspaceSkills) {
                        if (!bundledNames.has(ws.name)) {
                            skills.push(ws);
                        }
                    }
                    logger.info(`Loaded ${workspaceSkills.length} workspace skills`);
                }
            }

            this.skillsCache = skills;
            logger.info(`Total Agent Skills available: ${skills.length}`);
            return skills;

        } catch (error) {
            logger.error('Error loading Agent Skills', error as Error);
            return skills;
        }
    }

    /**
     * Load skills from a directory — supports both flat .md files and subdirectories with SKILL.md
     */
    private static async loadSkillsFromDirectory(dirPath: string): Promise<SkillMetadata[]> {
        const skills: SkillMetadata[] = [];
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.isDirectory()) {
                // Subdirectory: look for SKILL.md
                const skillFile = path.join(dirPath, entry.name, 'SKILL.md');
                if (fs.existsSync(skillFile)) {
                    const metadata = await this.parseSkillMetadata(skillFile);
                    if (metadata) {
                        skills.push({ ...metadata, path: skillFile });
                    }
                }
            } else if (entry.isFile() && entry.name.endsWith('.md')) {
                // Flat .md file: parse frontmatter directly
                const skillFile = path.join(dirPath, entry.name);
                const metadata = await this.parseSkillMetadata(skillFile);
                if (metadata) {
                    skills.push({ ...metadata, path: skillFile });
                }
            }
        }

        return skills;
    }

    /**
     * Parse skill file frontmatter to extract metadata
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
     * Read the full content of a skill file (cached)
     */
    static readSkillContent(skillPath: string): string {
        if (this.skillContentCache.has(skillPath)) {
            return this.skillContentCache.get(skillPath)!;
        }

        try {
            const content = fs.readFileSync(skillPath, 'utf-8');
            // Strip frontmatter, return body only
            const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').trim();
            this.skillContentCache.set(skillPath, body);
            return body;
        } catch (error) {
            logger.error(`Error reading skill content from ${skillPath}`, error as Error);
            return '';
        }
    }

    /**
     * Load (once) the bundled, manifest-driven Karate v2 skill pack. Returns null when it is unavailable.
     */
    static getPack(): SkillPack | null {
        if (this.pack) {
            return this.pack;
        }
        // Only a loaded pack is cached: a null result before setExtensionPath() must not stick.
        if (this.extensionPath) {
            try {
                this.pack = loadSkillPack(path.join(this.extensionPath, 'skills'), nodeFs);
            } catch (error) {
                logger.error('Failed to load the Karate skill pack', error as Error);
            }
        }
        return this.pack ?? null;
    }

    /**
     * Get the names of the pack skills relevant to an operation context
     */
    static async suggestRelevantSkills(context: {
        type: SkillContextType;
        hasSpec?: boolean;
        hasCollection?: boolean;
    }): Promise<string[]> {
        const pack = this.getPack();
        if (!pack) {
            return [];
        }
        return pack.select(CONTEXT_TO_QUERY[context.type]).included;
    }

    /**
     * The user's own workspace skills (.github/skills). They never replace pack skills.
     */
    private static async loadUserSkills(packNames: Set<string>): Promise<UserSkill[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return [];
        }
        const dir = path.join(workspaceFolders[0].uri.fsPath, '.github', 'skills');
        if (!fs.existsSync(dir)) {
            return [];
        }
        const found = await this.loadSkillsFromDirectory(dir);
        return found
            .filter(skill => !packNames.has(skill.name))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(skill => ({ name: skill.name, content: this.readSkillContent(skill.path) }))
            .filter(skill => skill.content.length > 0);
    }

    /**
     * Build the skill context string for AI prompts: the selected Karate v2 pack skills, followed by the
     * user's workspace skills within their own small allowance.
     */
    static async buildSkillContextForPrompt(contextType: SkillContextType): Promise<string> {
        const pack = this.getPack();
        if (!pack) {
            return '';
        }

        const selection = pack.select(CONTEXT_TO_QUERY[contextType], { budgetChars: DEFAULT_TOTAL_BUDGET });
        if (!selection.text) {
            return '';
        }

        let body = selection.text;
        try {
            body = appendUserSkills(body, await this.loadUserSkills(new Set(pack.skillIds())), USER_SKILL_ALLOWANCE);
        } catch (error) {
            logger.error('Error loading workspace skills', error as Error);
        }

        return '\n\nKARATE TASK GUIDANCE\n'
            + 'Apply only the relevant rules below; preserve established workspace conventions.\n\n'
            + body
            + '\n\nEND KARATE TASK GUIDANCE\n';
    }

    /**
     * Build skill context string for Copilot prompt (legacy – returns reference-only)
     */
    static buildSkillContext(skillNames: string[]): string {
        if (skillNames.length === 0) {
            return '';
        }

        return `

AVAILABLE AGENT SKILLS:
You have access to specialized knowledge about Karate testing through the following skills:
${skillNames.map(name => `- ${name}`).join('\n')}

Use these skills to generate accurate, best-practice Karate tests.
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
        this.skillContentCache.clear();
        this.isSupported = null;
        this.pack = undefined;
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
