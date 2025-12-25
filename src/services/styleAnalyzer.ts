import * as fs from 'fs';

export interface KarateStyle {
    indentation: string;
    variableCase: 'camelCase' | 'snake_case';
    commentStyle: 'hash' | 'doubleSlash'; // Karate primarily uses # but some might use // for custom purposes if they wrap it
    lineSpacing: number;
}

export class StyleAnalyzer {
    /**
     * Analyze a Karate feature file and extract style patterns
     */
    public static analyze(filePath: string): KarateStyle {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split(/\r?\n/);

        return {
            indentation: this.detectIndentation(lines),
            variableCase: this.detectVariableCase(content),
            commentStyle: 'hash', // Standard Karate
            lineSpacing: this.detectLineSpacing(lines)
        };
    }

    private static detectIndentation(lines: string[]): string {
        for (const line of lines) {
            const match = line.match(/^(\s+)(?=\S)/);
            if (match && match[1]) {
                return match[1]; // Return first non-zero indentation found
            }
        }
        return '  '; // Default 2 spaces
    }

    private static detectVariableCase(content: string): 'camelCase' | 'snake_case' {
        const camelMatches = (content.match(/def\s+[a-z]+[A-Z][a-z]+/g) || []).length;
        const snakeMatches = (content.match(/def\s+[a-z]+_[a-z]+/g) || []).length;

        return camelMatches >= snakeMatches ? 'camelCase' : 'snake_case';
    }

    private static detectLineSpacing(lines: string[]): number {
        let maxSpacing = 1;
        let currentSpacing = 0;

        for (const line of lines) {
            if (line.trim() === '') {
                currentSpacing++;
            } else {
                if (currentSpacing > maxSpacing) {
                    maxSpacing = currentSpacing;
                }
                currentSpacing = 0;
            }
        }

        return Math.min(maxSpacing, 2); // Limit to 2 for sanity
    }
}
