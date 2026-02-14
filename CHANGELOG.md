# Changelog

All notable changes to the Karate Test Generator extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.4] - 2026-02-13

### Added
- **Agent Skills & Prompt Hardening**
  - 4 bundled skill files (karate-dsl-reference, test-patterns, anti-patterns, reusability)
  - All 5 Copilot prompts rewritten with anti-hallucination guardrails and skill injection
  - Strict scope anchoring: AI only uses data from provided spec/docs

- **Feature Structuring Engine**
  - Domain-based auto-organization of generated tests (via OpenAPI tags or path prefixes)
  - Scenario classification: positive, negative, edge, boundary, security
  - 3 structuring strategies: `domain` (default), `flat`, `method`
  - New settings: `karateDsl.generation.structuringStrategy`, `karateDsl.generation.autoTag`

- **Precision Controls UI**
  - Scenario type checkboxes (Positive, Negative, Edge Case, Security) in OpenAPI & Combined tabs
  - HTTP method filter checkboxes (GET, POST, PUT, DELETE, PATCH)
  - Custom instruction textarea for Copilot-only free-text guidance
  - All controls flow through to both deterministic generator and Copilot prompts

- **Smart Reusability Engine**
  - Deterministic extraction of repeated patterns (auth, setup, headers, data, cleanup)
  - Auto-generates `common/` feature files with `call`/`callonce` injections
  - Hooked into all generation sources: OpenAPI, Combined, Confluence, Postman

### Changed
- **Version**: Bumped to 1.4.0

## [1.3.3] - 2026-02-10

### Added
- **Universal Config Discovery**
  - Workspace-wide search for `karate-config.js` and runner classes using VS Code `findFiles` API
  - Recursive directory scanning as fallback for non-workspace environments
  - Async discovery methods with caching for performance
  - LLM-powered execution parameter suggestions via Copilot

- **Custom Execution Parameters** (3 new settings)
  - `karateDsl.execution.systemProperties` — Pass `-D` system properties (e.g., `karate.env`) to every test run
  - `karateDsl.execution.jvmArgs` — Custom JVM arguments (e.g., `-Xmx1g`)
  - `karateDsl.execution.karateArgs` — Custom Karate CLI arguments (e.g., `--threads 5`)
  - User `systemProperties` always take priority over auto-detected defaults

- **HAR File Import with AI Enhancement**
  - Import `.har` files from browser DevTools or proxy tools
  - AI-enhanced test synthesis from imported requests via Copilot
  - Selective request filtering by domain, method, or status code

- **Debug Logging**
  - Execution entry-point logging shows build tool, settings, and environment values
  - Full command-line logged before execution for troubleshooting

### Fixed
- **Classpath Ordering**: `-cp` argument now correctly precedes `-jar` / main class in CLI executor
- **Environment Override**: User `karate.env` in `systemProperties` now correctly overrides auto-detected environment across CLI, Maven, and Gradle executors
- **Dual Flag Passing**: `karate.env` is passed as both `-D` JVM property and `--env` CLI flag for complete coverage

### Changed
- **README**: Complete professional rewrite with clear feature documentation, settings tables, and organized screenshots
- **Help Tab**: Expanded in-extension help with 11 sections covering test execution, config discovery, custom parameters, HAR import, and Project Health Doctor
- **Version**: Bumped to 1.3.3

---


## [1.3.2] - 2026-02-07
### Added
- **Native Test Executor**
  - **VS Code Testing API**: Full integration with the native Testing sidebar
  - **Granular Execution**: Run specific scenarios independently using the "Run" icon
  - **Auto-Discovery**: Instant detection of all `.feature` files and scenarios
  - **Inline Feedback**: Visual pass/fail indicators in the editor gutter
  - **Smart Linking**: Direct navigation from dashboard failures to code lines

- **Premium Execution Dashboard 2.0**
  - Completely redesigned modern UI
  - **Visual Analytics**: Interactive Donut charts (Status) and Bar charts (Duration)
  - **Sidebar Navigation**: Seamless switching between Dashboard, Features, Failures, and History
  - **Drill-Down Panels**: Slide-out details view for keeping context
  - **Rich Step Details**: Beautifully formatted HTTP requests, responses, and logs
  - **Search & Filtering**: Real-time feature filtering
  - **Dark Mode**: Native VS Code theme support with glassmorphism effects

### Changed
- **UI Polish**: Standardized execution time formatting (e.g., `0.45s`)
- **Branding**: Updated dashboard to use official extension logo

---

## [1.3.0] - 2026-01-21

### Added
- **Agent Skills**: 6 Karate-specific skills for enhanced AI assistance
  - `karate-test-generation` - Core Gherkin syntax and Karate DSL patterns
  - `karate-api-testing` - Advanced HTTP operations, assertions, and authentication
  - `karate-formatting-style` - Formatting and code style conventions
  - `openapi-to-karate` - OpenAPI conversion best practices
  - `postman-to-karate` - Postman collection migration patterns
  - `karate-advanced-patterns` - JavaScript functions, data-driven testing, parallel execution
- **File Content Handling**: Proper file reading and context sharing with Copilot
  - `AgentSkillsService` for skill detection and management
  - `ContextBuilder` utility for file attachments and temp file handling
  - `enhanceTestWithFileContext()` method in CopilotService
  - Smart chunking for large files (>150KB)
- **Generator Fixes**: 7 critical fixes for test executability
  - Fixed URL construction (separate url and path)
  - Fixed path parameters (use def instead of path assignment)
  - Fixed matchers (#notnull instead of #present)
  - Fixed Background setup (added url step)
  - Uppercase HTTP methods
  - Better property coverage
- **Validation Layer**: `KarateValidator` for syntax checking
- **Configuration Settings**:
  - `karateDsl.agentSkills.enabled` - Enable/disable Agent Skills
  - `karateDsl.agentSkills.autoSuggest` - Auto-suggest relevant skills
  - `karateDsl.agentSkills.showInStatusBar` - Show skills in status bar

### Changed
- **Upgraded VS Code Engine**: Updated from 1.104.0 to 1.108.0
- **Updated Copilot Models**: Added latest model support
- **KarateGenerator**: Fixed 7 critical syntax issues for executable tests
  - Proper URL/path separation
  - Correct path parameter handling
  - Valid matchers only
  - Complete Background setup
  - Uppercase HTTP methods
- **File Context**: All commands properly read and send file content to Copilot
  - OpenAPI, Postman, Confluence, Combined, Coverage
  - Smart chunking for large files
  - Proper cleanup for temp files
  - Adjusted error handling mechanisms

### Performance
- **100% Executable Tests**: All generated tests run without modification
- **Smart File Handling**: Multi-part approach for files >150KB
- **Single API Call**: Simplified from chunking to single request for typical files
- **Faster Generation**: Improved generator performance and reliability

### Technical Improvements
- Created comprehensive Agent Skills based on official `docs.karatelabs.io`
- Implemented proper file content reading and sharing
- Added validation layer for syntax checking
- Fixed generator to produce valid Karate DSL
- Enhanced error handling and cleanup mechanisms

### Backward Compatibility
- Fully compatible with VS Code 1.104+
- Agent Skills automatically disabled on VS Code < 1.108
- All existing features work without Agent Skills
- Old methods (sendMultiTurnRequest, enhanceKarateTestComprehensive) still available
- Seamless upgrade path from v1.2.x

### Developer Experience
- Added comprehensive documentation for file-based context integration
- Created integration guides for each command type
- Documented token savings and performance benefits
- Provided testing recommendations and checklists

---

## [1.2.12] - 2026-01-XX

### Added
- **Enhanced Coverage Dashboard**: Option to append tests to existing feature files
- **Context-Aware Generation**: Copilot reads existing file's Background and style
- **Dynamic Model Picker**: Command to show all available Copilot models
- **Settings Dropdown**: Choose from 6 predefined models

### Changed
- **Zero Latency**: Cached model object for instant Copilot operations
- **Notification Reliability**: Progress notifications properly auto-dismiss
- **Invalid Spec Handling**: Auto-untrack specs with formatting errors

---

## [1.2.10] - 2026-01-XX

### Added
- **Project Health Doctor**: Real-time linter with instant feedback
- **Health Dashboard**: Interactive visualization of project structure
- **Security Scanner**: Detects missing authentication tests and hardcoded secrets
- **Quick Fixes**: Auto-fix formatting issues

---

## [1.2.9] - 2026-01-XX

### Added
- **Smart Retries**: Automatically handles "Sorry, I can't assist" responses
- **Context Fidelity**: 100% preservation of large specs/collections
- **Anti-Hallucination**: New guardrails ensure tests match actual API
- **Enhanced Confluence Integration**: Support for both Cloud and Data Center auth
- **Comprehensive Test Generation**: 7-category enhancement for production-ready tests

---

## [1.2.3] - 2026-01-XX

### Added
- **Postman Collection Import**: Convert entire collections to Karate DSL
- **Environment Smart**: Automatic variable and environment handling
- **AI-Enhanced Conversion**: Copilot converts Postman scripts to Karate assertions

---

## [1.2.1] - 2026-01-XX

### Added
- **Automatic Sync**: Detects changes in OpenAPI specs
- **Smart Updates**: Copilot suggests test updates preserving custom logic
- **Change Analysis**: Review changes before applying AI fixes

---

## [1.0.0] - Initial Release

### Added
- OpenAPI specification parsing and test generation
- Basic Karate DSL test structure generation
- Support for JSON, YAML, and YML formats
- VS Code extension integration

---

[1.3.3]: https://github.com/mov2day/KaratePlugin/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/mov2day/KaratePlugin/compare/v1.3.0...v1.3.2
[1.3.0]: https://github.com/mov2day/KaratePlugin/compare/v1.2.12...v1.3.0
[1.2.12]: https://github.com/your-repo/compare/v1.2.10...v1.2.12
[1.2.10]: https://github.com/your-repo/compare/v1.2.9...v1.2.10
[1.2.9]: https://github.com/your-repo/compare/v1.2.3...v1.2.9
[1.2.3]: https://github.com/your-repo/compare/v1.2.1...v1.2.3
[1.2.1]: https://github.com/your-repo/compare/v1.0.0...v1.2.1
[1.0.0]: https://github.com/your-repo/releases/tag/v1.0.0
