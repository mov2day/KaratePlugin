# Contributing to Karate Test Management

Thanks for your interest in contributing to **Karate Test Management for VS Code**.

This project combines a TypeScript VS Code extension, a Preact-based management webview, Karate execution support, API test generation and analysis, AI-assisted workflows, and integrations such as GitHub, Jira, Confluence, and Zephyr Scale. Contributions are welcome across code, tests, documentation, examples, UX, and bug fixes.

## Before you start

For substantial changes, consider opening an issue first so the problem, expected behavior, and proposed direction are clear before implementation begins. Small bug fixes, tests, documentation corrections, and narrowly scoped improvements can usually go directly to a pull request.

When reporting a bug, include enough information to reproduce it without exposing credentials, proprietary API payloads, production data, or other sensitive information.

## Development prerequisites

Use the same baseline as the project CI wherever possible:

- **Node.js 20**
- **npm** with the committed `package-lock.json`
- **VS Code 1.108.0 or newer**
- **Git**

Java is only required when you need to exercise real Karate execution paths. For Karate 2.x standalone execution, use **Java 21 or newer**. The extension can also use its bundled Karate `1.5.0.RC3` JAR when no custom JAR or Karate version is configured.

Optional integrations such as GitHub Copilot, Claude, Ollama, Jira, Confluence, GitHub Actions, and Zephyr Scale are not required for the normal build and verification workflow.

## Set up the repository

Fork the repository if you do not have direct write access, then clone your fork:

```bash
git clone https://github.com/<your-user>/KaratePlugin.git
cd KaratePlugin
```

If you have direct access, you can clone the upstream repository instead:

```bash
git clone https://github.com/mov2day/KaratePlugin.git
cd KaratePlugin
```

Install the exact dependency versions from the lockfile:

```bash
npm ci
```

Compile once to confirm the environment is working:

```bash
npm run compile
```

Then open the repository in VS Code:

```bash
code .
```

## Run the extension locally

The repository includes VS Code launch configurations for development.

1. Open the project in VS Code.
2. Open **Run and Debug**.
3. Select **Run Extension**.
4. Press `F5`.

VS Code starts an **Extension Development Host** with this repository loaded as the extension under development.

The default build task runs the TypeScript compiler in watch mode:

```bash
npm run watch
```

### Webview development

The main Test Management UI lives under:

```text
src/webview/app/
```

The webview is bundled with esbuild into `media/test-management.js`. If you change `main.tsx`, `managementSearch.ts`, CSS, or webview dependencies, rebuild the webview:

```bash
npm run build:webview
```

Then reload or restart the Extension Development Host to validate the updated UI.

If a webview build changes tracked generated assets under `media/`, include the corresponding generated changes in the same pull request.

## Project structure

The main areas of the repository are:

```text
src/
├── extension.ts          # Extension activation and top-level wiring
├── commands/             # User-facing VS Code command implementations
├── services/             # Generation, execution, AI, CI, integrations, analysis, etc.
├── shared/               # Shared types/contracts used across extension features
├── types/                # Type definitions
├── utils/                # Reusable utilities
├── webview/              # Webview providers and Test Management UI
│   └── app/              # Preact application and styles
└── test/
    └── suite/            # VS Code-hosted Mocha tests

scripts/                  # Build, verification, contract, and focused test scripts
media/                    # Bundled webview/runtime assets
resources/                # Extension resources and icons
examples/                 # Example inputs/projects
api/                      # API-related project resources
docs/                     # Public documentation and privacy information
.github/workflows/        # CI configuration
```

A useful rule is to keep VS Code/UI orchestration thin and place reusable behavior in services or shared modules where it can be tested independently.

## Build commands

Common development commands are:

```bash
npm run compile
```

Compile TypeScript into `out/` for development and tests.

```bash
npm run typecheck
```

Run strict TypeScript validation without emitting files.

```bash
npm run lint
```

Run ESLint against the TypeScript source.

```bash
npm run build:webview
```

Bundle the Preact webview and copy required browser assets.

```bash
npm run build:extension
```

Bundle the production extension entry point with esbuild.

```bash
npm run package:check
```

Build the extension and validate the files that would be packaged.

```bash
npm run package
```

Create a VSIX package with `vsce`. This is normally needed for release validation rather than day-to-day development.

## Testing

### Extension test suite

Run the VS Code-hosted test suite with:

```bash
npm test
```

The `pretest` step compiles the project and runs ESLint before launching the extension tests.

Tests live primarily in:

```text
src/test/suite/
```

When adding or changing service behavior, add or update focused tests close to the affected area. Existing examples include generation, execution, coverage, Copilot/AI, CI ingestion, MCP tooling, flakiness, workspace state, shared styles, Bug Hunter, and Zephyr publishing.

### Focused repository tests

Execution behavior can be validated with:

```bash
npm run test:execution
```

AI model-routing behavior can be validated with:

```bash
npm run test:ai-routing
```

The repository also contains lightweight Node-based checks in `scripts/` for webview assets, message contracts, extension contributions, telemetry safeguards, management search, packaging, and other invariants.

### Required pre-PR verification

Before opening or updating a pull request, run:

```bash
npm run verify
```

This is the same command used by GitHub Actions. It validates the webview build, webview assets and protocol contracts, management webview contracts, VS Code contributions, focused repository tests, execution behavior, AI routing, TypeScript types, ESLint, and package contents.

A contribution should not intentionally weaken or bypass these checks to make CI pass.

## Coding guidelines

### TypeScript

The project uses strict TypeScript settings. New code should:

- Preserve strict typing and avoid unnecessary `any` usage.
- Keep functions and modules focused on one responsibility.
- Prefer existing services, shared contracts, and utilities over duplicating logic.
- Handle async operations and cancellation/error paths deliberately.
- Avoid silently swallowing errors that should be actionable to the user or diagnosable by the extension.
- Keep platform-specific assumptions explicit when working with files, Java, Maven, Gradle, or CLI execution.

Run both `npm run typecheck` and `npm run lint` before submitting changes.

### VS Code commands and settings

Existing command IDs and settings are part of the extension's compatibility surface.

When adding or changing commands, configuration, menus, views, or other VS Code contributions:

- Update `package.json` deliberately.
- Keep the implementation wiring in sync with the declared contribution.
- Avoid renaming or removing existing public command IDs/settings unless the change is intentionally breaking and has been discussed.
- Run `npm run verify`; the repository includes a contribution consistency check.

### Webview and UX changes

For changes under `src/webview/`:

- Use VS Code theme variables and preserve light/dark theme support.
- Keep keyboard navigation and accessibility behavior intact.
- Preserve the webview's content-security and local-asset model.
- Keep messages between the webview and extension host aligned with the existing shared/protocol contracts.
- Avoid adding remote runtime assets when a local bundled asset can be used.
- Run `npm run build:webview` and `npm run verify`.

For visible UI changes, include screenshots or a short recording in the pull request when that makes review easier.

### External services and AI integrations

Do not require real credentials for automated tests. Mock or isolate external services wherever possible.

Changes involving AI providers, GitHub, Jira, Confluence, Zephyr Scale, CI ingestion, or other network integrations should preserve deterministic non-AI/non-network behavior where the feature already supports it.

Provider selection must remain explicit. Do not silently send a request to a different AI provider when the configured provider is unavailable.

## Security and privacy requirements

Security and privacy behavior is part of the product contract, not an optional implementation detail.

Contributions must not:

- Hard-code API keys, tokens, passwords, cookies, or credentials.
- Commit `.env` files, private workspace data, production payloads, or user data.
- Print secrets or unredacted authentication material to logs.
- Bypass VS Code `SecretStorage` for credentials that should remain secret.
- Disable existing redaction or safety controls without a documented reason.
- Make destructive Bug Hunter behavior the default.
- Expand network access or external data sharing silently.

If a change modifies what data is stored, logged, sent to an AI provider, or transmitted to a third-party service, update the relevant documentation in `README.md` and/or `docs/PRIVACY.md` in the same pull request.

## Generated and local files

Do not commit local development output such as:

```text
node_modules/
out/
.vscode-test/
*.vsix
.env
.agents/
.karate-test-management/
```

The repository `.gitignore` contains the authoritative list of ignored local and generated development artifacts.

Do not edit compiled files under `out/` directly. Change the TypeScript source and rebuild instead.

## Documentation changes

Documentation contributions are welcome.

When a change affects user-visible behavior, settings, supported versions, privacy behavior, or workflows, update the appropriate documentation alongside the code. Keep command names and setting keys exactly aligned with the current extension.

Do not update the extension version or release notes for an ordinary contribution unless the change is specifically part of a release/versioning task.

## Branches and commits

Create a focused branch for your change, for example:

```bash
git checkout -b fix/execution-discovery
git checkout -b feat/coverage-filtering
git checkout -b docs/contributing-guide
```

Keep commits scoped and understandable. A clear commit message such as the following is preferred:

```text
fix: handle Gradle runner discovery in multi-module workspaces
feat: add coverage filtering by API tag
test: cover AI routing fallback within selected provider
docs: clarify Java requirements for Karate 2.x
```

Conventional Commit prefixes are useful for readability but are not required unless a maintainer requests them.

## Pull request checklist

Before requesting review, confirm that:

- [ ] The change has a clear purpose and is reasonably scoped.
- [ ] Relevant tests were added or updated.
- [ ] `npm run verify` passes locally.
- [ ] No credentials, private data, or generated local artifacts are included.
- [ ] User-facing behavior and settings are documented when needed.
- [ ] Privacy documentation is updated if data handling changed.
- [ ] Webview changes were rebuilt and manually checked in the Extension Development Host.
- [ ] Screenshots or recordings are included for meaningful visual changes.
- [ ] Existing command IDs/settings remain compatible unless a breaking change was explicitly intended.

GitHub Actions will run `npm ci` followed by `npm run verify` for pull requests.

## Bug reports

You can report bugs from the extension with **Karate: Report a Bug** or open a GitHub issue directly.

For execution problems, include:

- Karate Test Management extension version
- VS Code version
- Operating system
- Selected or discovered execution strategy (`cli`, Maven, Gradle, or custom runner)
- Java version when relevant
- Minimal reproducible project structure
- Expected behavior
- Actual behavior and sanitized error output

Never include access tokens, authentication headers, production API data, private feature contents, or other sensitive information in a public issue.

## License

By contributing to this repository, you agree that your contribution will be licensed under the project's [MIT License](LICENSE).
