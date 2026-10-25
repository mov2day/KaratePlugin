---
name: karate-project-config
description: Karate v2 project configuration - karate-config(.env).js, karate.env, sysenv/sysprop, configure auth/logging, secrets
---
Follow the project's existing config; never overwrite it. Keep config light.

## Config files
- `karate-config.js` is required and runs before every scenario; `karate-config-<env>.js` loads after it when `karate.env` is set (`-e staging` or `-Dkarate.env=staging`).
- Keep config light: return variables, no big file reads. Suite-wide one-time token setup may use `karate.callSingle`; otherwise load config helpers in the Background with `call`, and cache data with `def x = callonce read(...)`. Generated scaffolding loads `common/auth.feature` with `* call read('classpath:common/auth.feature')`; it holds declarative `configure auth`.
```javascript
function fn() {
  var env = karate.env || 'dev';
  var config = { env: env, baseUrl: karate.sysenv('API_BASE_URL', 'http://localhost:8080') };
  karate.configure('logging', { report: 'debug' });
  return config;
}
```

## Environment access
`karate.sysenv(name, default)` reads an OS variable (default used when unset or empty). `karate.sysprop(name, default)` reads a JVM property. Use them for base URLs and every secret.
```gherkin
* def apiHost = karate.sysenv('API_HOST', 'localhost')
* def port = karate.sysprop('server.port', '8080')
```

## Declarative auth
`configure auth` is inherited by called features and refreshes OAuth2 tokens itself. Map OpenAPI `securitySchemes` to it, with credentials from sysenv.
```gherkin
* configure auth = { type: 'basic', username: '#(user)', password: '#(pass)' }
* def token = karate.sysenv('API_TOKEN')
* configure auth = { type: 'bearer', token: '#(token)' }
* configure auth = { type: 'oauth2', tokenUrl: '#(tokenUrl)', clientId: '#(id)', clientSecret: '#(secret)' }
```
API keys: `* header X-API-Key = apiKey`.

## Logging
`configure logging` masks secrets in reports and console:
```gherkin
* configure logging = { report: 'debug', console: 'warn', mask: { headers: ['Authorization', 'Cookie'], jsonPaths: ['$.password', '$..token'] } }
```

## Adopting an existing project
- Reuse the URL variable already in its config (often `baseUrl`); read the config before naming one.
- A new project gets a base `karate-config.js` plus one `karate-config-<env>.js` per environment, each returning `baseUrl`.

## Rules
- V2-CFG-001: no literal `http(s)://` in `url`; use a config variable.
```gherkin
# BAD
* url 'https://qa.example.com/api'
# GOOD
* url baseUrl
```
- V2-CFG-002: a scenario that calls `method` needs a `url` in its Background or earlier steps.
```gherkin
# BAD: method with no url anywhere
Scenario: List
  Given path 'users'
  When method get
# GOOD
Background:
  * url baseUrl
```
- V2-SEC-001: never write a literal password, token, secret or API key; read it from sysenv/sysprop or config.
```gherkin
# BAD
* header Authorization = 'Bearer eyJhbGciOiJIUzI1NiJ9abc'
# GOOD
* header Authorization = 'Bearer ' + karate.sysenv('API_TOKEN')
```
