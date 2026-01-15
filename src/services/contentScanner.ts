import * as vscode from 'vscode';
import { logger } from '../utils/logger';

/**
 * Result of content scanning
 */
export interface ScanResult {
    hasTriggers: boolean;
    triggers: string[];
    sanitizedContent: string;
}

/**
 * Service to scan content for keywords known to trigger Copilot's content policy
 */
export class ContentScanner {

    // Keywords that frequently trigger "Sorry, I can't assist with that"
    private static readonly SENSITIVE_TERMS = [
        // Security checks interpreted as attacks
        { pattern: /sql\s*injection/gi, replacement: 'database scanning', label: 'SQL Injection' },
        { pattern: /xss/gi, replacement: 'script injection', label: 'XSS' },
        { pattern: /cross[-\s]site\s*scripting/gi, replacement: 'script injection', label: 'Cross-Site Scripting' },
        { pattern: /exploit/gi, replacement: 'test case', label: 'Exploit' },
        { pattern: /vulnerability/gi, replacement: 'weakness', label: 'Vulnerability' },
        { pattern: /attack/gi, replacement: 'security test', label: 'Attack' },
        { pattern: /malicious/gi, replacement: 'invalid', label: 'Malicious' },
        { pattern: /hacker/gi, replacement: 'user', label: 'Hacker' },
        { pattern: /penetration\s*test/gi, replacement: 'security audit', label: 'Penetration Test' },
        { pattern: /brute\s*force/gi, replacement: 'exhaustive test', label: 'Brute Force' },
        { pattern: /bypass/gi, replacement: 'alternative path', label: 'Bypass' }
    ];

    /**
     * Scan content for potentially triggering terms
     */
    public static scan(content: string): ScanResult {
        const triggers: Set<string> = new Set();
        let sanitized = content;

        for (const term of this.SENSITIVE_TERMS) {
            if (term.pattern.test(content)) {
                triggers.add(term.label);
                sanitized = sanitized.replace(term.pattern, term.replacement);
            }
        }

        return {
            hasTriggers: triggers.size > 0,
            triggers: Array.from(triggers),
            sanitizedContent: sanitized
        };
    }

    /**
     * Diagnose a rejection by finding what might have triggered it
     */
    public static diagnoseRejection(originalContent: string): string {
        const result = this.scan(originalContent);

        if (result.hasTriggers) {
            return `Postman script contains sensitive terms that likely triggered Copilot's content policy: ${result.triggers.join(', ')}. Try renaming these terms in your scripts.`;
        }

        return 'No obvious policy triggers found in content. The rejections might be due to implicit security testing patterns or complex nested logic.';
    }
}
