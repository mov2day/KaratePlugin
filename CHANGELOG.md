# Changelog

All notable changes to the Karate Test Generator extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.2] - 2026-01-01

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
