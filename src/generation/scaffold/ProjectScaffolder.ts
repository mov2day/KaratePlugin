/** Pure project scaffolder: plans karate-config and common helper files. No vscode, no node fs. */
import type { ProjectInfo } from '../config/ProjectDiscovery';
import type { GeneratorConfig } from '../config/GeneratorConfig';
import type { GenerationModel, SecurityScheme } from '../model/TestModel';

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

const DEFAULT_URL = 'http://localhost:8080';
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

function envConfigJs(env: string, urlVar: string, hasScheme: boolean): string {
    const lines = [
        `// Overrides for the '${env}' environment (karate.env = ${env}).`,
        'function fn() {',
        '  var config = {};',
        `  config.${urlVar} = karate.sysenv(${q(envVarName(env) + '_BASE_URL')}, ${q(`https://api.${env}.example.com`)});`
    ];
    if (hasScheme && env !== 'dev') {
        lines.push("  if (!karate.sysenv('API_TOKEN')) {", "    throw new Error('API_TOKEN is required');", '  }');
    }
    lines.push('  return config;', '}', '');
    return lines.join('\n');
}

function envJson(urlVar: string, env: string, baseUrl: string): string {
    const url = env === 'dev' ? baseUrl : `https://api.${env}.example.com`;
    return JSON.stringify({ [urlVar]: url, connectTimeout: 5000, readTimeout: 30000 }, null, 2) + '\n';
}

function authSteps(s: SecurityScheme): string[] {
    switch (s.kind) {
        case 'bearer':
            return ["* def token = karate.sysenv('API_TOKEN', '')", "* configure auth = { type: 'bearer', token: '#(token)' }"];
        case 'basic':
            return [
                "* def username = karate.sysenv('API_USER', '')",
                "* def password = karate.sysenv('API_PASSWORD', '')",
                "* configure auth = { type: 'basic', username: '#(username)', password: '#(password)' }"
            ];
        case 'oauth2':
            return [
                "* def clientId = karate.sysenv('API_CLIENT_ID', '')",
                "* def clientSecret = karate.sysenv('API_CLIENT_SECRET', '')",
                `* configure auth = { type: 'oauth2', tokenUrl: ${q(s.tokenUrl ?? '')}, clientId: '#(clientId)', clientSecret: '#(clientSecret)' }`
            ];
        case 'apiKey': {
            const name = s.paramName ?? 'X-API-Key';
            const steps = ["* def apiKey = karate.sysenv('API_KEY', '')"];
            if (s.in === 'query') steps.push(`# Query API key: scenarios add 'param ${name} = apiKey' to each request.`);
            else if (s.in === 'cookie') steps.push(`# Cookie API key: scenarios add 'cookie ${name} = apiKey' to each request.`);
            else steps.push(`* configure headers = { ${q(name)}: '#(apiKey)' }`);
            return steps;
        }
        default:
            return ["* def token = karate.sysenv('API_TOKEN', '')", "* configure auth = { type: 'bearer', token: '#(token)' }"];
    }
}

function authFeature(s: SecurityScheme): string {
    return ['@ignore', 'Feature: Authentication', '', '  Scenario: Configure authentication', ...authSteps(s).map(l => `    ${l}`), ''].join('\n');
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
    const baseUrl = model.baseUrl || DEFAULT_URL;
    const envJsonMode = config.config.mode === 'env-json';
    const files: ScaffoldFile[] = [];
    const add = (p: string, content: string, reason: string): void => {
        files.push({ path: joinPath(root, p), content, owner: 'user', reason });
    };

    if (!project.baseConfig) add('karate-config.js', baseConfigJs(urlVar, baseUrl, envJsonMode), 'Base Karate configuration');
    for (const env of config.config.envs) {
        if (envJsonMode) {
            if (!project.hasEnvJson || !project.envConfigs.includes(env)) add(`config/${env}.json`, envJson(urlVar, env, baseUrl), `Environment config for ${env}`);
        } else if (!project.envConfigs.includes(env)) {
            add(`karate-config-${env}.js`, envConfigJs(env, urlVar, model.schemes.length > 0), `Environment overrides for ${env}`);
        }
    }
    if (model.schemes.length > 0) add('common/auth.feature', authFeature(model.schemes[0]), 'Authentication setup from spec security schemes');
    add('common/utils.feature', UTILS_FEATURE, 'Shared helper functions');
    return files;
}
