# GitHub Copilot Integration Guide

## Overview

The Karate DSL Generator extension now includes optional GitHub Copilot integration to automatically enhance generated tests with AI-powered improvements.

## How It Works

When enabled, Copilot will:
1. Review the generated Karate test
2. Add comprehensive assertions and validations
3. Include edge cases and error scenarios
4. Improve test data with realistic examples
5. Add security and performance considerations
6. Suggest additional test scenarios

## Prerequisites

- Active GitHub Copilot subscription
- VS Code with GitHub Copilot extension installed

## Configuration

Enable Copilot enhancement in VS Code settings:

```json
{
  "karateDsl.useCopilot": true
}
```

Or via VS Code UI:
1. Open Settings (Cmd+, / Ctrl+,)
2. Search for "Karate DSL"
3. Check "Use Copilot"

## Usage

Once enabled, Copilot enhancement is automatic:

1. Run any generation command:
   - `Karate: Generate Tests from OpenAPI`
   - `Karate: Generate Tests from Confluence`
   - `Karate: Generate Combined Tests`

2. The extension will:
   - Generate initial tests
   - Send to Copilot for enhancement
   - Save the improved version

3. Progress notifications will show:
   - "Generating Karate tests..."
   - "Enhancing with GitHub Copilot..." (if enabled)
   - "Done!"

## Example Enhancement

### Before Copilot:
```gherkin
Scenario: Get pet by ID
  Given url baseUrl + '/pets/{petId}'
  And path 'petId' = 123
  When method get
  Then status 200
```

### After Copilot Enhancement:
```gherkin
Scenario: Get pet by ID - Success Case
  Given url baseUrl + '/pets/{petId}'
  And path 'petId' = 123
  When method get
  Then status 200
  And match response == { id: '#number', name: '#string', status: '#string' }
  And match response.id == 123
  And assert response.name.length > 0

Scenario: Get pet by ID - Not Found
  Given url baseUrl + '/pets/{petId}'
  And path 'petId' = 99999
  When method get
  Then status 404
  And match response.message contains 'not found'

Scenario: Get pet by ID - Invalid ID
  Given url baseUrl + '/pets/{petId}'
  And path 'petId' = 'invalid'
  When method get
  Then status 400
```

## Fallback Behavior

If Copilot is unavailable or enhancement fails:
- Original tests are used
- Warning message is shown
- No error occurs

## Privacy & Data

- Test content is sent to GitHub Copilot API
- Subject to GitHub Copilot privacy policy
- No data is stored by this extension

## Troubleshooting

### "GitHub Copilot is not available"
- Verify Copilot subscription is active
- Check GitHub Copilot extension is installed
- Restart VS Code

### Enhancement takes too long
- Copilot API may be slow
- Consider disabling for large test suites
- Use selectively for important tests

### Enhancement quality issues
- Copilot suggestions may vary
- Review generated tests before use
- Provide feedback to improve prompts

## Disabling Copilot

Set in VS Code settings:
```json
{
  "karateDsl.useCopilot": false
}
```

Tests will be generated without AI enhancement.
