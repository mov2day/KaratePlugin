export interface ScenarioIdentity {
    name: string;
    tags?: string[];
    line?: number;
}

export interface ScenarioMatch {
    startLine: number;
    tagStartLine: number;
    endLine: number;
    tags: string[];
}

/** Finds a complete Karate scenario by identity; it never chooses between ambiguous matches. */
export class ScenarioLocator {
    find(content: string, identity: ScenarioIdentity): ScenarioMatch | undefined {
        const lines = content.split(/\r?\n/);
        const matches: ScenarioMatch[] = [];
        for (let index = 0; index < lines.length; index++) {
            const header = lines[index].trim().match(/^Scenario(?: Outline)?:\s*(.+)$/);
            if (!header || header[1].trim() !== identity.name.trim()) continue;
            let tagStart = index;
            const tags: string[] = [];
            for (let preceding = index - 1; preceding >= 0; preceding--) {
                const value = lines[preceding].trim();
                if (value.startsWith('@')) {
                    tagStart = preceding;
                    tags.unshift(...value.split(/\s+/));
                } else if (value !== '') break;
            }
            let end = lines.length;
            for (let following = index + 1; following < lines.length; following++) {
                if (/^Scenario(?: Outline)?:\s*/.test(lines[following].trim())) {
                    end = following;
                    break;
                }
            }
            const lineMatches = identity.line === undefined || identity.line === index + 1;
            const tagsMatch = !identity.tags?.length || identity.tags.every(tag => tags.includes(tag));
            if (lineMatches && tagsMatch) matches.push({ startLine: index, tagStartLine: tagStart, endLine: end, tags });
        }
        return matches.length === 1 ? matches[0] : undefined;
    }

    replace(content: string, identity: ScenarioIdentity, replacement: string): string | undefined {
        const match = this.find(content, identity);
        if (!match) return undefined;
        const lines = content.split(/\r?\n/);
        return [...lines.slice(0, match.tagStartLine), replacement.trim(), '', ...lines.slice(match.endLine)].join('\n');
    }
}
