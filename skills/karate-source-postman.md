---
name: karate-source-postman
description: Convert Postman collections, environments and test scripts to native Karate v2 with an unsupported-script policy
---
Preserve requests, variables, auth, scripts, assertions and execution order from the collection. Convert to native Karate; do not wrap Postman JavaScript.

## Structure
- A collection folder becomes one feature; a request becomes a scenario, or a step group inside one scenario when later requests consume earlier responses.
- Keep the collection order. Disabled headers, params and requests are skipped.
- Requests that feed a variable (`pm.environment.set`, `pm.collectionVariables.set`) stay in one scenario and pass it with `* def`.

## Request mapping
| Postman | Karate |
|---|---|
| `{{baseUrl}}` | `url baseUrl` (set in karate-config.js) |
| `{{id}}` in a path | `path 'users', id` |
| `{{x}}` inside a string | `'#(x)'` or `'/a/' + x` |
| query param | `param name = value` |
| raw JSON body | `request { ... }` |
| urlencoded body | `form field name = value` |
| form-data body | `multipart field name = value` |
| header | `header Name = value` |
| collection or environment variable | config variable or `* def` |
```gherkin
Background:
  * url baseUrl

Scenario: Create user
  Given path 'users'
  And request { name: '#(name)', email: '#(email)' }
  When method post
  Then status 201
  * def userId = response.id
```
Environment values marked secret, and any literal token, key or password in the collection, become `karate.sysenv('NAME')`. Never copy the value.

## Auth block
Basic, Bearer and OAuth2 map to `configure auth` in the Background; API key to `header` or `param`.
```gherkin
* def token = karate.sysenv('API_TOKEN')
* configure auth = { type: 'bearer', token: '#(token)' }
```

## Scripts
| Postman | Karate |
|---|---|
| `pm.response.to.have.status(200)` | `Then status 200` |
| `pm.expect(j.id).to.be.a('number')` | `match response.id == '#number'` |
| `pm.expect(j.name).to.equal('Jo')` | `match response.name == 'Jo'` |
| `pm.environment.set('id', j.id)` | `* def id = response.id` |
| random or timestamp pre-request | `karate.uuid()`, `karate.faker.*` |
Each `pm.test` title becomes the comment directly above its `match`; it is the failure label.

## Unsupported scripts
`pm.sendRequest`, `setNextRequest`, crypto or other custom JavaScript: convert the request itself and keep the rest as a `# NOT TRANSLATED: <what it did>` comment. If a later step depends on it, tag the scenario `@ignore`. Never invent behaviour for a script you cannot map.

## Rules
- V2-SEC-001: no literal secrets from the collection.
```gherkin
# BAD
* header X-API-Key = 'sk_live_51Habcdefgh'
# GOOD
* header X-API-Key = karate.sysenv('API_KEY')
```
- V2-CFG-001: base URL from `baseUrl`, not the collection's literal host.
