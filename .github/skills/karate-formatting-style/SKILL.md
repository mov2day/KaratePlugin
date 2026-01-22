---
name: karate-formatting-style
description: Comprehensive guide for Karate DSL formatting, indentation, spacing, and code style conventions. Use when ensuring tests follow proper formatting standards.
---

# Karate Formatting and Style Guide

Official formatting standards for Karate DSL based on [docs.karatelabs.io](https://docs.karatelabs.io).

## When to use this skill

Use this skill when you need to:
- Format Karate feature files correctly
- Ensure consistent indentation and spacing
- Apply proper naming conventions
- Validate code style compliance

## Indentation Rules

### Feature Level - No Indentation
```gherkin
Feature: User API Tests
```

### Background - 2 Spaces
```gherkin
Feature: User API Tests

  Background:
    * url 'https://api.example.com'
    * header Accept = 'application/json'
```

### Scenario - 2 Spaces
```gherkin
Feature: User API Tests

  Scenario: Get user by ID
    Given path 'users', 1
    When method get
    Then status 200
```

### Steps - 4 Spaces (under Scenario/Background)
```gherkin
  Scenario: Create new user
    Given path 'users'
    And request { name: 'John', email: 'john@test.com' }
    When method post
    Then status 201
    And match response.id == '#number'
```

## Complete Indentation Example

```gherkin
Feature: User Management API

  Background:
    * url baseUrl
    * def adminToken = 'Bearer xyz123'
    * header Authorization = adminToken

  Scenario: Get all users returns array
    Given path 'users'
    When method get
    Then status 200
    And match response == '#[]'
    And match response[0].id == '#number'

  Scenario Outline: Create user with different data
    Given path 'users'
    And request { name: '<name>', age: <age> }
    When method post
    Then status <status>

    Examples:
      | name  | age | status |
      | John  | 25  | 201    |
      | Alice | 30  | 201    |
```

## Spacing Conventions

### Around Operators
```gherkin
# ✅ CORRECT - spaces around =
* def userId = 123
And match response.id == userId
And header Authorization = 'Bearer token'

# ❌ WRONG - no spaces
* def userId=123
And match response.id==userId
```

### In JSON Objects
```gherkin
# ✅ CORRECT - space after colon, space after comma
And request { name: 'John', email: 'john@test.com', age: 30 }

# ✅ ALSO CORRECT - multi-line with proper indentation
And request
  """
  {
    "name": "John",
    "email": "john@test.com",
    "age": 30
  }
  """

# ❌ WRONG - no spaces
And request {name:'John',email:'john@test.com'}
```

### Between Scenarios
```gherkin
Feature: User API

  Background:
    * url baseUrl
    
  Scenario: First test
    Given path 'users', 1
    When method get
    Then status 200
  
  # ✅ CORRECT - blank line between scenarios
  Scenario: Second test
    Given path 'users'
    When method get
    Then status 200
```

## Variable Naming Conventions

### Use camelCase for Variables
```gherkin
# ✅ CORRECT
* def userId = 123
* def authToken = 'Bearer xyz'
* def baseUrl = 'https://api.example.com'
* def newUser = { name: 'John' }

# ❌ WRONG - snake_case or hyphens
* def user_id = 123
* def auth-token = 'Bearer xyz'
```

### Meaningful Names
```gherkin
# ✅ CORRECT - descriptive
* def expectedUserId = 5
* def createdTimestamp = '2024-01-20T10:00:00Z'
* def validEmailPattern = '^.+@.+$'

# ❌ WRONG - cryptic
* def x = 5
* def temp = '2024-01-20T10:00:00Z'
* def p = '^.+@.+$'
```

## String Formatting

### Single Quotes for Simple Strings
```gherkin
# ✅ CORRECT
* url 'https://api.example.com'
* def name = 'John Doe'
And header Authorization = 'Bearer token123'

# ❌ AVOID - double quotes (not wrong, but single is convention)
* url "https://api.example.com"
```

### Triple Quotes for Multi-line Strings
```gherkin
# ✅ CORRECT - multi-line JSON
And request
  """
  {
    "name": "John Doe",
    "email": "john@example.com",
    "address": {
      "street": "123 Main St",
      "city": "Boston"
    }
  }
  """

# ✅ CORRECT - multi-line XML
And request
  """
  <user>
    <name>John Doe</name>
    <email>john@example.com</email>
  </user>
  """
```

## Comment Formatting

### Inline Comments
```gherkin
Scenario: Get user by ID
  # Arrange - set up user ID
  * def userId = 1
  
  # Act - make API call
  Given path 'users', userId
  When method get
  
  # Assert - verify response
  Then status 200
  And match response.id == userId
```

### Section Comments
```gherkin
Feature: User Management

  Background:
    # === Setup ===
    * url baseUrl
    * header Accept = 'application/json'

  # === Positive Test Cases ===
  
  Scenario: Create user with valid data
    Given path 'users'
    And request { name: 'John' }
    When method post
    Then status 201

  # === Negative Test Cases ===
  
  Scenario: Create user with invalid email
    Given path 'users'
    And request { name: 'John', email: 'invalid' }
    When method post
    Then status 400
```

## Path Construction Formatting

### Multiple Path Segments
```gherkin
# ✅ CORRECT - comma-separated with spaces
Given path 'users', userId, 'posts', postId

# ✅ ALSO CORRECT - one per line for readability
Given path 'users', userId
And path 'posts', postId

# ❌ WRONG - no spaces after commas
Given path 'users',userId,'posts',postId
```

### Query Parameters
```gherkin
# ✅ CORRECT - one param per line for readability
Given path 'users'
And param status = 'active'
And param limit = 10
And param offset = 0

# ✅ ALSO CORRECT - grouped related params
Given path 'search'
And param q = 'karate'
And param type = 'users'
And param limit = 20, offset = 0
```

## Match Statement Formatting

### Simple Matches
```gherkin
# ✅ CORRECT - space around ==
And match response.id == 123
And match response.name == 'John'
And match response.active == true
```

### Schema Matches
```gherkin
# ✅ CORRECT - single line for simple objects
And match response == { id: '#number', name: '#string' }

# ✅ CORRECT - multi-line for complex objects
And match response ==
  """
  {
    id: '#number',
    name: '#string',
    email: '#regex ^.+@.+$',
    address: {
      street: '#string',
      city: '#string',
      zipCode: '#string'
    },
    roles: '#[]'
  }
  """
```

### Array Matching
```gherkin
# ✅ CORRECT - clear array validations
And match response.users == '#[]'           # is array
And match response.users == '#[5]'           # exactly 5 items
And match response.users == '#[_ 10]'        # at most 10 items
And match response.users[0].id == '#number'  # first item schema

# ✅ CORRECT - validate each array item
And match each response.users == { id: '#number', name: '#string' }
```

## Background vs Scenario Organization

### Background - Common Setup Only
```gherkin
# ✅ CORRECT - truly common setup
Background:
  * url baseUrl
  * header Accept = 'application/json'
  * header Content-Type = 'application/json'

# ❌ WRONG - test-specific data in Background
Background:
  * url baseUrl
  * def user = { name: 'John' }  # ❌ Only some tests need this
```

### Scenario - Test-Specific Setup
```gherkin
Scenario: Create user and retrieve it
  # Setup specific to this test
  * def newUser = { name: 'John', email: 'john@test.com' }
  
  # Create user
  Given path 'users'
  And request newUser
  When method post
  Then status 201
  * def userId = response.id
  
  # Retrieve created user
  Given path 'users', userId
  When method get
  Then status 200
  And match response.name == newUser.name
```

## Tag Formatting

### Tag Placement
```gherkin
# ✅ CORRECT - tags on separate line above Feature
@smoke @regression
Feature: User Management
```

### Multiple Tags
```gherkin
# ✅ CORRECT - space-separated on one line
@smoke @api @userManagement
Feature: User API

# ✅ CORRECT - scenario-specific tags
@smoke
Feature: User API

  @positive @createUser
  Scenario: Create user with valid data
    # ...
  
  @negative @createUser
  Scenario: Create user with invalid email
    # ...
```

## Variable Interpolation

### Embedded Expressions
```gherkin
# ✅ CORRECT - use #() for string concatenation
* def fullUrl = baseUrl + '/users/' + userId
* def message = 'User ID is: ' + userId

# ✅ CORRECT - embedded in JSON
And request { name: 'John', userId: #(userId) }

# ✅ CORRECT - in paths
Given path 'users/#(userId)/posts'
```

### Direct Variable Use vs Interpolation
```gherkin
# ✅ CORRECT - direct use in path
Given path 'users', userId

# ✅ CORRECT - interpolation in strings
And header X-User-ID = '#(userId)'

# ✅ CORRECT - in match statements
And match response.id == userId
```

## File Organization

### Naming Convention
```
# ✅ CORRECT - descriptive, kebab-case
users-api.feature
create-user-validation.feature
payment-processing-flow.feature

# ❌ WRONG - not descriptive
test1.feature
users.feature
api.feature
```

### One Feature Per File
```gherkin
# ✅ CORRECT - focused on one feature
Feature: User Authentication
  # All scenarios related to authentication

# ❌ WRONG - mixing unrelated features
Feature: API Tests
  # Some user tests, some payment tests, some inventory tests
```

## Complete Formatted Example

```gherkin
@userManagement @smoke
Feature: User Management API
  Test suite for user CRUD operations

  Background:
    * url 'https://api.example.com'
    * def adminToken = 'Bearer ' + karate.env.ADMIN_TOKEN
    * header Authorization = adminToken
    * header Accept = 'application/json'
    * header Content-Type = 'application/json'

  @positive @createUser
  Scenario: Create new user returns 201 and user object
    * def newUser = { name: 'John Doe', email: 'john@test.com', age: 30 }
    
    Given path 'users'
    And request newUser
    When method post
    Then status 201
    And match response.id == '#number'
    And match response.name == newUser.name
    And match response.email == newUser.email
    And match response.createdAt == '#string'

  @positive @getUser
  Scenario: Get user by ID returns correct user
    * def userId = 1
    
    Given path 'users', userId
    When method get
    Then status 200
    And match response ==
      """
      {
        id: '#(userId)',
        name: '#string',
        email: '#regex ^.+@.+$',
        age: '#number',
        active: '#boolean',
        createdAt: '#string',
        updatedAt: '#string?'
      }
      """

  @negative @getUser
  Scenario: Get non-existent user returns 404
    * def nonExistentId = 99999
    
    Given path 'users', nonExistentId
    When method get
    Then status 404
    And match response.error == 'User not found'

  @datadriven @createUser
  Scenario Outline: Create user with various inputs
    Given path 'users'
    And request { name: '<name>', email: '<email>', age: <age> }
    When method post
    Then status <expectedStatus>

    Examples:
      | name     | email              | age | expectedStatus |
      | John Doe | john@example.com   | 30  | 201            |
      | Jane Doe | jane@example.com   | 25  | 201            |
      | Invalid  | not-an-email       | 30  | 400            |
      | NoAge    | test@example.com   | -1  | 400            |
```

## Common Formatting Mistakes

### ❌ WRONG
```gherkin
Feature:User API Tests  # No space after colon

Background:
  *url baseUrl  # No space after *
  *def userId=123  # No spaces around =

Scenario:Get User  # No space after colon
Given path 'users',userId  # No space after comma
When method get
Then status 200
And match response.id==userId  # No spaces around ==
```

### ✅ CORRECT
```gherkin
Feature: User API Tests

  Background:
    * url baseUrl
    * def userId = 123

  Scenario: Get user by ID
    Given path 'users', userId
    When method get
    Then status 200
    And match response.id == userId
```

## Summary

**Key Formatting Rules:**
1. Feature: no indent
2. Background/Scenario: 2 spaces
3. Steps: 4 spaces
4. Always space around `=` and `==`
5. Space after comma in lists
6. Use single quotes for strings
7. camelCase for variables
8. Blank lines between scenarios
9. Descriptive names for scenarios and variables
10. One feature per file

Following these conventions ensures readable, maintainable Karate tests that integrate seamlessly with CI/CD pipelines and team workflows.

## References

- Official Style Guide: https://docs.karatelabs.io
- Best Practices: https://docs.karatelabs.io/karate/karate-core
