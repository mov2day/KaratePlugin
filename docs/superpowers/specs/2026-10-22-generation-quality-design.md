# Generation Quality: Review and Plan

Status: **DRAFT for approval. No product code has been changed.**
Repository inspected: `20db9c6` (2.0.3). Scope: every generation mode (OpenAPI, Confluence, OpenAPI+Confluence, Postman, HAR/session, GraphQL, Jira, directory batch, Scout, AI enhance/repair).

## 1. Intent

Generated Karate suites should look like what a senior SDET would commit: maintainable, configuration-driven, reusable, consistent across modes, and verified before they are written. Today output is runnable-looking but shallow and hard-coded.

Success: the same quality bar and the same project layout regardless of source; environment/auth/test data live in separately maintained files; regeneration never destroys user edits; every written file passed an automated gate.

Non-goals: changing the UI flow, replacing AI providers, supporting non-Karate frameworks.
Anti-goals: tests that pass only because assertions are weak; more AI dependence (deterministic output must be good on its own); overwriting user-owned config.

## 2. Review findings (verified in code)

### A. Deterministic generator output is shallow (`karateGenerator.ts`)
1. Background hard-codes `def baseUrl = 'http://localhost:8080'` (l.446). No `karate-config.js`, no environments anywhere in `src` (grep: zero hits).
2. Positive assertion is `match response contains { a: '#notnull', ... }` on only the first 5 properties (l.162). No schema validation, types, formats, or required-vs-optional distinction. Only the first of 200/201/204 is asserted.
3. Negative/edge/security scenarios are guesses, not contract-derived: `request { invalid: true }`, id `99999999`, `status 405` for a wrong method, `Authorization = ''` expecting 401 even when the endpoint declares no security, SQL-injection path expecting `400 || 404`, `assert responseStatus == 400 || 422`. These will fail or pass for the wrong reasons against real APIs.
4. `securitySchemes`, declared error responses (4xx/5xx with schemas), required fields, enums, min/max, pagination, and examples are mostly unused. No CRUD chaining (create then read/update/delete), no data-driven Scenario Outlines.
5. Request bodies are inline docstrings; test data is not separated from steps.

### B. No configuration layer, and style config is partial
1. Settings are scattered: `testTemplate` (3 enum values), `structuringStrategy`, `autoTag`, `outputPath`, `sharedStylePath`, `smartTestData`, `scenarioOutlineThreshold`.
2. `KarateStyle.commentStyle` and `lineSpacing` are loaded and validated but never applied by the renderer; indentation maths is odd (`indent/2` repeats).
3. `TemplateManager` presets use `{{source}}` that is never substituted, `String.replace` only hits the first placeholder, and the presets add `Given url baseUrl` while the generator already emits `url` in Background.
4. `SmartValueGenerator` is partly wired via `openApiParser`, but `ScenarioOutlineBuilder` has no caller, so `scenarioOutlineThreshold`/data-driven generation appears to be a dead setting (to confirm in Phase 0).

### C. Skills are not reliably reaching the model (`agentSkillsService.ts`, `KaratePromptComposer.ts`)
1. Static map picks 2 of the 4 bundled skills per context; `karate-test-patterns` and `karate-reusability` are only used for Confluence/never. The six larger `.github/skills/*` (openapi-to-karate, postman-to-karate, formatting-style, advanced-patterns, api-testing, test-generation) are excluded by `.vscodeignore` and not in the map, so users never get them.
2. Guidance is cut with `content.slice(0, remaining)` at 8,000 chars, so a rule can be truncated mid-example.
3. Skills are only injected on the "enhance with AI" path of `copilotService`. Jira (`generateFromJira.ts`), Postman Copilot conversion, GraphQL, Scout explore and Bug Hunter build their own prompts with their own fence stripping.
4. ~2,900 lines of skills overlap heavily (DSL reference vs api-testing vs test-generation), and `skills-lock.json` references an unrelated "caveman" skill.

### D. Generation paths have diverged
Entry points: `GenerationService` (OpenAPI/Confluence/combined), `generateFromDirectory` (flat only, no structurer, no reuse), `GraphQLKarateGenerator` (own renderer), `postmanToKarateConverter` (own renderer, 969 lines, `.bak` copy still in `src`), `generateFromJira` (single AI call), `ScoutGenerator` (own renderer), plus direct `KarateGenerator` calls in `extension.ts` (l.522, 738, 750). Each applies a different subset of structuring, tagging, reuse, style, templates and validation.

### E. Weak quality gate
1. `KarateValidator` is **never called**, and two of its rules are wrong: `#present` is valid Karate (Scout and GraphQL emit it deliberately), and lowercase `method get` is valid (Scout emits it).
2. The AI output gate is a regex for `Feature:` + `Scenario:` and no fences. Failure silently returns the original, so the user cannot tell that enhancement did nothing.
3. One AI call per whole file with `maxTokens: 4096`, so large features can truncate; no repair loop; no parse/dry-run through the bundled Karate jar (`lib/karate-1.5.0.RC3.jar`).
4. Confluence mode emits `method get # TODO: Replace with actual API call` scenarios, which are not runnable and have no `@ignore`/draft marking (Scout does this correctly).

### F. Reuse engine is regex-driven (`ReusabilityEngine.ts`)
It lifts any line matching `token`, `url`, or `Authorization` into `common/*.feature`, which can change scenario semantics; stubs are written with `mock-token-123` and `localhost:8080`. Reuse is applied per file after the fact instead of being designed in.

### G. Tests
Two light generator tests and one service test. No golden-file tests per mode, no test that generated features parse or run, no skills/prompt regression tests.

## 3. Proposed design

### 3.1 One pipeline for every mode
```
Source adapter (OpenAPI | Postman | HAR | GraphQL | Jira | Confluence | Scout | Combined)
  → Normalized TestModel (operations, auth, data needs, evidence, source refs)
  → Scenario planner  (contract-driven strategies, pluggable per mode)
  → Renderer          (single Karate emitter honoring style + template)
  → Project scaffolder (config, data, schemas, helpers; create-if-missing)
  → AI refinement     (optional, per-feature chunk, skills-grounded)
  → Quality gate      (lint + validator + optional Karate parse/dry-run)
  → Writer            (marker headers, no-clobber, report)
```
Existing parsers/clients are kept as adapters; Scout keeps its journey semantics but shares renderer, scaffolder and gate.

### 3.2 Separately maintained, reusable configuration
Generated **once**, user-owned afterwards, referenced by every generated feature:
- `karate-config.js`: `karate.env` switch, `baseUrl` from env/system property, timeouts, `configure` defaults.
- `config/<env>.json` (or `karate-config-<env>.js`, see Decision 2): non-secret environment values. Secrets only via properties/env variables, never written.
- `common/` helpers: `auth.feature` (strategy chosen from `securitySchemes`), `headers.feature`, `cleanup.feature`, `data-setup.feature`, all `@ignore`.
- `data/<resource>.json` and Scenario Outline `Examples` for test data; `schemas/<resource>.json` response schemas used with `match response == schema`.
- `.karate-generator.json` (workspace): one file for style, naming, tag taxonomy, layout, scenario policy per category, enabled sources, AI refinement policy. It replaces `sharedStylePath` (still read for compatibility) and the scattered settings, with VS Code settings as overrides.

### 3.3 Better deterministic scenarios (all derived from the contract)
Status codes from declared responses; schema match not first-5-`#notnull`; required-field and enum/min/max negatives from schema constraints; 401/403 only where `security` applies; 404 with a created-then-deleted or generated id; CRUD chains with `callonce`/`call` setup and cleanup; Scenario Outlines for data-driven cases; tags from one taxonomy; consistent naming and traceability comment (`# source: openapi#operationId`). Guessed behaviors (405, SQLi) become opt-in, clearly tagged `@exploratory`, and not enabled by default.

### 3.4 Skills and prompts
- One **skill pack** in `skills/` with a manifest (`id`, `appliesTo` modes/tasks, `priority`, `budgetChars`, `requires`), shipped in the VSIX. `.github/skills` becomes a generated or removed copy, not an independent source.
- Split into short always-on **rules** and on-demand **reference** sections; trim duplicates; budget by whole section, never mid-example.
- A single `PromptBuilder` used by every AI path (generate, enhance, repair, Jira, GraphQL, Postman scripts, Scout) so fence stripping, evidence blocks, untrusted-input handling, output contract and skill selection are identical.
- AI refinement works per feature/scenario chunk, requires a structured diff-safe result, and a failed gate is **reported to the user** and retried once with the validator errors fed back.

### 3.5 Quality gate
Rewrite `KarateValidator` as a rule set shared with the linter (fix the two incorrect rules). Checks: syntax shape, unresolved placeholders/TODOs not marked `@ignore`, hard-coded URLs/secrets, missing config references, unreachable `read()` paths, duplicate scenario names, every scenario has a status assertion plus a body assertion. Optional parse/dry-run with the bundled jar when Java is present. Results appear in the generation summary and as linter diagnostics.

### 3.6 Regeneration without clobbering
Each generated file carries a header with generator version and a content hash. Unchanged → overwrite; changed by the user → write `*.generated.feature` alongside (or offer a diff); config/data files are never overwritten. `specHashManager` records the hashes.

## 4. Phases (each independently shippable and tested)

| Phase | Deliverable | Verification |
|---|---|---|
| 0 | Baseline: golden snapshot fixtures for every mode on `examples/sample-petstore.yaml` and small Postman/HAR/GraphQL/Jira/Confluence fixtures; confirm dead-code claims in B.4 | Snapshot tests green on current output |
| 1 | Foundation: `TestModel`, shared `Renderer`, `.karate-generator.json` loader, scaffolder (karate-config.js, env, common, data, schemas), quality gate, `PromptBuilder`, skill pack + manifest | Unit tests; generated project parses with Karate jar |
| 2 | OpenAPI + Combined + Directory on the pipeline (contract-driven scenarios, schemas, data, auth) | Updated goldens; execute against a mock server in CI |
| 3 | Postman, HAR/session, GraphQL on the pipeline | Goldens; Postman scripts → native Karate; no `.bak` |
| 4 | Jira, Confluence, Scout share renderer/config/gate; Confluence draft scenarios marked `@ignore` or AI-completed against a linked spec | Goldens; Scout suite tests keep passing |
| 5 | Remove dead code (old paths, `.bak`, unused settings), docs, CHANGELOG, settings migration | `npm run verify` |

Compatibility: all command IDs and existing settings stay; old settings map onto the new config file.

## 5. Decisions (resolved 2026-10-22)
1. **Karate 2.x is the target** (latest 2.1.4, Java 21+). Output must run on v2 and use v2-native features. v1-only idioms are not generated.
2. **Config layout:** default to the standard `karate-config.js` + `karate-config-<env>.js` (v2 loads the env file after the base file when `karate.env` is set). If the workspace already has `karate-config*.js`, **adopt it**: never overwrite, detect its variable names (`baseUrl` etc.) and reference those. Env-JSON mode stays available as an option.
3. **Exploratory scenarios** (wrong-method 405, injection, empty-auth): opt-in only, tagged `@exploratory`.
4. **Rollout:** one release containing all phases (phases stay as internal milestones, with tests per phase).
5. **Skills:** consolidate into one pack under `skills/`; `.github/skills` stops being an independent source.
6. **Quality target:** best-in-class with AI **and** without AI. The deterministic path must be good on its own; AI refinement only adds value on top and can never lower quality (it is gated and falls back visibly).

## 6. Karate v2 facts the generator and skills must follow
Verified against docs.karatelabs.io, the official migration guide and release notes (latest release v2.1.4, 2026-10-22).

| Area | v2 fact | Consequence for generation |
|---|---|---|
| Runtime | Java 21+, virtual threads, custom JS engine (no GraalJS) | Scaffold notes Java 21; avoid GraalJS-only interop; no `karate.toJava()` (deprecated no-op) |
| Parallel safety | `@parallel=false` is silently ignored; use `@lock=<name>` (feature or scenario) or `@lock=*` | Emit `@lock=<resource>` for scenarios that mutate shared state; `KarateV2Migrator` already converts the old tag |
| Env config | `karate-config.js` always; `karate-config-<env>.js` loaded after when `karate.env` set; auto-discovered from the working directory; keep config light (no auth calls, no big reads) | Scaffold base + env files; auth goes in `callonce` helper, never in config |
| Env access | `karate.sysenv(name, default)` and `karate.sysprop(name, default)` replace `karate.properties['x'] \|\| 'd'` | Use them for secrets/base URL overrides |
| Auth | Declarative `configure auth = { type: 'basic' \| 'bearer' \| 'oauth2' ... }`, inherited by called features, OAuth2 auto-refresh | Generate `configure auth` from OpenAPI `securitySchemes` instead of hand-rolled headers where it fits; credentials only from sysenv/sysprop |
| Assertions | Markers `#ignore #null #notnull #present #notpresent #array #object #boolean #number #string #uuid #regex #? expr`; `##` optional; `#[] #string`, `#[n]`, `match each`; `match response == schema`; new `match ... within { low, high }` | `#present` is valid (fix validator); prefer full `match response == schema` with `##` for optional; use `within` for ranges |
| Failures | Complete diffs per match; soft assertions via `configure continueOnStepFailure`; a comment directly above a `match`/`assert` becomes its failure label | Put a short intent comment above key assertions |
| Test data | `karate.faker.*`, `karate.uuid()`, `karate.copy()`; Scenario Outline columns auto-bound as variables, `col!` type hint evaluates JS, `__row`, `__num`, dynamic names `<col>` | Use variables not `<placeholder>` for values, faker/uuid for unique data (parallel safe), `karate.copy` before mutating loaded data |
| Gherkin strictness | A step outside Background/Scenario (e.g. after Examples) is now a parse error; stray tokens on a JS line are a `SyntaxError`; a JSON-literal RHS is relaxed JSON (use `#(x)` or paren-wrap JS) | Renderer must produce well-formed Gherkin; validator rule for stray steps and unquoted vars in JSON literals |
| Reuse | `callonce` per feature, `karate.callSingle` for suite-wide; `configure url` persists across calls but `url` resets; Background reruns per scenario; use `classpath:` for shared files; `@ignore` helpers | Match current reusability rules; helpers read with `classpath:` |
| Pitfalls | Large integers lose precision (use strings/BigDecimal); never commit `karate.stop()`; avoid heavy logic in features (Java instead) | Validator rules; schemas use `#string` for ids > 2^53 |
| Reports/logging | Reports mask credential headers by default; unified `configure logging`; JSONL events; JUnit/Cucumber JSON opt-in | Scaffold `logging` in env config; never print secrets |
| CLI | `karate run -t <tags> -T <threads> -e <env> -o <dir> -f <formats> features/`; **`-D/--dryrun` parses and expands outlines without executing** | The optional quality-gate "parse check" uses `karate run -D -o <tmp>` (or `Runner` with dryrun) when a v2 CLI/jar is present |
| Runner | `io.karatelabs.core.Runner`, `SuiteResult`, `karate-junit6` returning `Iterable<DynamicNode>` | Any generated runner uses the v2 API |
| Mock/extras | New mock server; `karate-boot.js` extension SPI | Out of scope for generation |

Open question to settle during implementation: the bundled `lib/karate-1.5.0.RC3.jar` is v1. The dry-run gate must locate a v2 CLI (the existing `KarateCliExecutor`/`ConfigDiscovery` already resolve one) and otherwise degrade to the static validator, never failing generation because Java is missing.

## 7. Skill pack design (v2-grounded)
Pack in `skills/` with a `manifest.json`. Each skill is short, single-purpose, v2-accurate, and versioned with the Karate version it was verified against.

| Skill id | Role | Loaded for |
|---|---|---|
| `karate-v2-core` | Always-on rules: v2 syntax, markers, Gherkin strictness, anti-hallucination, output contract | every task |
| `karate-project-config` | karate-config(.env).js, sysenv/sysprop, `configure auth/logging`, env adoption, secrets handling | every generate task |
| `karate-assertions-schemas` | match/schema patterns, `##` optional, `within`, soft assertions, failure labels | generate/enhance/repair |
| `karate-data-driven` | Outline/Examples, `col!`, `__row`, faker/uuid, CSV/JSON data, `karate.copy` | generate/enhance |
| `karate-reuse-isolation` | callonce/callSingle, `@ignore` helpers, `classpath:`, `@lock`, cleanup, parallel safety | generate/enhance/repair |
| `karate-source-openapi` | contract to scenarios: statuses, schemas, constraints, security, CRUD chains | openapi, combined, directory, coverage gaps |
| `karate-source-postman` | variables/auth/scripts/tests to native Karate; unsupported-script policy | postman |
| `karate-source-har-session` | evidence-only conversion, dynamic value extraction, de-duplication | har, session |
| `karate-source-graphql` | query/variables/errors patterns, `data`/`errors` asserts | graphql |
| `karate-source-requirements` | Jira/Confluence acceptance criteria to traceable scenarios, `@ignore` drafts when contract unknown | jira, confluence |
| `karate-repair` | minimal-diff repair, failure categories, never weaken assertions | repair, flakiness |
| `karate-review-checklist` | the same rules as the quality gate, used for AI self-review | enhance, review |

Selection is by `{mode, task}` from the manifest, with per-skill `budgetChars` and whole-section trimming. The same rule IDs (for example `V2-LOCK-001`) are shared by skills, the validator and the linter so a gate failure can be fed back to the model by rule ID.
