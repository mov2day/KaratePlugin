/** Pure planning of which security schemes common/auth.feature can apply. Karate v2 has one active `configure auth`. */
import type { SecurityScheme } from '../model/TestModel';

export interface AuthPlan {
    /** The single scheme applied with `configure auth` (first bearer/basic/oauth2/openIdConnect in declared order). */
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

const words = (name: string): string[] => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
const upperSnake = (name: string): string => words(name).map(w => w.toUpperCase()).join('_') || 'KEY';
const camel = (name: string): string => words(name).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('') || 'Key';

export function planAuth(schemes: SecurityScheme[]): AuthPlan {
    const primary = schemes.find(isPrimaryKind);
    const apiKeys = schemes.filter(s => s.kind === 'apiKey');
    const headerKeys = apiKeys.filter(s => s.in !== 'query' && s.in !== 'cookie');
    const queryKeys = apiKeys.filter(s => s.in === 'query' || s.in === 'cookie');
    const apiKeyVars = new Map<string, { env: string; variable: string }>();
    // One apiKey scheme overall keeps the original names; several are disambiguated by scheme name.
    for (const s of apiKeys) {
        apiKeyVars.set(s.name, apiKeys.length === 1 ? { env: 'API_KEY', variable: 'apiKey' } : { env: `API_KEY_${upperSnake(s.name)}`, variable: `apiKey${camel(s.name)}` });
    }
    return {
        primary,
        headerKeys,
        queryKeys,
        configured: new Set([...(primary ? [primary.name] : []), ...headerKeys.map(s => s.name)]),
        viaStep: new Set(queryKeys.map(s => s.name)),
        unsupported: schemes.filter(s => !isPrimaryKind(s) && s.kind !== 'apiKey' || (isPrimaryKind(s) && s !== primary)),
        apiKeyVars
    };
}

/** Env variables the generated auth.feature reads. */
export function requiredSecrets(plan: AuthPlan): string[] {
    const out: string[] = [];
    switch (plan.primary?.kind) {
        case undefined: break;
        case 'basic': out.push('API_USER', 'API_PASSWORD'); break;
        case 'oauth2': out.push('API_CLIENT_ID', 'API_CLIENT_SECRET'); break;
        default: out.push('API_TOKEN');
    }
    for (const s of plan.headerKeys) {out.push(plan.apiKeyVars.get(s.name)!.env);}
    return out;
}
