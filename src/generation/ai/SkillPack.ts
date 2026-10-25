import type { FsLike } from '../config/ProjectDiscovery';
import type { SourceKind } from '../model/TestModel';
import type { AITask } from '../../services/ai/AIProvider';

export interface ManifestEntry {
    id: string;
    file: string;
    appliesTo: { modes: SourceKind[] | '*'; tasks: AITask[] | '*' };
    /** Lower numbers are rendered first and dropped last. */
    priority: number;
    budgetChars: number;
    verifiedAgainst: string;
    rules: string[];
}

export interface SkillQuery {
    mode: SourceKind;
    task: AITask;
}

export interface SkillSelection {
    text: string;
    /** Skill ids that contribute text, in priority order. */
    included: string[];
    /** Skill ids that were applicable but lost at least one section (or all of them) to a budget. */
    trimmed: string[];
}

export interface SelectOptions {
    budgetChars?: number;
}

export const DEFAULT_TOTAL_BUDGET = 16_000;
/** Extra characters the user's own workspace skills may add after the pack. */
export const USER_SKILL_ALLOWANCE = 2_000;

interface Section {
    heading: string;
    text: string;
}

interface LoadedSkill {
    entry: ManifestEntry;
    name: string;
    sections: Section[];
}

const RULES_HEADING = '## Rules';

/** Split a markdown body on `## ` headings; fences are opaque so a `## ` inside a code block never splits. */
function splitSections(body: string): Section[] {
    const sections: Section[] = [{ heading: '', text: '' }];
    let inFence = false;
    for (const line of body.split('\n')) {
        if (/^\s*```/.test(line)) {inFence = !inFence;}
        if (!inFence && /^## /.test(line)) {sections.push({ heading: line.trim(), text: '' });}
        const current = sections[sections.length - 1];
        current.text += (current.text ? '\n' : '') + line;
    }
    return sections.map(s => ({ heading: s.heading, text: s.text.replace(/\s+$/, '') })).filter(s => s.text.length > 0);
}

function parseSkill(entry: ManifestEntry, raw: string): LoadedSkill {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
    const name = fm ? /^name:\s*(.+)$/m.exec(fm[1])?.[1].trim() ?? entry.id : entry.id;
    const body = (fm ? raw.slice(fm[0].length) : raw).replace(/\r\n/g, '\n');
    return { entry, name, sections: splitSections(body) };
}

function matches(entry: ManifestEntry, q: SkillQuery): boolean {
    const { modes, tasks } = entry.appliesTo;
    return (modes === '*' || modes.includes(q.mode)) && (tasks === '*' || tasks.includes(q.task));
}

/** Indices of droppable sections, cheapest first: later non-Rules sections, then Rules. The preamble (index 0 without heading) stays. */
function dropOrder(sections: Section[]): number[] {
    const idx = sections.map((s, i) => i).filter(i => sections[i].heading !== '');
    const other = idx.filter(i => sections[i].heading !== RULES_HEADING).reverse();
    const rules = idx.filter(i => sections[i].heading === RULES_HEADING);
    return [...other, ...rules];
}

function render(skill: LoadedSkill, kept: boolean[]): string {
    const parts = skill.sections.filter((_, i) => kept[i]).map(s => s.text);
    return parts.length ? `# ${skill.name}\n${parts.join('\n\n')}` : '';
}

export class SkillPack {
    private readonly skills: LoadedSkill[];

    constructor(skills: LoadedSkill[]) {
        this.skills = skills;
    }

    /** Ids of every skill in the pack, selected or not. */
    skillIds(): string[] {
        return this.skills.map(s => s.entry.id);
    }

    /** Sorted union of the rule ids declared by the manifest. */
    ruleIds(): string[] {
        return [...new Set(this.skills.flatMap(s => s.entry.rules))].sort();
    }

    select(q: SkillQuery, options: SelectOptions = {}): SkillSelection {
        const budget = options.budgetChars ?? DEFAULT_TOTAL_BUDGET;
        const chosen = this.skills
            .filter(s => matches(s.entry, q))
            .sort((a, b) => a.entry.priority - b.entry.priority || a.entry.id.localeCompare(b.entry.id));
        const kept = chosen.map(s => s.sections.map(() => true));
        const trimmed = new Set<string>();

        const lengthOf = (i: number): number => render(chosen[i], kept[i]).length;
        const dropOne = (i: number): boolean => {
            for (const sectionIdx of dropOrder(chosen[i].sections)) {
                if (!kept[i][sectionIdx]) {continue;}
                kept[i][sectionIdx] = false;
                trimmed.add(chosen[i].entry.id);
                // Nothing but the preamble left: drop the whole skill.
                if (chosen[i].sections.every((s, k) => s.heading === '' || !kept[i][k])) {kept[i] = kept[i].map(() => false);}
                return true;
            }
            if (kept[i].some(Boolean)) {
                kept[i] = kept[i].map(() => false);
                trimmed.add(chosen[i].entry.id);
                return true;
            }
            return false;
        };

        // Per-skill budget first.
        chosen.forEach((s, i) => { while (lengthOf(i) > s.entry.budgetChars && dropOne(i)) { /* keep dropping */ } });

        const total = (): number => {
            const parts = chosen.map((_, i) => render(chosen[i], kept[i])).filter(Boolean);
            return parts.join('\n\n').length;
        };
        // Then the total budget: lowest-priority skills lose sections first.
        for (let i = chosen.length - 1; i >= 0 && total() > budget; i--) {
            while (total() > budget && dropOne(i)) { /* keep dropping */ }
        }

        const included: string[] = [];
        const parts: string[] = [];
        chosen.forEach((s, i) => {
            const text = render(s, kept[i]);
            if (!text) {return;}
            included.push(s.entry.id);
            parts.push(text);
        });
        let text = parts.join('\n\n');
        if (text.length > budget || !text) {
            // Even fully trimmed nothing fits: fall back to the highest-priority Rules sections that do.
            included.length = 0;
            text = '';
            for (const s of chosen) {
                const rules = s.sections.find(sec => sec.heading === RULES_HEADING);
                if (!rules) {continue;}
                const piece = `# ${s.name}\n${rules.text}`;
                const next = text ? `${text}\n\n${piece}` : piece;
                if (next.length > budget) {continue;}
                text = next;
                included.push(s.entry.id);
                trimmed.add(s.entry.id);
            }
        }
        return { text, included, trimmed: [...trimmed] };
    }
}

export function loadSkillPack(dir: string, fsApi: FsLike): SkillPack {
    const manifestPath = `${dir}/manifest.json`;
    if (!fsApi.exists(manifestPath)) {throw new Error(`Skill manifest not found: ${manifestPath}`);}
    let manifest: { skills?: ManifestEntry[] };
    try {
        manifest = JSON.parse(fsApi.read(manifestPath));
    } catch (error) {
        throw new Error(`Skill manifest is not valid JSON: ${manifestPath} (${(error as Error).message})`);
    }
    const skills: LoadedSkill[] = [];
    for (const entry of manifest.skills ?? []) {
        const file = `${dir}/${entry.file}`;
        if (!fsApi.exists(file)) {continue;}
        skills.push(parseSkill(entry, fsApi.read(file)));
    }
    return new SkillPack(skills);
}

export interface UserSkill {
    name: string;
    content: string;
}

/** Cut `text` to at most `max` chars at a line boundary without leaving a code fence open. */
function truncateSafely(text: string, max: number): string {
    if (text.length <= max) {return text;}
    let cut = text.slice(0, Math.max(0, max));
    const nl = cut.lastIndexOf('\n');
    if (nl >= 0) {cut = cut.slice(0, nl);}
    const lines = cut.split('\n');
    let open = -1;
    lines.forEach((line, i) => { if (/^\s*```/.test(line)) {open = open < 0 ? i : -1;} });
    if (open >= 0) {cut = lines.slice(0, open).join('\n');}
    return cut.replace(/\s+$/, '');
}

/**
 * Append the user's own workspace skills after the pack text, adding at most `allowance` characters in total.
 * The pack text is returned untouched and is never truncated or displaced.
 */
export function appendUserSkills(packText: string, userSkills: UserSkill[], allowance: number = USER_SKILL_ALLOWANCE): string {
    let out = packText;
    const limit = packText.length + allowance;
    for (const skill of userSkills) {
        const header = `\n\n# ${skill.name} (workspace skill)\n`;
        const room = limit - out.length - header.length;
        if (room <= 0) {break;}
        const body = truncateSafely(skill.content.trim(), room);
        if (!body) {continue;}
        out += header + body;
    }
    return out;
}
