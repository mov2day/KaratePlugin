// Pure GraphQL schema reader (SDL text or introspection JSON). No vscode, no logger, no I/O.

/**
 * Parsed GraphQL field from SDL or introspection.
 */
export interface GraphQLField {
    name: string;
    type: 'Query' | 'Mutation' | 'Subscription';
    args: GraphQLArg[];
    /** Full type reference as written, for example `[Book!]!`. */
    returnType: string;
    /** Names of the selectable leaf fields of the return type (empty for scalar or enum returns and unknown types). */
    returnFields: string[];
    deprecated?: boolean;
}

export interface GraphQLArg {
    name: string;
    /** Type reference without one trailing `!` (see `required`), for example `[Int!]`. */
    type: string;
    required: boolean;
    /** Raw GraphQL literal, for example `10`, `"abc"` or `[1, 2]`. */
    defaultValue?: string;
}

export interface GraphQLTypeField {
    name: string;
    /** Full type reference as written, for example `[Book!]!`. */
    type: string;
    args: GraphQLArg[];
    deprecated?: boolean;
}

export interface GraphQLTypeDef {
    kind: 'object' | 'interface' | 'union' | 'enum' | 'input' | 'scalar';
    /** Object and interface fields, or the fields of an input object. */
    fields: GraphQLTypeField[];
    enumValues: string[];
    /** Union members. */
    possibleTypes: string[];
}

export interface GraphQLSchema {
    name: string;
    queries: GraphQLField[];
    mutations: GraphQLField[];
    subscriptions?: GraphQLField[];
    /** Every named type found in the source (absent only for hand-built schemas). */
    types?: Record<string, GraphQLTypeDef>;
}

export interface TypeRef {
    /** Named type, absent for a list. */
    name?: string;
    /** List element type. */
    list?: TypeRef;
    nonNull: boolean;
}

/** Parses `[Book!]!` into a structure. Unparseable input yields a nullable named `Unknown`. */
export function parseTypeRef(text: string): TypeRef {
    const go = (s: string): TypeRef => {
        const nonNull = s.endsWith('!');
        const body = nonNull ? s.slice(0, -1) : s;
        if (body.startsWith('[') && body.endsWith(']')) {return { list: go(body.slice(1, -1)), nonNull };}
        return { name: body || 'Unknown', nonNull };
    };
    return go(text.replace(/\s+/g, ''));
}

/** The innermost named type of a reference. */
export function namedType(text: string): string {
    let r = parseTypeRef(text);
    while (r.list) {r = r.list;}
    return r.name ?? 'Unknown';
}

export const BUILTIN_SCALARS = ['String', 'Int', 'Float', 'Boolean', 'ID'];

type RootKind = 'Query' | 'Mutation' | 'Subscription';

/**
 * GraphQLParser — extracts Query, Mutation and Subscription fields plus the type definitions from SDL or introspection JSON.
 * Subscriptions are collected only so that the generator can report them as unsupported.
 */
export class GraphQLParser {

    /** Parse from SDL string (.graphql / .gql content). */
    parseSDL(sdl: string): GraphQLSchema {
        const sc = new Scanner(sdl);
        const types: Record<string, GraphQLTypeDef> = {};
        const roots: Record<RootKind, string> = { Query: 'Query', Mutation: 'Mutation', Subscription: 'Subscription' };
        const ensure = (name: string, kind: GraphQLTypeDef['kind']): GraphQLTypeDef => {
            types[name] ??= { kind, fields: [], enumValues: [], possibleTypes: [] };
            return types[name];
        };

        while (!sc.eof()) {
            sc.skipIgnored();
            if (sc.eof()) {break;}
            if (sc.peek() === '"') {sc.readString(); continue;}
            let keyword = sc.readName();
            if (keyword === '') {sc.pos++; continue;}
            if (keyword === 'extend') {
                sc.skipIgnored();
                keyword = sc.readName();
            }
            switch (keyword) {
                case 'type':
                case 'interface': {
                    const name = sc.readNameSkipping();
                    sc.skipImplements();
                    sc.skipDirectives();
                    const def = ensure(name, keyword === 'type' ? 'object' : 'interface');
                    if (sc.peekAfterIgnored() === '{') {def.fields.push(...sc.readFieldBlock());}
                    break;
                }
                case 'input': {
                    const name = sc.readNameSkipping();
                    sc.skipDirectives();
                    const def = ensure(name, 'input');
                    if (sc.peekAfterIgnored() === '{') {def.fields.push(...sc.readFieldBlock(true));}
                    break;
                }
                case 'enum': {
                    const name = sc.readNameSkipping();
                    sc.skipDirectives();
                    const def = ensure(name, 'enum');
                    if (sc.peekAfterIgnored() === '{') {def.enumValues.push(...sc.readEnumBlock());}
                    break;
                }
                case 'union': {
                    const name = sc.readNameSkipping();
                    sc.skipDirectives();
                    const def = ensure(name, 'union');
                    if (sc.peekAfterIgnored() === '=') {
                        sc.pos = sc.indexAfterIgnored() + 1;
                        for (;;) {
                            sc.skipIgnored();
                            if (sc.peek() === '|') {sc.pos++; sc.skipIgnored();}
                            const member = sc.readName();
                            if (member === '') {break;}
                            def.possibleTypes.push(member);
                            const save = sc.pos;
                            sc.skipIgnored();
                            if (sc.peek() !== '|') {sc.pos = save; break;}
                        }
                    }
                    break;
                }
                case 'scalar': {
                    const name = sc.readNameSkipping();
                    sc.skipDirectives();
                    ensure(name, 'scalar');
                    break;
                }
                case 'schema': {
                    sc.skipDirectives();
                    if (sc.peekAfterIgnored() === '{') {
                        for (const f of sc.readFieldBlock(false, true)) {
                            const op = f.name === 'query' ? 'Query' : f.name === 'mutation' ? 'Mutation' : f.name === 'subscription' ? 'Subscription' : undefined;
                            if (op) {roots[op] = f.type;}
                        }
                    }
                    break;
                }
                case 'directive': {
                    sc.skipIgnored();
                    if (sc.peek() === '@') {sc.pos++;}
                    sc.readName();
                    if (sc.peekAfterIgnored() === '(') {sc.skipIgnored(); sc.readBalanced('(', ')');}
                    sc.skipIgnored();
                    if (sc.readName() === 'repeatable') {sc.skipIgnored(); sc.readName();}
                    for (;;) {
                        const save = sc.pos;
                        sc.skipIgnored();
                        if (sc.peek() === '|') {sc.pos++; sc.skipIgnored(); sc.readName();} else {sc.pos = save; break;}
                    }
                    break;
                }
                default:
                    break;
            }
        }

        return this.assemble(types, roots);
    }

    /** Parse from introspection JSON (__schema format). */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parseIntrospection(json: any): GraphQLSchema {
        const schemaData = json?.__schema || json?.data?.__schema || json || {};
        const roots: Record<RootKind, string> = {
            Query: schemaData.queryType?.name || 'Query',
            Mutation: schemaData.mutationType?.name || 'Mutation',
            Subscription: schemaData.subscriptionType?.name || 'Subscription'
        };
        const types: Record<string, GraphQLTypeDef> = {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const t of (Array.isArray(schemaData.types) ? schemaData.types : []) as any[]) {
            if (!t || typeof t.name !== 'string' || t.name.startsWith('__')) {continue;}
            const kind = ({ OBJECT: 'object', INTERFACE: 'interface', UNION: 'union', ENUM: 'enum', INPUT_OBJECT: 'input', SCALAR: 'scalar' } as Record<string, GraphQLTypeDef['kind']>)[t.kind];
            if (!kind) {continue;}
            const rawFields = kind === 'input' ? t.inputFields : t.fields;
            types[t.name] = {
                kind,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                fields: (Array.isArray(rawFields) ? rawFields : []).map((f: any): GraphQLTypeField => ({
                    name: String(f.name),
                    type: this.introspectionTypeToString(f.type),
                    args: this.introspectionArgs(f.args),
                    ...(f.isDeprecated === true ? { deprecated: true } : {})
                })),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                enumValues: (Array.isArray(t.enumValues) ? t.enumValues : []).map((e: any) => String(e.name)),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                possibleTypes: (Array.isArray(t.possibleTypes) ? t.possibleTypes : []).map((p: any) => String(p.name))
            };
        }
        return this.assemble(types, roots);
    }

    /** Auto-detect format and parse. */
    parse(content: string): GraphQLSchema {
        const trimmed = content.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                return this.parseIntrospection(JSON.parse(trimmed));
            } catch {
                // Not JSON — try as SDL
            }
        }
        return this.parseSDL(content);
    }

    private assemble(types: Record<string, GraphQLTypeDef>, roots: Record<RootKind, string>): GraphQLSchema {
        const fieldsOf = (kind: RootKind): GraphQLField[] => (types[roots[kind]]?.fields ?? []).map(f => ({
            name: f.name,
            type: kind,
            args: f.args,
            returnType: f.type,
            returnFields: this.leafFields(types, f.type),
            ...(f.deprecated ? { deprecated: true } : {})
        }));
        return { name: 'GraphQL API', queries: fieldsOf('Query'), mutations: fieldsOf('Mutation'), subscriptions: fieldsOf('Subscription'), types };
    }

    private leafFields(types: Record<string, GraphQLTypeDef>, typeRef: string): string[] {
        const def = types[namedType(typeRef)];
        if (!def || (def.kind !== 'object' && def.kind !== 'interface')) {return [];}
        return def.fields.filter(f => {
            const n = namedType(f.type);
            const d = types[n];
            return f.args.every(a => !a.required) && (BUILTIN_SCALARS.includes(n) || d?.kind === 'enum' || d?.kind === 'scalar');
        }).map(f => f.name);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private introspectionArgs(args: any): GraphQLArg[] {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (Array.isArray(args) ? args : []).map((arg: any): GraphQLArg => {
            const full = this.introspectionTypeToString(arg.type);
            const required = arg.type?.kind === 'NON_NULL';
            return {
                name: arg.name,
                type: required ? full.slice(0, -1) : full,
                required,
                ...(typeof arg.defaultValue === 'string' ? { defaultValue: arg.defaultValue } : {})
            };
        });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private introspectionTypeToString(type: any): string {
        if (!type) {return 'Unknown';}
        if (type.kind === 'NON_NULL') {return this.introspectionTypeToString(type.ofType) + '!';}
        if (type.kind === 'LIST') {return '[' + this.introspectionTypeToString(type.ofType) + ']';}
        return type.name || 'Unknown';
    }
}

/** Character scanner for the subset of SDL the generator needs. Strings and comments are never mistaken for structure. */
class Scanner {
    pos = 0;
    constructor(private readonly s: string) {}

    eof(): boolean { return this.pos >= this.s.length; }
    peek(): string { return this.s[this.pos] ?? ''; }

    /** Whitespace, commas, the BOM and `#` comments. */
    skipIgnored(): void {
        for (;;) {
            const c = this.peek();
            if (c === '') {return;}
            if (/[\s,\uFEFF]/.test(c)) {
                this.pos++;
            } else if (c === '#') {
                while (!this.eof() && this.peek() !== '\n' && this.peek() !== '\r') {this.pos++;}
            } else {
                return;
            }
        }
    }
    indexAfterIgnored(): number {
        const save = this.pos;
        this.skipIgnored();
        const at = this.pos;
        this.pos = save;
        return at;
    }
    peekAfterIgnored(): string {
        return this.s[this.indexAfterIgnored()] ?? '';
    }

    readName(): string {
        const m = /^[A-Za-z_]\w*/.exec(this.s.slice(this.pos, this.pos + 256));
        if (!m) {return '';}
        this.pos += m[0].length;
        return m[0];
    }
    readNameSkipping(): string {
        this.skipIgnored();
        return this.readName();
    }

    /** A regular or block string; returns its raw text. */
    readString(): string {
        const start = this.pos;
        if (this.s.startsWith('"""', this.pos)) {
            let e = this.s.indexOf('"""', this.pos + 3);
            while (e > 0 && this.s[e - 1] === '\\') {e = this.s.indexOf('"""', e + 3);}
            this.pos = e < 0 ? this.s.length : e + 3;
            return this.s.slice(start, this.pos);
        }
        this.pos++;
        while (!this.eof() && this.peek() !== '"' && this.peek() !== '\n') {
            this.pos += this.peek() === '\\' ? 2 : 1;
        }
        if (this.peek() === '"') {this.pos++;}
        return this.s.slice(start, this.pos);
    }

    /** Text between balanced delimiters (the opening one is at `pos`); strings and comments are skipped. */
    readBalanced(open: string, close: string): string {
        const start = this.pos;
        let depth = 0;
        let end = -1;
        while (!this.eof()) {
            const c = this.peek();
            if (c === '"') {this.readString(); continue;}
            if (c === '#') {this.skipIgnored(); continue;}
            if (c === open) {
                depth++;
            } else if (c === close) {
                depth--;
                if (depth === 0) {end = this.pos; this.pos++; break;}
            }
            this.pos++;
        }
        return this.s.slice(start + 1, end < 0 ? this.pos : end);
    }

    skipImplements(): void {
        this.skipIgnored();
        const save = this.pos;
        if (this.readName() !== 'implements') {this.pos = save; return;}
        for (;;) {
            this.skipIgnored();
            if (this.peek() === '&') {this.pos++; this.skipIgnored();}
            if (this.readName() === '') {return;}
            const s2 = this.pos;
            this.skipIgnored();
            if (this.peek() !== '&') {this.pos = s2; return;}
        }
    }

    /** Skips `@name(args)` directives; returns the names seen. */
    skipDirectives(): string[] {
        const names: string[] = [];
        for (;;) {
            const save = this.pos;
            this.skipIgnored();
            if (this.peek() !== '@') {this.pos = save; return names;}
            this.pos++;
            names.push(this.readName());
            if (this.peekAfterIgnored() === '(') {this.skipIgnored(); this.readBalanced('(', ')');}
        }
    }

    readTypeRef(): string {
        this.skipIgnored();
        let out = '';
        if (this.peek() === '[') {
            this.pos++;
            out = `[${this.readTypeRef()}`;
            this.skipIgnored();
            if (this.peek() === ']') {this.pos++;}
            out += ']';
        } else {
            out = this.readName() || 'Unknown';
        }
        if (this.peekAfterIgnored() === '!') {this.skipIgnored(); this.pos++; out += '!';}
        return out;
    }

    /** A GraphQL value literal; returns its raw text. */
    readValue(): string {
        this.skipIgnored();
        const c = this.peek();
        const start = this.pos;
        if (c === '"') {return this.readString();}
        if (c === '[') {return `[${this.readBalanced('[', ']')}]`;}
        if (c === '{') {return `{${this.readBalanced('{', '}')}}`;}
        const m = /^[^\s,)\]}#]+/.exec(this.s.slice(this.pos));
        if (m) {this.pos += m[0].length;}
        return this.s.slice(start, this.pos);
    }

    readArgs(): GraphQLArg[] {
        const args: GraphQLArg[] = [];
        for (;;) {
            this.skipIgnored();
            if (this.eof() || this.peek() === ')') {return args;}
            if (this.peek() === '"') {this.readString(); continue;}
            const name = this.readName();
            if (name === '') {this.pos++; continue;}
            this.skipIgnored();
            if (this.peek() !== ':') {continue;}
            this.pos++;
            const full = this.readTypeRef();
            let defaultValue: string | undefined;
            if (this.peekAfterIgnored() === '=') {this.skipIgnored(); this.pos++; defaultValue = this.readValue();}
            this.skipDirectives();
            const required = full.endsWith('!');
            args.push({ name, type: required ? full.slice(0, -1) : full, required, ...(defaultValue !== undefined ? { defaultValue } : {}) });
        }
    }

    /** `{ name(args): Type @dir ... }`; for input objects `name: Type = default`; for `schema` the type is the root name. */
    readFieldBlock(input = false, schemaBlock = false): GraphQLTypeField[] {
        const fields: GraphQLTypeField[] = [];
        this.skipIgnored();
        if (this.peek() !== '{') {return fields;}
        this.pos++;
        for (;;) {
            this.skipIgnored();
            if (this.eof()) {return fields;}
            if (this.peek() === '}') {this.pos++; return fields;}
            if (this.peek() === '"') {this.readString(); continue;}
            const name = this.readName();
            if (name === '') {this.pos++; continue;}
            let args: GraphQLArg[] = [];
            if (!input && this.peekAfterIgnored() === '(') {
                this.skipIgnored();
                args = new Scanner(this.readBalanced('(', ')')).readArgs();
            }
            this.skipIgnored();
            if (this.peek() !== ':') {continue;}
            this.pos++;
            const type = this.readTypeRef();
            if (input && this.peekAfterIgnored() === '=') {this.skipIgnored(); this.pos++; this.readValue();}
            const directives = this.skipDirectives();
            if (schemaBlock) {fields.push({ name, type: type.replace(/!$/, ''), args: [] }); continue;}
            fields.push({ name, type, args, ...(directives.includes('deprecated') ? { deprecated: true } : {}) });
        }
    }

    readEnumBlock(): string[] {
        const values: string[] = [];
        this.skipIgnored();
        if (this.peek() !== '{') {return values;}
        this.pos++;
        for (;;) {
            this.skipIgnored();
            if (this.eof()) {return values;}
            if (this.peek() === '}') {this.pos++; return values;}
            if (this.peek() === '"') {this.readString(); continue;}
            const name = this.readName();
            if (name === '') {this.pos++; continue;}
            values.push(name);
            this.skipDirectives();
        }
    }
}
