# Changelog

All notable changes to the Karate Test Generator extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1] - 2026-02-06
### Added
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

[1.3.0]: https://github.com/your-repo/compare/v1.2.12...v1.3.0
[1.2.12]: https://github.com/your-repo/compare/v1.2.10...v1.2.12
[1.2.10]: https://github.com/your-repo/compare/v1.2.9...v1.2.10
[1.2.9]: https://github.com/your-repo/compare/v1.2.3...v1.2.9
[1.2.3]: https://github.com/your-repo/compare/v1.2.1...v1.2.3
[1.2.1]: https://github.com/your-repo/compare/v1.0.0...v1.2.1
[1.0.0]: https://github.com/your-repo/releases/tag/v1.0.0
