# Karate API Test Generator for VS Code

> **The complete Karate DSL toolkit** — Generate, execute, maintain, and analyze API tests with AI assistance.

Transform OpenAPI specs, Postman collections, and Confluence docs into production-ready Karate tests in seconds. Run them from your editor, track coverage, and let AI keep everything in sync as your API evolves.

[![Version](https://img.shields.io/badge/version-1.3.5-blue.svg)](https://marketplace.visualstudio.com/items?itemName=MuthuKumarKoodalingam.karate-test-generator)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.108.0+-brightgreen.svg)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**Keywords**: Karate API testing, OpenAPI test generation, API automation, Karate DSL, REST API testing, BDD API tests, QA automation, contract testing, Postman to Karate converter

---

## 🆕 What's New in v1.3.5

### 🧠 Agent Skills & Prompt Hardening
- **Grounded AI Generation**: Copilot now uses a dedicated knowledge base of Karate best practices to generate code.
- **Zero Hallucination**: Strict scoping rules ensure AI **only** uses endpoints and fields that actually exist in your API spec.
- **4 Bundled Skills**: Includes guides for `karate-dsl-reference`, `test-patterns`, `anti-patterns`, and `reusability`.

### 🎯 Precision Controls UI
- **Fine-Grained Filtering**: Select exactly which **Scenario Types** (Positive, Negative, Edge, Security) and **HTTP Methods** you want to generate.
- **Custom Instructions**: Provide free-text guidance to Copilot for specific requirements (e.g., "Use tenantId header for all requests").

### 🏗️ Feature Structuring Engine
- **Domain-Driven Organization**: Automatically groups tests into separate feature files based on your API's domain or tags.
- **3 Structuring Strategies**:
  - `Domain` (default): Group by tag/resource (e.g., `orders.feature`, `users.feature`).
  - `Flat`: All scenarios in one file.
  - `Method`: Group by HTTP method.

### ♻️ Smart Reusability Engine
- **Auto-Extraction**: Detects repeated patterns (auth, setup, headers) and extracts them into reusable `common/` feature files.
- **Intelligent Stubs**: Auto-creates `common/setup.feature`, `common/auth.feature` etc. with functional defaults if they don't exist.

- Internal code quality improvements, security hardening, and test infrastructure updates.

---

## 🚀 Previously in v1.3.3

### 🔍 Universal Config Discovery
- **Workspace-Wide Search**: Automatically finds `karate-config.js` and runner classes anywhere in your project — no more hardcoded paths.
- **LLM-Powered Suggestions**: Copilot suggests optimal classpath and JVM args based on your project structure.

### ⚙️ Custom Execution Parameters
Three new settings let you control exactly how tests run:

| Setting | Example | Purpose |
|:--------|:--------|:--------|
| `systemProperties` | `{"karate.env": "staging"}` | `-D` flags for every run |
| `jvmArgs` | `["-Xmx1g"]` | JVM tuning flags |
| `karateArgs` | `["--threads", "5"]` | Karate CLI arguments |

### 📥 HAR File Import
- **One-Click Import**: Convert `.har` files from browser DevTools into Karate feature files.
- **AI Enhancement**: Copilot enriches imported requests with assertions and error scenarios.

---

## ⚡ Why Karate API Test Generator?

Stop wasting hours manually writing Boilerplate Gherkin. Let AI handle the structure so you can focus on business logic.

| Workflow | Manual | With This Extension |
|:---------|:------:|:-------------------:|
| **New Test Creation** | 15–30 min | **< 30 seconds** |
| **OpenAPI Sync** | Manual tracking | **Auto-detect & Update** |
| **Postman Migration** | Rewrite everything | **One-click Import** |
| **Test Quality** | Peer review needed | **Copilot Optimized** |
| **Coverage Visibility** | Spreadsheet hell | **Visual Dashboard** |

---

## ✨ Features at a Glance

### 🤖 AI-Powered Test Generation
Generate tests from **three input sources**, each enhanced by GitHub Copilot:

- **OpenAPI / Swagger** — Right-click any `.json`, `.yaml`, or `.yml` spec → *Generate Tests Now*
- **Confluence Documentation** — Pull API docs from Confluence pages and generate tests
- **Combined (OpenAPI + Confluence)** — Merge spec structure with documentation context for the richest tests

Copilot adds: smart assertions, realistic test data, edge-case scenarios (400, 401, 404, 500), and performance tests.

### 🧪 Native Test Executor
Run Karate tests directly from VS Code — no terminal required.

- **CodeLens Actions**: Click **▶ Run Feature** or **▶ Run Scenario** inline in `.feature` files
- **Testing Sidebar**: All features and scenarios appear in the VS Code Testing tab
- **Auto-Discovery**: Every `.feature` file in your workspace is detected automatically
- **Build Tool Support**: CLI (standalone JAR), Maven, or Gradle — auto-detected or configurable

### 📊 Premium Execution Dashboard
A modern, interactive dashboard replaces plain-text reports.

![Dashboard Overview](https://github.com/mov2day/Docs/blob/main/dashboard-overview.png?raw=true)

- **Visual Analytics**: Donut charts for pass/fail rates, bar charts for duration
- **Feature Drill-Down**: Expand any feature to inspect scenarios and step-level details
- **Search & Filter**: Find failing tests instantly
- **Dark Mode**: Full VS Code theme support with glassmorphism effects

![Feature Breakdown](https://github.com/mov2day/Docs/blob/main/dashboard-feature.png?raw=true)

![Step-Level Details](https://github.com/mov2day/Docs/blob/main/dashboard-detail.png?raw=true)

### 📈 Visual Test Coverage
Track which API endpoints have tests and which don't.

- **Coverage Dashboard**: See tested vs untested endpoints at a glance
- **Gap Analysis**: Identify missing test scenarios per endpoint
- **Generate Missing Tests**: Click to generate tests for uncovered endpoints
- **Append to Existing Files**: Add AI-generated scenarios to existing feature files with matching style

### 📦 Postman Collection Import
Migrate from Postman to Karate in one click.

- **Full Collection Conversion**: Collections + environments → Karate feature files
- **Variable Translation**: Postman `{{variables}}` become Karate `karate.properties`
- **Script Conversion**: Pre-request scripts and test assertions converted via Copilot

### 📥 HAR File Import
Convert real API traffic into Karate tests.

- **Browser DevTools**: Export a `.har` file from Chrome/Firefox DevTools → import into the extension
- **AI Enhancement**: Copilot analyzes requests and generates assertions, schema checks, and error scenarios
- **Selective Import**: Choose which requests to convert — filter by domain, method, or status code

### 🔄 Automatic Test Maintenance
When your OpenAPI spec changes, the extension keeps tests in sync.

1. **Detects changes** when you save the spec
2. **Analyzes impact** on existing test files
3. **Uses Copilot** to intelligently update affected tests
4. **Preserves custom logic** you've added manually

### 🩺 Project Health Doctor
Real-time code quality analysis for Karate projects.

- **Linter**: Catches errors as you type — hardcoded URLs, duplicate scenarios, indentation issues
- **Security Scanner**: Detects missing auth tests and hardcoded secrets
- **Quick Fixes**: One-click auto-fixes for common issues
- **Health Dashboard**: Visualize project structure and dependencies

### 🎨 Style Learning
Maintain consistency across your team's tests.

- **Learn from Examples**: Right-click a well-formatted `.feature` file → *Learn Style Now*
- **Future Consistency**: All generated tests match your team's patterns
- **Template System**: Save and reuse preferred test structures

### 🛡️ Copilot Transparency & Privacy
Full visibility into AI interactions.

- **Activity Log**: View every prompt and response (`Cmd+Shift+P` → *Show Copilot Activity Log*)
- **Privacy**: Sensitive data (API keys, tokens) is automatically redacted
- **Performance Metrics**: See response times and token usage

---

## 🚀 Quick Start

### 1. Install
Search for **"Karate Test Generator"** in the VS Code Extensions marketplace, or install from the [Marketplace page](https://marketplace.visualstudio.com/items?itemName=MuthuKumarKoodalingam.karate-test-generator).

### 2. Generate Your First Test

**Option A — Right-Click Menu** (fastest):
1. Right-click any OpenAPI spec file (`.json`, `.yaml`, `.yml`)
2. Select **Karate: Generate Tests Now**
3. Click **Open File** to view the generated `.feature` file

**Option B — Extension Panel**:
1. Click the **Karate icon** in the Activity Bar
2. Navigate to the **OpenAPI** tab
3. Select your spec file and click **Generate Tests**

### 3. Run Tests
- Click **▶ Run Feature** above the `Feature:` line in any `.feature` file
- Or open the **Testing** sidebar and click the play button

### 4. Enable AI Enhancement (optional)
1. Install the **GitHub Copilot** extension
2. Generate tests as usual — Copilot automatically enhances them with richer assertions and edge cases

---

## 📖 Usage Guide

### Generating from OpenAPI

```
Right-click spec.yaml → "Karate: Generate Tests Now"
```

Or use the Extension Panel → **OpenAPI** tab with the Copilot toggle for AI-enhanced output.

### Generating from Confluence

1. Open the Extension Panel → **Confluence** tab
2. Enter the Confluence page URL
3. Provide credentials (see [Configuration](#-configuration) below)
4. Click **Generate Tests**

**Extracted content**: API endpoint descriptions, request/response examples, business logic, edge cases.

### Combined Generation (OpenAPI + Confluence)

1. Open the Extension Panel → **Combined** tab
2. Select the OpenAPI spec file
3. Enter the Confluence documentation URL
4. Click **Generate Tests**

**Result**: Tests combine the **structure** from your OpenAPI spec with the **business context** from your documentation.

### Importing Postman Collections

```
Cmd+Shift+P → "Karate: Import Postman Collection"
```

Select your Postman collection file (`.json`) and optionally an environment file.

### Running Tests

| Method | Where | Scope |
|:-------|:------|:------|
| **▶ Run Feature** (CodeLens) | Above `Feature:` line | Entire feature |
| **▶ Run Scenario** (CodeLens) | Above each `Scenario:` | Single scenario |
| **Testing Sidebar** | VS Code Testing tab | Any combination |
| **Run Folder** | Command palette | All features in folder |
| **Run by Tags** | Command palette | Tag-filtered execution |

### Learning Style

```
Right-click your best .feature file → "Karate: Learn Style Now"
```

All future generations will match this file's formatting, naming, and assertion patterns.

---

## ⚙️ Configuration

Access settings via **Preferences → Settings** and search for `karateDsl`.

### Execution Settings

| Setting | Default | Description |
|:--------|:--------|:------------|
| `karateDsl.execution.defaultBuildTool` | `cli` | Build tool: `cli`, `maven`, or `gradle` |
| `karateDsl.execution.parallelThreads` | `1` | Number of parallel threads |
| `karateDsl.execution.configPath` | `""` | Custom path to `karate-config.js` or runner class |
| `karateDsl.execution.additionalClasspath` | `[]` | Extra classpath entries |
| `karateDsl.execution.systemProperties` | `{}` | System properties as `-D` flags (e.g., `{"karate.env": "local"}`) |
| `karateDsl.execution.jvmArgs` | `[]` | JVM arguments (e.g., `["-Xmx512m"]`) |
| `karateDsl.execution.karateArgs` | `[]` | Karate CLI arguments (e.g., `["--threads", "5"]`) |
| `karateDsl.execution.autoOpenReport` | `true` | Auto-open execution report after runs |
| `karateDsl.execution.historyLimit` | `20` | Max execution history entries |

### Confluence Settings

| Setting | Description |
|:--------|:------------|
| `karateDsl.confluence.baseUrl` | Confluence URL (e.g., `https://confluence.company.com`) |
| `karateDsl.confluence.email` | Your email (Cloud) or leave empty (Data Center) |
| `karateDsl.confluence.apiToken` | Atlassian API Token (Cloud) or PAT (Data Center) |
| `karateDsl.confluence.authType` | `basic` for Cloud, `bearer` for Data Center |

### Copilot Settings

| Setting | Default | Description |
|:--------|:--------|:------------|
| `karate.copilot.logging.enabled` | `true` | Toggle AI activity logging |
| `karate.copilot.logging.redactSensitiveData` | `true` | Auto-redact secrets from logs |
| `karate.copilot.logging.showTokenUsage` | `false` | Show token consumption stats |

### Agent Skills (VS Code 1.108+)

| Setting | Default | Description |
|:--------|:--------|:------------|
| `karateDsl.agentSkills.enabled` | `true` | Enable Karate-specific skills for Copilot |
| `karateDsl.agentSkills.autoSuggest` | `true` | Auto-suggest relevant skills |

Agent Skills provide Karate-specific domain knowledge (syntax patterns, API testing best practices, conversion rules) to GitHub Copilot. Automatically enabled on VS Code 1.108+; gracefully disabled on earlier versions.

---

## 📝 Example Output

**Input**: OpenAPI spec with `/pets/{id}` endpoint

**Generated Test**:
```gherkin
Feature: Pet API Tests

  Background:
    * url baseUrl
    * def petId = 1

  Scenario: Get pet by ID - Success
    Given path 'pets', petId
    When method GET
    Then status 200
    And match response.id == petId
    And match response.name == '#string'

  Scenario: Get pet by ID - Not Found
    Given path 'pets', 99999
    When method GET
    Then status 404
```

---

## 🔧 Requirements

| Requirement | Version | Notes |
|:------------|:--------|:------|
| **VS Code** | 1.108.0+ | Recommended. Basic features work on 1.104+ |
| **Java** | 8+ | Required for running Karate tests |
| **GitHub Copilot** | Latest | Optional, for AI-enhanced features |

---

## 🐛 Troubleshooting

**Tests not generating?**
- Verify the file is a valid OpenAPI spec (JSON/YAML)
- Check the Output panel → **Karate Test Generator** for errors

**Copilot not working?**
- Ensure GitHub Copilot extension is installed and activated (check status bar)
- Verify you have an active Copilot subscription

**karate.env not being applied?**
- Set it in `systemProperties`, not as a separate environment setting:
  ```json
  "karateDsl.execution.systemProperties": { "karate.env": "local" }
  ```
- Check Output panel for `[DEBUG] User systemProperties:` to confirm it's read

**Config file not found?**
- The extension searches your entire workspace. Check Output panel for discovery logs.
- Use `karateDsl.execution.configPath` to set an explicit path.

---

## 📚 Documentation

- [Copilot Integration Guide](docs/COPILOT_GUIDE.md)
- [Development Setup](DEVELOPMENT.md)

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

- Built with [Karate DSL](https://github.com/karatelabs/karate)
- Powered by [GitHub Copilot](https://github.com/features/copilot)
- OpenAPI parsing by [@apidevtools/swagger-parser](https://github.com/APIDevTools/swagger-parser)

## 💬 Feedback & Support

- 🐛 [Report Issues](https://github.com/mov2day/KaratePlugin/issues)
- 💡 [Request Features](https://github.com/mov2day/KaratePlugin/issues/new)
- ⭐ [Star on GitHub](https://github.com/mov2day/KaratePlugin)

---

**Made with ❤️ for the Karate testing community**
