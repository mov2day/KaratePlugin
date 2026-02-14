---
name: karate-anti-patterns
description: Common mistakes and anti-patterns to avoid in Karate test generation
---

# Karate Anti-Patterns

## CRITICAL: Anti-Hallucination Rules

### ❌ NEVER invent endpoints
```gherkin
# BAD — endpoint not in the spec
Given path '/orders/analytics/summary'
```
```gherkin
# GOOD — only use endpoints from the provided spec
Given path '/orders'
```

### ❌ NEVER invent response fields
```gherkin
# BAD — fields not in the spec schema
And match response contains { analytics: '#object', score: '#number' }
```
```gherkin
# GOOD — only validate fields defined in the spec
And match response contains { id: '#number', name: '#string' }
```

### ❌ NEVER assume request body fields
```gherkin
# BAD — guessing fields not documented
And request { name: 'test', priority: 'high', category: 'A' }
```
```gherkin
# GOOD — only use documented request fields
And request { name: 'test' }
```

---

## Code Quality Anti-Patterns

### ❌ Hardcoded URLs
```gherkin
# BAD
Given url 'https://api.production.com/v1'
Given path '/orders'
```
```gherkin
# GOOD — use karate-config.js or Background
Background:
  * url baseUrl
```

### ❌ Duplicate auth in every scenario
```gherkin
# BAD — auth token fetched in each scenario
Scenario: Test 1
  Given url authUrl
  And request { username: 'admin', password: 'pass' }
  When method post
  * def token = response.token
  # ... test logic

Scenario: Test 2
  Given url authUrl
  And request { username: 'admin', password: 'pass' }
  When method post
  * def token = response.token
  # ... test logic
```
```gherkin
# GOOD — callonce in Background
Background:
  * def auth = callonce read('common/auth.feature')
  * header Authorization = 'Bearer ' + auth.token
```

### ❌ Hardcoded secrets
```gherkin
# BAD
* def password = 'SuperSecret123!'
* header Authorization = 'Bearer eyJhbGciOiJIUzI1...'
```
```gherkin
# GOOD — use config variables
* def password = karate.properties['test.password']
```

### ❌ Missing status code assertions
```gherkin
# BAD — no status check
Given path '/orders'
When method get
And match response.items == '#array'
```
```gherkin
# GOOD
Given path '/orders'
When method get
Then status 200
And match response.items == '#array'
```

### ❌ Vague scenario names
```gherkin
# BAD
Scenario: Test 1
Scenario: Check API
Scenario: Verify response
```
```gherkin
# GOOD — intent-based, descriptive
Scenario: GET /orders returns paginated list of active orders
Scenario: POST /orders with missing product name returns 400
Scenario: DELETE /orders/{id} for non-existent order returns 404
```

### ❌ No negative test scenarios
```gherkin
# BAD — only happy path
Scenario: Create order
  Given path '/orders'
  And request { product: 'Widget' }
  When method post
  Then status 201
```
```gherkin
# GOOD — include negative cases
@positive
Scenario: Create order with valid data
  Given path '/orders'
  And request { product: 'Widget', quantity: 5 }
  When method post
  Then status 201

@negative
Scenario: Create order with missing required fields returns 400
  Given path '/orders'
  And request {}
  When method post
  Then status 400

@negative
Scenario: Create order with invalid quantity returns 400
  Given path '/orders'
  And request { product: 'Widget', quantity: -1 }
  When method post
  Then status 400
```

### ❌ Using call when callonce is appropriate
```gherkin
# BAD — auth runs every scenario
Background:
  * def auth = call read('common/auth.feature')
```
```gherkin
# GOOD — auth runs once per feature
Background:
  * def auth = callonce read('common/auth.feature')
```

### ❌ Overly complex single scenarios
```gherkin
# BAD — too many assertions in one scenario
Scenario: Test everything
  # 50+ lines of mixed concerns
```
```gherkin
# GOOD — focused scenarios with clear intent
Scenario: Verify order creation returns correct schema
Scenario: Verify order creation with boundary values
Scenario: Verify order creation handles duplicate names
```

### ❌ Security attack patterns in tests
```gherkin
# BAD — SQL injection, XSS in test data
And request { name: "'; DROP TABLE orders; --" }
And request { name: "<script>alert('xss')</script>" }
```
```gherkin
# GOOD — functional negative testing only
And request { name: '' }              # empty string
And request { name: 'a'.repeat(256) } # boundary length
And request {}                        # missing field
```
