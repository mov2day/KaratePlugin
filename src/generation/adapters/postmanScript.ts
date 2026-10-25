// Pure Postman script/body conversion, shared by the legacy PostmanToKarateConverter and the generation adapter.
// No vscode, no logger, no I/O.
import type { PostmanBody } from '../../services/postmanParser';

/** Replace Postman variables `{{var}}` using a map of known values; unknown ones become `#(var)`. */
export function replaceVariables(text: string, variables: Map<string, string>): string {
    return text.replace(/\{\{([^}]{1,200})\}\}/g, (_match, varName: string) => {
        if (variables.has(varName)) {
            return variables.get(varName)!;
        }
        return `#(${varName})`;
    });
}

/** Add quotes to a value unless it is a Karate expression or a number. */
export function formatValue(value: string): string {
    if (value.startsWith('#(')) {
        return value;
    }
    if (!isNaN(Number(value))) {
        return value;
    }
    return `'${value}'`;
}

export function isJson(str: string): boolean {
    try {
        JSON.parse(str);
        return true;
    } catch {
        return false;
    }
}

/**
 * Convert a request body to Karate step lines. `subst` replaces `{{var}}` references inside body text
 * (the legacy converter substitutes literal values; the adapter emits `#(expr)` embedded expressions).
 */
export function convertBody(body: PostmanBody, subst: (text: string) => string): string[] {
    const lines: string[] = [];

    switch (body.mode) {
        case 'raw':
            if (body.raw) {
                const processedBody = subst(body.raw);

                if (body.options?.raw?.language === 'json' || isJson(processedBody)) {
                    try {
                        const jsonObj = JSON.parse(processedBody);
                        lines.push(`And request ${JSON.stringify(jsonObj, null, 2)}`);
                    } catch {
                        lines.push(`And request ${processedBody}`);
                    }
                } else {
                    lines.push(`And request ${formatValue(processedBody)}`);
                }
            }
            break;

        case 'urlencoded':
            if (body.urlencoded) {
                const formData: Record<string, string> = {};
                for (const param of body.urlencoded) {
                    if (!param.disabled) {
                        formData[param.key] = subst(param.value);
                    }
                }
                lines.push(`And form fields ${JSON.stringify(formData)}`);
            }
            break;

        case 'formdata':
            if (body.formdata) {
                const formData: Record<string, string> = {};
                for (const param of body.formdata) {
                    if (!param.disabled) {
                        if (param.type === 'file') {
                            lines.push(`And multipart file ${param.key} = { read: '${param.value}' }`);
                        } else {
                            formData[param.key] = subst(param.value);
                        }
                    }
                }
                if (Object.keys(formData).length > 0) {
                    lines.push(`And multipart fields ${JSON.stringify(formData)}`);
                }
            }
            break;
    }

    return lines;
}

// ---------------------------------------------------------------- test scripts

export interface ScriptAnalysis {
    /** Converted Karate lines (steps and, for legacy fallbacks, `#` comment lines). */
    lines: string[];
    /** Assertion-like script lines that could not be converted (an assertion was lost). */
    lostAssertions: string[];
    /** Every meaningful script line that could not be converted (superset of lostAssertions). */
    unsupported: string[];
    /** Variables the script defines with `* def`. */
    setVars: string[];
    /** Credential literals that were replaced by `karate.sysenv(...)` (names only, never values). */
    warnings: string[];
}

export const SECRET_NAME = /token|secret|password|passwd|apikey|api_key|api-key|authorization|bearer/i;
const NON_KARATE_JS = /\bpm\.|\bpostman\.|\bconsole\./;
const JWT = /^['"]?eyJ[\w-]+\.[\w-]+\.[\w-]+['"]?$/;
const AUTH_VALUE = /^['"](?:Bearer|Basic|Token)\s+\S+['"]$/i;
const STRING_OR_NUMBER = /^(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false)$/;
const envName = (name: string): string =>
    name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => w.toUpperCase()).join('_') || 'SECRET';

/**
 * Guard one converted line: `* def` values that call Postman/console APIs are unsupported, and credential
 * literals (secret-looking names, JWTs, Bearer/Basic strings) become `karate.sysenv(...)`. Returns null to drop the line.
 */
function guardDef(line: string, out: ScriptAnalysis): { line: string | null; unsupported: boolean } {
    const m = /^\* def ([^ ]+) = ([\s\S]*)$/.exec(line);
    if (!m) {return { line, unsupported: false };}
    const [, name, value] = m;
    if (NON_KARATE_JS.test(value)) {return { line: null, unsupported: true };}
    const literal = STRING_OR_NUMBER.test(value.trim());
    if (literal && (SECRET_NAME.test(name) || JWT.test(value.trim()) || AUTH_VALUE.test(value.trim()))) {
        out.warnings.push(`Script value assigned to "${name}" looks like a credential; replaced with karate.sysenv('${envName(name)}')`);
        return { line: `* def ${name} = karate.sysenv('${envName(name)}', '')`, unsupported: false };
    }
    return { line, unsupported: false };
}

const SET_CALL = /pm\.(?:environment|variables|globals|collectionVariables)\.set/;
const UNSUPPORTED_MARKERS = /pm\.sendRequest|setNextRequest|CryptoJS|\brequire\(|\batob\(|\bbtoa\(|xml2Json|\btv4\b|\bajv\b|pm\.visualizer|pm\.execution|\beval\(|setTimeout|postman\.setEnvironmentVariable|postman\.setGlobalVariable/;
const ASSERTION_LIKE = /pm\.expect\(|pm\.response\.to\.|pm\.assert|\.to\.(?:have|be|eql|equal|eq|include|contain|exist|not|deep|match)\b/;
const LITERAL_ARG = /^(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)$/;

const toKarateLiteral = (arg: string): string => (arg.startsWith('"') ? `'${arg.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'` : arg);

/** Convert JSON assertion from Postman to Karate */
export function convertJsonAssertion(line: string): string | null {
    // pm.expect(jsonData.id).to.eql(1) / .equal('x') / .eq(2)
    const eqlMatch = line.match(/jsonData((?:\.[\w$]+|\[\d+\]|\['[^']+'\]|\["[^"]+"\])*)\)\.to\.(?:deep\.)?(?:eql|equal|eq)\(([^)]+)\)/);
    if (eqlMatch && LITERAL_ARG.test(eqlMatch[2].trim())) {
        const lhs = eqlMatch[1] ? `response${eqlMatch[1]}` : 'response';
        return `And match ${lhs} == ${toKarateLiteral(eqlMatch[2].trim())}`;
    }

    // pm.expect(jsonData.name).to.be.a('string') / jsonData).to.be.an('array')
    const typeMatch = line.match(/jsonData((?:\.[\w$]+|\[\d+\])*)\)\.to\.be\.an?\(['"]([^'"]+)['"]\)/);
    if (typeMatch) {
        const types: Record<string, string> = { string: '#string', number: '#number', boolean: '#boolean', array: '#[]', object: '#object' };
        const lhs = typeMatch[1] ? `response${typeMatch[1]}` : 'response';
        return `And match ${lhs} == '${types[typeMatch[2]] ?? '#present'}'`;
    }

    // pm.expect(jsonData.id).to.exist
    const existMatch = line.match(/jsonData((?:\.[\w$]+|\[\d+\])+)\)\.to\.exist\b/);
    if (existMatch) {
        return `And match response${existMatch[1]} == '#present'`;
    }

    // pm.expect(jsonData.items).to.have.lengthOf(3)
    const lenMatch = line.match(/jsonData((?:\.[\w$]+|\[\d+\])*)\)\.to\.have\.(?:lengthOf|length)\((\d+)\)/);
    if (lenMatch) {
        return `And match response${lenMatch[1]} == '#[${lenMatch[2]}]'`;
    }

    // pm.expect(jsonData).to.have.property('x')
    const propMatch = line.match(/jsonData((?:\.[\w$]+|\[\d+\])*)\)\.to\.have\.property\(['"]([^'"]+)['"]\)/);
    if (propMatch) {
        return `And match response${propMatch[1]}.${propMatch[2]} == '#present'`;
    }

    return null;
}

/** Convert one (trimmed, normalised) test-script line; null when no rule matched. Branch order mirrors the legacy converter. */
function convertTestLine(trimmed: string): string[] | null {
    if (trimmed.includes('pm.response.to.have.status')) {
        const match = trimmed.match(/status\((\d+)\)/);
        return match ? [`Then status ${match[1]}`] : null;
    }
    const code = trimmed.match(/pm\.expect\(pm\.response\.code\)\.to\.(?:eql|equal|eq)\((\d+)\)/);
    if (code) {
        return [`Then status ${code[1]}`];
    }
    if (/pm\.response\.to\.be\.(?:ok|success)\b/.test(trimmed)) {
        return ['Then assert responseStatus >= 200 && responseStatus < 300'];
    }
    if (trimmed.includes('pm.expect(pm.response.responseTime)')) {
        const match = trimmed.match(/below\((\d+)\)/);
        return match ? [`And assert responseTime < ${match[1]}`] : null;
    }
    if (SET_CALL.test(trimmed) && (trimmed.includes('pm.response.json()') || trimmed.includes('jsonData'))) {
        const varMatch = trimmed.match(/\.set\(['"]([^'"]+)['"]\s*,\s*(?:pm\.response\.json\(\)|jsonData)\.([^)]+)\)/);
        if (varMatch) {
            const jsonPath = varMatch[2].replace(/\[['"]([^'"]+)['"]\]/g, '.$1');
            return [`* def ${varMatch[1]} = response.${jsonPath}`];
        }
        const simple = trimmed.match(/\.set\(['"]([^'"]+)['"]/);
        return simple ? [`# TODO: Extract ${simple[1]} from response`, `# Original: ${trimmed}`] : null;
    }
    if (SET_CALL.test(trimmed)) {
        const lit = trimmed.match(/\.set\(['"]([^'"]+)['"]\s*,\s*(.+?)\)\s*;?$/);
        if (lit && LITERAL_ARG.test(lit[2].trim())) {
            return [`* def ${lit[1]} = ${toKarateLiteral(lit[2].trim())}`];
        }
        return null;
    }
    const assign = trimmed.match(/(?:var|let|const)\s+(\w+)\s*=\s*(?:pm\.response\.json\(\)|jsonData)\.(\w+)/);
    if (assign) {
        return [`* def ${assign[1]} = response.${assign[2]}`];
    }
    if (trimmed.includes('pm.expect(') && (trimmed.includes('jsonData') || trimmed.includes('pm.response.json()'))) {
        const converted = convertJsonAssertion(trimmed);
        return converted ? [converted] : null;
    }
    if (trimmed.includes('.to.have.lengthOf')) {
        const lengthMatch = trimmed.match(/jsonData\.(\w+).*lengthOf\((\d+)\)/);
        return lengthMatch ? [`And match response.${lengthMatch[1]} == '#[${lengthMatch[2]}]'`] : null;
    }
    if (trimmed.includes('.to.have.property')) {
        const propMatch = trimmed.match(/\.to\.have\.property\(['"]([^'"]+)['"]\)/);
        return propMatch ? [`And match response.${propMatch[1]} == '#present'`] : null;
    }
    if (trimmed.includes('pm.response.to.have.header')) {
        const match = trimmed.match(/header\(['"]([^'"]+)['"]\)/);
        return match ? [`And match header ${match[1]} == '#present'`] : null;
    }
    if (trimmed.includes('pm.response.to.be.json')) {
        return ["And match header Content-Type contains 'json'"];
    }
    if (trimmed.includes('pm.response.text()') && trimmed.includes('include')) {
        const match = trimmed.match(/include\(['"]([^'"]+)['"]\)/);
        return match ? [`And match response contains '${match[1]}'`] : null;
    }
    return null;
}

const ALIAS_DECL = /^(?:var|let|const)\s+(\w+)\s*=\s*(?:pm\.response\.json\(\)|jsonData)\s*;?$/;

/** Analyse a Postman test script: converted lines plus what could not be converted. */
export function analyzeTestScript(script: string): ScriptAnalysis {
    const out: ScriptAnalysis = { lines: [], lostAssertions: [], unsupported: [], setVars: [], warnings: [] };
    const aliases = new Set<string>();
    for (const raw of script.split('\n')) {
        let trimmed = raw.trim();
        if (trimmed === '' || trimmed.startsWith('//')) {continue;}
        const alias = ALIAS_DECL.exec(trimmed);
        if (alias) {
            aliases.add(alias[1]);
            continue;
        }
        trimmed = trimmed.replace(/pm\.response\.json\(\)/g, 'jsonData');
        for (const a of aliases) {
            trimmed = trimmed.replace(new RegExp(`(?<![\\w.'"$])${a.replace(/\$/g, '\\$')}(?![\\w'"$])`, 'g'), 'jsonData');
        }
        const converted = convertTestLine(trimmed);
        if (converted && converted.length > 0) {
            for (const raw0 of converted) {
                const g = guardDef(raw0, out);
                if (g.line === null) {
                    out.unsupported.push(trimmed);
                    continue;
                }
                const l = g.line;
                out.lines.push(l);
                const def = /^\* def (\w+) =/.exec(l);
                if (def) {out.setVars.push(def[1]);}
                if (l.startsWith('# TODO')) {out.unsupported.push(trimmed);}
            }
            continue;
        }
        if (UNSUPPORTED_MARKERS.test(trimmed)) {
            out.unsupported.push(trimmed);
        } else if (ASSERTION_LIKE.test(trimmed)) {
            out.lostAssertions.push(trimmed);
            out.unsupported.push(trimmed);
        }
    }
    return out;
}

/** Legacy conversion: converted lines, or a default status plus the original script as comments. */
export function convertTestScript(script: string): string[] {
    const assertions = analyzeTestScript(script).lines;
    if (assertions.length === 0) {
        assertions.push('Then status 200');
        assertions.push('# Original Postman test script (not automatically converted):');
        assertions.push(...script.split('\n').map(l => `# ${l}`));
        assertions.push('# Tip: Enable Copilot for better script conversion');
    }
    return assertions;
}

// ---------------------------------------------------------------- pre-request scripts

/** One pre-request line: Karate lines, 'sendRequest' for pm.sendRequest, or null when no rule matched. */
function convertPreLine(trimmed: string): string[] | 'sendRequest' | null {
    if (trimmed.includes('pm.environment.set') || trimmed.includes('pm.variables.set') || trimmed.includes('pm.globals.set') || trimmed.includes('pm.collectionVariables.set')) {
        const match = trimmed.match(/\.set\(['"]([^'"]+)['"]\s*,\s*(.+)\)/);
        if (!match) {return [];}
        const key = match[1];
        let value = match[2].trim().replace(/;$/, '').replace(/^['"](.+)['"]$/, "'$1'");
        if (value.includes('Date.now()') || value.includes('new Date()')) {
            return [`* def ${key} = new java.util.Date().getTime()`];
        }
        if (value.includes('Math.random()')) {
            return [`* def ${key} = Math.random()`];
        }
        value = value.trim();
        return [`* def ${key} = ${value}`];
    }
    const decl = trimmed.match(/^(?:var|let|const)\s+(\w+)\s*=\s*(.+)/);
    if (decl) {
        const value = decl[2].replace(/;$/, '');
        if (value.includes('Date.now()')) {return [`* def ${decl[1]} = new java.util.Date().getTime()`];}
        if (value.includes('Math.random()')) {return [`* def ${decl[1]} = Math.random()`];}
        return [`* def ${decl[1]} = ${value}`];
    }
    if (trimmed.includes('$randomInt') || trimmed.includes('{{$randomInt}}')) {
        return ['* def randomInt = Math.floor(Math.random() * 1000)'];
    }
    if (trimmed.includes('$guid') || trimmed.includes('{{$guid}}') || /\buuid\b/i.test(trimmed)) {
        return ['* def randomId = java.util.UUID.randomUUID()'];
    }
    if (trimmed.includes('$timestamp') || trimmed.includes('{{$timestamp}}')) {
        return ['* def timestamp = new java.util.Date().getTime()'];
    }
    if (trimmed.includes('pm.sendRequest')) {
        return 'sendRequest';
    }
    return null;
}

/** Legacy pre-request conversion (kept verbatim in behaviour). */
export function convertPreRequestScript(script: string): string | null {
    const karateLines: string[] = [];
    for (const line of script.split('\n')) {
        const trimmed = line.trim();
        const r = convertPreLine(trimmed);
        if (r === 'sendRequest') {
            karateLines.push("# TODO: Convert pm.sendRequest to Karate 'call' statement");
            karateLines.push(`# Original: ${trimmed}`);
        } else if (r) {
            karateLines.push(...r);
        }
    }
    if (karateLines.length === 0 && script.trim().length > 0) {
        karateLines.push('# Original pre-request script (not automatically converted):');
        karateLines.push(...script.split('\n').map(l => `# ${l}`));
        karateLines.push('# Tip: Enable Copilot for better script conversion');
    }
    return karateLines.length > 0 ? karateLines.join('\n') : null;
}

const balanced = (s: string): boolean => {
    let depth = 0;
    for (const ch of s.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '')) {
        if ('({['.includes(ch)) {depth++;}
        else if (')}]'.includes(ch)) {depth--;}
        if (depth < 0) {return false;}
    }
    return depth === 0;
};

/** Pre-request analysis for the adapter: only balanced `* def` lines are kept; the rest is reported as unsupported. */
export function analyzePreRequestScript(script: string): ScriptAnalysis {
    const out: ScriptAnalysis = { lines: [], lostAssertions: [], unsupported: [], setVars: [], warnings: [] };
    for (const raw of script.split('\n')) {
        const trimmed = raw.trim();
        if (trimmed === '' || trimmed.startsWith('//')) {continue;}
        const r = convertPreLine(trimmed);
        if (r === 'sendRequest') {
            out.unsupported.push(trimmed);
        } else if (r && r.length > 0) {
            if (r.every(balanced)) {
                for (const raw0 of r) {
                    const g = guardDef(raw0, out);
                    if (g.line === null) {
                        out.unsupported.push(trimmed);
                        continue;
                    }
                    const l = g.line;
                    out.lines.push(l);
                    const def = /^\* def (\w+) =/.exec(l);
                    if (def) {out.setVars.push(def[1]);}
                }
            } else {
                out.unsupported.push(trimmed);
            }
        } else if (r) {
            out.unsupported.push(trimmed); // matched a rule but produced nothing
        } else if (UNSUPPORTED_MARKERS.test(trimmed) || /\bpm\./.test(trimmed)) {
            out.unsupported.push(trimmed);
        }
    }
    return out;
}
