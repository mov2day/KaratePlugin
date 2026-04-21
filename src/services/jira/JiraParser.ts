import { JiraIssue } from './JiraClient';
import { logger } from '../../utils/logger';

/**
 * Parsed test-relevant content from a Jira issue.
 */
export interface JiraTestContent {
    issueKey: string;
    summary: string;
    description: string;          // plain text from ADF
    acceptanceCriteria: string[];
    labels: string[];
    issueType: string;
}

/**
 * JiraParser — extracts scenario-relevant content from Jira issue JSON.
 * Handles Atlassian Document Format (ADF) conversion to plain text.
 */
export class JiraParser {

    /**
     * Parse a Jira issue into test-relevant content.
     */
    parse(issue: JiraIssue): JiraTestContent {
        const description = this.adfToText(issue.fields.description);
        const acceptanceCriteria = this.extractAcceptanceCriteria(description, issue);

        logger.info(`JiraParser: parsed ${issue.key} — ${acceptanceCriteria.length} acceptance criteria`);

        return {
            issueKey: issue.key,
            summary: issue.fields.summary || '',
            description,
            acceptanceCriteria,
            labels: issue.fields.labels || [],
            issueType: issue.fields.issuetype?.name || 'Task'
        };
    }

    /**
     * Convert Atlassian Document Format to plain text.
     */
    private adfToText(adf: any): string {
        if (!adf) {
            return '';
        }

        // If it's already a string, return it
        if (typeof adf === 'string') {
            return adf;
        }

        // ADF is a tree structure with content arrays
        if (adf.type === 'doc' && adf.content) {
            return this.processNodes(adf.content);
        }

        return JSON.stringify(adf);
    }

    private processNodes(nodes: any[]): string {
        if (!Array.isArray(nodes)) {
            return '';
        }

        return nodes.map(node => this.processNode(node)).join('\n');
    }

    private processNode(node: any): string {
        if (!node) {
            return '';
        }

        switch (node.type) {
            case 'paragraph':
                return this.processNodes(node.content || []);

            case 'text':
                return node.text || '';

            case 'heading':
                const headingText = this.processNodes(node.content || []);
                return headingText;

            case 'bulletList':
            case 'orderedList':
                return (node.content || []).map((item: any, i: number) => {
                    const text = this.processNodes(item.content || []);
                    return node.type === 'orderedList' ? `${i + 1}. ${text}` : `- ${text}`;
                }).join('\n');

            case 'listItem':
                return this.processNodes(node.content || []);

            case 'codeBlock':
                return this.processNodes(node.content || []);

            case 'table':
                return this.processNodes(node.content || []);

            case 'tableRow':
                return (node.content || []).map((cell: any) =>
                    this.processNodes(cell.content || [])
                ).join(' | ');

            case 'mention':
                return ''; // Strip @mentions

            case 'mediaSingle':
            case 'media':
                return ''; // Strip embedded media

            case 'inlineCard':
            case 'blockCard':
                return node.attrs?.url || '';

            case 'hardBreak':
                return '\n';

            default:
                if (node.content) {
                    return this.processNodes(node.content);
                }
                return node.text || '';
        }
    }

    /**
     * Extract acceptance criteria from description or dedicated field.
     */
    private extractAcceptanceCriteria(description: string, issue: JiraIssue): string[] {
        const criteria: string[] = [];

        // Check for custom acceptance_criteria field
        const customField = issue.fields.acceptance_criteria ||
            issue.fields.customfield_10001 || // Common custom field IDs
            issue.fields.customfield_10020;

        if (customField) {
            const customText = typeof customField === 'string'
                ? customField
                : this.adfToText(customField);

            criteria.push(...this.parseList(customText));
        }

        // Extract from description sections
        const acSection = this.extractSection(description, [
            'acceptance criteria',
            'ac:',
            'given/when/then',
            'expected behavior',
            'expected behaviour',
            'requirements'
        ]);

        if (acSection) {
            criteria.push(...this.parseList(acSection));
        }

        // If no structured AC found, use the whole description
        if (criteria.length === 0 && description.trim()) {
            // Split on newlines and filter meaningful lines
            const lines = description.split('\n')
                .map(l => l.trim())
                .filter(l => l.length > 10);  // Skip very short lines
            criteria.push(...lines.slice(0, 10));  // Max 10 criteria
        }

        return criteria;
    }

    /**
     * Extract a named section from text.
     */
    private extractSection(text: string, sectionNames: string[]): string | null {
        const lines = text.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const lower = lines[i].toLowerCase().trim();
            for (const name of sectionNames) {
                if (lower.includes(name)) {
                    // Collect lines until next section header or end
                    const sectionLines: string[] = [];
                    for (let j = i + 1; j < lines.length; j++) {
                        const nextLine = lines[j].trim();
                        // Stop at next section header (line ending with : or starting with #)
                        if (nextLine.endsWith(':') && nextLine.length < 50) {
                            break;
                        }
                        if (nextLine) {
                            sectionLines.push(nextLine);
                        }
                    }
                    if (sectionLines.length > 0) {
                        return sectionLines.join('\n');
                    }
                }
            }
        }

        return null;
    }

    /**
     * Parse a text block into list items.
     */
    private parseList(text: string): string[] {
        return text.split('\n')
            .map(l => l.trim())
            .map(l => l.replace(/^[-*•]\s*/, '').replace(/^\d+\.\s*/, ''))
            .filter(l => l.length > 3);
    }
}
