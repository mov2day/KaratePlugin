import { ConfluencePage } from './confluenceClient';
import { ConfluenceTestData, ConfluenceTestCase } from '../types';
import { logger } from '../utils/logger';

export class ConfluenceParser {
    /**
     * Parse Confluence page content to extract test data
     */
    parsePageContent(page: ConfluencePage): ConfluenceTestData {
        const content = page.body.storage?.value || page.body.view?.value || '';

        return {
            requirements: this.extractRequirements(content),
            testCases: this.extractTestCases(content),
            flowSteps: this.extractFlowSteps(content)
        };
    }

    /**
     * Extract requirements from page content
     */
    private extractRequirements(content: string): string[] {
        const requirements: string[] = [];

        // Look for sections with "requirement" in heading
        const reqSectionRegex = /<h[1-6][^>]*>.*?requirement.*?<\/h[1-6]>(.*?)(?=<h[1-6]|$)/gis;
        const matches = content.matchAll(reqSectionRegex);

        for (const match of matches) {
            const sectionContent = match[1];

            // Extract list items
            const listItemRegex = /<li[^>]*>(.*?)<\/li>/gi;
            const items = sectionContent.matchAll(listItemRegex);

            for (const item of items) {
                const text = this.stripHtml(item[1]).trim();
                if (text) {
                    requirements.push(text);
                }
            }
        }

        logger.info(`Extracted ${requirements.length} requirements`);
        return requirements;
    }

    /**
     * Extract test cases from page content
     */
    private extractTestCases(content: string): ConfluenceTestCase[] {
        const testCases: ConfluenceTestCase[] = [];

        // Look for test case tables
        const tableRegex = /<table[^>]*>(.*?)<\/table>/gis;
        const tables = content.matchAll(tableRegex);

        for (const table of tables) {
            const tableContent = table[1];

            // Check if this is a test case table (has columns like "Test Case", "Steps", "Expected Result")
            if (this.isTestCaseTable(tableContent)) {
                const cases = this.parseTestCaseTable(tableContent);
                testCases.push(...cases);
            }
        }

        logger.info(`Extracted ${testCases.length} test cases`);
        return testCases;
    }

    /**
     * Extract flow steps from flowcharts/diagrams
     */
    private extractFlowSteps(content: string): string[] {
        const steps: string[] = [];

        // Look for Mermaid diagrams
        const mermaidRegex = /```mermaid(.*?)```/gis;
        const mermaidMatches = content.matchAll(mermaidRegex);

        for (const match of mermaidMatches) {
            const diagram = match[1];
            // Extract nodes from mermaid flowchart
            const nodeRegex = /\w+\[(.*?)\]/g;
            const nodes = diagram.matchAll(nodeRegex);

            for (const node of nodes) {
                const text = node[1].trim();
                if (text && !text.startsWith('Start') && !text.startsWith('End')) {
                    steps.push(text);
                }
            }
        }

        // Look for ordered lists that might represent flows
        const flowSectionRegex = /<h[1-6][^>]*>.*?(flow|process|steps).*?<\/h[1-6]>(.*?)(?=<h[1-6]|$)/gis;
        const flowMatches = content.matchAll(flowSectionRegex);

        for (const match of flowMatches) {
            const sectionContent = match[2];
            const listItemRegex = /<li[^>]*>(.*?)<\/li>/gi;
            const items = sectionContent.matchAll(listItemRegex);

            for (const item of items) {
                const text = this.stripHtml(item[1]).trim();
                if (text) {
                    steps.push(text);
                }
            }
        }

        logger.info(`Extracted ${steps.length} flow steps`);
        return steps;
    }

    /**
     * Check if table is a test case table
     */
    private isTestCaseTable(tableContent: string): boolean {
        const lowerContent = tableContent.toLowerCase();
        return (lowerContent.includes('test case') || lowerContent.includes('scenario')) &&
            (lowerContent.includes('steps') || lowerContent.includes('expected'));
    }

    /**
     * Parse test case table
     */
    private parseTestCaseTable(tableContent: string): ConfluenceTestCase[] {
        const testCases: ConfluenceTestCase[] = [];

        // Extract rows
        const rowRegex = /<tr[^>]*>(.*?)<\/tr>/gis;
        const rows = Array.from(tableContent.matchAll(rowRegex));

        if (rows.length < 2) {
            return testCases;
        }

        // Parse header to find column indices
        const headerRow = rows[0][1];
        const headerCells = Array.from(headerRow.matchAll(/<th[^>]*>(.*?)<\/th>/gi));

        const columns = headerCells.map(cell => this.stripHtml(cell[1]).toLowerCase().trim());
        const nameIdx = columns.findIndex(c => c.includes('test') || c.includes('scenario') || c.includes('name'));
        const stepsIdx = columns.findIndex(c => c.includes('steps') || c.includes('action'));
        const expectedIdx = columns.findIndex(c => c.includes('expected') || c.includes('result'));

        // Parse data rows
        for (let i = 1; i < rows.length; i++) {
            const rowContent = rows[i][1];
            const cells = Array.from(rowContent.matchAll(/<td[^>]*>(.*?)<\/td>/gis));

            if (cells.length > 0) {
                const testCase: ConfluenceTestCase = {
                    name: nameIdx >= 0 && cells[nameIdx] ? this.stripHtml(cells[nameIdx][1]).trim() : `Test Case ${i}`,
                    steps: [],
                    expectedResult: expectedIdx >= 0 && cells[expectedIdx] ? this.stripHtml(cells[expectedIdx][1]).trim() : undefined
                };

                if (stepsIdx >= 0 && cells[stepsIdx]) {
                    const stepsText = this.stripHtml(cells[stepsIdx][1]);
                    testCase.steps = stepsText.split(/\n|<br\s*\/?>/i)
                        .map(s => s.trim())
                        .filter(s => s.length > 0);
                }

                testCases.push(testCase);
            }
        }

        return testCases;
    }

    /**
     * Strip HTML tags from text
     */
    private stripHtml(html: string): string {
        return html
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/\s+/g, ' ')
            .trim();
    }
}
