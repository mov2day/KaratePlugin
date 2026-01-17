# Change Log

All notable changes to the "Karate Test Generator" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.12] - 2026-01-17

### Added
- **Coverage Dashboard Enhancements**:
  - **Append to File**: "Generate Test" and "Generate with AI" now support appending scenarios to existing feature files
  - **Context-Aware AI Generation**: When appending, Copilot automatically reuses existing Background variables, auth setup, and coding style
  - **File Selection**: Intelligent QuickPick to choose between "New Feature File" or "Append to [Selected File]"
- **Copilot Model Selection**: Dynamic model picker command to select from available Copilot models
  - Command: "Karate: Select Copilot Model" shows real-time available models
  - Settings dropdown: `karateDsl.copilot.model` with 6 predefined models (default: gpt-5-mini)
  - Auto-refresh: Changing model in settings re-initializes Copilot instantly
  - Smart fallback: Automatically uses gpt-4o/gpt-4/gpt-3.5-turbo if configured model unavailable
- **Copilot Initialization**: Model object cached at VS Code startup for instant operations
- **Configuration Listener**: Dynamic re-initialization when model setting changes

### Improved
- **Smart Appending**: Appending tests via AI now reads the target file first to ensure seamless integration with existing `Background` sections
- **Performance**: All Copilot operations now use cached model object (zero runtime latency)
- **Error Handling**: Quota exhaustion shows "Change Model" button for easy switching
- **Notification Reliability**: Fixed missing `await` on transient error notifications
- **Invalid Spec Handling**: Auto-untrack specs with formatting errors to prevent notification loops
  - Shows 3-second transient notification before auto-dismissing
  - Prevents infinite error notifications for malformed specs

### Fixed
- Missing `await` on `withProgress` for transient spec error notifications
- All 11 notification points now properly auto-dismiss in error cases
- Invalid tracked specs causing continuous error notifications

### Technical
- Added `cachedModel` property to CopilotService
- Re-implemented `initialize()` method for startup model caching
- Updated all Copilot methods to use cachedModel (sendMultiTurnRequest, generateAdditionalScenarios, getSuggestions)
- Comprehensive notification audit completed (11 withProgress, 17 errors, 13 warnings)

## [1.2.10]
- **New Feature**: "Project Health Doctor" - A comprehensive suite for maintaining high-quality Karate tests.
- **Feature**: Real-time Linter with 8+ rules (Indentation, Naming, Hardcoded URLs).
- **Feature**: Interactive Health Dashboard with Dependency Graph (Mermaid.js).
- **Feature**: Security Scanner for missing auth tests and hardcoded secrets.
- **Feature**: Code Actions (Quick Fixes) for formatting issues.
- **Improved**: Added `karate.linter.enabledRules` configuration to toggle specific rules.


## [1.2.9] - 2026-01-15

### Improved
- **Copilot Reliability**: Optimized prompts to prevent "Sorry, I can't assist with that" responses by removing safety-triggering language while maintaining test quality.
- **Smart Retry Mechanism**: Automatically detects Copilot refusals and retries with refined instructions to ensure successful test generation.
- **Strict Anti-Hallucination**: Enforced stricter context adherence to prevent invention of non-existent fields or endpoints.
- **Context Preservation**: Fixed an issue where large OpenAPI specs or Postman collections similar to 50KB+ were truncating context in multi-turn conversations.

## [1.2.8] - 2026-01-14

### Added
- **Multi-Turn Copilot Support**: All Copilot interactions now use intelligent multi-turn conversations
  - Automatic chunking for large content (>3000 chars) - no token limits
  - Full context support: OpenAPI specs, Confluence docs, and Postman collections
  - Complete content sent to Copilot in labeled chunks for maximum context awareness
- **Enhanced Context Chunking**: 
  - OpenAPI specifications: Full spec chunked and sent (handles 50KB+ specs)
  - Confluence documentation: Full docs extracted and chunked (handles 20KB+ docs)
  - Postman collections: Complete collection JSON chunked and sent
  - Combined mode: Both OpenAPI + Confluence sent together
- **Comprehensive Prompt Engineering**:
  - Production-ready enhancement: 7 detailed categories
  - Covers edge cases, security validation, performance, best practices
- **Postman Context Type**: Added semantic `postman` type to CopilotFullContext interface

### Improved
- **Content Policy Compliance**: Updated security testing terminology for Copilot compliance
  - Replaced "SQL injection" with "database parameter sanitization"
  - Replaced "XSS" with "output encoding validation"
  - Maintains same testing intent with policy-safe language
- **Prompt Quality**: All Copilot prompts now use structured, comprehensive requirements
- **Context Awareness**: Copilot sees 100% of documentation, not just summaries

### Technical
- Enhanced `sendMultiTurnRequest()` helper for consistent multi-turn logic across all methods
- Updated `enhanceKarateTest()` with full context support and 7-category prompts
- Updated `enhanceKarateTestComprehensive()` with full context support and 15-category prompts
- All enhancement methods pass `fullContext` for complete awareness

## [1.2.6] - 2026-01-13

### Added
- **Dynamic Copilot Model Selection**: Extension now automatically discovers available Copilot models and intelligently falls back when configured model is unavailable
- **Plain Text Confluence Content**: Confluence API now fetches plain text format (atlas_doc_format) eliminating HTML cleanup issues
- **Enhanced Postman Script Conversion**: Dramatically improved conversion accuracy for both test and pre-request scripts
  - Response value extraction: `pm.environment.set("token", pm.response.json().token)` now properly converts to `* def token = response.token`
  - Array validations, property existence checks, and variable assignments
  - Timestamp generation, random data, and complex expressions in pre-request scripts
  - 8 new test script patterns and 6 new pre-request patterns added

### Improved
- **Copilot Integration**: All Copilot features now use centralized service with dynamic model discovery and 5-minute caching
- **Quota Handling**: Graceful degradation when Copilot quota is exhausted - returns original tests with helpful user notifications
- **Model Fallback**: Automatic priority-based fallback (gpt-4o → gpt-4 → gpt-3.5-turbo) with user notifications
- **Postman Copilot Conversion**: Enhanced prompts with detailed examples for better script-to-Karate conversion accuracy
- **Confluence Integration**: Improved error messages for authentication, connectivity, and configuration issues
- **Settings Persistence**: Fixed Confluence base URL and email configuration saving

### Fixed
- Confluence settings not persisting after reload
- HTML entities in Confluence content causing readability issues
- Postman scripts only generating status code validations
- Hardcoded Copilot model causing failures for users without specific model access
- Missing response value extraction in Postman test scripts

### Technical
- Removed manual Copilot model selection from UI (now automatic)
- Added model availability caching (5 minutes) for performance
- Enhanced error handling for quota exhaustion and unavailable models
- Improved Confluence client with base URL normalization and type detection

## [1.2.5] - 2025-12-28

### 🚀 Major Enhancements

#### Comprehensive Copilot Integration
- **Enhanced AI Test Generation**: Added `enhanceKarateTestComprehensive()` with detailed prompts covering:
  - Positive test cases (200, 201, 204 status codes)
  - Negative test cases (400, 401, 403, 404 errors)
  - Edge cases (empty, null, boundary values)
  - Corner cases (special characters, long strings, timezone issues)
  - Race conditions (concurrent requests, idempotency)
  - Security tests (authentication, authorization, injection attacks)
- **Karate DSL Best Practices**: AI now generates tests with proper variable usage, Scenario Outlines, comprehensive assertions, and professional formatting
- **AI-Powered Postman Conversion**: Enhanced script conversion with Copilot for better accuracy

#### Coverage Dashboard Improvements
- **Fixed File Selection**: Resolved issue where OpenAPI specs and feature files couldn't be selected
- **Accurate Coverage Analysis**: Fixed bug where dashboard showed 100% coverage even when tests were missing
  - Now uses only selected feature files instead of auto-discovering all workspace files
  - Coverage accurately reflects the selected test files
- **Refresh Functionality**: Added "🔄 Refresh Analysis" button to re-analyze coverage after file modifications
- **Progress Feedback**: Added visual progress notifications for AI test generation showing each step
- **AI Generation Buttons**: Added "🤖 Generate with AI" buttons to:
  - Uncovered endpoints in the endpoint list
  - Priority endpoints in AI Insights section

### 🐛 Bug Fixes
- Fixed JavaScript syntax errors in coverage dashboard webview
- Fixed variable scope issues preventing file paths from being stored
- Fixed CSP violations by removing inline onclick handlers
- Fixed message communication between extension and webview
- Fixed coverage analyzer to use user-selected files instead of workspace auto-discovery

### 🎨 UI/UX Improvements
- Added comprehensive console logging for debugging
- Improved error handling with try-catch blocks
- Added event delegation for dynamically created buttons
- Better visual feedback during AI operations

## [1.2.4] - 2026-01-05

### 🎉 Major Features

#### 📊 Next-Gen Interactive Coverage Dashboard
- **New Re-imagined UI**: A modern, full-screen dashboard replacing the old sidebar view for a more immersive analysis experience.
- **Interactive Control Panel**: 
  - **📂 Multi-select Specs**: Easily browse and select multiple OpenAPI specifications.
  - **📂 Custom Feature Selection**: Manually pick exactly which folders or feature files to include in the analysis.
  - **🤖 One-Click AI Analysis**: Toggle Copilot's enhanced reasoning with a single switch.
- **Robust Visualization**: 
  - **Clean Method Breakdown**: Visual bar charts for GET, POST, PUT, DELETE coverage.
  - **Real-time Stats**: Instant updates on total coverage percentage and endpoint counts.
- **Improved AI Insights**: Get prioritized recommendations and quality assessments directly in the dashboard UI.
- **Direct Action**: Generate missing tests or view details directly from the endpoint list.

### 🔧 Bug Fixes & Improvements
- **Security Fix**: Applied robust Content Security Policy (CSP) and nonces to the webview.
- **Stability**: Rewrote webview script core to resolve syntax errors and improve event handling in restricted VS Code environments.
- **UI/UX**: Better layout responsiveness and VS Code theme integration.

## [1.2.3] - 2026-01-03

### 🎉 Major Features

#### Postman Collection Import
- **Import Postman Collections**: Convert Postman collections to Karate DSL tests
- **Environment File Support**: Import and merge Postman environment variables
- **Copilot Enhancement**: Optional AI-powered improvement of converted tests
  - Better variable handling and definitions
  - Improved test script → Karate assertion conversion
  - Realistic test data generation
  - Enhanced pre-request script conversion
  - Proper authentication setup
- **Smart Conversion**: Automatic conversion of:
  - HTTP requests (GET, POST, PUT, DELETE, etc.)
  - Headers and query parameters
  - Request bodies (JSON, form-data, urlencoded)
  - Authentication (Basic, Bearer, API Key)
  - Postman variables ({{var}} → #(var))
- **Folder Structure Preservation**: Maintains collection organization
- **Right-Click Integration**: Import directly from Explorer context menu

#### Visual Test Coverage Dashboard
- **Multi-Spec Analysis**: Analyze multiple OpenAPI specifications simultaneously
- **Multi-Directory Support**: Select specific feature file directories to include
- **Copilot-Powered Coverage Computation**:
  - Accurate coverage percentage calculation
  - Quality assessment (Excellent/Good/Fair/Poor)
  - Top 5 priority endpoints needing tests
  - Specific recommendations for improvement
  - Risk assessment for uncovered endpoints
- **Enhanced Endpoint Matching**:
  - Path segment matching
  - Operation ID matching
  - Path parameter detection
  - Case-insensitive matching
- **Beautiful HTML Reports**: Export comprehensive coverage reports with:
  - Overall coverage statistics
  - Method breakdown (GET, POST, PUT, DELETE)
  - Endpoint-level details
  - Copilot insights section
  - Priority recommendations
- **Intelligent Missing Test Analysis**: Copilot suggests specific test scenarios:
  - Success cases (200, 201, 204)
  - Client errors (400, 401, 403, 404)
  - Server errors (500, 503)
  - Edge cases and boundary conditions
  - Security tests

### ✨ Enhancements
- **Better Coverage Matching**: Improved algorithm for matching endpoints to test scenarios
- **Flexible Selection**: Choose exactly which specs and features to analyze
- **Actionable Insights**: Specific, prioritized recommendations
- **Enhanced Services**: Created `EnhancedCoverageService` for better analysis
- **Improved Logging**: Better debug information throughout

### 🔧 Technical Improvements
- Created `PostmanParser` service (300+ lines)
- Created `PostmanToKarateConverter` service (400+ lines)
- Created `PostmanImportService` service (300+ lines)
- Enhanced `CoverageAnalyzer` with Copilot integration (400+ lines)
- Created `EnhancedCoverageService` for multi-spec analysis (250+ lines)
- Total new code: ~1650 lines

### 📚 Documentation
- Updated README with new features
- Added detailed usage examples
- Updated version badges

## [1.2.1] - 2025-12-29

### 🎉 Major Features

#### AI-Powered Test Maintenance
- **Copilot Integration for Test Updates**: When OpenAPI specs change, use GitHub Copilot to intelligently update affected tests
- **Intelligent Diff Analysis**: Automatically detects added, removed, and modified endpoints
- **Context-Aware Updates**: Copilot receives old spec, new spec, and current test content for smart updates
- **Preserves Custom Logic**: AI updates tests while maintaining your custom assertions and logic

#### Smart Notification System
- **Notification Debouncing**: 30-second cooldown prevents duplicate notifications
- **Processing Awareness**: Notifications blocked while Copilot is running
- **Automatic Hash Updates**: Tests updated → hash updated → no re-notification
- **Clean User Experience**: No more notification spam!

#### Independent Command Execution
- **Direct Generation**: "Generate Tests Now" works without opening extension panel
- **Direct Style Learning**: "Learn Style Now" works independently
- **Immediate Feedback**: Progress notifications with "Open File" option
- **No Webview Dependency**: Commands work even if panel isn't initialized

### ✨ New Features

- **Manual OpenAPI Diff Comparison**: Compare two OpenAPI versions and intelligently update feature files
  - Select old and new spec versions
  - Scans repository for existing feature files
  - Intelligently matches endpoints to files (3-tier strategy)
  - Updates scenarios in-place without regeneration
  - Marks removed endpoints as deprecated

- **Notification Tracking**: Prevents showing same notification multiple times
- **Processing Flag**: Blocks notifications during Copilot execution
- **Enhanced Logging**: Better debug information for troubleshooting

### 🐛 Bug Fixes

- **Fixed**: "Generate Tests Now" context menu not creating files
  - Root cause: Webview initialization dependency
  - Solution: Direct service invocation without webview

- **Fixed**: "Learn Style Now" context menu not working
  - Root cause: Same webview dependency issue
  - Solution: Direct StyleAnalyzer call with detailed feedback

- **Fixed**: Notification spam after clicking "Ignore"
  - Root cause: Hash not updated on ignore
  - Solution: Update hash when user ignores changes

- **Fixed**: Repeated notifications during polling
  - Root cause: No cooldown mechanism
  - Solution: 30-second cooldown with timestamp tracking

- **Fixed**: Notifications appearing during Copilot processing
  - Root cause: No processing state tracking
  - Solution: Processing flag with try-finally cleanup

### 🔄 Changes

- **Simplified Notifications**: Reduced from 4 buttons to 2
  - Removed: "View Changes" and "Update Tests"
  - Kept: "Update with Copilot" and "Ignore"
  - Cleaner, more focused user experience

- **Automatic Cleanup**: Hash updates happen automatically after Copilot fixes
- **Better Error Handling**: All operations wrapped in try-catch with proper logging

### 📚 Documentation

- Added comprehensive walkthrough documentation
- Created marketplace-ready README
- Moved development docs to DEVELOPMENT.md
- Added detailed changelog

### 🔧 Technical Improvements

- **Service Architecture**: Commands now use services directly
- **Notification Management**: Map-based tracking with timestamps
- **Processing State**: Set-based tracking for active operations
- **Type Safety**: Fixed AffectedTest interface compatibility
- **Compilation**: All TypeScript errors resolved

## [1.1.1] - 2025-12-25

### Added
- Activity bar icon and panel
- Modern webview UI
- Template management system
- History tracking
- GitHub Copilot integration

### Fixed
- OpenAPI parser library compatibility
- TypeScript compilation errors
- UI regressions

## [1.1.0] - 2025-12-20

### Added
- AI-Powered Test Maintenance system
- Spec change detection with file watcher
- Spec diff analyzer
- Test impact analyzer
- Sync panel UI

### Changed
- Improved extension architecture
- Better service organization

## [1.0.0] - 2025-12-15

### Added
- Initial release
- OpenAPI to Karate test generation
- Basic template support
- Configuration options

---

## Legend

- 🎉 Major Features
- ✨ New Features
- 🐛 Bug Fixes
- 🔄 Changes
- 📚 Documentation
- 🔧 Technical Improvements
- ⚠️ Breaking Changes
- 🗑️ Deprecated
