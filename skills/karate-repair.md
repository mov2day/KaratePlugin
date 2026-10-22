---
name: karate-repair
description: Minimal-diff repair of failing Karate v2 scenarios and flakiness, by failure category, without weakening assertions
---
Repair only the failing scenario. Keep unrelated scenarios, tags, names and ordering byte-identical.

## Method
1. Read the failure: Karate prints every mismatched path with expected vs actual and types. Fix all of them in one pass.
2. Name the category, change the smallest thing that addresses it, and keep intent.
3. Return the full corrected feature text, no fences, no commentary.

## Categories
| Symptom | Likely cause | Fix |
|---|---|---|
| status mismatch | wrong path, method, auth or precondition | fix the request, not the expected status, unless the evidence shows the status is wrong |
| `#string` vs number (or reverse) | schema drift or quoting | align the marker with the evidence |
| key `#notpresent` / `#present` | optional field | use `##type` for optional |
| `{ id: id }` is a string | relaxed JSON on `{` | `'#(id)'` or `({ id: id })` |
| works alone, fails in a suite | shared data, Background reset, ordering | unique data, `callonce`, `@lock=<name>` |
| url missing in a called feature | `url` resets in calls | `configure url = baseUrl` |
| 401/403 | missing or expired auth | `configure auth` with sysenv credentials |
| timing | async result | `retry until <js expression>`, not sleeps |
| precision | id above 2^53 | quote it as a string |
| parse error | step outside Background/Scenario, stray tokens | restructure the Gherkin |

## Never
- Never weaken a failing assertion to make it pass: no deleting `match`, no `#ignore` on a field that failed, no changing an expected value to the observed one without evidence that the new value is correct.
- Never add `karate.stop`, sleeps, or hard-coded URLs or secrets.
- Never rename scenarios or drop tags; do not re-order scenarios.
- If the evidence cannot decide, keep the assertion and tag the scenario `@ignore` with a `# NEEDS:` comment.

## Flakiness
Look for shared mutable data, reliance on scenario order, non-unique generated values, a Background that is assumed to persist, and unbounded waits. Fix with unique data (`karate.uuid()`), independent scenarios, `callonce` for expensive setup and `@lock=<name>` only for genuinely shared state.

## Rules
- V2-ASSERT-001: a repaired scenario still asserts its status.
- V2-LOCK-001: serialize shared state with `@lock=<name>`; the v1 parallel tag is silently ignored in v2.
```gherkin
# BAD
@parallel=false
# GOOD
@lock=orders
```
- Weakening is a repair failure:
```gherkin
# BAD: hides the mismatch
* match response == { id: '#ignore', total: '#ignore' }
# GOOD: fix the expected shape from evidence
* match response == { id: '#number', total: '#number' }
```
