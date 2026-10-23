/** Bounded, side-effect-free compatibility check for generated Karate v2 syntax. */
const V2_CONSTRUCT = /\bkarate\.(?:sysprop|sysenv)\s*\(|@lock\s*=|\bconfigure\s+auth\b/i;
const MAX_INPUT = 1024 * 1024;

export function usesKarateV2Constructs(text: string): boolean {
    const bounded = text.slice(0, MAX_INPUT);
    const uncommented = bounded.replace(/^\s*#.*$/gm, '').replace(/^\s*\/\/.*$/gm, '');
    return V2_CONSTRUCT.test(uncommented);
}

export function karateV2Preflight(version: string, bundled: boolean, texts: Iterable<string>): string | undefined {
    const v1 = bundled || /^1(?:\.|$)/.test(version.trim());
    if (!v1) {return undefined;}
    for (const text of texts) {
        if (usesKarateV2Constructs(text)) {
            return `This feature/config uses Karate 2.x constructs, but the resolved Karate ${version} JAR is v1. Set karateDsl.execution.jarPath or karateDsl.execution.karateVersion to Karate 2.x and run with Java 21+.`;
        }
    }
    return undefined;
}
