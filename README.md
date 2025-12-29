# Karate Test Generator for VS Code

> **AI-Powered Test Generation & Maintenance** for Karate DSL

Generate comprehensive API tests from OpenAPI specifications, Confluence documentation, or both combined. Automatically maintain tests when your API evolves with intelligent AI assistance.

[![Version](https://img.shields.io/badge/version-1.2.0-blue.svg)](https://marketplace.visualstudio.com/items?itemName=your-publisher.karate-test-generator)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.85.0+-brightgreen.svg)](https://code.visualstudio.com/)

## 🎉 What's New in v1.2.0

### Major Features
- 🤖 **AI-Powered Test Maintenance** - Copilot intelligently updates tests when specs change
- 🚫 **Smart Notification System** - No more spam! Intelligent debouncing and processing awareness
- ⚡ **Direct Generation** - Right-click menu now works independently, no panel needed
- 🎨 **Style Learning** - Learn from existing tests to maintain consistency

### Bug Fixes
- ✅ Fixed "Generate Now" not creating files
- ✅ Fixed "Learn Style Now" not working
- ✅ Fixed notification spam during polling
- ✅ Fixed notifications appearing during Copilot processing

### Improvements
- 📊 Better error handling and logging
- 🎯 Simplified notification buttons (Update with Copilot + Ignore)
- 🔄 Automatic hash updates prevent re-notification
- ⏱️ 30-second cooldown prevents duplicate notifications

[See full changelog](CHANGELOG.md)

---

## ✨ Features

### 🤖 AI-Powered Test Generation
- **GitHub Copilot Integration** - Enhance generated tests with AI suggestions
- **Smart Test Scenarios** - Automatically generate positive and negative test cases
- **Intelligent Assertions** - AI-powered validation based on your API schema

### 📋 Multiple Input Sources

#### OpenAPI Specifications
- **Instant Test Generation** - Right-click any OpenAPI file → "Generate Tests Now"
- **Multiple Formats** - Supports JSON, YAML, and YML specifications
- **Complete Coverage** - Generates tests for all endpoints automatically

#### Confluence Documentation
- **Documentation-Driven Tests** - Generate tests from Confluence API documentation
- **Flexible Input** - Supports Confluence pages with API specifications
- **Team Collaboration** - Perfect for teams using Confluence for API docs

#### Combined Generation
- **Best of Both Worlds** - Combine OpenAPI specs with Confluence documentation
- **Enhanced Context** - Uses spec structure + documentation details
- **Richer Tests** - More comprehensive test scenarios with business context

### 🔄 Automatic Test Maintenance
- **Spec Change Detection** - Monitors OpenAPI files for changes
- **AI-Powered Updates** - Use Copilot to intelligently update affected tests
- **Zero Notification Spam** - Smart debouncing prevents duplicate alerts

### 🎨 Style Learning
- **Learn from Examples** - Right-click existing tests → "Learn Style Now"
- **Consistent Formatting** - Maintains your team's coding standards
- **Custom Templates** - Save and reuse your preferred test patterns

### 🎯 Modern UI
- **Activity Bar Panel** - Quick access to all features
- **Recent Generations** - Track your test generation history
- **Template Management** - Save and organize test templates

## 🚀 Quick Start

### 1. Install the Extension
Search for "Karate Test Generator" in VS Code Extensions marketplace.

### 2. Generate Your First Test

**Option A: Right-Click Menu**
```
1. Right-click any OpenAPI file (.json, .yaml, .yml)
2. Select "Karate: Generate Tests Now"
3. Click "Open File" to view generated tests
```

**Option B: Extension Panel**
```
1. Click the Karate icon in Activity Bar
2. Navigate to "OpenAPI" tab
3. Select your spec file
4. Click "Generate Tests"
```

### 3. Enable AI Enhancement (Optional)
```
1. Install GitHub Copilot extension
2. Generate tests as usual
3. Tests will be automatically enhanced with AI suggestions
```

## 📖 Usage Guide

### Generating Tests from OpenAPI

**Direct Generation** (Fastest):
```
Right-click spec.yaml → "Generate Tests Now"
```

**With Copilot Enhancement**:
```
1. Open Extension Panel
2. Select OpenAPI tab
3. Choose spec file
4. Enable "Use Copilot" toggle
5. Click "Generate Tests"
```

### Generating from Confluence Documentation

**Access Confluence Tab**:
```
1. Open Extension Panel
2. Navigate to "Confluence" tab
3. Enter Confluence page URL
4. Provide credentials (if required)
5. Click "Generate Tests"
```

**What gets extracted**:
- API endpoint descriptions
- Request/response examples
- Business logic documentation
- Edge cases mentioned in docs

### Combined Generation (OpenAPI + Confluence)

**Best of both worlds**:
```
1. Open Extension Panel
2. Navigate to "Combined" tab
3. Select OpenAPI spec file
4. Enter Confluence documentation URL
5. Click "Generate Tests"
```

**Benefits**:
- ✅ **Structure** from OpenAPI spec
- ✅ **Context** from Confluence docs
- ✅ **Business Logic** from documentation
- ✅ **Complete Coverage** from both sources

### Learning Style from Existing Tests

**To maintain consistency**:
```
1. Right-click your well-formatted .feature file
2. Select "Karate: Learn Style Now"
3. Future generations will match this style
```

### Automatic Test Maintenance

**When your API evolves**:
```
1. Modify your OpenAPI spec
2. Save the file
3. Notification appears: "spec.yaml has changed"
4. Click "Update with Copilot"
5. AI intelligently updates your tests
```

**What gets updated**:
- ✅ New endpoints → New test scenarios added
- ✅ Modified parameters → Tests updated automatically
- ✅ Removed endpoints → Marked as deprecated
- ✅ Breaking changes → AI detects and fixes

## 🎯 Key Features Explained

### AI-Powered Test Updates

When your OpenAPI spec changes, the extension:
1. **Detects changes** automatically (every 5 seconds)
2. **Analyzes impact** on existing tests
3. **Uses Copilot** to intelligently update tests
4. **Preserves custom logic** you've added
5. **Adds new test cases** for new parameters

**Example**:
```
Spec Change: Added optional parameter "includeOwner"
AI Action: Adds two test scenarios:
  - Test with includeOwner=true
  - Test with includeOwner=false
```

### Smart Notification System

- **No Spam**: Maximum one notification per 30 seconds
- **Processing Aware**: No notifications while Copilot is running
- **Auto-Dismiss**: Hash updated after fixes prevent re-notification

### Template System

**Save your patterns**:
```
1. Generate a test you like
2. Click "Save as Template"
3. Name it (e.g., "REST API Standard")
4. Reuse for future generations
```

## ⚙️ Configuration

Access settings via: `Preferences → Settings → Karate Test Generator`

**Available Options**:
- `karateGenerator.outputPath` - Where to save generated tests
- `karateGenerator.testTemplate` - Default template to use
- `karateGenerator.enableCopilot` - Enable/disable AI enhancement
- `karateGenerator.autoSync` - Enable automatic test maintenance

## 🔧 Requirements

- **VS Code**: Version 1.85.0 or higher
- **GitHub Copilot** (Optional): For AI-powered features
- **Node.js**: Version 14.x or higher (for extension development)

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

## 🤝 GitHub Copilot Integration

**What Copilot Enhances**:
- ✅ More realistic test data
- ✅ Additional edge case scenarios
- ✅ Better assertion coverage
- ✅ Improved error handling tests
- ✅ Documentation comments

**How to Enable**:
1. Install GitHub Copilot extension
2. Ensure Copilot is activated
3. Use "Update with Copilot" when prompted
4. Or toggle "Use Copilot" in generation panel

## 🐛 Troubleshooting

**Tests not generating?**
- Check that file is valid OpenAPI spec
- Ensure output directory is writable
- Check Output panel for errors

**Copilot not working?**
- Verify GitHub Copilot extension is installed
- Check Copilot is activated (bottom status bar)
- Ensure you have an active Copilot subscription

**Notifications not appearing?**
- Check that spec file is tracked (generate tests first)
- Verify file watcher is enabled
- Look for logs in Output → Karate Generator

## 📚 Documentation

- [Copilot Integration Guide](docs/COPILOT_GUIDE.md)
- [Development Setup](DEVELOPMENT.md)
- [Contributing Guidelines](CONTRIBUTING.md)

## 🎉 What's New in v1.2.0

### Major Features
- 🤖 **AI-Powered Test Maintenance** - Copilot intelligently updates tests when specs change
- 🚫 **Smart Notification System** - No more spam! Intelligent debouncing and processing awareness
- ⚡ **Direct Generation** - Right-click menu now works independently, no panel needed
- 🎨 **Style Learning** - Learn from existing tests to maintain consistency

### Bug Fixes
- ✅ Fixed "Generate Now" not creating files
- ✅ Fixed "Learn Style Now" not working
- ✅ Fixed notification spam during polling
- ✅ Fixed notifications appearing during Copilot processing

### Improvements
- 📊 Better error handling and logging
- 🎯 Simplified notification buttons (Update with Copilot + Ignore)
- 🔄 Automatic hash updates prevent re-notification
- ⏱️ 30-second cooldown prevents duplicate notifications

[See full changelog](CHANGELOG.md)

## 🔮 Coming Soon

### Version Comparison & Manual Test Updates

**Compare OpenAPI Spec Versions** - Professional workflow for controlled test maintenance:

```
Command Palette → "Karate: Compare OpenAPI Versions"
```

**How it works**:
1. **Select Versions**: Choose old and new OpenAPI specification files
2. **Intelligent Analysis**: System analyzes differences between versions
3. **Smart Matching**: Automatically identifies which test files need updates
4. **Targeted Updates**: Updates only affected scenarios, preserves customizations
5. **Change Summary**: Detailed report of what was modified

**Use Cases**:
- **API Version Migration**: Migrating from v1 to v2 of your API
- **Release Management**: Comparing staging vs production specs
- **Change Validation**: Review impact before updating tests
- **Team Collaboration**: Merge changes from multiple team members

**What gets updated**:
- ✅ **Added Endpoints** → New test scenarios created
- ✅ **Modified Parameters** → Existing tests updated intelligently
- ✅ **Removed Endpoints** → Marked as deprecated with timestamp
- ✅ **Breaking Changes** → Detected and highlighted for review

**Example Workflow**:
```
1. Save current spec as "api-v1.0.yaml"
2. Update spec to v2.0
3. Run: Compare OpenAPI Versions
4. Select: api-v1.0.yaml (old) and api-v2.0.yaml (new)
5. Review: Summary shows "3 added, 2 modified, 1 removed"
6. Confirm: Tests updated automatically
7. Result: Only changed scenarios updated, custom logic preserved
```

**Benefits**:
- 🎯 **Precision**: Updates only what changed
- 🔒 **Safety**: Preserves your custom test logic
- 📊 **Visibility**: Clear summary of all changes
- ⚡ **Speed**: Faster than manual updates
- 🤝 **Collaboration**: Perfect for team workflows

This feature is **already implemented** and will be highlighted in the next release!

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details

## 🙏 Acknowledgments

- Built with [Karate DSL](https://github.com/karatelabs/karate)
- Powered by [GitHub Copilot](https://github.com/features/copilot)
- OpenAPI parsing by [@apidevtools/swagger-parser](https://github.com/APIDevTools/swagger-parser)

## 💬 Feedback & Support

- 🐛 [Report Issues](https://github.com/your-repo/issues)
- 💡 [Request Features](https://github.com/your-repo/issues/new)
- ⭐ [Star on GitHub](https://github.com/your-repo)

---

**Made with ❤️ for the Karate testing community**
