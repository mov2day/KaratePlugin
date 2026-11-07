/** Pure helpers that decide when the free Karate language mode applies. No vscode import, so they are unit testable. */

export const KARATE_LANGUAGE_ID = 'karate-dsl';
export const OFFICIAL_LANGUAGE_ID = 'karate';
export const OFFICIAL_EXTENSION_ID = 'karatelabs.karate';

const CANDIDATE_LANGUAGE_IDS = new Set(['plaintext', 'feature', 'gherkin', 'cucumber']);
const KARATE_STEP = /^\s*(\*|Given|When|Then|And|But)\s+(url|path|method|status|def|match|request|header|param|call|callonce|configure|print)\b/;
const KARATE_API = /\bkarate\.\w+/;
const KARATE_CLASSPATH = /read\(\s*['"]classpath:/;

export function isKarateText(text: string): boolean {
    const lines = text.split(/\r?\n/, 300);
    return lines.some(line => KARATE_STEP.test(line) || KARATE_API.test(line) || KARATE_CLASSPATH.test(line));
}

export interface KarateModeInput {
    fileName: string;
    languageId: string;
    autoDetect: boolean;
    officialInstalled: boolean;
    workspaceHasKarateConfig: boolean;
    text: string;
}

export function shouldApplyKarateMode(input: KarateModeInput): boolean {
    return input.autoDetect
        && !input.officialInstalled
        && input.fileName.toLowerCase().endsWith('.feature')
        && CANDIDATE_LANGUAGE_IDS.has(input.languageId)
        && (input.workspaceHasKarateConfig || isKarateText(input.text));
}
