/** Pure planning of which security schemes common/auth.feature can apply. Karate v2 has one active `configure auth`. */
import type { OperationModel, SecurityScheme } from '../model/TestModel';

export interface AuthPlan {
    /** The single scheme applied with `configure auth`: the most used bearer/basic/oauth2/openIdConnect scheme (ties by declaration order). */
    primary?: SecurityScheme;
    /** Header-placed apiKey schemes, applied together in one `configure headers`. */
    headerKeys: SecurityScheme[];
    /** Query/cookie apiKey schemes: auth.feature defines the variable, scenarios add the step. */
    queryKeys: SecurityScheme[];
    /** Scheme names whose credentials auth.feature applies itself. */
    configured: Set<string>;
    /** Scheme names that need an explicit per-scenario step. */
    viaStep: Set<string>;
    /** Schemes auth.feature cannot apply (for example a second bearer/basic/oauth2 scheme). */
    unsupported: SecurityScheme[];
    /** Env var and Karate variable per apiKey scheme name. */
    apiKeyVars: Map<string, { env: string; variable: string }>;
}

const isPrimaryKind = (s: SecurityScheme): boolean => s.kind === 'bearer' || s.kind === 'basic' || s.kind === 'oauth2' || s.kind === 'openIdConnect';
/** Client-credentials and password oauth2 (or oauth2 without flow info) can be driven from auth.feature; authorizationCode and implicit need a browser. */
const configurable = (s: SecurityScheme): boolean => isPrimaryKind(s) && (s.kind !== 'oauth2' || s.flow === undefined || s.flow === 'clientCredentials' || s.flow === 'password');

/** How many operations reference each scheme name (each operation counts a name once). */
export function schemeUsage(operations: OperationModel[]): Map<string, number> {
    const usage = new Map<string, number>();
    for (const op of operations) {
        const names = new Set((op.securityGroups && op.securityGroups.length > 0 ? op.securityGroups.flat() : Array.isArray(op.security) ? op.security : []));
        for (const n of names) {usage.set(n, (usage.get(n) ?? 0) + 1);}
    }
    return usage;
}

const words = (name: string): string[] => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
const upperSnake = (name: string): string => words(name).map(w => w.toUpperCase()).join('_') || 'KEY';
const camel = (name: string): string => words(name).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('') || 'Key';

export function planAuth(schemes: SecurityScheme[], operations: OperationModel[] = []): AuthPlan {
    const usage = schemeUsage(operations);
    // Array.sort is stable, so equal usage keeps declaration order.
    const primary = schemes.filter(configurable).sort((a, b) => (usage.get(b.name) ?? 0) - (usage.get(a.name) ?? 0))[0];
    const unsupported: SecurityScheme[] = schemes.filter(s => isPrimaryKind(s) && s !== primary);
    const headerKeys: SecurityScheme[] = [];
    const queryKeys: SecurityScheme[] = [];
    const headerNames = new Set<string>();
    for (const s of schemes.filter(x => x.kind === 'apiKey')) {
        if (s.in === 'query' || s.in === 'cookie') {
            queryKeys.push(s);
            continue;
        }
        const header = (s.paramName ?? 'X-API-Key').toLowerCase();
        if (headerNames.has(header) || (primary && header === 'authorization')) {unsupported.push(s);} // a headers object cannot hold the same key twice
        else {
            headerNames.add(header);
            headerKeys.push(s);
        }
    }
    const keys = [...headerKeys, ...queryKeys];
    const apiKeyVars = new Map<string, { env: string; variable: string }>();
    const usedEnv = new Set<string>();
    const usedVar = new Set<string>();
    // One apiKey scheme overall keeps the original names; several are disambiguated by scheme name, then a numeric suffix.
    for (const s of keys) {
        let env = keys.length === 1 ? 'API_KEY' : `API_KEY_${upperSnake(s.name)}`;
        let variable = keys.length === 1 ? 'apiKey' : `apiKey${camel(s.name)}`;
        for (let n = 2; usedEnv.has(env); n++) {env = `${keys.length === 1 ? 'API_KEY' : `API_KEY_${upperSnake(s.name)}`}_${n}`;}
        for (let n = 2; usedVar.has(variable); n++) {variable = `apiKey${camel(s.name)}${n}`;}
        usedEnv.add(env);
        usedVar.add(variable);
        apiKeyVars.set(s.name, { env, variable });
    }
    return {
        primary,
        headerKeys,
        queryKeys,
        configured: new Set([...(primary ? [primary.name] : []), ...headerKeys.map(s => s.name)]),
        viaStep: new Set(queryKeys.map(s => s.name)),
        unsupported,
        apiKeyVars
    };
}

/** Env variables the generated auth.feature reads. */
export function requiredSecrets(plan: AuthPlan): string[] {
    const out: string[] = [];
    switch (plan.primary?.kind) {
        case undefined: break;
        case 'basic': out.push('API_USER', 'API_PASSWORD'); break;
        case 'oauth2': out.push('API_CLIENT_ID', 'API_CLIENT_SECRET', ...(plan.primary.flow === 'password' ? ['API_USERNAME', 'API_PASSWORD'] : [])); break;
        default: out.push('API_TOKEN');
    }
    for (const s of [...plan.headerKeys, ...plan.queryKeys]) {out.push(plan.apiKeyVars.get(s.name)!.env);}
    return out;
}

/** Why auth.feature cannot configure a scheme. */
export function unsupportedReason(s: SecurityScheme): string {
    if (s.kind === 'oauth2' && s.flow && s.flow !== 'clientCredentials' && s.flow !== 'password') {
        return `oauth2 ${s.flow} flow needs an interactive browser login and is not supported; obtain a token yourself, set API_TOKEN and configure a bearer scheme, or extend common/auth.feature`;
    }
    if (s.kind === 'apiKey') {return 'header name already used by another apiKey scheme or by the Authorization header of the primary scheme';}
    return "Karate v2 applies a single auth scheme; add credentials manually";
}
