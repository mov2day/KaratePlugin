---
name: karate-test-generation
description: Core guide for generating Karate DSL test files. Use when creating new test scenarios, understanding Karate syntax, or converting specifications to tests.
---

# Karate Test Generation

This skill teaches you how to generate high-quality Karate DSL test files based on official documentation from [https://docs.karatelabs.io](https://docs.karatelabs.io/getting-started/why-karate).

## When to use this skill

Use this skill when you need to:
- Create new Karate test feature files
- Understand Karate DSL syntax and structure
- Convert API specifications to Karate tests
- Review and validate existing Karate tests

## Core Karate Concepts

### Feature File Structure

Karate tests use Gherkin syntax but **require NO step definitions** (unlike Cucumber).

```gherkin
Feature: User API Tests
  
  Background:
    * url 'https://api.example.com'
    * header Accept = 'application/json'
  
  Scenario: Get user by ID
    Given path 'users', 1
    When method get
    Then status 200
    And match response == { id: '#number', name: '#string', email: '#string' }
```

**Key principles:**
- `Feature:` - Describes what is being tested
- `Background:` - Common setup for all scenarios (runs before each)
- `Scenario:` - Individual test case

### Variables and Interpolation

**Defining variables:**
```gherkin
* def baseUrl = 'https://api.example.com'
* def userId = 123
* def user = { name: 'John', age: 30, active: true }
```

**Variable interpolation:**
```gherkin
* def userId = 5
Given path 'users', userId         # Direct use
Given path 'users/#(userId)'       # Explicit interpolation  
And match response.id == userId    # In expressions
```

### HTTP Methods

```gherkin
When method get
When method post
When method put
When method delete
When method patch
```

### Path and Request Construction

```gherkin
# Simple path
Given path 'users'

# Path with parameters
Given path 'users', userId

# Query parameters
And param status = 'active'
And param limit = 10

# Request body (JSON - no quotes needed around keys!)
And request { name: 'John', email: 'john@example.com' }

# Request body from variable
* def newUser = { name: 'Jane', email: 'jane@example.com' }
And request newUser
```

### Response Validation

**Status code:**
```gherkin
Then status 200
Then status 201
Then status 404
```

**Schema matching with type markers:**
```gherkin
And match response == { id: '#number', name: '#string', email: '#string' }
And match response.user.active == '#boolean'
And match response.items == '#array'
And match response.metadata == '#object'
```

**Common type markers:**
- `#string` - must be a string
- `#number` - must be a number
- `#boolean` - must be boolean
- `#array` - must be an array
- `#object` - must be an object
- `#null` - must be null
- `#present` - must be present (not undefined)
- `#ignore` - ignore this field
- `#regex` - match regex pattern
- `#uuid` - must be valid UUID

**Pattern matching:**
```gherkin
And match response.email == '#regex ^.+@.+$'
And match response.id == '#uuid'
And match response.createdAt == '#string'
```

**Array validation:**
```gherkin
And match response.items == '#[]'               # is array
And match response.items == '#[3]'              # array with exactly 3 items
And match response.items[0].id == '#number'    # first item schema
```

### Headers and Cookies

```gherkin
And header Authorization = 'Bearer token123'
And header Content-Type = 'application/json'
And cookie sessionId = 'abc123'
```

## Best Practices

### 1. Organize with Tags

```gherkin
@smoke @regression
Feature: User Management

  @createUser @positive
  Scenario: Create new user with valid data
    # test steps...
  
  @createUser @negative
  Scenario: Create user with invalid email
    # test steps...
```

### 2. Use Descriptive Scenario Names

✅ **Good:**
```gherkin
Scenario: Create user returns 201 and user object with ID
```

❌ **Bad:**
```gherkin
Scenario: Test 1
```

### 3. Extract Reusable Values to Background

```gherkin
Background:
  * url baseUrl
  * def authToken = 'Bearer xyz123'
  * header Authorization = authToken
  * header Content-Type = 'application/json'
```

### 4. Data-Driven Testing with Scenario Outline

```gherkin
Scenario Outline: Validate user creation with different inputs
  Given path 'users'
  And request { name: '\u003cname\u003e', age: \u003cage\u003e }
  When method post
  Then status \u003cexpectedStatus\u003e
  
  Examples:
    | name  | age | expectedStatus |
    | John  | 25  | 201            |
    | Alice | 30  | 201            |
    | Bob   | -1  | 400            |
```

### 5. Keep Tests Readable

Karate tests should read like documentation. Non-programmers should understand what the test does.

## JSON and XML Native Support

**JSON - no escaping needed:**
```gherkin
* def user = { name: 'John', age: 30, emails: ['work@example.com', 'personal@example.com'] }
* match user.emails[0] == 'work@example.com'
```

**XML - direct manipulation:**
```gherkin
* def xml = \u003cuser\u003e\u003cname\u003eJohn\u003c/name\u003e\u003cage\u003e30\u003c/age\u003e\u003c/user\u003e
* match xml/user/name == 'John'
* match xml/user/age == '30'
```

## Complete Example

```gherkin
@userApi @smoke
Feature: User Management API

  Background:
    * url 'https://jsonplaceholder.typicode.com'
    * header Accept = 'application/json'
  
  Scenario: Get all users returns 200 and array of users
    Given path 'users'
    When method get
    Then status 200
    And match response == '#[]'
    And match response[0] == { id: '#number', name: '#string', email: '#string' }
  
  Scenario: Get user by ID returns correct user
    Given path 'users', 1
    When method get
    Then status 200
    And match response.id == 1
    And match response.name == '#string'
    And match response.email == '#regex ^.+@.+$'
  
  Scenario: Create new user returns 201 with ID
    Given path 'users'
    And request { name: 'Test User', email: 'test@example.com' }
    When method post
    Then status 201
    And match response.id == '#number'
    And match response.name == 'Test User'
  
  @negative
  Scenario: Get non-existent user returns 404
    Given path 'users', 99999
    When method get
    Then status 404
```

## References

- Official Documentation: https://docs.karatelabs.io/getting-started/why-karate
- No step definitions needed (unlike Cucumber)
- Tests read like documentation
- Native JSON/XML support without escaping
