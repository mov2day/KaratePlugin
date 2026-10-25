# Test generation (Karate 2.x)

Every generation mode (OpenAPI, Confluence, OpenAPI + Confluence, Postman, HAR/session, GraphQL, Jira, directory batch, Scout) goes through one pipeline: source adapter, normalized model, scenario planner, renderer, project scaffolder, optional AI refinement, quality gate, writer.

MCP generation uses the same pipeline and protected writer as the editor commands. Legacy spec sync cannot safely supply the pipeline's project/config context, so it gates legacy output and writes a unique `.generated.feature` sibling; it never replaces a user scenario in place. No generation path invents a `localhost` URL.

Generated suites target **Karate 2.x** (skills are verified against 2.1.4). Running Karate 2.x standalone needs **Java 21 or later**.

## Configuration

Generation settings come from three layers; later layers win:

1. Built-in defaults.
2. VS Code settings (`karateDsl.generation.*`, `karateDsl.outputPath`, `karateDsl.testTemplate`).
3. The workspace file `.karate-generator.json` (path from `karateDsl.generation.configFile`, default `.karate-generator.json`).

Unknown keys, wrong types, and invalid enum values produce a warning and fall back to the default; the file never blocks generation. A file that is not valid JSON is ignored with a warning.

### `.karate-generator.json` reference

All keys are optional. Defaults shown.

```json
{
  "karateVersion": "2",
  "layout": { "outputRoot": "src/test/karate", "strategy": "domain", "classpathRoot": "src/test/java" },
  "config": { "mode": "standard", "urlVariable": "baseUrl", "envs": ["dev", "staging"] },
  "style": { "indentation": "  ", "variableCase": "camelCase", "commentStyle": "hash", "lineSpacing": 1 },
  "tags": {
    "auto": true,
    "taxonomy": {
      "positive": "@positive", "negative": "@negative", "edge": "@edge",
      "boundary": "@boundary", "security": "@security", "exploratory": "@exploratory"
    }
  },
  "scenarios": {
    "categories": ["positive", "negative", "edge", "boundary", "security"],
    "exploratory": false,
    "crud": true,
    "outlineThreshold": 3
  },
  "data": { "smart": true, "externalize": true },
  "ai": { "refine": true, "maxRetries": 1, "chunk": "feature", "enrich": "off" },
  "gate": { "dryRun": "auto", "failOn": "error" }
}
```

| Key | Values | Meaning |
|---|---|---|
| `karateVersion` | `"2"` only | Target major version |
| `layout.outputRoot` | path | Where feature files are written |
| `layout.strategy` | `domain`, `flat`, `method` | How scenarios are grouped into files |
| `layout.classpathRoot` | path | Root that `classpath:` references resolve to (`karate-config.js`, `common/`, `data/`, `schemas/` live here) |
| `config.mode` | `standard`, `env-json` | `standard` = `karate-config.js` plus `karate-config-<env>.js`; `env-json` = `config/<env>.json` files |
| `config.urlVariable` | name | Variable features use for the base URL |
| `config.envs` | list | Environments to scaffold |
| `style.*` | see above | Indentation, variable casing (`camelCase`/`snake_case`), comment style (`hash`/`doubleSlash`), blank lines between scenarios |
| `tags.auto` | boolean | Add category tags |
| `tags.taxonomy` | tag per category | Rename the category tags; rule `V2-TAG-001` checks them |
| `scenarios.categories` | subset of `positive`, `negative`, `edge`, `boundary`, `security` | Categories to generate |
| `scenarios.exploratory` | boolean | Opt in to speculative `@exploratory` scenarios (off by default) |
| `scenarios.crud` | boolean | Chain create/read/update/delete scenarios |
| `scenarios.outlineThreshold` | integer | Required-field count that triggers Scenario Outline generation |
| `scenarios.responseChecks` | `basic` \| `contract` | `basic` asserts status and a type-level schema match. `contract` adds Content-Type, declared Location/ETag/Retry-After/pagination headers, string formats, array bounds and list size limits |
| `scenarios.responseTimeMs` | integer | Response-time budget in ms (`assert responseTime < N`); `0` disables it |
| `scenarios.business` | `off` \| `on` | OpenAPI only. `on` adds business checks: the CRUD lifecycle echoes every plain request field after create, read and update, re-reads after the update and (with `responseChecks: contract`) checks Content-Type/Location on each call. It also adds `@business` workflow scenarios to the `-crud` file: create then list contains the item, delete then list no longer contains it plus a repeat delete 404, duplicate create 409 (when declared), repeated PUT/DELETE, and `@ignore` drafts for status/state transitions. Standalone get/put/delete-by-id scenarios create their own resource when a create operation exists, and 400/422 scenarios assert the declared `message`/`code`/`error` string fields. Default `off` leaves output unchanged |
| `data.smart` | boolean | Generate realistic values from names and formats |
| `data.externalize` | boolean | Write request data to `data/*.json` instead of inline bodies |
| `ai.refine` | boolean | Allow AI refinement when AI is enabled for the run |
| `ai.maxRetries` | `1` only | One repair round after a rejected AI answer |
| `ai.chunk` | `feature`, `scenario` | Unit sent to the model |
| `ai.enrich` | `off` \| `business` | `business` (needs `ai.refine` and AI on) sends each feature to the model with a compact business context built from the spec (descriptions, enums, examples, status fields, declared errors, resource links; capped at 6,000 characters) and lets it add justified scenarios and assertions. See [AI business enrich](#ai-business-enrich). Default `off` leaves AI behavior unchanged |
| `gate.dryRun` | `auto`, `off` | Run a Karate v2 dry-run when a v2 CLI is found |
| `gate.failOn` | `error`, `never` | Whether gate errors reject a generated file |

### VS Code settings

| Setting | Notes |
|---|---|
| `karateDsl.generation.configFile` | Path of the generator config file, default `.karate-generator.json` |
| `karateDsl.generation.configMode` | `standard` or `env-json` (same as `config.mode`) |
| `karateDsl.generation.exploratory` | Opt in to exploratory scenarios (same as `scenarios.exploratory`) |
| `karateDsl.generation.structuringStrategy` | Deprecated, use `layout.strategy` |
| `karateDsl.generation.autoTag` | Deprecated, use `tags.auto` |
| `karateDsl.generation.smartTestData` | Deprecated, use `data.smart` |
| `karateDsl.generation.scenarioOutlineThreshold` | Deprecated, use `scenarios.outlineThreshold` |
| `karateDsl.generation.sharedStylePath` | Deprecated, use `style`; still read |
| `karateDsl.outputPath` | Deprecated, use `layout.outputRoot` |
| `karateDsl.testTemplate` | `standard`, `detailed`, `minimal`; see below |
| `karateDsl.useCopilot` | Enables AI refinement (Jira generation follows it too) |

Deprecated settings still work when no `.karate-generator.json` value overrides them.

### How legacy settings are merged

Two small pieces cooperate; they are not duplicates:

- `SettingsMapping` (`src/generation/config/SettingsMapping.ts`) maps the `karateDsl.generation.*` and `karateDsl.outputPath` settings into the settings layer.
- `migrateSettings` (`src/generation/vscode/migrateSettings.ts`) handles only the legacy `testTemplate` preset, as the lowest layer, and only when no config file exists. Explicit settings beat it.

`testTemplate` presets: `standard` = defaults; `detailed` = `scenarios.exploratory: true`; `minimal` = categories `positive` and `negative` only. This mapping is a documented choice rather than a Karate rule.

## Folder layout

With the defaults, a generated project looks like this (paths under `layout.outputRoot` and `layout.classpathRoot`):

```text
karate-config.js              base config: karate.env switch, base URL from env / system property
karate-config-<env>.js        per-environment overrides (or config/<env>.json in env-json mode)
common/auth.feature           auth from spec security schemes (configure auth), @ignore
common/utils.feature          shared helper functions, @ignore
data/<resource>.json          request data used by features
schemas/<resource>.json       response schemas used with match
<name>.feature                generated scenarios, placed per layout.strategy
<domain>-security.feature     401/403 scenarios without the auth setup
```

Notes:

- Secrets are never written. Credentials are read with `karate.sysenv(...)` or system properties.
- An existing `karate-config*.js` is adopted: it is never overwritten and generated features reference its variable names.
- Operations whose security scheme the generated `common/auth.feature` does not configure become `@ignore` drafts with a stated reason.
- If you author `common/auth.feature` yourself, include a `# Configures: schemeName, otherScheme` header using the OpenAPI security-scheme names. Without it, generation leaves secured operations runnable and warns that it cannot verify auth coverage.
- Scenarios that cannot be generated safely (for example an unsatisfiable `pattern`) become `@ignore` drafts rather than runnable guesses.

## Regeneration rules

Each generated `.feature` file starts with a header line:

```text
# Generated by Karate Test Management <version> | source: <source> | hash: <sha-256 of body>
```

On regeneration:

| Existing file | Result |
|---|---|
| Missing | Created |
| Config, data, schema, and helper files (user-owned) | Never overwritten; reported as skipped |
| Generated feature, body unchanged since last write | Overwritten |
| Generated feature, edited by you | Left alone; the new output is written to `<name>.generated.feature` beside it |

"Unchanged" is decided from the header hash or from hashes the extension keeps in workspace state (key `karateDsl.generatedHashes`). Delete the `.generated.feature` file after merging what you want.

If that sibling was also edited, the writer keeps adding `.generated` before `.feature` (for example, `name.generated.generated.feature`) until it finds an unused or known-generated file. Output roots and feature paths must be workspace-relative; absolute paths and `..` traversal are rejected. Before protected writes, a configured Karate v2 dry run stages generated feature content in a temporary directory and removes it afterwards. A parse failure keeps an existing feature and emits a draft sibling.

## Quality gate

Every generated file passes the gate before it is written. The same rules run in the editor as diagnostics (source `Karate Gate`). Individual rules can be switched off with `karate.linter.enabledRules`, for example `{ "V2-ASSERT-002": false }`. Gate findings that duplicate the older hard-coded URL (`K001`) or hard-coded secret (`S002`) diagnostics on the same line are hidden so you see one diagnostic per problem.

| Rule | Severity | Checks |
|---|---|---|
| `V2-GHERKIN-001` | error | Steps outside any Background or Scenario |
| `V2-GHERKIN-002` | error | A step appears after an `Examples:` table |
| `V2-LOCK-001` | error | `@parallel=false` (unsupported in v2); quick fix to `@lock=<name>` |
| `V2-CFG-001` | error | Hard-coded `url 'http...'` in a feature |
| `V2-CFG-002` | error | A request is made but no `url` is set |
| `V2-SEC-001` | error | Literal secret (Authorization, API key, password, token) in a step |
| `V2-ASSERT-001` | error | A request scenario never asserts the status |
| `V2-ASSERT-002` | warning | A 2xx scenario has no body assertion |
| `V2-ASSERT-003` | warning | A 2xx scenario with only status and timing/media-type checks (no content assertion); scenarios with no assertion at all stay with `V2-ASSERT-002` |
| `V2-ASSERT-004` | warning | A 2xx scenario whose only body assertion is a bare `'#object'`, `'#[]'` or `'#array'` marker |
| `V2-ASSERT-005` | warning | A 4xx scenario (not 401/403, not `@security`) that asserts only the status, with no error body or header check |
| `V2-ASSERT-006` | warning | A 2xx POST scenario with other assertions that never touches `response` or `match header Location` (no id capture, echo or Location) |
| `V2-DRAFT-001` | error | `TODO` left in a scenario that is not `@ignore` |
| `V2-DUP-001` | error | Duplicate scenario name |
| `V2-API-001` | error | `karate.stop(` (hangs CI) |
| `V2-API-002` | warning | `karate.toJava(` (discouraged in v2) |
| `V2-NUM-001` | error | Integer literal beyond the JavaScript safe range |
| `V2-REF-001` | error | `read('classpath:...')` does not resolve to a known file |
| `V2-TAG-001` | warning | Category tag differs from the configured taxonomy |
| `V2-REUSE-001` | warning | `callonce` of an auth/header/setup helper (use `call`) |
| `V2-PARSE-001` | error | Staged v2 dry run reported a parse error |
| `V2-AI-001` | error | AI returned empty output |
| `V2-AI-002` | error | AI dropped an input scenario |
| `V2-AI-003` | error | AI invented contract paths or references |
| `V2-AI-004` | error | AI output is not the requested Karate shape |
| `V2-AI-005` | error | AI output has an unterminated docstring |
| `V2-AI-006` | error | AI refinement made an input `@ignore` Feature or Scenario runnable |
| `V2-AI-007` | error | Enrich mode only: a new scenario has no `# AI-proposed: <reason>` comment (in its body or directly above it) or has gate errors |

`V2-ASSERT-003` to `006` skip `@ignore`, `@draft` and `@exploratory` scenarios, are always warnings (they never reject a file or change the summary level), and can be switched off with `karate.linter.enabledRules`.

AI-refined output is also checked for non-feature content, unterminated docstrings, and invented paths before the gate. A rejected refinement keeps the deterministic output and the run summary says why. When a Karate v2 CLI is found (`karate` on `PATH` reporting v2, or `karateDsl.execution.jarPath` pointing at a v2 jar with Java 21+), the gate also runs a dry-run. The bundled Karate 1.5.0.RC3 jar is never used for this and nothing is downloaded automatically.

## AI business enrich

With `ai.enrich: "business"`, AI refinement of each feature uses the `enrich-business` task instead of `enhance-feature`. The model receives an extra `business-context` evidence block (`src/generation/ai/BusinessContext.ts`, deterministic, sorted by path and method, secret-looking example fields redacted, truncated to a prefix of operations with an "omitted" note) and the `karate-business-invariants` skill. It may add scenarios and assertions the evidence justifies, each marked with a `# AI-proposed: <reason>` comment. The usual guards stay on: `V2-AI-002` (dropped scenario), `V2-AI-003` (invented path or file) and `V2-AI-006` (un-ignored draft); `V2-AI-007` adds that every new scenario carries the comment and passes the quality gate. A rejected answer keeps the deterministic output, as for any refinement. The mode is off by default; it only runs when AI is enabled for the run and `ai.refine` is true.

Business context by source: OpenAPI uses summaries, descriptions, enums, examples and links. GraphQL uses field, argument and type descriptions from the SDL or introspection, enum values of arguments, input objects and return types, and the AI switch is `karateDsl.useCopilot` (as for OpenAPI). Postman uses folder names (tags), request descriptions, `pm.test` titles and saved example names. HAR uses the resource segment as tag and observed id flows (`Response response.id (orderId) is reused by GET /api/orders/{orderId}`, names only, no values). These descriptions are model-only: they are never written into feature files, and the context redacts credentials again before sending.

## Adding a skill

The AI prompts are grounded by the skill pack in `skills/`, selected by `skills/manifest.json`.

1. Create `skills/<id>.md` with frontmatter `name: <id>` and a `description:`. Put short rules under a `## Rules` heading; other `## ` sections are dropped whole when a budget is tight.
2. Add an entry to `skills/manifest.json`:
   - `id`, `file`
   - `appliesTo.modes` (`"*"` or source kinds such as `openapi`, `postman`, `har`) and `appliesTo.tasks` (`"*"` or AI task names, for example `enrich-business`)
   - `priority` (lower renders first and is dropped last), `budgetChars`, `verifiedAgainst` (the Karate version you checked)
   - `rules`: the `V2-*` ids the skill cites
3. Keep the file under 5,000 characters and within its own `budgetChars`. Only mention rule ids that exist in `src/generation/quality/rules.ts`, and mention every rule id in at least one skill.
4. Run `npm run test:generation` (the skills suite checks the manifest, budgets, rule ids, and banned Karate 1.x constructs).

A workspace `.github/skills` folder, if present, is loaded as extra lower-priority skills with a separate small budget.

## Known limitations and manual acceptance

Manual acceptance of generated output against a real Karate v2 run: **not executed, no v2 CLI available** in the environment where this release was prepared. Automated tests cover the generator, planner, renderer, writer, gate, and the dry-run glue with fakes; they do not run Karate.

Open design risks that need a real v2 run:

- Authentication is configured once in `common/auth.feature` with `configure auth`, and features call it with a plain `call`. Whether that `configure` persists into the calling feature the way the generator assumes is unverified.
- The `##ignore` marker used for recorded null values is unverified in v2.
- The dry-run output parser accepts several message shapes because the v2 dry-run format is unverified; a non-zero exit with no recognizable parse error is reported as a skipped check, not a pass.
- Docstring bodies are indented one level deeper than the `"""` fence; plain-text bodies may keep that indentation in a real run.
- The Scout browser test fixture still reads `karate.properties['scout.testPassword']`, which needs a real v2 run to confirm.

Also note:

- Operations that use a security scheme other than the first one in the spec become drafts until multi-scheme auth is supported by the generated helper.
- `ResourceLifecycleAnalyzer` is gone; recorded sessions no longer produce per-resource lifecycle scenarios.
