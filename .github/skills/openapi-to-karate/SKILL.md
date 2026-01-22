---
name: openapi-to-karate
description: Guide for converting OpenAPI/Swagger specifications to Karate test files. Use when generating tests from OpenAPI specs or API documentation.
---

# OpenAPI to Karate Conversion

Convert OpenAPI (Swagger) specifications into comprehensive Karate test scenarios.

## When to use this skill

Use this skill when you need to:
- Generate Karate tests from OpenAPI 2.0/3.0 specifications
- Convert Swagger definitions to test scenarios
- Create tests from API documentation
- Ensure API contract compliance

## OpenAPI to Karate Mapping

### Basic Structure Mapping

**OpenAPI Structure:**
```yaml
paths:
  /users/{id}:
    get:
      summary: Get user by ID
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: integer
      responses:
        '200':
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: integer }
                  name: { type: string }
                  email: { type: string, format: email }
```

**Karate Test:**
```gherkin
Scenario: Get user by ID returns 200 with user object
  Given path 'users', 1
  When method get
  Then status 200
  And match response == 
    """
    {
      id: '#number',
      name: '#string',
      email: '#regex ^.+@.+$'
    }
    """
```

### Path Parameters

**OpenAPI:**
```yaml
/users/{userId}/posts/{postId}
```

**Karate:**
```gherkin
Given path 'users', userId, 'posts', postId
```

### Query Parameters

**OpenAPI:**
```yaml
parameters:
  - name: status
    in: query
    schema:
      type: string
      enum: [active, inactive]
  - name: limit
    in: query
    schema:
      type: integer
      default: 10
```

**Karate:**
```gherkin
And param status = 'active'
And param limit = 10
```

### Request Body (POST/PUT/PATCH)

**OpenAPI Schema:**
```yaml
requestBody:
  content:
    application/json:
      schema:
        type: object
        required: [name, email]
        properties:
          name: { type: string }
          email: { type: string, format: email }
          age: { type: integer, minimum: 0 }
```

**Karate Request:**
```gherkin
And request 
  """
  {
    name: 'John Doe',
    email: 'john@example.com',
    age: 30
  }
  """
```

### Response Schema to Match Assertions

**OpenAPI Response Schema:**
```yaml
responses:
  '200':
    content:
      application/json:
        schema:
          type: object
          properties:
            id: { type: integer }
            name: { type: string }
            email: { type: string }
            active: { type: boolean }
            roles: 
              type: array
              items: { type: string }
            metadata:
              type: object
              properties:
                created: { type: string, format: date-time }
```

**Karate Validation:**
```gherkin
And match response == 
  """
  {
    id: '#number',
    name: '#string',
    email: '#string',
    active: '#boolean',
    roles: '#array',
    metadata: {
      created: '#string'
    }
  }
  ```

### Type Conversions

| OpenAPI Type | Karate Marker |
|--------------|---------------|
| `integer` | `#number` |
| `number` | `#number` |
| `string` | `#string` |
| `boolean` | `#boolean` |
| `array` | `#array` or `#[]` |
| `object` | `#object` or `{}` |
| `string` with `format: email` | `#regex ^.+@.+$` |
| `string` with `format: uuid` | `#uuid` |
| `string` with `format: date` | `#string` |
| `string` with `format: date-time` | `#string` |
| `enum` | Exact value or `#string` |

### Authentication Schemes

**OpenAPI Security:**
```yaml
security:
  - bearerAuth: []
securitySchemes:
  bearerAuth:
    type: http
    scheme: bearer
    bearerFormat: JWT
```

**Karate Background:**
```gherkin
Background:
  * def authToken = 'your-jwt-token'
  * header Authorization = 'Bearer ' + authToken
```

**API Key:**
```yaml
securitySchemes:
  apiKey:
    type: apiKey
    in: header
    name: X-API-Key
```

**Karate:**
```gherkin
Background:
  * header X-API-Key = 'your-api-key'
```

## Test Scenario Patterns

### Happy Path Scenario

```gherkin
Scenario: Create user returns 201 with created user
  Given path 'users'
  And request { name: 'John Doe', email: 'john@example.com' }
  When method post
  Then status 201
  And match response.id == '#number'
  And match response.name == 'John Doe'
  And match response.email == 'john@example.com'
```

### Validation Error Scenarios

```gherkin
@negative
Scenario: Create user with invalid email returns 400
  Given path 'users'
  And request { name: 'Test', email: 'invalid-email' }
  When method post
  Then status 400
  And match response.error contains 'email'

@negative
Scenario: Create user with missing required field returns 400
  Given path 'users'
  And request { email: 'test@example.com' }
  When method post
  Then status 400
  And match response.error contains 'name'
```

### Data-Driven Tests from Examples

```gherkin
Scenario Outline: Create user with various inputs
  Given path 'users'
  And request { name: '<name>', email: '<email>' }
  When method post
  Then status <status>

  Examples:
    | name    | email              | status |
    | John    | john@example.com   | 201    |
    | Alice   | alice@test.com     | 201    |
    | Invalid | not-an-email       | 400    |
    |         | missing@name.com   | 400    |
```

## Complete Example from OpenAPI

**OpenAPI Spec:**
```yaml
/api/v1/products:
  get:
    summary: List products
    parameters:
      - name: category
        in: query
        schema:
          type: string
      - name: limit
        in: query
        schema:
          type: integer
  post:
    summary: Create product
    requestBody:
      required: true
      content:
        application/json:
          schema:
            type: object
            required: [name, price]
            properties:
              name: { type: string }
              price: { type: number, minimum: 0 }
              inStock: { type: boolean }
```

**Generated Karate Tests:**
```gherkin
@productApi
Feature: Product API Tests

  Background:
    * url 'https://api.example.com/api/v1'
    * header Content-Type = 'application/json'

  Scenario: List products returns 200 with array
    Given path 'products'
    When method get
    Then status 200
    And match response == '#[]'

  Scenario: List products with category filter
    Given path 'products'
    And param category = 'electronics'
    And param limit = 10
    When method get
    Then status 200
    And match response == '#[]'

  Scenario: Create product returns 201 with product
    Given path 'products'
    And request 
      """
      {
        name: 'Wireless Mouse',
        price: 29.99,
        inStock: true
      }
      """
    When method post
    Then status 201
    And match response.id == '#number'
    And match response.name == 'Wireless Mouse'
    And match response.price == 29.99

  @negative
  Scenario: Create product with negative price returns 400
    Given path 'products'
    And request { name: 'Test', price: -10 }
    When method post
    Then status 400

  @negative
  Scenario: Create product without required name returns 400
    Given path 'products'
    And request { price: 100 }
    When method post
    Then status 400
```

## Best Practices for OpenAPI Conversion

1. **Use file attachments**: Share OpenAPI spec as file for better context
2. **Generate comprehensive coverage**: Include happy path, validation, and edge cases
3. **Preserve schema structure**: Match response validation to OpenAPI schema exactly
4. **Handle authentication**: Convert security schemes to proper Karate headers
5. **Tag scenarios**: Use `@smoke`, `@regression`, `@negative` for organization
6. **Data-driven where applicable**: Use Scenario Outline for multiple similar cases

## References

- Karate DSL: https://docs.karatelabs.io/
- OpenAPI Specification: https://swagger.io/specification/
