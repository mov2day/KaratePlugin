/** Where the cursor is inside a Karate line, to decide what to suggest. Pure, no vscode import. */

export type SmartContext =
    | { kind: 'keyword' }
    | { kind: 'operator' }
    | { kind: 'marker' }
    | { kind: 'path'; prefix: string; classpath: boolean }
    | { kind: 'tag'; typed: string }
    | { kind: 'karate-member'; typed: string }
    | { kind: 'member'; object: string; typed: string }
    | { kind: 'method'; typed: string }
    | { kind: 'status' }
    | { kind: 'header-name'; typed: string }
    | { kind: 'header-value'; header: string }
    | { kind: 'configure-key'; typed: string }
    | { kind: 'url-path'; typed: string }
    | { kind: 'expression'; typed: string }
    | { kind: 'none' };

const STEP_PREFIX = /^\s*(?:\*|Given|When|Then|And|But)\s+/;
const READ_OPEN = /read\(\s*(['"])([^'"]*)$/;
const EXPRESSION_KINDS = /^(?:def|url|path|match|request|print|assert|set|copy|call|callonce|eval|param|params|header|headers|cookie|cookies|form field|replace|text|json|string|xml|table|retry until|multipart file|multipart field)\b/;

export function smartContext(linePrefix: string): SmartContext {
    const read = READ_OPEN.exec(linePrefix);
    if (read) {
        const typed = read[2];
        const classpath = typed.startsWith('classpath:');
        return { kind: 'path', prefix: classpath ? typed.slice('classpath:'.length) : typed, classpath };
    }
    const tag = /^\s*@([\w.=-]*)$/.exec(linePrefix);
    if (tag) { return { kind: 'tag', typed: tag[1] }; }
    const step = STEP_PREFIX.exec(linePrefix);
    if (!step) { return { kind: 'none' }; }
    const rest = linePrefix.slice(step[0].length);

    const karate = /\bkarate\.(\w*)$/.exec(rest);
    if (karate) { return { kind: 'karate-member', typed: karate[1] }; }
    if (/#[\w[\]?]*$/.test(rest)) { return { kind: 'marker' }; }
    const member = /\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.(\w*)$/.exec(rest);
    if (member && member[1] !== 'karate' && EXPRESSION_KINDS.test(rest)) { return { kind: 'member', object: member[1], typed: member[2] }; }

    let m: RegExpExecArray | null;
    if ((m = /^method\s+(\w*)$/i.exec(rest))) { return { kind: 'method', typed: m[1] }; }
    if (/^status\s+\d*$/i.test(rest)) { return { kind: 'status' }; }
    if ((m = /^header\s+([\w-]+)\s*=\s*['"]?[^'"]*$/i.exec(rest))) { return { kind: 'header-value', header: m[1] }; }
    if ((m = /^header\s+([\w-]*)$/i.exec(rest))) { return { kind: 'header-name', typed: m[1] }; }
    if ((m = /^configure\s+(\w*)$/i.exec(rest))) { return { kind: 'configure-key', typed: m[1] }; }
    if ((m = /^path\s+(?:.*,\s*)?['"]([^'"]*)$/i.exec(rest))) { return { kind: 'url-path', typed: m[1] }; }
    if (/^match\s+\S+\s+\S*$/.test(rest)) { return { kind: 'operator' }; }
    if (/^(?:(?:form|retry|soap|multipart)\s+)?[a-z]*$/.test(rest)) { return { kind: 'keyword' }; }
    if (EXPRESSION_KINDS.test(rest)) {
        const typed = /([A-Za-z_]\w*)$/.exec(rest)?.[1] ?? '';
        if (typed || /(?:=|==|\(|,|:|\+|\b(?:request|print|assert|match|json|string|text|xml))\s*$/.test(rest)) { return { kind: 'expression', typed }; }
    }
    return { kind: 'none' };
}
