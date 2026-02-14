---
name: karate-reusability
description: Guide for extracting and organizing reusable Karate feature components
---

# Karate Reusability Guide

## call vs callonce Decision Matrix

| Use Case | Keyword | Reason |
|----------|---------|--------|
| Auth token | `callonce` | Token valid for entire feature; avoid re-authentication |
| Base config/setup | `callonce` | Config doesn't change between scenarios |
| Shared headers | `callonce` | Headers static per feature run |
| Test data creation | `callonce` | Create once, use across scenarios |
| Per-scenario setup | `call` | Each scenario needs fresh data |
| Cleanup/teardown | `call` | Must run after every scenario |
| Parameterized helper | `call` | Different params per invocation |

## Reusable Feature Extraction

### When to extract

Extract a step sequence into a separate feature when:
- **Same 3+ steps** appear in **2+ scenarios**
- Steps involve **auth, setup, or teardown** logic
- Steps are **infrastructure** (not business logic)

### Common Reusable Features

#### `common/auth.feature` — Authentication
```gherkin
Feature: Authentication Helper
  Scenario: Get bearer token
    Given url authUrl
    And path '/auth/token'
    And request { username: '#(username)', password: '#(password)' }
    When method post
    Then status 200
    * def token = response.access_token
```

**Usage:**
```gherkin
Background:
  * def auth = callonce read('common/auth.feature')
  * header Authorization = 'Bearer ' + auth.token
```

#### `common/setup.feature` — Environment Setup
```gherkin
Feature: Environment Setup
  Scenario: Configure base settings
    * def baseUrl = karate.properties['baseUrl'] || 'http://localhost:8080'
    * def env = karate.env || 'dev'
```

**Usage:**
```gherkin
Background:
  * def config = callonce read('common/setup.feature')
  * url config.baseUrl
```

#### `common/headers.feature` — Shared Headers
```gherkin
Feature: Common Headers
  Scenario: Set standard headers
    * def requestHeaders = { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Correlation-Id': '#(java.util.UUID.randomUUID() + "")' }
```

**Usage:**
```gherkin
Background:
  * def commonHeaders = callonce read('common/headers.feature')
  * headers commonHeaders.requestHeaders
```

#### `common/testdata.feature` — Shared Test Data
```gherkin
Feature: Test Data Helper

  Scenario: Create test user
    Given url baseUrl
    And path '/users'
    And request { name: 'Test User', email: '#("test_" + java.lang.System.currentTimeMillis() + "@test.com")' }
    When method post
    Then status 201
    * def userId = response.id
    * def userEmail = response.email
```

**Usage:**
```gherkin
Background:
  * def testUser = callonce read('common/testdata.feature')

Scenario: Create order for test user
  Given path '/orders'
  And request { userId: '#(testUser.userId)' }
  When method post
  Then status 201
```

#### `common/cleanup.feature` — Resource Cleanup
```gherkin
Feature: Cleanup Helper

  Scenario: Delete resource
    Given url baseUrl
    And path resourcePath, resourceId
    When method delete
    # Don't assert status — resource might already be cleaned up
```

**Usage (call, not callonce — runs per scenario):**
```gherkin
* call read('common/cleanup.feature') { resourcePath: '/orders', resourceId: '#(orderId)' }
```

## Background Optimization Rules

1. **Include in Background**: URL, auth, common headers, shared config
2. **Do NOT include in Background**: Request bodies, assertions, test-specific setup
3. **Keep Background minimal**: 3-5 lines maximum
4. **Use callonce for expensive operations**: Auth, data seeding

## karate-config.js Pattern

```javascript
function fn() {
  var env = karate.env || 'dev';
  var config = {
    baseUrl: 'http://localhost:8080',
    authUrl: 'http://localhost:8080/auth',
    username: 'testuser',
    password: 'testpass'
  };

  if (env === 'staging') {
    config.baseUrl = 'https://staging-api.example.com';
    config.authUrl = 'https://staging-api.example.com/auth';
  }

  if (env === 'prod') {
    config.baseUrl = 'https://api.example.com';
    config.authUrl = 'https://api.example.com/auth';
  }

  return config;
}
```

## File Organization

```
src/test/java/karate/
├── karate-config.js          (environment config)
├── common/
│   ├── auth.feature          (callonce — auth tokens)
│   ├── setup.feature         (callonce — base config)
│   ├── headers.feature       (callonce — shared headers)
│   ├── testdata.feature      (callonce — seed data)
│   └── cleanup.feature       (call — per-scenario teardown)
├── orders.feature            (domain: orders)
├── payments.feature          (domain: payments)
└── users.feature             (domain: users)
```
