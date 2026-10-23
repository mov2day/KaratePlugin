# Test generation (Karate 2.x)

Every generation mode (OpenAPI, Confluence, OpenAPI + Confluence, Postman, HAR/session, GraphQL, Jira, directory batch, Scout) goes through one pipeline: source adapter, normalized model, scenario planner, renderer, project scaffolder, optional AI refinement, quality gate, writer.

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
  "ai": { "refine": true, "maxRetries": 1, "chunk": "feature" },
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
| `data.smart` | boolean | Generate realistic values from names and formats |
| `data.externalize` | boolean | Write request data to `data/*.json` instead of inline bodies |
| `ai.refine` | boolean | Allow AI refinement when AI is enabled for the run |
| `ai.maxRetries` | `1` only | One repair round after a rejected AI answer |
| `ai.chunk` | `feature`, `scenario` | Unit sent to the model |
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

## Quality gate

Every generated file passes the gate before it is written. The same rules run in the editor as diagnostics (source `Karate Gate`). Individual rules can be switched off with `karate.linter.enabledRules`, for example `{ "V2-ASSERT-002": false }`. Gate findings that duplicate the older hard-coded URL (`K001`) or hard-coded secret (`S002`) diagnostics on the same line are hidden so you see one diagnostic per problem.

| Rule | Severity | Checks |
|---|---|---|
| `V2-GHERKIN-001` | error | Steps outside any Background or Scenario |
| `V2-LOCK-001` | error | `@parallel=false` (unsupported in v2); quick fix to `@lock=<name>` |
| `V2-CFG-001` | error | Hard-coded `url 'http...'` in a feature |
| `V2-CFG-002` | error | A request is made but no `url` is set |
| `V2-SEC-001` | error | Literal secret (Authorization, API key, password, token) in a step |
| `V2-ASSERT-001` | error | A request scenario never asserts the status |
| `V2-ASSERT-002` | warning | A 2xx scenario has no body assertion |
| `V2-DRAFT-001` | error | `TODO` left in a scenario that is not `@ignore` |
| `V2-DUP-001` | error | Duplicate scenario name |
| `V2-API-001` | error | `karate.stop(` (hangs CI) |
| `V2-API-002` | warning | `karate.toJava(` (discouraged in v2) |
| `V2-NUM-001` | error | Integer literal beyond the JavaScript safe range |
| `V2-REF-001` | error | `read('classpath:...')` does not resolve to a known file |
| `V2-TAG-001` | warning | Category tag differs from the configured taxonomy |
| `V2-REUSE-001` | warning | `callonce` of an auth/header/setup helper (use `call`) |

AI-refined output is also checked for non-feature content, unterminated docstrings, and invented paths before the gate. A rejected refinement keeps the deterministic output and the run summary says why. When a Karate v2 CLI is found (`karate` on `PATH` reporting v2, or `karateDsl.execution.jarPath` pointing at a v2 jar with Java 21+), the gate also runs a dry-run. The bundled Karate 1.5.0.RC3 jar is never used for this and nothing is downloaded automatically.

## Adding a skill

The AI prompts are grounded by the skill pack in `skills/`, selected by `skills/manifest.json`.

1. Create `skills/<id>.md` with frontmatter `name: <id>` and a `description:`. Put short rules under a `## Rules` heading; other `## ` sections are dropped whole when a budget is tight.
2. Add an entry to `skills/manifest.json`:
   - `id`, `file`
   - `appliesTo.modes` (`"*"` or source kinds such as `openapi`, `postman`, `har`) and `appliesTo.tasks` (`"*"` or AI task names)
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
