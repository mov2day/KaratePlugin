/** Pure project scaffolder: plans karate-config and common helper files. No vscode, no node fs. */
import type { ProjectInfo } from '../config/ProjectDiscovery';
import type { GeneratorConfig } from '../config/GeneratorConfig';
import type { GenerationModel } from '../model/TestModel';
import { planAuth, requiredSecrets, unsupportedReason } from '../plan/AuthSchemes';
import type { AuthPlan } from '../plan/AuthSchemes';

export interface ScaffoldFile {
    path: string;
    content: string;
    owner: 'user' | 'generated';
    reason: string;
}

export interface ScaffoldContext {
    project: ProjectInfo;
    config: GeneratorConfig;
    model: GenerationModel;
}

const q = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const joinPath = (root: string, p: string): string => `${root.replace(/\/+$/, '')}/${p}`;
const envVarName = (env: string): string => env.toUpperCase().replace(/[^A-Z0-9]/g, '_');

function baseConfigJs(urlVar: string, baseUrl: string, envJson: boolean): string {
    const head = envJson
        ? [
              "  var env = karate.env || 'dev';",
              "  var config = karate.read('classpath:config/' + env + '.json');"
          ]
        : [
              "  var env = karate.env || 'dev';",
              '  var config = { env: env };',
              `  config.${urlVar} = karate.sysprop('baseUrl', ${q(baseUrl)});`
          ];
    return [
        '// Karate base configuration. Keep it light: no auth calls and no large file reads here.',
        'function fn() {',
        ...head,
        "  karate.configure('connectTimeout', 5000);",
        "  karate.configure('readTimeout', 30000);",
        "  karate.configure('logging', { console: { level: 'info' }, report: { level: 'info' } });",
        '  return config;',
        '}',
        ''
    ].join('\n');
}

function envConfigJs(env: string, urlVar: string, secrets: string[]): string {
    const lines = [
        `// Overrides for the '${env}' environment (karate.env = ${env}). Only overrides when the variable is set.`,
        'function fn() {',
        '  var config = {};',
        `  var url = karate.sysenv(${q(envVarName(env) + '_BASE_URL')});`,
        '  if (url) {',
        `    config.${urlVar} = url;`,
        '  }'
    ];
    if (secrets.length > 0 && env !== 'dev') {
        lines.push(
            `  var required = [${secrets.map(q).join(', ')}];`,
            '  var missing = [];',
            '  for (var i = 0; i < required.length; i++) {',
            '    if (!karate.sysenv(required[i])) {',
            '      missing.push(required[i]);',
            '    }',
            '  }',
            '  if (missing.length > 0) {',
            "    throw new Error(missing.join(', ') + ' is required');",
            '  }'
        );
    }
    lines.push('  return config;', '}', '');
    return lines.join('\n');
}

function envJson(urlVar: string, baseUrl: string): string {
    return JSON.stringify({ [urlVar]: baseUrl, connectTimeout: 5000, readTimeout: 30000 }, null, 2) + '\n';
}

function authFeature(plan: AuthPlan): string {
    const lines: string[] = [];
    const applied = [...plan.configured].join(', ') || 'none';
    const viaStep = [...plan.viaStep].join(', ');
    lines.push(`# Configures: ${applied}${viaStep ? `; per-scenario step needed: ${viaStep}` : ''}`);
    for (const u of plan.unsupported) {
        lines.push(`# Cannot configure ${u.name}: ${unsupportedReason(u)}`);
    }
    const steps: string[] = [];
    const s = plan.primary;
    if (s?.kind === 'basic') {
        steps.push(
            "* def username = karate.sysenv('API_USER', '')",
            "* def password = karate.sysenv('API_PASSWORD', '')",
            "* configure auth = { type: 'basic', username: '#(username)', password: '#(password)' }"
        );
    } else if (s?.kind === 'oauth2') {
        const scopes = (s.scopes ?? []).join(' ');
        if (!s.tokenUrl) {steps.push("# WARNING: the spec declares no tokenUrl for this oauth2 scheme; set API_TOKEN_URL (or replace tokenUrl below)");}
        const tokenUrl = s.tokenUrl ? q(s.tokenUrl) : 'tokenUrl';
        if (!s.tokenUrl) {steps.push("* def tokenUrl = karate.sysenv('API_TOKEN_URL', '')");}
        steps.push(
            "* def clientId = karate.sysenv('API_CLIENT_ID', '')",
            "* def clientSecret = karate.sysenv('API_CLIENT_SECRET', '')"
        );
        if (scopes) {steps.push(`# Scopes declared by the spec; override with API_SCOPE (space separated)`, `* def scope = karate.sysenv('API_SCOPE', ${q(scopes)})`);}
        if (s.flow === 'password') {
            steps.push(
                '# Password flow: API_USERNAME and API_PASSWORD are exchanged for a bearer token',
                "* def username = karate.sysenv('API_USERNAME', '')",
                "* def password = karate.sysenv('API_PASSWORD', '')",
                `* url ${tokenUrl}`,
                "* form field grant_type = 'password'",
                "* form field client_id = clientId",
                "* form field client_secret = clientSecret",
                "* form field username = username",
                "* form field password = password",
                ...(scopes ? ['* form field scope = scope'] : []),
                '* method post',
                '* status 200',
                '* def token = response.access_token',
                "* configure auth = { type: 'bearer', token: '#(token)' }"
            );
        } else {
            steps.push(`* configure auth = { type: 'oauth2', tokenUrl: ${tokenUrl}, clientId: '#(clientId)', clientSecret: '#(clientSecret)'${scopes ? ", scope: '#(scope)'" : ''} }`);
        }
    } else if (s) {
        if (s.kind === 'openIdConnect') {
            steps.push(`# openIdConnect${s.openIdConnectUrl ? ` (${s.openIdConnectUrl})` : ''}: obtain an access token from the provider and set API_TOKEN`);
        }
        steps.push("* def token = karate.sysenv('API_TOKEN', '')", "* configure auth = { type: 'bearer', token: '#(token)' }");
    }
    for (const k of plan.headerKeys) {
        const v = plan.apiKeyVars.get(k.name)!;
        steps.push(`* def ${v.variable} = karate.sysenv('${v.env}', '')`);
    }
    if (plan.headerKeys.length > 0) {
        const entries = plan.headerKeys.map(k => `${q(k.paramName ?? 'X-API-Key')}: '#(${plan.apiKeyVars.get(k.name)!.variable})'`);
        steps.push(`* configure headers = { ${entries.join(', ')} }`);
    }
    for (const k of plan.queryKeys) {
        const v = plan.apiKeyVars.get(k.name)!;
        const name = k.paramName ?? 'api_key';
        steps.push(`* def ${v.variable} = karate.sysenv('${v.env}', '')`);
        steps.push(`# ${k.in === 'cookie' ? 'Cookie' : 'Query'} API key: scenarios add '${k.in === 'cookie' ? 'cookie' : 'param'} ${name} = ${v.variable}' to each request.`);
    }
    return [...lines, '@ignore', 'Feature: Authentication', '', '  Scenario: Configure authentication', ...steps.map(l => `    ${l}`), ''].join('\n');
}

const UTILS_FEATURE = [
    '@ignore',
    'Feature: Utilities',
    '',
    '  Scenario: Shared helpers',
    '    * def uuid = function() { return karate.uuid() }',
    '    * def randomInt = function() { return karate.faker.randomInt() }',
    ''
].join('\n');

export function planScaffold(ctx: ScaffoldContext): ScaffoldFile[] {
    const { project, config, model } = ctx;
    const root = project.classpathRoot;
    const urlVar = config.config.urlVariable;
    // Never invent a runnable endpoint. A source may supply a declared server; otherwise users must configure baseUrl.
    const baseUrl = model.baseUrl || '';
    const envJsonMode = config.config.mode === 'env-json';
    const files: ScaffoldFile[] = [];
    const add = (p: string, content: string, reason: string): void => {
        files.push({ path: joinPath(root, p), content, owner: 'user', reason });
    };

    if (!project.baseConfig) {
        add('karate-config.js', baseConfigJs(urlVar, baseUrl, envJsonMode), 'Base Karate configuration');
        const secrets = requiredSecrets(planAuth(model.schemes, model.operations));
        for (const env of config.config.envs) {
            if (project.envConfigs.includes(env)) {continue;}
            if (envJsonMode) {add(`config/${env}.json`, envJson(urlVar, baseUrl), `Environment config for ${env}`);}
            else {add(`karate-config-${env}.js`, envConfigJs(env, urlVar, secrets), `Environment overrides for ${env}`);}
        }
    }
    if (model.schemes.length > 0) {add('common/auth.feature', authFeature(planAuth(model.schemes, model.operations)), 'Authentication setup from spec security schemes');}
    add('common/utils.feature', UTILS_FEATURE, 'Shared helper functions');
    return files;
}
