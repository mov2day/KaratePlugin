# Karate API Test Generator for VS Code

AI-powered **Karate API testing** extension that generates and maintains
**Karate DSL tests from OpenAPI specifications and Confluence documentation**.

Generate comprehensive API tests from OpenAPI specifications, Confluence documentation, or both combined. Automatically maintain tests when your API evolves with intelligent AI assistance.

**Keywords**: Karate API testing, OpenAPI test generation, API automation,
Karate DSL tests, REST API testing, BDD API tests, QA automation, contract testing, Postman to Karate, Postman to Karate converter, Postman migration to Karate,postman

[![Version](https://img.shields.io/badge/version-1.2.6-blue.svg)](https://marketplace.visualstudio.com/items?itemName=your-publisher.karate-test-generator)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.85.0+-brightgreen.svg)](https://code.visualstudio.com/)


### Why Karate API Test Generator?
Unlike generic API test generators, this extension is **built specifically for Karate DSL**
and supports **automatic test maintenance when OpenAPI specs evolve**.
Works with: Karate DSL, OpenAPI 3.x, Swagger, REST APIs

---

## 🆕 What's New in v1.2.6

### 🤖 Intelligent Copilot Model Management
- **Automatic Model Discovery**: Extension dynamically detects available Copilot models from your subscription
- **Smart Fallback**: Automatically uses best available model if preferred model unavailable
- **Quota Handling**: Graceful degradation when quota exhausted - returns tests without AI enhancement instead of failing

### 📄 Enhanced Confluence Integration
- **Plain Text Content**: Now fetches clean plain text from Confluence API (no HTML cleanup needed)
- **Better Error Messages**: Clear guidance for authentication, connectivity, and configuration issues
- **Fixed Settings**: Confluence base URL and email now persist correctly after reload

### 🔄 Improved Postman Conversion
The extension now properly converts complex Postman scripts that were previously ignored:

**Test Scripts - New Conversions:**
- ✅ **Response Value Extraction**: `pm.environment.set("token", pm.response.json().access_token)` → `* def token = response.access_token`
- ✅ **Array Validations**: `pm.expect(jsonData.items).to.have.lengthOf(5)` → `And match response.items == '#[5]'`
- ✅ **Property Checks**: Existence checks, type validations, nested JSON paths

**Pre-Request Scripts - New Conversions:**
- ✅ **Timestamps**: `Date.now()` → `* def timestamp = new java.util.Date().getTime()`
- ✅ **Random Data**: Handles `$randomInt`, `$guid`, `Math.random()`, UUIDs
- ✅ **Variable Assignments**: All `var`/`let`/`const` declarations now convert properly

---

## ⚡️ The Karate Generator Advantage

Stop wasting hours manually writing Boilerplate Gherkin. Let AI handle the structure so you can focus on the business logic.

| Feature | Manual Typing | Karate Generator + Copilot |
| :--- | :---: | :---: |
| **New Test Creation** | 15-30 mins | **< 30 seconds** |
| **OpenAPI Sync** | Manual tracking | **Auto-detect & Update** |
| **Postman Migration** | Rewrite everything | **One-click Import** |
| **Test Quality** | Peer review needed | **Copilot Optimized** |
| **Coverage Visibility** | Spreadsheet hell | **Visual Dashboard** |

---

## 🛠 Functionality Details

### 📦 Postman Collection Import (v1.2.3)
- **Zero-Effort Migration**: Convert entire Postman collections to Karate DSL in seconds.
- **Environment Smart**: Automatically handles variables and environments.
- **AI-Enhanced**: Uses Copilot to intelligently convert Postman scripts into robust Karate assertions.

### 🤖 AI-Powered Maintenance (v1.2.1)
- **Automatic Sync**: Detects changes in your OpenAPI specs.
- **Smart Updates**: Copilot suggests updates to existing tests, preserving your custom logic.
- **Change Analysis**: See exactly what changed before applying AI fixes.

---

## 🤖 AI-Powered Excellence with GitHub Copilot

This extension is designed to work hand-in-hand with GitHub Copilot to provide:

*   **Smart Assertions**: AI automatically generates complex JSONPath/Match statements based on schema logic.
*   **Edge Case Detection**: Automatically suggests scenarios for 400, 401, 404, and 500 status codes.
*   **Realistic Data**: Instead of `foo/bar`, Copilot generates realistic names, emails, and UUIDs.
*   **Test Maintenance**: When your spec changes, AI intelligently decides whether to update, delete, or add scenarios.

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

### 🛡️ Copilot Transparency & Privacy

We believe in full transparency when AI is involved. The extension includes a dedicated **Copilot Activity Log** so you always know what's happening.

**Features:**
- 📊 **Activity Log**: View every prompt sent to Copilot and the response received (`Cmd+Shift+P` -> "Karate: Show Copilot Activity Log")
- 🔒 **Privacy First**: Sensitive data (API keys, tokens, passwords) is automatically redacted from logs
- ⏱️ **Performance Metrics**: See how long each AI request takes
- 🔍 **Full Visibility**: Verify exactly what context is being shared with the AI

**Configuration:**
- `karate.copilot.logging.enabled`: Toggle logging on/off
- `karate.copilot.logging.redactSensitiveData`: Enable/disable automatic redaction
- `karate.copilot.logging.showTokenUsage`: Display token consumption stats

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
