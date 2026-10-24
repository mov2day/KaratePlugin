# Generation quality plan (all flows)

Branch: `feat/generation-quality`. Status: approved, Phase 0 in progress.

## Problem

User feedback after testing auth support:

1. Auth from OpenAPI is still not parsed properly.
2. Too many tests land in a single feature file, with no grouping.
3. Generated tests are mostly status-code checks. They need to cover business cases and response quality.

None of this is OpenAPI-only. The planner is the only flow that gets grouping, data factory, schema assertions and CRUD chains. The other flows re-implement part of that or skip it.

## Current state per flow

| Flow | Grouping | Auth | Assertions |
|---|---|---|---|
| OpenAPI (`plan/OpenApiPlanner.ts`) | domain (first tag) x kind (main/crud/security); no cap | see gaps below | status + type-level schema match |
| Postman (`adapters/postman.ts`) | one feature per folder or flat; no cap | bearer/basic/apikey/oauth2 blocks; one scheme; scripts ignored | status + converted `pm.test`; saved examples unread |
| HAR (`adapters/har.ts`) | one file, one scenario with every request | bearer/basic only; cookies dropped | recorded status + types-only schema + id chains |
| GraphQL (`adapters/graphql.ts`) | `-queries` / `-mutations` | none | `errors == '#notpresent'` + type markers |
| Requirements (`adapters/requirements.ts`) | one file, one scenario per criterion | via planner | via planner builder |
| Scout (`services/scout`) | one `journey.feature` | own fixture setup | status + confirmed pointers; skips `runPipeline` |

`services/postmanToKarateConverter.ts` has no callers (dead code, leave for a separate cleanup).

## OpenAPI auth gaps

- `$ref`'d entries in `components.securitySchemes` are dropped (`adapters/openapi.ts:208-212`).
- `mutualTLS` and non basic/bearer `http` schemes are dropped silently.
- One scheme is configured, picked by declaration order, not by use.
- oauth2: only clientCredentials; scopes ignored. openIdConnect is a static bearer; `openIdConnectUrl` unused.
- Optional auth (`{}` alternative) is dropped, so a 401 test is generated for ops that allow anonymous access.
- `Bearer` is hardcoded in `OpenApiPlanner.ts:628`; query/cookie names are unquoted in 403/empty-credential steps; `apiKey.in` is case-sensitive; unknown scheme names in `security` give no warning.

## Grouping gaps

- Files split only by domain (`tags[0]`) and kind. Positive, negative, boundary, edge and exploratory all go to one main file (`OpenApiPlanner.ts:177, 182-188`).
- No scenario cap, no category split, no sections inside a file. `flat` puts the whole API in one file.

## Assertion gaps

- Only `status N` + type-level schema match. Formats (email/date/uri), `minItems`/`uniqueItems`, headers, content-type, examples, list contents and error bodies are never asserted.
- `ResponseModel.example` / `contentType` are captured but unused. Response headers, links and descriptions are not captured.
- One CRUD chain only; it compares one field. GET-by-id uses hardcoded id `1`.
- `ASSERT-002` is satisfied by `match response == '#object'`.
- AI refiner is "never invent / never add"; no business context.

## Shared architecture

1. **Layout stage.** Source-neutral step in `runPipeline` (at the `i.scenarios` branch, `GenerationPipeline.ts:154`). Input: `PlannedFeature[]` + `layout` config. Owns file naming, resource/category/tag splits, public/secured split, scenario caps, section markers. Extracted from `Planner.baseFor` / `assemble`.
2. **Auth layer.** `SecurityScheme` + `planAuth` are the single auth model. Multi-scheme `auth.feature`, scheme chosen by use. GraphQL gets an auth hint; Postman/HAR get per-request scheme detail; Scout gets a bridge.
3. **Assertion enrichers.** Shared `assertionsFor(op, status)` extracted from the planner's response matcher and `schemaMatch`; HAR's `schemaOf` folds in. Adapters supply real `example`/`schema` (Postman from saved examples, HAR from observed bodies, GraphQL from schema types).

## Phases

- **Phase 0 (~1d): layout stage + `TestModel` extensions.** `PlannedFeature` gets category and tags. Opt-in first; existing goldens stay stable. Adapters adopt one at a time.
- **Phase 1 (~1d): auth layer.** OpenAPI fixes, then Postman, HAR, GraphQL, then the Scout bridge.
- **Phase 2 (~1-2d): layout adoption per flow.** HAR split into flows and scenarios; Postman/GraphQL by resource and category; Requirements by feature; Scout with scenario sections.
- **Phase 3 (~3-4d): enrichers.**
  - 3a richer model: response headers, links, descriptions, examples per status, formats, array bounds, error schemas.
  - 3b contract checks: Content-Type, Location/ETag, formats, array bounds, pagination shape, optional response-time budget.
  - 3c echo checks: full payload compared after create/update.
  - 3d business scenarios: create then list contains it, update then verify, delete then gone; duplicate create (409); idempotent retry; error-body assertions; ids from a Background instead of hardcoded `1`.
  - 3e AI business-enrich mode: opt-in, marks `# AI-proposed`, must pass AI-002/003/006 guards.
  - 3f quality gate: warn on status-only scenarios, header-less 2xx, error without body, `#object`-only match.
- **Phase 4 (~0.5d): verify.** Generation test suite, golden diff review per flow, lint, build.

Phases 0 and 1 share few files and can run in parallel. Phase 2 needs 0; Phase 3 needs 0 and 1.

## Decisions (defaults taken, open to change)

1. New layout is default for new output only; `layout.legacy` keeps old paths.
2. AI business-enrich is opt-in.
3. Scout shares the quality gate and enrichers first; moving onto `runPipeline` is deferred.
4. Legacy `PostmanToKarateConverter` is left in place.
5. Response-time budget is off by default.

## Execution

Sonnet subagents. Each gets a short brief and returns a summary under 300 words. (`haiku` maps to a nonexistent model in this environment; use it for fixture/golden refreshes only if that is fixed.)

## Phase 1 notes

Done: OpenAPI scheme parsing ($ref'd schemes, case-insensitive `apiKey.in`, warnings for mutualTLS, other `http` schemes, invalid `in` and unknown scheme names, `optionalAuth` on operations), primary scheme chosen by use (`planAuth(schemes, operations)`), oauth2 password flow and scopes, `openIdConnectUrl` recorded, Bearer/Basic/raw credentials derived from the scheme, optional GraphQL `auth` hint, Postman/HAR usage-based primary and HAR API key header classification.

Left for later:

- Scout (`services/scout/*`, `saveSuite.ts`, `ScoutGenerator.ts`) still builds its own fixture/auth setup and never reads `SecurityScheme` or `common/auth.feature`. Bridging it means feeding its captured auth into `planAuth` and calling `auth.feature` from its Background.
- GraphQL `auth` is an input field only; no command, setting or UI passes it yet (`commands/generateFromGraphQL.ts` would need a setting in `package.json`).
- oauth2 authorizationCode/implicit stay unsupported (they need a browser login); use `API_TOKEN` with a bearer scheme.
- The password flow in `auth.feature` requests the token with explicit `form field` steps; the Karate v2 `configure auth` oauth2 keys (including `scope`) are unverified, like the rest of `configure auth` persistence.
- Only one of bearer/basic/oauth2/openIdConnect can be active (they share `Authorization`); apiKey header, query and cookie schemes combine with it.

## Phase 2 notes

Done:

- HAR: sessions with more than 8 requests are split into one scenario per resource run (first named path segment after `api`/version prefixes). A request that reuses an id captured earlier pulls everything between producer and consumer into the same scenario, so id chains stay together. Scenarios are named `<name>: <resource> flow` and carry `domain`. Short sessions and the drafted cross-origin scenario are unchanged.
- Postman: scenario category now includes `security` (a 401/403 status assertion); previously those were `negative`. Category and domain were already set in flat mode, so `layout.splitBy` works on flat output.
- GraphQL: no adapter change needed beyond the layout stage reading the `@exploratory` tag as the exploratory category (`KarateScenario.category` has no such value). Positive/negative already carried categories; `-queries`/`-mutations` files are kept.
- Requirements: when matched criteria span two or more operation domains, one file per domain (`<root>-<domain>-requirements.feature`); unmatched drafts stay in `<root>-requirements.feature`. One domain or none keeps the single file.
- LayoutStage: `splitBy: 'tag'` (first scenario tag that is not a category/draft tag or a `key=value` tag, else `untagged`) and `'path'` (scenario `domain`, else `general`) are implemented. The first group keeps the original file name. `layoutWarnings` and its pipeline call are removed.

Deferred:

- Scout stays on its own path: one `journey.feature`. Section markers or category naming were not added; baseline and variant scenarios carry no category today, so it needs more than a renderer flag.
- The `tag` split uses a fixed category taxonomy, not the configured one.
- HAR split does not consider the `layout.strategy` or run per-resource files itself; use `splitBy: 'path'` for that.

## Phase 3c/3d notes

Done, OpenAPI planner only, behind `scenarios.business: 'on'` (default `off`, output unchanged):

- 3c: the CRUD chain compares every plain request field (not readOnly/writeOnly, not id/timestamp/secret-like, not date formats, absent-from-response fields skipped) with `match response.f == payload.f` after create, read and update, then re-reads after update. The chain also gets the contract checks (Content-Type, Location) under `responseChecks: 'contract'`.
- 3d: `@business` scenarios in the `-crud` file: create then list contains the item (`karate.jsonPath(response, '$[*].id') contains id`; a plain `contains { id: .. }` compares whole list elements in Karate, so it is not used), delete then list `!contains` plus a repeat DELETE 404, duplicate create 409, PUT repeated (same status and echoed fields), DELETE repeated (only when 204 is declared, 404 is not, and the read declares 404), error-body structure for 400/422/409 (`message`/`code`/`error` string fields), and `@ignore` drafts for status/state enums with 3 or more values that have an action sub-path or a PUT/PATCH carrying the field. Standalone by-id scenarios (positive and boundary) create their resource first and clean it up; resources without a create operation keep id `1`.

Verified against a local mock server with the Karate 1.5.0.RC3 jar after replacing the v2-only `karate.copy`/`karate.uuid` calls: all business and lifecycle scenarios passed. Remaining failures were existing ones (empty list vs `each`/`#[] #object` on a fresh mock, the hardcoded-id action path).

Deferred: Postman, HAR (chains already exist), GraphQL and Scout have no spec-derived relationships between operations, so they get none of this; requirements mapping (`scenarioFor`) keeps the sample id; action sub-path scenarios keep the sample id; state-transition drafts do not guess the legal transitions; the AI business-enrich mode (3e) and the quality-gate rules (3f) are separate.

## Phase 3e/3f notes

Done:

- 3e: `ai.enrich: 'off' | 'business'` (default `off`). With `business` and AI on, `runPipeline` appends a `business-context` evidence item (`ai/BusinessContext.ts`) and refines with the new `enrich-business` task (extra contract bullets in `PromptBuilder`, skill `karate-business-invariants`, also added to the openapi source, assertions and checklist skills for that task only). New guard `V2-AI-007` runs only for that task: every scenario in the output that matches no input scenario needs a `# AI-proposed: <reason>` comment and must have no gate errors in its own lines. AI-002/003/006 are unchanged. With `off` the prompts and results are identical.
- 3f: `V2-ASSERT-003` to `006`, warnings only, skipping `@ignore`/`@draft`/`@exploratory`. On the petstore fixtures under basic, contract and business modes only `petstore-secured` draws warnings (`V2-ASSERT-005`: 1, 1 and 2). No golden changed.

Decisions to check:

- ASSERT-003 and 006 never repeat an ASSERT-002 finding (a scenario with no assertion at all). So 003 means status plus timing/media-type only, and 006 needs some other assertion present. A literal reading would double-report the common status-only case.
- ASSERT-005 skips 401/403 and `@security` scenarios (framework-defined bodies) and covers 4xx only, not 5xx.
- The proposal comment may sit in the scenario or directly above its tags/header (the parser files a comment above a header under the previous scenario).

Left undone: no guard compares existing assertions one by one (the prompt forbids weakening them); assertions added inside existing scenarios are not required to carry the comment; business context is built from the model only, so Postman/HAR/GraphQL get little (no descriptions or enums); `ai.enrich` has no VS Code setting.

