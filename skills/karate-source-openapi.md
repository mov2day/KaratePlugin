---
name: karate-source-openapi
description: Turn an OpenAPI contract into Karate v2 scenarios - statuses, schemas, constraints, security, CRUD chains
---
Generate only from documented operations, parameters, schemas and response codes. Never invent an endpoint, field or status.

## Per operation
One scenario per documented outcome. Name it `<METHOD> <path> returns <status> <meaning>`.
```gherkin
Scenario: GET /users/{id} returns 200 with the user
  Given path 'users', userId
  When method get
  Then status 200
  And match response == { id: '#number', name: '#string', email: '#regex .+@.+', nickname: '##string' }
```
- Path parameters: `path 'users', userId`. Query parameters: `param status = 'active'` or `params {...}`.
- Request bodies: build from the schema (required fields first). Use `karate.uuid()` / `karate.faker.*` for unique values.
- Cover 4xx/5xx only when the spec documents that code and a way to trigger it (missing required field, bad id format, no credentials).

## Schema to markers
| OpenAPI | Karate |
|---|---|
| integer, number | `#number` |
| string, date, date-time | `#string` |
| format uuid | `#uuid` |
| format email | `#regex .+@.+` |
| boolean, object | `#boolean`, `#object` |
| array of T | `#[] #string` or `#[] schemaName` |
| optional or nullable property | `##string` |
| enum | `#? EXPR` (below) |
| minimum / maximum | `#number? _ >= 0 && _ <= 100` |
| minLength / maxLength | `#string? _.length >= 1 && _.length <= 50` |
| minItems | `#[_ >= 1]` |
| pattern | `#regex STR` (double backslash) |

```gherkin
* match response.status == '#? _ == "a" || _ == "b"'
```
Required property: marker without `##`. Large integer ids (beyond 2^53): quote them and use `#string`. Define each component schema once in the Background and reuse it with `#(name)` or `#[] name`.

## Security
Map `securitySchemes` to `configure auth` (http basic, http bearer, oauth2 clientCredentials) with credentials from `karate.sysenv`. API keys go to `header` or `param`. Never write a credential literal.
```gherkin
Background:
  * url baseUrl
  * def token = karate.sysenv('API_TOKEN')
  * configure auth = { type: 'bearer', token: '#(token)' }
```

## CRUD chains
Create, read, update, delete the same resource in ONE scenario (data from step N feeds step N+1), or use a helper `callonce`. Capture the id with `* def id = response.id`, delete what you created, and use unique names so parallel runs do not collide. Lock shared resources with `@lock=<name>`.

## Unsupported content
Constructs without a Karate mapping (webhooks, callbacks): skip, noting it in a `#` comment above an `@ignore` scenario.

## Rules
- V2-ASSERT-001 and V2-ASSERT-002: assert the documented status, then the schema for 2xx.
```gherkin
# BAD
When method get
# GOOD
When method get
Then status 200
And match response == '#object'
```
- V2-CFG-001: base URL from config (`url baseUrl`), never the spec's `servers` literal.
