# Generation Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every generation mode produce Karate v2 suites that are maintainable, configuration-driven, reusable and verified, with strong output both without AI and with AI refinement, shipped as one release.

**Architecture:** A vscode-free `src/generation/` library: source adapters build a normalized model, a planner derives scenarios from the contract, one renderer emits Karate v2 Gherkin, a scaffolder creates user-owned config/data/schema/helper files only when missing, an optional AI refiner works per feature behind a rule-based quality gate, and a writer marks and protects files. Thin vscode glue (settings, progress, UI) calls the pipeline. Skills become one manifest-driven pack whose rule IDs are shared with the gate.

**Tech Stack:** TypeScript (strict, CommonJS, ES2020), VS Code API only in glue, `@apidevtools/swagger-parser`, Node `assert` scripts under `scripts/` run against `out/` (existing pattern, e.g. `scripts/test-ai-routing.cjs`).

**Spec:** `docs/superpowers/specs/2026-10-22-generation-quality-design.md`

## Global Constraints

- Target **Karate 2.x** (latest verified 2.1.4), **Java 21+**. Never generate v1-only idioms: `@parallel=false` (use `@lock=<name>`/`@lock=*`), `karate.toJava()`, `karate.properties['x'] || 'd'` (use `karate.sysprop`/`karate.sysenv` with a default), `HttpLogModifier`, `logPrettyRequest`-style keys (use `configure logging`).
- Standard config layout: `karate-config.js` + `karate-config-<env>.js` (base then env). An existing `karate-config*.js` is **adopted, never overwritten**; env-JSON mode is an option.
- `#present`, `#notpresent`, lowercase `method get`, and `##` optional markers are valid Karate and must never be flagged.
- Exploratory scenarios (wrong method 405, injection, empty-auth) are **opt-in** and tagged `@exploratory`.
- Secrets are never written to disk; credentials come from `karate.sysenv`/`karate.sysprop` only. Config/data/schema/helper files are created only if missing.
- Deterministic output must be good with AI off; AI may only refine, must pass the gate, and a failed refinement is **reported**, never silent.
- `src/generation/**` must not import `vscode` or `../utils/logger`.
- All existing command IDs and settings keep working; old settings map onto `.karate-generator.json`.
- Shared files (helpers, data, schemas) are read with `classpath:`; feature-local files with relative paths.
- Rule IDs have the form `V2-<AREA>-<NNN>` and are identical in skills, gate, and linter.

## Review Focus

1. OpenAPI with no `securitySchemes`, or `security: []` on one operation: no auth step and no 401/403 scenario is generated for it.
2. Spec using `allOf`/`oneOf`/`$ref` cycles, only a `default` response, or only non-JSON bodies (`multipart/form-data`, `application/x-www-form-urlencoded`, `text/plain`): generation completes, uses supported parts, and marks the rest `@ignore` with a reason.
3. Workspace already has `karate-config.js` using other variable names (`apiUrl`, `host`) or `karate-config-<env>.js`: scaffold leaves them untouched and generated features reference the detected URL variable.
4. Regenerating over a file the user edited: user content is never lost; a `*.generated.feature` sibling or diff is produced and reported.
5. AI returns fenced text, truncated output, a different feature, or invented endpoints: the original deterministic feature is kept, the failure is reported with rule IDs, and exactly one retry carries those IDs.

---

### Task 0: Branch, fixtures and golden harness

**Files:**
- Create: `scripts/test-generation.cjs`, `scripts/fixtures/generation/openapi/petstore-secured.yaml` (copy of `examples/sample-petstore.yaml` plus `securitySchemes` bearer + apiKey, one `security: []` operation, one `allOf`, one `multipart` body), `scripts/fixtures/generation/{postman,har,graphql,jira,confluence}/*` (one small realistic fixture each), `scripts/fixtures/generation/golden/` (generated)
- Modify: `package.json` (script `test:generation`: `npm run compile && node ./scripts/test-generation.cjs`; append to `verify`)

**Interfaces:**
- Produces: `scripts/test-generation.cjs` exposing helpers `golden(name, text)` (compares to `golden/<name>`; rewrites when `UPDATE_GOLDEN=1`) and a `suite(name, fn)` runner; later tasks append suites to this one file by requiring `scripts/generation-tests/<area>.cjs` modules.

- [ ] **Step 1:** `git switch -c feat/generation-quality`.
- [ ] **Step 2:** Write the runner so it loads every `scripts/generation-tests/*.cjs`, runs each exported `{ name, run }`, prints pass/fail, exits non-zero on any failure. Add an initial test `no-vscode-in-generation` that fails if any file under `out/generation/` requires `vscode` or `utils/logger` (passes vacuously now).
- [ ] **Step 3:** Capture **baseline goldens** of today's output for OpenAPI flat+domain, Postman, GraphQL, Scout using the current classes (`KarateGenerator`, `PostmanToKarateConverter`, `GraphQLKarateGenerator`, `generateScoutSuite`) into `golden/baseline/` so reviewers can diff old versus new.
- [ ] **Step 4:** Run `npm run test:generation`. Expected: PASS (baseline recorded).
- [ ] **Step 5:** Commit `test: add generation golden harness and baselines`.

### Task 1: Model, config schema and resolver

**Files:**
- Create: `src/generation/model/TestModel.ts`, `src/generation/config/GeneratorConfig.ts`, `scripts/generation-tests/config.cjs`
- Modify: `src/types/index.ts` (`KarateScenario` gains `examples?: { columns: string[]; rows: string[][] }`, `comments?: string[]`, `source?: string`, `draftReason?: string`)

**Interfaces:**
- Produces (`TestModel.ts`): `SourceKind = 'openapi'|'postman'|'har'|'graphql'|'jira'|'confluence'|'combined'|'scout'|'session'`; `SecurityScheme { name; kind: 'basic'|'bearer'|'apiKey'|'oauth2'|'openIdConnect'; in?: 'header'|'query'|'cookie'; paramName?: string; tokenUrl?: string }`; `ParamModel { name; required: boolean; schema: JsonSchema }`; `BodyModel { contentType: string; schema?: JsonSchema; example?: unknown }`; `ResponseModel { status: string; schema?: JsonSchema; contentType?: string }`; `OperationModel { id; method; path; summary?; tags: string[]; pathParams; queryParams; headerParams; body?: BodyModel; responses: ResponseModel[]; security: string[] | 'none' | 'inherit'; sourceRef: string }`; `GenerationModel { source: SourceKind; name: string; baseUrl?: string; schemes: SecurityScheme[]; operations: OperationModel[]; unsupported: { sourceRef: string; reason: string }[] }`; `JsonSchema = Record<string, any>`.
- Produces (`GeneratorConfig.ts`): `GeneratorConfig` (below) and `resolveGeneratorConfig(file: unknown, settings: Partial<GeneratorConfig>): { config: GeneratorConfig; warnings: string[] }`, `DEFAULT_GENERATOR_CONFIG`.

```ts
interface GeneratorConfig {
  karateVersion: '2';
  layout: { outputRoot: string; strategy: 'domain'|'flat'|'method'; classpathRoot: string };
  config: { mode: 'standard'|'env-json'; urlVariable: string; envs: string[] };
  style: KarateStyle;
  tags: { auto: boolean; taxonomy: Record<'positive'|'negative'|'edge'|'boundary'|'security'|'exploratory', string> };
  scenarios: { categories: ('positive'|'negative'|'edge'|'boundary'|'security')[]; exploratory: boolean; crud: boolean; outlineThreshold: number };
  data: { smart: boolean; externalize: boolean };
  ai: { refine: boolean; maxRetries: 1; chunk: 'feature'|'scenario' };
  gate: { dryRun: 'auto'|'off'; failOn: 'error'|'never' };
}
```

- [ ] **Step 1:** Write failing tests in `config.cjs`: defaults resolve with `exploratory === false`, `config.mode === 'standard'`, `urlVariable === 'baseUrl'`; a file overriding `style.indentation` wins over settings; an unknown key yields a warning, not an error; invalid `layout.strategy` falls back to default with a warning; legacy `sharedStylePath` JSON (indentation/variableCase/commentStyle/lineSpacing) is accepted as `style`.
- [ ] **Step 2:** Run `npm run test:generation`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement the types and `resolveGeneratorConfig` (precedence: file > settings > defaults; pure, no I/O).
- [ ] **Step 4:** Run tests. Expected: PASS. **Step 5:** Commit `feat(generation): model and generator config resolver`.

### Task 2: Config loader and project discovery (adopt existing)

**Files:**
- Create: `src/generation/config/ProjectDiscovery.ts`, `src/generation/vscode/GeneratorConfigLoader.ts`, `scripts/generation-tests/discovery.cjs`
- Modify: `package.json` (settings: `karateDsl.generation.configFile` default `.karate-generator.json`, `karateDsl.generation.exploratory` boolean false, `karateDsl.generation.configMode` enum standard/env-json), `src/utils/configManager.ts` (accessors)

**Interfaces:**
- Produces: `discoverProject(root: string, fsApi?: FsLike): ProjectInfo` where `ProjectInfo { classpathRoot: string; baseConfig?: { path; urlVariable?: string; variables: string[] }; envConfigs: string[]; hasEnvJson: boolean; runnerStyle: 'junit6'|'cli'|'unknown' }`; `GeneratorConfigLoader.load(workspaceRoot: string): Promise<{ config: GeneratorConfig; warnings: string[]; source: 'file'|'settings'|'defaults' }>` (vscode side, reads settings, calls `resolveGeneratorConfig`).
- `FsLike = { exists(p): boolean; read(p): string; list(dir): string[] }` so tests use an in-memory fs.

- [ ] **Step 1:** Tests with an in-memory fs: (a) `src/test/java/karate-config.js` with `var config = { apiUrl: '...' }` → `baseConfig.urlVariable === 'apiUrl'`, `classpathRoot === 'src/test/java'`; (b) `src/test/resources/karate-config.js` using `baseUrl` → `urlVariable === 'baseUrl'`; (c) `karate-config-staging.js` present → `envConfigs` contains `'staging'`; (d) no config → `baseConfig` undefined and `classpathRoot` defaults to `src/test/java`; (e) config exporting via `return { host: ... }` detects `host`; (f) a config whose URL variable cannot be detected → `urlVariable` undefined (caller falls back to `baseUrl`).
- [ ] **Step 2:** Run; expect FAIL. **Step 3:** Implement with regex scanning for `(\w*[uU]rl|host)\s*:` on the first returned object literal (`var config = {…}` or `return {…}`); no JS evaluation.
- [ ] **Step 4:** Implement `GeneratorConfigLoader` and the settings; run tests (PASS). **Step 5:** Commit.

### Task 3: Quality rules and gate

**Files:**
- Create: `src/generation/quality/FeatureParser.ts`, `src/generation/quality/rules.ts`, `src/generation/quality/QualityGate.ts`, `scripts/generation-tests/quality.cjs`
- Modify: `src/utils/karateValidator.ts` (delegate to the gate; delete wrong rules)

**Interfaces:**
- Produces: `parseFeature(text: string): ParsedFeature` (`{ lines; tags; scenarios: { name; tags; startLine; endLine; steps: { line; keyword; text }[]; isOutline }[]; background?: ... }`); `Finding { ruleId: string; severity: 'error'|'warning'; line: number; message: string; fix?: string }`; `QualityContext { knownFiles?: Set<string>; config?: GeneratorConfig }`; `runGate(text: string, ctx?: QualityContext): { findings: Finding[]; ok: boolean }` (`ok` false iff an `error` exists).
- Rules (ID → meaning, severity): `V2-GHERKIN-001` step outside Background/Scenario (error); `V2-LOCK-001` `@parallel=false` (error); `V2-CFG-001` literal `url 'http…'` in a feature (error); `V2-CFG-002` request made with no `url`/`configure url` reachable from Background or scenario (error); `V2-SEC-001` literal bearer/basic/api-key/password value (error); `V2-ASSERT-001` scenario with a `method` step and no `status` assertion (error); `V2-ASSERT-002` 2xx scenario with no `match`/`assert` body check (warning); `V2-DRAFT-001` TODO/placeholder step outside an `@ignore` scenario (error); `V2-DUP-001` duplicate scenario name (error); `V2-API-001` `karate.stop(` (error); `V2-API-002` `karate.toJava(` (warning); `V2-NUM-001` integer literal above 9007199254740991 (error); `V2-REF-001` `read('classpath:…')` pointing at a file not in `knownFiles` (error, only when `knownFiles` provided); `V2-TAG-001` category tag not from the configured taxonomy (warning).

- [ ] **Step 1:** Tests: one fixture string per rule that triggers exactly its ID at the right line; and a "clean" fixture proving **no findings** for `#present`, `#notpresent`, lowercase `method get`, `##string`, `@lock=orders`, and a `@ignore` scenario containing `# TODO`.
- [ ] **Step 2:** Run; expect FAIL. **Step 3:** Implement parser (line-based, tolerant of CRLF) and rules as data (`{ id, severity, check(parsed, ctx) }[]`).
- [ ] **Step 4:** Replace `KarateValidator.validateFeatureContent` body with `runGate(...).findings.map(f => ...)` and remove `#present`/uppercase-method checks. **Step 5:** Run tests; commit.

### Task 4: Feature renderer

**Files:**
- Create: `src/generation/render/FeatureRenderer.ts`, `scripts/generation-tests/render.cjs`
- Modify: `src/services/karateGenerator.ts` (`featureToString` delegates to renderer; keep public API)

**Interfaces:**
- Consumes: `KarateFeature`, `KarateStyle`, `GeneratorConfig['tags']`.
- Produces: `renderFeature(feature: KarateFeature, opts: { style: KarateStyle; header?: string[]; featureTags?: string[] }): string`; `renderScenario(s: KarateScenario, style: KarateStyle): string`.

- [ ] **Step 1:** Tests: 2-space and 4-space indentation applied consistently to Background/steps/docstrings; `lineSpacing` honored; `commentStyle` `hash` only (doubleSlash is converted to `#` with a note since Karate has no `//` Gherkin comments); scenario with `examples` renders `Scenario Outline:` + `Examples:` table with aligned pipes and `col!` headers preserved; tags rendered one line; `draftReason` renders `@ignore` plus `# Draft: <reason>`; `comments` render directly above their step as `#` lines; output ends with one newline; round-trip `parseFeature(renderFeature(f))` yields the same scenario names.
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement; replace the odd `indent/2` arithmetic with an explicit depth parameter. **Step 4:** PASS; rebase goldens with `UPDATE_GOLDEN=1` and review the diff in the PR. **Step 5:** Commit.

### Task 5: Scaffolder and output writer

**Files:**
- Create: `src/generation/scaffold/ProjectScaffolder.ts`, `src/generation/write/OutputWriter.ts`, `scripts/generation-tests/scaffold.cjs`
- Modify: `src/utils/fileUtils.ts` (writer uses it for I/O only), `src/services/specHashManager.ts` (store generated-file hashes)

**Interfaces:**
- Produces: `planScaffold(ctx: { project: ProjectInfo; config: GeneratorConfig; model: GenerationModel }): ScaffoldFile[]` where `ScaffoldFile { path: string; content: string; owner: 'user'|'generated'; reason: string }`; `OutputWriter.write(files: { path; content; owner }[], fsApi: FsLike & { write(p, c): void }, history: HashStore): WriteReport` where `WriteReport { created: string[]; updated: string[]; skippedExisting: string[]; sideBySide: { path; generatedPath }[] }`; `HashStore { get(path): string|undefined; set(path, hash): void }`.
- Scaffold set (standard mode): `karate-config.js` (only if no base config) with `karate.env` default `dev`, base URL `karate.sysprop('baseUrl', <spec server url or 'http://localhost:8080'>)`, timeouts via `karate.configure`, `configure logging` with credential masking, no auth calls; `karate-config-<env>.js` for each configured env (dev/staging by default) with overrides and a `throw` when a required secret is missing in non-dev; `common/auth.feature` (`@ignore`, chosen from `schemes`: uses `configure auth` for basic/bearer/oauth2, header/param for apiKey, secrets from `karate.sysenv`); `common/utils.feature` (`@ignore`, `uuid`, `randomInt` via `karate.uuid()`/`karate.faker`); `data/<resource>.json` and `schemas/<resource>.json` are produced by the planner (Task 7), not here. `env-json` mode emits `config/<env>.json` plus a `karate-config.js` reading it with `karate.read('classpath:config/' + env + '.json')`.
- Generated feature files get header lines `# Generated by Karate Test Management <version> | source: <ref> | hash: <sha256-of-body>`; the writer overwrites a `generated` file only if its current body hash equals the recorded hash, else writes `<name>.generated.feature` and lists it in `sideBySide`; `owner: 'user'` files are never overwritten.

- [ ] **Step 1:** Tests: existing user `karate-config.js` is in `skippedExisting` and unchanged; fresh project yields base config + `karate-config-dev.js` + `karate-config-staging.js`; no emitted file contains a literal token/password; bearer scheme → `configure auth = { type: 'bearer', token: ... }` reading `karate.sysenv('API_TOKEN', '')` wiring; apiKey-in-header scheme → `header <paramName> = ...`; regenerating unchanged content yields `updated` (no side-by-side); modifying a generated file then regenerating yields `sideBySide` and the user's edit intact; CRLF files treated the same.
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement both modules (pure; fs injected). **Step 4:** PASS. **Step 5:** Commit.

### Task 6: OpenAPI model extraction

**Files:**
- Modify: `src/services/openApiParser.ts`
- Create: `src/generation/adapters/openapi.ts`, `scripts/generation-tests/openapi-model.cjs`

**Interfaces:**
- Consumes: `OpenAPIParser.parseSpec` (dereferenced via `SwaggerParser.validate`).
- Produces: `OpenAPIParser.parseModel(filePath: string): Promise<GenerationModel>` and pure `buildOpenApiModel(api: any, sourceName: string): GenerationModel` (adapter file) so tests pass plain objects. Handles OAS 2 and 3: `securitySchemes`/`securityDefinitions`, global and per-operation `security` (`[]` → `'none'`), `servers[0]` (with variable defaults), per-status responses with the first JSON schema, `default` response, parameters merged from path-item level, `allOf` merged shallowly, `oneOf`/`anyOf` taking the first branch with a recorded note, non-JSON bodies pushed to `unsupported` with reason.
- `parseSpec` keeps returning `OpenAPIEndpoint[]` for existing callers.

- [ ] **Step 1:** Tests on the petstore-secured fixture: bearer scheme extracted with `kind 'bearer'`; operation with `security: []` has `security === 'none'`; path-item parameters appear on each operation; `default`-only response operation has one `ResponseModel` with `status 'default'`; multipart operation appears in `unsupported` with a reason mentioning `multipart`; `allOf` schema merged into one object schema with all properties and a union of `required`; cyclic `$ref` does not hang (depth capped at 5).
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit.

### Task 7: OpenAPI scenario planner (deterministic)

**Files:**
- Create: `src/generation/plan/OpenApiPlanner.ts`, `src/generation/plan/schemaMatch.ts`, `src/generation/plan/dataFactory.ts`, `scripts/generation-tests/planner.cjs`
- Modify: `src/services/data/SmartValueGenerator.ts` (expose pure `generateValue(schema, name)`; keep static `generate`), `src/services/data/ScenarioOutlineBuilder.ts` (wire or delete per Task 19 decision recorded in its commit)

**Interfaces:**
- Produces: `planOpenApi(model: GenerationModel, config: GeneratorConfig): { features: PlannedFeature[]; files: { path; content; owner: 'user' }[]; warnings: string[] }` where `PlannedFeature { relativePath; feature: KarateFeature }` (`files` = `data/<resource>.json`, `schemas/<resource>.json`); `toKarateSchema(schema: JsonSchema, opts: { optionalAsDoubleHash: boolean }): unknown` producing Karate markers (`#string`, `#number`, `#boolean`, `#uuid` for `format: uuid`, `#regex` for `pattern`, `##<marker>` for non-required, `'#[] <schemaRef>'`/`#[]` for arrays, ids over 2^53 as `#string`).
- Planned scenarios per operation, category from config: **positive** — success status from the lowest declared 2xx (all declared 2xx noted in a comment), `match response == <schema>` read from `schemas/<resource>.json` via `read('classpath:schemas/..')`, `within` for numeric ranges with min/max, request body from `data/<resource>.json` copied with `karate.copy` and unique fields via `karate.uuid()`/`karate.faker`; **negative** — one scenario per *declared* 4xx response (400 only if declared; body built by removing a required field or violating an enum/min/max/format taken from the schema; 404 for path-param operations using a `karate.uuid()` id; 401/403 only when `security` is not `'none'` and the operation declares or inherits a scheme, run with `configure auth` unset); **edge/boundary** — min/max/length from the schema as a Scenario Outline with `Examples` when rows ≥ `outlineThreshold`; **CRUD chain** (when `crud` true and POST+GET+PUT/PATCH+DELETE share a resource): one `@crud` feature using `callonce read('classpath:common/auth.feature')`, create → read → update → delete → read expects 404, cleanup in a `@lock=<resource>` scenario when state is shared; **exploratory** (only when `config.scenarios.exploratory`): 405 wrong method, injection strings, empty auth, all tagged `@exploratory` with a `# Exploratory: expectation is not declared in the contract` comment and asserting only `responseStatus < 500`.
- Every scenario carries `source: '<METHOD> <path>'`, rendered as `# source: …`, tags from `config.tags.taxonomy` plus `@domain=<domain>`; Background is `* url <config.urlVariable>` only (never a literal URL).

- [ ] **Step 1:** Tests on the secured fixture: positive scenario uses `status 200` from the spec (not hard-coded) and `match response == read('classpath:schemas/pet.json')`; no scenario contains `localhost` or `'http`; operation with `security: 'none'` yields no 401/403 scenario while a secured one yields 401 (and 403 only if declared); undeclared 400 is **not** generated; exploratory scenarios absent by default and present with `@exploratory` when enabled; `toKarateSchema` marks optional props `##string`, arrays `#[] #string`, `format: uuid` → `#uuid`; every planned feature passes `runGate` with `knownFiles` = scaffold + generated files (zero errors); outline emitted only above threshold; planner is deterministic (same input → byte-identical output).
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement planner/data/schema modules. **Step 4:** PASS; update goldens. **Step 5:** Commit.

### Task 8: v2 skill pack, manifest and selector

**Files:**
- Create: `skills/manifest.json`, `skills/karate-v2-core.md`, `skills/karate-project-config.md`, `skills/karate-assertions-schemas.md`, `skills/karate-data-driven.md`, `skills/karate-reuse-isolation.md`, `skills/karate-source-openapi.md`, `skills/karate-source-postman.md`, `skills/karate-source-har-session.md`, `skills/karate-source-graphql.md`, `skills/karate-source-requirements.md`, `skills/karate-repair.md`, `skills/karate-review-checklist.md`, `src/generation/ai/SkillPack.ts`, `scripts/generation-tests/skills.cjs`
- Modify: `src/services/agentSkillsService.ts` (delegate `buildSkillContextForPrompt` to `SkillPack`; keep class API for callers), `.vscodeignore` (ensure `skills/**` ships), `skills-lock.json` (remove the unrelated `caveman` entry or regenerate)
- Delete: old `skills/karate-anti-patterns.md`, `karate-dsl-reference.md`, `karate-reusability.md`, `karate-test-patterns.md` after their content is merged; `.github/skills/*` are removed and replaced by a short `.github/skills/README.md` pointing to `skills/`

**Interfaces:**
- Manifest entry: `{ id; file; appliesTo: { modes: SourceKind[] | '*'; tasks: AITask[] | '*' }; priority: number; budgetChars: number; verifiedAgainst: '2.1.4'; rules: string[] }`.
- Produces: `loadSkillPack(dir: string, fsApi: FsLike): SkillPack`; `SkillPack.select(q: { mode: SourceKind; task: AITask }): { text: string; included: string[]; trimmed: string[] }` (orders by priority, total budget default 12,000 chars, drops/trims **whole sections** delimited by `## ` headings, never mid-code-block); `SkillPack.ruleIds(): string[]`.
- Content requirements (each skill: ≤ 5,000 chars, frontmatter `name`, `description`, a "Rules" section with rule IDs and a good/bad pair; all facts from spec §6): core = v2 syntax, markers, Gherkin strictness, anti-hallucination, output contract (pure DSL, no fences); config = standard + env files + adoption + `sysenv/sysprop` + `configure auth/logging`; assertions = schema/`##`/`within`/soft assertions/failure labels; data = Outline columns as variables, `col!`, `__row`, faker/uuid, `karate.copy`; reuse = `callonce/callSingle`, `@ignore` helpers, `classpath:`, `@lock`, Background reruns per scenario, `configure url` vs `url`; each source skill = mapping rules plus unsupported-content policy; repair = minimal diff, never weaken assertions; review = the gate's rule list.

- [ ] **Step 1:** Tests: every manifest file exists and has frontmatter; every skill ≤ 5,000 chars; every rule ID mentioned in a skill exists in `rules.ts` and every gate rule is mentioned in `karate-review-checklist` or its owner skill; **no skill text contains** `@parallel=false` outside a "wrong" example block, `karate.toJava`, `properties['`; `select({mode:'postman',task:'generate-postman'})` includes `karate-v2-core` and `karate-source-postman` and excludes `karate-source-graphql`; trimming never splits a fenced block (count of ``` is even); total ≤ budget; `select` is deterministic.
- [ ] **Step 2:** Run; FAIL. **Step 3:** Author the skills (use docs under `docs.karatelabs.io` as verified in the spec; carry examples from the fetched pages, adapted), implement `SkillPack`, rewire `AgentSkillsService`. **Step 4:** PASS. **Step 5:** Commit.

### Task 9: Prompt builder and AI refiner

**Files:**
- Create: `src/generation/ai/PromptBuilder.ts`, `src/generation/ai/AiRefiner.ts`, `scripts/generation-tests/ai-refine.cjs`
- Modify: `src/services/ai/KaratePromptComposer.ts` (compose through `PromptBuilder`), `src/services/copilotService.ts` (use refiner; drop duplicated prompt strings), `src/commands/generateFromJira.ts` (use refiner), `src/services/postmanToKarateConverter.ts` (Copilot script helpers use `PromptBuilder`), `src/services/ai/AIProvider.ts` (add tasks `'generate-graphql'`, `'generate-jira'`, `'refine-feature'` if missing)

**Interfaces:**
- Produces: `buildPrompt(i: { task: AITask; mode: SourceKind; skills: string; evidence: { label: string; text: string }[]; feature?: string; request?: string; findings?: Finding[] }): { system: string; user: string }` (evidence is wrapped as untrusted data blocks, sanitized by existing `InputSanitizer`; output contract: only the complete Karate feature, no fences, preserve `# source:` comments, never alter `read('classpath:…')` targets); `refine(i: { feature: string; mode; task; evidence; skills: SkillPack; ai: (p: { system; user }) => Promise<string>; knownFiles: Set<string>; config: GeneratorConfig }): Promise<RefineResult>` where `RefineResult { text: string; status: 'refined'|'unchanged'|'rejected'; findings: Finding[]; attempts: number }`.
- Behavior: strip fences/prose, run `runGate`; if errors, **one** retry with `findings` (rule IDs + messages) in the prompt; if still failing or the output drops scenarios that existed (by `# source:`/name) or adds endpoints absent from evidence, return the **original** with `status: 'rejected'` and the findings. Features larger than 40 scenarios are split per `config.ai.chunk` and re-joined.

- [ ] **Step 1:** Tests with a fake `ai` function: fenced output is cleaned and accepted; output with `V2-CFG-001` triggers exactly one retry whose prompt contains `V2-CFG-001`; retry still bad → original returned, `status 'rejected'`, findings non-empty; output missing a scenario present in input → rejected; invented path (`/orders/analytics`) not in evidence → rejected; empty/whitespace output → rejected; prompt contains skill text and evidence but evidence marked as data; prompt for `generate-jira` and `generate-openapi` both come from the same builder.
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement and rewire callers (Jira's private fence stripping removed). **Step 4:** PASS (`npm run test:ai-routing` still PASS). **Step 5:** Commit.

### Task 10: Pipeline orchestrator and OpenAPI/Combined/Directory wiring

**Files:**
- Create: `src/generation/pipeline/GenerationPipeline.ts`, `src/generation/vscode/runGeneration.ts`, `scripts/generation-tests/pipeline.cjs`
- Modify: `src/services/GenerationService.ts`, `src/commands/generateFromOpenAPI.ts`, `src/commands/generateCombined.ts`, `src/commands/generateFromDirectory.ts`, `src/extension.ts` (direct `KarateGenerator` calls at the three sites), `src/webview/WebviewProvider.ts` (summary payload shows findings, side-by-side files, draft scenarios)

**Interfaces:**
- Produces: `runPipeline(i: { model: GenerationModel; config: GeneratorConfig; project: ProjectInfo; ai?: AiFn; skills: SkillPack; fsApi: FsLike & Writer; history: HashStore; progress(msg: string, pct: number): void }): Promise<PipelineResult>` with `PipelineResult { written: WriteReport; features: { path; findings: Finding[]; refinement?: RefineResult }[]; draftScenarios: number; warnings: string[] }`. Stages in order: scaffold plan → planner → render → (refine if `ai`) → gate (`failOn`) → write. A gate **error** blocks that file from being written as runnable: it is written with `@ignore` on failing scenarios and listed in the summary (never silent).
- `GenerationService.generateFromOpenAPI/Combined/Confluence` keep their signatures and return `{ files, content }` plus `summary`.

- [ ] **Step 1:** Tests with in-memory fs and a fake AI: end-to-end petstore-secured → files = scaffold + features + data + schemas, zero gate errors, `karate-config.js` present and untouched on second run; second run with identical inputs reports `updated` only; AI off and AI on both produce gate-clean output; AI failure leaves deterministic output and `refinement.status === 'rejected'`; `failOn: 'never'` still writes; progress callback monotonic.
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement; replace `applyReusability`/phantom-stub logic usage in `GenerationService` with the pipeline; route directory batch through the pipeline per spec (shared config, one scaffold). **Step 4:** `npm run test:generation && npm run typecheck`. PASS. **Step 5:** Commit.

### Task 11: Postman on the pipeline

**Files:**
- Create: `src/generation/adapters/postman.ts`, `scripts/generation-tests/postman.cjs`
- Modify: `src/services/postmanToKarateConverter.ts` (becomes thin: parse → `GenerationModel` + per-request step lists), `src/services/postmanImportService.ts` (use pipeline), delete `src/services/postmanToKarateConverter.ts.bak`

**Interfaces:**
- Produces: `buildPostmanModel(collection: any, env?: any): { model: GenerationModel; scenarios: KarateScenario[]; envVars: Record<string,string>; unsupported: { sourceRef; reason }[] }`. Collection/environment variables move to `karate-config(-env).js` entries and `sysprop` lookups, **not** `def key = 'value'` literals; auth blocks map to `configure auth` (basic/bearer/oauth2) or header; secrets-looking values (`token`, `secret`, `password`, `apiKey`) are never written; folders become features with request order preserved; `pm.response.to.have.status`, `pm.expect(...).to.eql/equal/exist`, `pm.collectionVariables.set` → native `status`, `match`, `def`; unconvertible scripts become `# UNSUPPORTED (pm script): …` comment plus the scenario tagged `@ignore` only if an assertion was lost.

- [ ] **Step 1:** Tests on the Postman fixture: base URL from `{{baseUrl}}` appears in config, not in features; bearer auth produces auth helper wiring and no literal token; test script assertions converted; request order preserved; a script with an unsupported `pm.sendRequest` yields an `unsupported` entry and a visible comment; output gate-clean.
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement and rewire. **Step 4:** PASS. **Step 5:** Commit.

### Task 12: HAR and recorded sessions on the pipeline

**Files:**
- Create: `src/generation/adapters/har.ts`, `scripts/generation-tests/har.cjs`
- Modify: `src/services/session/SessionRecorderService.ts`, `src/services/session/HarImporter.ts`

**Interfaces:**
- Produces: `buildHarModel(entries: CapturedRequest[], opts: { allowedHosts?: string[] }): { model: GenerationModel; scenarios: KarateScenario[] }`. Rules: keep only evidenced requests; drop static assets/analytics; collapse duplicate calls; replace volatile headers (`cookie`, `authorization`, `user-agent`, `x-request-id`) by config/auth wiring; extract ids from earlier responses into `def` variables and reuse them in later paths/bodies (`match` on the **value shape**, not the literal); infer `url` origin into config, never literal.

- [ ] **Step 1:** Tests: static assets dropped; authorization header never appears; id from a POST response is reused in the following GET path; repeated identical GETs collapsed; gate-clean output. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit.

### Task 13: GraphQL on the pipeline

**Files:**
- Modify: `src/services/graphql/GraphQLKarateGenerator.ts`, `src/commands/generateFromGraphQL.ts`
- Create: `scripts/generation-tests/graphql.cjs`

**Interfaces:**
- Produces: `GraphQLKarateGenerator.plan(schema: GraphQLSchema, config: GeneratorConfig): PlannedFeature[]` (returns `KarateFeature`, rendered by `renderFeature`). Uses the `variables` map instead of inlined args, requests built with `def query = read('classpath:graphql/<op>.graphql')`-style files only if `data.externalize`, otherwise a docstring; asserts `response.errors` `'#notpresent'` and `response.data.<op>` against a schema derived from `returnFields`; negative case per required argument (omit one) expecting `errors` present; correct `escapeJson` (also escapes backslashes and newlines); base URL from config, endpoint path from option (default `graphql`).

- [ ] **Step 1:** Tests: variables passed as JSON object; a query containing a quote/backslash/newline renders valid JSON; one negative per required arg; no literal host; gate-clean. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit.

### Task 14: Jira and Confluence on the pipeline

**Files:**
- Create: `src/generation/adapters/requirements.ts`, `scripts/generation-tests/requirements.cjs`
- Modify: `src/commands/generateFromJira.ts`, `src/commands/generateFromConfluence.ts`, `src/services/GenerationService.ts` (`mapConfluenceDataToScenarios` removed)

**Interfaces:**
- Produces: `buildRequirementScenarios(items: { id: string; title: string; criteria: string[]; link?: string }[], opts: { model?: GenerationModel }): KarateScenario[]`. Each criterion becomes one scenario named from the criterion, tagged `@req=<id>`, with `# source: <link or id>`. With a linked `model` (OpenAPI), the planner picks the best-matching operation by path/summary/word overlap and fills real steps; **without** one the scenario is rendered as `@ignore` with `draftReason: 'No API contract linked; select an OpenAPI spec or enable AI refinement'` — never `method get # TODO` live steps. With AI on, the refiner may complete drafts from evidence but only keeps output that passes the gate.

- [ ] **Step 1:** Tests: no-spec case yields `@ignore` scenarios with the reason and `@req=` tags and zero live steps; with spec, an acceptance criterion "creating a pet returns 201" maps to `POST /pets` with `status 201`; gate-clean either way; Jira command passes through refiner (fake AI) with no private fence stripping. **Step 2:** FAIL. **Step 3:** Implement and rewire. **Step 4:** PASS. **Step 5:** Commit.

### Task 15: Scout shares renderer, gate and writer

**Files:**
- Modify: `src/services/scout/ScoutGenerator.ts`, `src/services/scout/ScoutController.ts`
- Create: `scripts/generation-tests/scout-shared.cjs`

**Interfaces:**
- `generateScoutSuite` keeps its signature and journey semantics (`@ignore` drafts, redaction, reset, auth fixture). Changes: Scout-authored scaffold files (`scout-setup.feature`, `scout-reset.feature`, `scout-data.json`) are written through `OutputWriter` (create-if-missing for user-owned, hash-protected for generated); the produced `journey.feature` runs through `runGate` (Scout-specific allowance list: `V2-ASSERT-002` downgraded) and findings are surfaced in the Scout summary; `karate.properties['scout.baseUrl']` becomes `karate.sysprop('scout.baseUrl', '')`.

- [ ] **Step 1:** Tests: existing `npm run test:scout` still PASS unchanged goldens except the `sysprop` swap; Scout suite files obey no-clobber; gate findings reported. **Step 2:** FAIL for the new assertions. **Step 3:** Implement. **Step 4:** `npm run test:scout && npm run test:generation` PASS. **Step 5:** Commit.

### Task 16: Reusability designed in, regex extraction retired

**Files:**
- Modify: `src/services/ReusabilityEngine.ts`, `src/services/postmanImportService.ts`, `src/webview/WebviewProvider.ts`
- Create: `scripts/generation-tests/reuse.cjs`

**Interfaces:**
- `ReusabilityEngine.extract` stays for existing hand-written features but is **no longer called on generated output** (the planner already emits `callonce read('classpath:common/auth.feature')`). Add guards: extract only whole contiguous Background blocks, never `url`/`def baseUrl`, and never rewrite scenario steps; stub creation (`mock-token-123`, `localhost:8080`) removed — missing `common/*.feature` is a gate error `V2-REF-001`, not a stub.

- [ ] **Step 1:** Tests: extraction on a handwritten feature moves a repeated auth Background block only; a scenario containing `Authorization` mid-steps is untouched; no output contains `mock-token` or `localhost:8080`. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit.

### Task 17: Dry-run parse check (optional gate stage)

**Files:**
- Create: `src/generation/quality/DryRun.ts`, `scripts/generation-tests/dryrun.cjs`
- Modify: `src/generation/vscode/runGeneration.ts` (locate CLI using existing `KarateCliExecutor`/`ConfigDiscovery`)

**Interfaces:**
- Produces: `dryRun(opts: { cli: string | undefined; root: string; files: string[]; exec: (cmd: string, args: string[]) => Promise<{ code: number; out: string }> }): Promise<{ status: 'passed'|'failed'|'skipped'; message: string; findings: Finding[] }>`. Invokes `<cli> run -D -o <tmpdir> <paths>` (v2 dry run: parses and expands outlines without HTTP). `cli` undefined, Java < 21, or non-zero for environmental reasons → `skipped` with a message, **never** a generation failure. Parse errors map to `Finding { ruleId: 'V2-PARSE-001', severity: 'error', line }` (line parsed from the CLI message when present).

- [ ] **Step 1:** Tests with fake `exec`: success → `passed`; stdout containing a parse error with `file.feature:12` → `failed` and one `V2-PARSE-001` at line 12; missing CLI → `skipped`; exec throws → `skipped`; temp output dir passed with `-o`. **Step 2:** FAIL. **Step 3:** Implement and call it from the pipeline when `config.gate.dryRun !== 'off'`. **Step 4:** PASS. **Step 5:** Commit.

### Task 18: Linter integration, settings migration, UI surface

**Files:**
- Modify: `src/services/linter/KarateLinter.ts` and rule files (add adapters emitting gate findings by ID; keep existing rules), `package.json` (settings, descriptions, mark old ones deprecated with `markdownDeprecationMessage`), `src/webview/WebviewProvider.ts`, `media/*` only if the summary view needs a findings table
- Create: `src/generation/vscode/migrateSettings.ts`, `scripts/generation-tests/migration.cjs`

**Interfaces:**
- Produces: `migrateSettings(old: { testTemplate?; structuringStrategy?; autoTag?; outputPath?; sharedStylePath?; scenarioOutlineThreshold?; smartTestData? }): Partial<GeneratorConfig>` mapping every legacy setting (template names map to `style`/layout defaults documented in the spec), and the loader calls it when `.karate-generator.json` is absent. The generation summary lists: files written, kept-as-is, side-by-side, gate findings (grouped by rule ID), drafts, and "AI refinement rejected: <rule IDs>".

- [ ] **Step 1:** Tests: each legacy setting maps to its new field; unknown legacy values produce warnings; linter reports `V2-LOCK-001` for `@parallel=false` with a quick-fix hint to `@lock=`. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `npm run test:generation && npm run lint` PASS. **Step 5:** Commit.

### Task 19: Cleanup, docs, release checks

**Files:**
- Delete: `src/services/copilotService.ts.bak`, dead code decided in Tasks 7/16 (`ScenarioOutlineBuilder` if still unreferenced, the unused `KarateGenerator` OpenAPI-only scenario builders after Task 10, `TemplateManager` `{{source}}` placeholder fix or removal)
- Modify: `README.md`, `CHANGELOG.md`, `docs/COPILOT_GUIDE.md`, `CONTRIBUTING.md`, `package.json` (version 2.1.0, `engines`/docs mention Karate 2.x and Java 21+), `scripts/check-package-files.cjs` (require `skills/manifest.json`)
- Create: `docs/generation.md` (config file reference, folder layout, regeneration rules, adding a skill, rule ID table)

- [ ] **Step 1:** Run `git grep -n "applyReusability\|createStubFile\|mock-token\|localhost:8080" src` and remove or justify every remaining hit.
- [ ] **Step 2:** Write docs; update changelog with **breaking-behavior notes** (exploratory scenarios now opt-in, generated config files, `.karate-generator.json`).
- [ ] **Step 3:** Run `npm run verify`. Expected: all stages PASS including `test:generation`.
- [ ] **Step 4:** Manual acceptance: with a Karate v2 CLI available, generate the petstore-secured fixture into a scratch project and run `karate run -D` then a real run against a mock server of the spec; record results in the PR. If no v2 CLI is available, state that in the PR rather than claiming execution.
- [ ] **Step 5:** Commit; open PR.

## Self-Review (done)

- **Spec coverage:** §2A→T6/T7; §2B→T1/T2/T4/T18; §2C→T8/T9; §2D→T10–T15; §2E→T3/T9/T17; §2F→T16; §2G→T0 plus per-task suites; §3.2 config→T2/T5; §3.6 regeneration→T5; §5 decisions→Global Constraints; §6 v2 facts→T3 rules, T5 scaffold, T8 skills; §7 skill pack→T8.
- **Type consistency:** `Finding`, `GenerationModel`, `GeneratorConfig`, `ProjectInfo`, `FsLike`, `HashStore`, `PlannedFeature`, `RefineResult` are defined once (T1, T2, T3, T5, T7, T9) and consumed with the same names later.
- **Proportion:** tasks give signatures, rule tables and assertions; implementers write bodies.
- **Open items to confirm during execution:** where `HashStore` persists (spec hash manager vs `.karate-test-management`), and whether a Karate v2 CLI is installable in the dev environment for Task 19 step 4.
