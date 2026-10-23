---
name: karate-review-checklist
description: The quality-gate rules as a self-review checklist for Karate v2 features, one line per rule id
---
Before returning a feature, check it against every rule below. A failed rule is fixed in place; the gate reports findings by these IDs. Output stays pure Karate DSL: no fences, no commentary.

## Rules
- V2-GHERKIN-001 (error): every step sits inside a Background or Scenario.
- V2-GHERKIN-002 (error): no step follows an `Examples:` table in the same outline.
- V2-LOCK-001 (error): the v1 parallel tag is not used; shared-state scenarios use `@lock=<name>` (or `@lock=*`).
- V2-CFG-001 (error): no literal `http://` or `https://` in a `url` step; use `url baseUrl`.
- V2-CFG-002 (error): a scenario that calls `method` has a `url` in Background or earlier in the scenario.
- V2-SEC-001 (error): no literal password, token, secret or API key in steps or docstrings; use `karate.sysenv`, `karate.sysprop` or config.
- V2-ASSERT-001 (error): every scenario with `method` asserts the status (`status` or a match on `responseStatus`).
- V2-ASSERT-002 (warning): a 2xx scenario also asserts the body (`match response ...`).
- V2-DRAFT-001 (error): no TODO or placeholder step or comment outside `@ignore`.
- V2-DUP-001 (error): scenario names are unique within the feature.
- V2-API-001 (error): no `karate.stop` call; it hangs CI until a socket connects.
- V2-API-002 (warning): no toJava wrapper; it is a no-op in v2.
- V2-NUM-001 (error): integers above 9007199254740991 are quoted strings.
- V2-REF-001 (error): `read('classpath:...')` resolves to an existing or generated file.
- V2-TAG-001 (warning): category tags match the configured taxonomy (`@positive @negative @edge @boundary @security @exploratory` by default).
- V2-REUSE-001 (warning): config helpers (auth, headers, setup) are loaded with `call`, never an unassigned `callonce`.

## Also check
- Evidence: every path, field, status and value comes from the supplied source; nothing invented.
- Structure: Feature, optional Background, then Scenarios; step keywords consistent; unique, descriptive names.
- Karate-JSON: no bare identifiers inside `{ }` or `[ ]` literals; use `'#(x)'` or `({ ... })`.
- Isolation: unique generated data (`karate.uuid()`, `karate.faker.*`), `karate.copy` before changing loaded data, independent scenarios.
- Reuse: helpers are `@ignore` features read via `classpath:`; config helpers (auth, headers) use `call`; `callonce` only caches data via `def x = callonce read(...)`; no deep call chains.
- Assertions: schemas with markers, `##` for optional fields, a comment above each key assertion.
