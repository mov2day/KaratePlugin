---
name: karate-v2-core
description: Always-on Karate v2 (2.1.4, Java 21+) rules - output contract, request flow, Gherkin structure, anti-hallucination
---
Target Karate v2 (io.karatelabs, Java 21+). Karate-JSON is not JavaScript.

## Output contract
- Emit only the `.feature` text: no markdown fences, no prose.
- Shape: `Feature:`, optional `Background:`, then `Scenario:` / `Scenario Outline:`. Every step starts with `*`, Given, When, Then or And, and sits inside a Background or Scenario.
- Scenarios are independent, run in any order and in parallel, and each checks one behaviour.
- Use only endpoints, fields, statuses and values present in the supplied evidence. Unknown contract: write an `@ignore` draft with a comment, never a guess.
- Prefer native keywords over JavaScript; move complex logic to Java.

## Request flow
```gherkin
Background:
  * url baseUrl

Scenario: Get a user
  Given path 'users', 1
  When method get
  Then status 200
  And match response == { id: 1, name: '#string' }
```
- `path 'users', id` joins segments. Query strings use `param` / `params`; `?` inside `path` is encoded to %3F.
- Bodies: `request { name: 'Jo' }`; forms: `form field name = 'Jo'`; headers: `header X-Id = id` or `headers obj`.
- Null values in `params` and `headers` objects are skipped.

## Markers
`#ignore #null #notnull #present #notpresent #array #object #boolean #number #string #uuid #regex STR #? EXPR`, `##` makes a marker optional, `#[] #string`, `#[3]`. Regex needs double backslash: `'#regex \\d+'`.

## Karate-JSON pitfall
A `{` or `[` right-hand side is relaxed JSON: a bare identifier is a string.
```gherkin
# BAD: payload.id is the string 'id'
* def payload = { id: id }
# GOOD
* def payload = { id: '#(id)' }
* def payload2 = ({ id: id })
```

## Rules
- V2-GHERKIN-001: no step outside a Background or Scenario (never after `Examples:`).
```gherkin
# BAD
Examples:
  | id |
  | 1  |
* match response.id == id
# GOOD: steps stay above Examples
```
- V2-DUP-001: scenario names are unique within a feature.
- V2-API-001: never commit `karate.stop`; it pauses until a socket connects and hangs CI.
```gherkin
# BAD
* karate.stop(9000)
```
- V2-API-002: the toJava wrapper is a no-op in v2; JS functions already coerce to Java interfaces.
```gherkin
# BAD
* def cb = karate.toJava(handler)
# GOOD
* def cb = handler
```
- V2-TAG-001: use the category tags the project configures (default `@positive @negative @edge @boundary @security @exploratory`); do not invent spellings.
