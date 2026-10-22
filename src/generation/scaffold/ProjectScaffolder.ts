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

function requiredSecrets(s: SecurityScheme | undefined): string[] {
    switch (s?.kind) {
        case undefined:
            return [];
        case 'basic':
            return ['API_USER', 'API_PASSWORD'];
        case 'oauth2':
            return ['API_CLIENT_ID', 'API_CLIENT_SECRET'];
        case 'apiKey':
            return ['API_KEY'];
        default:
            return ['API_TOKEN'];
    }
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
            if (s.in === 'query') {steps.push(`# Query API key: scenarios add 'param ${name} = apiKey' to each request.`);}
            else if (s.in === 'cookie') {steps.push(`# Cookie API key: scenarios add 'cookie ${name} = apiKey' to each request.`);}
            else {steps.push(`* configure headers = { ${q(name)}: '#(apiKey)' }`);}
            return steps;
        }
        default:
            return ["* def token = karate.sysenv('API_TOKEN', '')", "* configure auth = { type: 'bearer', token: '#(token)' }"];
    }
}

function authFeature(s: SecurityScheme, ignored: SecurityScheme[]): string {
    const note = ignored.length > 0 ? [`# Note: only scheme '${s.name}' is configured; other schemes ignored: ${ignored.map(i => i.name).join(', ')}`] : [];
    return [...note, '@ignore', 'Feature: Authentication', '', '  Scenario: Configure authentication', ...authSteps(s).map(l => `    ${l}`), ''].join('\n');
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

    if (!project.baseConfig) {
        add('karate-config.js', baseConfigJs(urlVar, baseUrl, envJsonMode), 'Base Karate configuration');
        const secrets = requiredSecrets(model.schemes[0]);
        for (const env of config.config.envs) {
            if (project.envConfigs.includes(env)) {continue;}
            if (envJsonMode) {add(`config/${env}.json`, envJson(urlVar, baseUrl), `Environment config for ${env}`);}
            else {add(`karate-config-${env}.js`, envConfigJs(env, urlVar, secrets), `Environment overrides for ${env}`);}
        }
    }
    if (model.schemes.length > 0) {add('common/auth.feature', authFeature(model.schemes[0], model.schemes.slice(1)), 'Authentication setup from spec security schemes');}
    add('common/utils.feature', UTILS_FEATURE, 'Shared helper functions');
    return files;
}
