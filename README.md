# Karate DSL Test Generator

A powerful VS Code extension that automatically generates Karate DSL test files from OpenAPI specifications and Confluence documentation.

## User Interface

The extension provides two ways to generate Karate tests:

### 1. Webview Panel UI (Recommended)

A modern, visual interface in the VS Code sidebar:

1. **Open the panel:**
   - Click the "Karate Test Generator" view in the Explorer sidebar
   - Or run command: `Karate: Open Test Generator`

2. **Use the tabbed interface:**
   - **OpenAPI Tab**: Select an OpenAPI spec file and generate tests
   - **Confluence Tab**: Enter a Confluence page URL/ID and generate tests
   - **Combined Tab**: Merge both sources into comprehensive tests
   - **Settings Tab**: Configure output paths, Copilot, and Confluence credentials

3. **Features:**
   - 📁 Visual file picker
   - ⚙️ Easy configuration management
   - 📊 Real-time progress tracking
   - 👁️ Preview generated tests
   - 🎨 Theme-aware design (light/dark mode)
   - ✅ Success/error notifications

### 2. Command Palette (Alternative)

Traditional command-based workflow:

- `Karate: Generate Tests from OpenAPI`
- `Karate: Generate Tests from Confluence`
- `Karate: Generate Combined Tests`

## Features


### 🚀 Generate from OpenAPI Specification
- Parse OpenAPI 2.0, 3.0, and 3.1 specifications
- Automatically generate test scenarios for all API endpoints
- Include request/response examples from schemas
- Support for path parameters, query parameters, headers, and request bodies

### 📄 Generate from Confluence Pages
- Fetch test requirements from Confluence pages
- Parse test case tables and flow diagrams
- Extract Mermaid flowcharts and ordered process steps
- Convert requirements into executable Karate tests

### 🔄 Combined Test Generation
- Merge OpenAPI endpoints with Confluence requirements
- Map test cases to corresponding API endpoints
- Generate comprehensive test suites with business context

### 🤖 AI-Powered Enhancement with GitHub Copilot (Optional)
- Automatically improve generated tests with Copilot suggestions
- Add comprehensive assertions and edge cases
- Include error scenarios and security tests
- Enhance test data and validations
- Requires GitHub Copilot subscription

## Installation

1. Open VS Code
2. Go to Extensions (Cmd+Shift+X / Ctrl+Shift+X)
3. Search for "Karate DSL Test Generator"
4. Click Install

Or install from VSIX:
```bash
code --install-extension karate-dsl-generator-0.1.0.vsix
```

## Configuration

### Required Settings

Open VS Code Settings (Cmd+, / Ctrl+,) and configure:

```json
{
  "karateDsl.outputPath": "src/test/karate",
  "karateDsl.confluence.baseUrl": "https://yourcompany.atlassian.net/wiki",
  "karateDsl.confluence.email": "your.email@company.com",
  "karateDsl.testTemplate": "standard",
  "karateDsl.useCopilot": false
}
```

### GitHub Copilot (Optional)

To enable AI-powered test enhancement:

1. Ensure you have an active GitHub Copilot subscription
2. Enable in VS Code settings:
   ```json
   {
     "karateDsl.useCopilot": true
   }
   ```
3. Generated tests will automatically be enhanced with:
   - Additional assertions and validations
   - Edge cases and error scenarios
   - Improved test data
   - Security considerations

### Confluence API Token

1. Generate an API token at: https://id.atlassian.com/manage-profile/security/api-tokens
2. The extension will prompt for your token on first use
3. Token is securely stored in VS Code's secret storage

## Usage

### Generate from OpenAPI

1. Open Command Palette (Cmd+Shift+P / Ctrl+Shift+P)
2. Run: `Karate: Generate Tests from OpenAPI`
3. Select your OpenAPI spec file (JSON or YAML)
4. Tests will be generated in the configured output path

**Example Output:**
```gherkin
Feature: petstore

  Background:
    Given def baseUrl = 'http://localhost:8080'

  Scenario: Get pet by ID
    Given url baseUrl + '/pets/{petId}'
    And path 'petId' = 123
    When method get
    Then status 200
    And match response contains { id: '#present', name: '#present' }
```

### Generate from Confluence

1. Open Command Palette
2. Run: `Karate: Generate Tests from Confluence`
3. Enter Confluence page URL or page ID
4. Tests will be generated from page content

**Supported Content:**
- Test case tables with columns: Test Case, Steps, Expected Result
- Mermaid flowcharts
- Ordered lists under "Flow" or "Process" headings
- Requirements sections

### Generate Combined Tests

1. Open Command Palette
2. Run: `Karate: Generate Combined Tests`
3. Select OpenAPI spec file
4. Enter Confluence page URL
5. Combined tests will be generated

## Configuration Options

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `karateDsl.outputPath` | string | `src/test/karate` | Output directory for generated feature files |
| `karateDsl.confluence.baseUrl` | string | - | Confluence base URL |
| `karateDsl.confluence.email` | string | - | Confluence user email |
| `karateDsl.testTemplate` | enum | `standard` | Template style: `standard`, `detailed`, or `minimal` |
| `karateDsl.useCopilot` | boolean | `false` | Enable GitHub Copilot enhancement (requires subscription) |

## Examples

### OpenAPI Spec Example

```yaml
openapi: 3.0.0
info:
  title: Pet Store API
  version: 1.0.0
paths:
  /pets:
    get:
      summary: List all pets
      responses:
        '200':
          description: Success
```

### Confluence Test Case Table

| Test Case | Steps | Expected Result |
|-----------|-------|-----------------|
| Create Pet | 1. Send POST to /pets<br>2. Verify response | Pet created with ID |
| Get Pet | 1. Send GET to /pets/{id} | Pet details returned |

## Troubleshooting

### "Confluence base URL is not configured"
- Set `karateDsl.confluence.baseUrl` in VS Code settings

### "Failed to fetch Confluence page"
- Verify your API token is valid
- Check that you have access to the page
- Ensure the page ID is correct

### "No endpoints found in OpenAPI specification"
- Verify your OpenAPI spec is valid
- Check that the spec contains a `paths` section

## Requirements

- VS Code 1.85.0 or higher
- Node.js (for extension development)

## Development

### Building from Source

```bash
# Clone repository
git clone https://github.com/yourusername/karate-dsl-generator.git
cd karate-dsl-generator

# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Run extension in development mode
# Press F5 in VS Code
```

### Running Tests

```bash
npm test
```

### Packaging

```bash
npm run package
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see LICENSE file for details

## Support

- Report issues: GitHub Issues
- Documentation: See included documentation files
- **Copilot Integration**: See COPILOT_GUIDE.md in the docs folder
- **Privacy & Data Sharing**: See PRIVACY.md in the docs folder

## Roadmap

- [ ] Support for GraphQL schemas
- [ ] Custom template editor
- [ ] Test execution integration
- [ ] More Confluence diagram formats
- [ ] Jira integration for test cases
