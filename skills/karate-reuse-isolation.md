---
name: karate-reuse-isolation
description: Karate v2 reuse and parallel safety - call/callonce/callSingle, @ignore helpers, classpath, @lock, Background and url behaviour
---
Reuse shallowly. A test that needs five other files to be understood is too fragmented; a little duplication beats a deep chain.

## Calling helpers
Helpers are `@ignore` features, read with `classpath:` so they survive moves.
```gherkin
@ignore
Feature: Login helper

Scenario:
  Given url baseUrl
  And path 'auth', 'login'
  And request { username: '#(username)', password: '#(password)' }
  When method post
  Then status 200
  * def authToken = response.token
```
```gherkin
* def login = call read('classpath:auth/login.feature') { username: '#(user)', password: '#(pass)' }
* def token = login.authToken
```
- Argument keys become variables in the called feature; a bare `{ id: id }` passes the string 'id', so use `'#(id)'` or `({ id: id })`.
- `def x = call ...` is isolated; a bare `call read(...)` merges the helper's variables into the caller.
- An array argument calls the feature once per element.
- Defaults inside a helper: `* def role = karate.get('role', 'user')`.
- Select a scenario by tag: `call read('classpath:common.feature@setup')`.

## One-time setup
- `callonce` runs once per feature file; the result is cached. Return plain JSON only.
- `karate.callSingle('classpath:auth/token.feature')` runs once for the whole suite.
```gherkin
Background:
  * def auth = callonce read('classpath:auth/get-token.feature')
  * def token = auth.authToken
```

## Scope and url
- The Background re-runs before every Scenario; its variables reset each time. Use `callonce` for setup that must persist.
- `url` resets in called features; `configure url = baseUrl` persists across calls.
- Read shared data with `read('classpath:...')`, never `../../` paths.
- Clone shared objects with `karate.copy` before changing them.

## Parallel safety
Karate v2 runs scenarios in parallel. Prefer independent scenarios with generated unique data. Where scenarios share mutable state (a database row, a file), serialize only those:
```gherkin
@lock=orders
Scenario: Create an order
  # only one @lock=orders scenario runs at a time

@lock=*
Scenario: Schema migration check
  # runs alone; use sparingly, it stalls the worker pool
```
A `@lock=name` on the Feature line applies to every scenario in it. Different lock names run concurrently.

## Rules
- V2-LOCK-001: the v1 parallel tag is silently ignored in v2; use `@lock=<name>`.
```gherkin
# BAD
@parallel=false
Feature: Orders
# GOOD
@lock=orders
Feature: Orders
```
- V2-REF-001: every `read('classpath:...')` points to a file that exists (or is generated in the same run).
```gherkin
# BAD: no such helper
* call read('classpath:auth/missing.feature')
# GOOD: the helper exists under the classpath root
* call read('classpath:auth/login.feature')
```
