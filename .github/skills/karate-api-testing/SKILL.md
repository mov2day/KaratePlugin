---
name: karate-api-testing
description: Specialized guidance for API testing with Karate. Use when testing REST APIs, validating responses, or working with HTTP operations.
---

# Karate API Testing

Advanced patterns and best practices for API testing with Karate DSL.

## When to use this skill

Use this skill when you need to:
- Test RESTful APIs
- Validate complex response structures
- Handle authentication and authorization
- Perform advanced HTTP operations

## HTTP Methods and Operations

### All HTTP Methods

```gherkin
When method get     # GET request
When method post    # POST request
When method put     # PUT (full update)
When method patch   # PATCH (partial update)
When method delete  # DELETE request
When method head    # HEAD request
When method options # OPTIONS request
```

### Request Configuration

```gherkin
# Headers
And header Authorization = 'Bearer token123'
And header Content-Type = 'application/json'
And header X-Custom-Header = 'value'

# Cookies
And cookie sessionId = 'abc123'
And cookie csrfToken = tokenValue

# Query parameters
And param search = 'karate'
And param limit = 10
And param offset = 0

# Form fields (application/x-www-form-urlencoded)
And form field username = 'testuser'
And form field password = 'secret'

# Multipart (file upload)
And multipart file upload = { read: 'test.pdf', contentType: 'application/pdf' }
And multipart field description = 'Test upload'
```

## Powerful One-Line Assertions

### Complete Schema Validation

```gherkin
# Validate entire response structure
And match response == 
  """
  {
    id: '#number',
    name: '#string',
    email: '#regex ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}$',
    age: '#number',
    active: '#boolean',
    createdAt: '#string',
    metadata: '#object',
    tags: '#array',
    optional: '##string'
  }
  """
```

### Type Markers Reference

| Marker | Description | Example |
|--------|-------------|---------|
| `#string` | Must be string | `name: '#string'` |
| `#number` | Must be number | `id: '#number'` |
| `#boolean` | Must be boolean | `active: '#boolean'` |
| `#array` | Must be array | `items: '#array'` |
| `#object` | Must be object | `metadata: '#object'` |
| `#null` | Must be null | `deletedAt: '#null'` |
| `#present` | Must be present (not undefined) | `id: '#present'` |
| `#ignore` | Ignore this field | `timestamp: '#ignore'` |
| `##type` | Optional field | `middleName: '##string'` |
| `#regex` | Match regex | `email: '#regex ^.+@.+$'` |
| `#uuid` | Valid UUID | `id: '#uuid'` |
| `#[]` | Is array | `items: '#[]'` |
| `#[n]` | Array with n items | `items: '#[5]'` |
| `#[_]` | Each array item (for iteration) | See below |

### Advanced Array Validation

```gherkin
# Check if array
And match response.items == '#[]'

# Check array length
And match response.items == '#[3]'

# Validate each item in array
And match each response.items == { id: '#number', name: '#string' }

# Validate specific item
And match response.items[0].id == 1

# Contains check
And match response.tags contains 'important'
And match response.tags !contains 'obsolete'

# Array contains object
And match response.users contains { name: 'John' }
```

### JSON Path Expressions

```gherkin
# Direct path
And match response.user.name == 'John'

# Nested objects
And match response.user.address.city == 'New York'

# Array indexing
And match response.items[0].id == 1
And match response.items[2].name == 'Third Item'

# Get all IDs from array
* def ids = $response.items[*].id
```

### XML Path Expressions

```gherkin
# XML navigation with forward slash
And match /users/user[1]/name == 'John'
And match /users/user[2]/email == 'jane@example.com'

# XML attributes
And match /user/@id == '123'
```

## Authentication Patterns

### Bearer Token

```gherkin
Background:
  * def authToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
  * header Authorization = 'Bearer ' + authToken
```

### Basic Auth

```gherkin
Background:
  * def credentials = 'username:password'
  * def encodedCred = karate.encode(credentials)
  * header Authorization = 'Basic ' + encodedCred
```

### OAuth 2.0 Flow

```gherkin
Background:
  # Get access token
  Given url 'https://auth.example.com'
  And path 'oauth/token'
  And form field grant_type = 'client_credentials'
  And form field client_id = clientId
  And form field client_secret = clientSecret
  When method post
  Then status 200
  * def accessToken = response.access_token
  
  # Use token for API calls
  * url 'https://api.example.com'
  * header Authorization = 'Bearer ' + accessToken
```

## Status Code Validation

```gherkin
# Success codes
Then status 200    # OK
Then status 201    # Created
Then status 204    # No Content

# Client errors
Then status 400    # Bad Request
Then status 401    # Unauthorized
Then status 403    # Forbidden
Then status 404    # Not Found
Then status 409    # Conflict
Then status 422    # Unprocessable Entity

# Server errors
Then status 500    # Internal Server Error
Then status 503    # Service Unavailable
```

## Response Time Assertions

```gherkin
# Assert response time
* def responseTime = karate.get('responseTime')
* assert responseTime < 2000   # Less than 2 seconds

# Or use configure
* configure responseHeaders = { 'X-Response-Time': '#present' }
```

## Dynamic Data Handling

### Extract and Reuse Response Data

```gherkin
# Store response data
* def userId = response.id
* def userName = response.name

# Use in next request
Given path 'users', userId, 'posts'
When method get
Then status 200
```

### JavaScript Functions

```gherkin
# Define JavaScript function
* def generateEmail = function(name){ return name.toLowerCase() + '@example.com' }

# Use function
* def email = generateEmail('JohnDoe')
And match email == 'johndoe@example.com'
```

## Error Handling

### Validate Error Responses

```gherkin
@negative
Scenario: Invalid email returns 400 with error message
  Given path 'users'
  And request { name: 'Test', email: 'invalid-email' }
  When method post
  Then status 400
  And match response.error == '#string'
  And match response.error contains 'email'
  And match response.details == '#array'
```

## Complete API Test Example

```gherkin
@productApi @regression
Feature: Product Management API

  Background:
    * url 'https://api.shop.example.com/v1'
    * header Content-Type = 'application/json'
    * header Authorization = 'Bearer token123'
  
  Scenario: Get all products with pagination
    Given path 'products'
    And param page = 1
    And param limit = 10
    When method get
    Then status 200
    And match response == 
      """
      {
        products: '#[]',
        total: '#number',
        page: 1,
        limit: 10
      }
      """
    And match each response.products == 
      """
      {
        id: '#number',
        name: '#string',
        price: '#number',
        inStock: '#boolean',
        sku: '#string',
        description: '##string'
      }
      """
  
  Scenario: Create product and verify response
    * def newProduct = 
      """
      {
        name: 'Wireless Mouse',
        price: 29.99,
        inStock: true,
        sku: 'WM-001'
      }
      """
    Given path 'products'
    And request newProduct
    When method post
    Then status 201
    And match response.id == '#number'
    And match response.name == newProduct.name
    And match response.price == newProduct.price
    * def productId = response.id
    
    # Verify created product can be retrieved
    Given path 'products', productId
    When method get
    Then status 200
    And match response.name == 'Wireless Mouse'
  
  @negative
  Scenario: Create product with invalid price returns 400
    Given path 'products'
    And request { name: 'Test', price: -10, inStock: true }
    When method post
    Then status 400
    And match response.error contains 'price'
```

## References

- Official Documentation: https://docs.karatelabs.io/
- One-line assertions make validation simple
- Native JSON support - no escaping needed
- First-class XML support
