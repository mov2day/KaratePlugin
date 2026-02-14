---
name: karate-dsl-reference
description: Core Karate DSL syntax reference for accurate test generation
---

# Karate DSL Reference

## Feature File Structure

```gherkin
Feature: [descriptive name]

  Background:
    * url baseUrl
    * def authToken = callonce read('common/auth.feature')
    * header Authorization = 'Bearer ' + authToken.token

  @positive @smoke
  Scenario: [descriptive intent-based name]
    Given path '/endpoint'
    When method get
    Then status 200
    And match response == { id: '#number', name: '#string' }
```

## HTTP Methods

```gherkin
When method get
When method post
When method put
When method delete
When method patch
```

## Request Construction

```gherkin
# Path
Given path '/users', userId

# Query params
And param status = 'active'
And params { page: 1, size: 10 }

# Headers
And header Content-Type = 'application/json'
And headers { Accept: 'application/json', X-Request-Id: '#(requestId)' }

# Request body
And request { name: 'test', email: 'test@example.com' }
And request read('data/payload.json')
```

## Type Markers (for match assertions)

| Marker | Meaning |
|--------|---------|
| `#string` | Any string |
| `#number` | Any number |
| `#boolean` | Any boolean |
| `#null` | Null value |
| `#present` | Field exists (any value) |
| `#notpresent` | Field does not exist |
| `#array` | Any JSON array |
| `#object` | Any JSON object |
| `#uuid` | Valid UUID format |
| `#regex [pattern]` | Matches regex |
| `#? [expression]` | Custom validator |
| `##string` | Optional string (can be null) |
| `##number` | Optional number (can be null) |

## Match Assertions

```gherkin
# Exact match
And match response == { id: '#number', name: '#string' }

# Contains (subset match)
And match response contains { name: 'expected' }

# Contains only (exact set, any order)
And match response contains only [1, 2, 3]

# Each (array element validation)
And match each response.items == { id: '#number', name: '#string' }

# Not equals
And match response.status != 'deleted'

# Array size
And match response.items == '#[3]'          # exactly 3 items
And match response.items == '#[_ > 0]'      # at least 1 item

# Deep match
And match response contains deep { address: { city: '#string' } }

# Response headers
And match responseHeaders['Content-Type'][0] contains 'application/json'
```

## Variables and Expressions

```gherkin
# Define variable
* def userId = response.id

# Embedded expressions in JSON
And request { name: '#(userName)', id: '#(userId)' }

# JavaScript expressions
* def timestamp = java.lang.System.currentTimeMillis()
* def randomEmail = 'test_' + timestamp + '@example.com'

# Conditional logic
* def result = (status == 200) ? 'success' : 'failure'

# karate object utilities
* def uuid = java.util.UUID.randomUUID() + ''
```

## Call and Callonce

```gherkin
# call — runs every time (per scenario)
* def result = call read('helper.feature')
* def result = call read('helper.feature') { param1: 'value1' }

# callonce — runs once per feature (cached)
* def auth = callonce read('common/auth.feature')

# Inline function call
* def add = function(a, b){ return a + b }
* def sum = add(1, 2)
```

## Scenario Outline (Data-Driven)

```gherkin
Scenario Outline: Validate <field> with value <value>
  Given path '/endpoint'
  And request { '<field>': '<value>' }
  When method post
  Then status <expectedStatus>

  Examples:
    | field  | value     | expectedStatus |
    | name   | valid     | 200            |
    | name   |           | 400            |
    | email  | invalid   | 400            |
```

## Configuration

```gherkin
# Timeouts
* configure connectTimeout = 5000
* configure readTimeout = 30000

# Retry
* configure retry = { count: 3, interval: 1000 }
* retry until response.status == 'COMPLETED'

# SSL
* configure ssl = true
```

## Response Time Assertion

```gherkin
And assert responseTime < 3000
```
