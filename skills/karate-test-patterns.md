---
name: karate-test-patterns
description: Proven test patterns and best practices for enterprise Karate tests
---

# Karate Test Patterns

## 1. Auth Token Reuse (callonce)

```gherkin
# common/auth.feature
Feature: Authentication
  Scenario: Get auth token
    Given url authUrl
    And request { username: '#(username)', password: '#(password)' }
    When method post
    Then status 200
    * def token = response.access_token

# In test features — use callonce in Background
Background:
  * def auth = callonce read('common/auth.feature')
  * header Authorization = 'Bearer ' + auth.token
```

**Rule**: Auth should run ONCE per feature via `callonce`, never repeated per scenario.

## 2. Base URL and Config in Background

```gherkin
Background:
  * url baseUrl
  * def auth = callonce read('common/auth.feature')
  * header Authorization = 'Bearer ' + auth.token
  * header Content-Type = 'application/json'
```

**Rule**: Common setup (URL, auth, headers) belongs in Background. Never repeat across scenarios.

## 3. CRUD Lifecycle Pattern

```gherkin
@crud
Scenario: Complete CRUD lifecycle for orders
  # CREATE
  Given path '/orders'
  And request { product: 'Widget', quantity: 5 }
  When method post
  Then status 201
  * def orderId = response.id

  # READ
  Given path '/orders', orderId
  When method get
  Then status 200
  And match response.product == 'Widget'

  # UPDATE
  Given path '/orders', orderId
  And request { quantity: 10 }
  When method put
  Then status 200
  And match response.quantity == 10

  # DELETE
  Given path '/orders', orderId
  When method delete
  Then status 204

  # VERIFY DELETED
  Given path '/orders', orderId
  When method get
  Then status 404
```

## 4. Data-Driven Testing

```gherkin
Scenario Outline: Create order with <description>
  Given path '/orders'
  And request { product: '<product>', quantity: <quantity> }
  When method post
  Then status <status>

  Examples:
    | description        | product  | quantity | status |
    | valid order        | Widget   | 5        | 201    |
    | zero quantity      | Widget   | 0        | 400    |
    | negative quantity  | Widget   | -1       | 400    |
    | empty product      |          | 5        | 400    |
```

## 5. Shared Data Setup

```gherkin
# common/testdata.feature
Feature: Test data setup
  Scenario: Create test user
    Given url baseUrl
    And path '/users'
    And request { name: 'Test User', role: 'tester' }
    When method post
    Then status 201
    * def userId = response.id

# In test features
* def testUser = callonce read('common/testdata.feature')
Given path '/orders'
And request { userId: '#(testUser.userId)' }
```

## 6. Response Validation Pattern

```gherkin
# Full schema validation
And match response ==
  """
  {
    id: '#number',
    name: '#string',
    email: '#string',
    createdAt: '#string',
    status: '#? _ == "active" || _ == "inactive"',
    address: {
      street: '##string',
      city: '#string',
      country: '#string'
    },
    tags: '#[] #string'
  }
  """

# Array validation
And match response.items == '#[_ > 0]'
And match each response.items contains { id: '#number' }
```

## 7. Error Response Validation

```gherkin
@negative
Scenario: Invalid request returns proper error
  Given path '/orders'
  And request { product: '' }
  When method post
  Then status 400
  And match response contains { error: '#string', message: '#string' }
  And match response.error == 'VALIDATION_ERROR'
```

## 8. Pagination Pattern

```gherkin
Scenario: Verify pagination
  Given path '/orders'
  And param page = 1
  And param size = 10
  When method get
  Then status 200
  And match response.items == '#[_ <= 10]'
  And match response contains { page: 1, totalPages: '#number' }
```

## 9. Retry for Async Operations

```gherkin
Scenario: Wait for async processing
  # Trigger async operation
  Given path '/jobs'
  And request { type: 'export' }
  When method post
  Then status 202
  * def jobId = response.jobId

  # Poll until complete
  Given path '/jobs', jobId
  And retry until response.status == 'COMPLETED'
  When method get
  Then status 200
```

## 10. Cleanup Pattern

```gherkin
# Use call (not callonce) for cleanup — runs per scenario
Scenario: Test with cleanup
  # Setup
  Given path '/orders'
  And request { product: 'Temp' }
  When method post
  Then status 201
  * def tempId = response.id

  # Test logic here...

  # Cleanup
  Given path '/orders', tempId
  When method delete
  Then status 204
```
