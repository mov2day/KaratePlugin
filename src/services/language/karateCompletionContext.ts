/** Pure completion-context detection from the text before the cursor. No vscode import. */

export const STEP_KEYWORDS: ReadonlyArray<{ label: string; detail: string }> = [
    { label: 'url', detail: 'Set the base URL' },
    { label: 'path', detail: 'Append path segments' },
    { label: 'method', detail: 'Send the HTTP request' },
    { label: 'status', detail: 'Assert the response status' },
    { label: 'param', detail: 'Add a query parameter' },
    { label: 'params', detail: 'Add query parameters from a JSON object' },
    { label: 'header', detail: 'Add a request header' },
    { label: 'headers', detail: 'Add request headers from a JSON object' },
    { label: 'cookie', detail: 'Add a request cookie' },
    { label: 'cookies', detail: 'Add request cookies' },
    { label: 'form field', detail: 'Add a form field' },
    { label: 'request', detail: 'Set the request body' },
    { label: 'def', detail: 'Define a variable' },
    { label: 'text', detail: 'Define a text variable' },
    { label: 'yaml', detail: 'Define a YAML variable' },
    { label: 'csv', detail: 'Define a CSV variable' },
    { label: 'string', detail: 'Define a string variable' },
    { label: 'json', detail: 'Convert to JSON' },
    { label: 'xml', detail: 'Convert to XML' },
    { label: 'xmlstring', detail: 'Convert XML to a string' },
    { label: 'bytes', detail: 'Define a bytes variable' },
    { label: 'copy', detail: 'Deep-copy a variable' },
    { label: 'table', detail: 'Define a data table' },
    { label: 'replace', detail: 'Replace placeholders in text' },
    { label: 'match', detail: 'Assert with the match operators' },
    { label: 'assert', detail: 'Assert a JavaScript expression' },
    { label: 'print', detail: 'Print a value to the log' },
    { label: 'call', detail: 'Call a feature or function' },
    { label: 'callonce', detail: 'Call once per feature' },
    { label: 'configure', detail: 'Change a runtime setting' },
    { label: 'eval', detail: 'Evaluate JavaScript' },
    { label: 'retry until', detail: 'Retry the next request until true' },
    { label: 'soap action', detail: 'Send a SOAP request' },
    { label: 'multipart file', detail: 'Add a multipart file' },
    { label: 'multipart field', detail: 'Add a multipart field' },
    { label: 'listen', detail: 'Wait for an async event' }
];

export const MATCH_OPERATORS = ['==', '!=', 'contains', 'contains only', 'contains any', 'contains deep', '!contains', 'each', 'within'];

export const FUZZY_MARKERS = ['#string', '#number', '#boolean', '#array', '#object', '#null', '#notnull', '#present', '#notpresent', '#ignore', '#uuid', '#regex', '#date', '#datetime', '#[]', '#? '];

export type CompletionContext =
    | { kind: 'keyword' }
    | { kind: 'operator' }
    | { kind: 'marker' }
    | { kind: 'path'; prefix: string; classpath: boolean }
    | { kind: 'none' };

const STEP_PREFIX = /^\s*(?:\*|Given|When|Then|And|But)\s+/;
const READ_OPEN = /read\(\s*(['"])([^'"]*)$/;

export function completionContext(linePrefix: string): CompletionContext {
    const read = READ_OPEN.exec(linePrefix);
    if (read) {
        const typed = read[2];
        const classpath = typed.startsWith('classpath:');
        return { kind: 'path', prefix: classpath ? typed.slice('classpath:'.length) : typed, classpath };
    }
    const step = STEP_PREFIX.exec(linePrefix);
    if (!step) {
        return { kind: 'none' };
    }
    if (/#[\w[\]?]*$/.test(linePrefix)) {
        return { kind: 'marker' };
    }
    const rest = linePrefix.slice(step[0].length);
    if (/^match\s+\S+\s+\S*$/.test(rest)) {
        return { kind: 'operator' };
    }
    if (/^[a-z ]*$/.test(rest)) {
        return { kind: 'keyword' };
    }
    return { kind: 'none' };
}
