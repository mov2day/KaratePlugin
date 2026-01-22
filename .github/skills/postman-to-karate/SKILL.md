---
name: postman-to-karate
description: Guide for converting Postman collections to Karate test files. Use when migrating from Postman or converting Postman collections to Karate tests.
---

# Postman to Karate Conversion

Convert Postman collections and environments into Karate test scenarios.

## When to use this skill

Use this skill when you need to:
- Migrate from Postman to Karate
- Convert Postman collections to automated tests
- Transform Postman scripts to Karate JavaScript
- Map Postman variables to Karate variables

## Postman to Karate Mapping

### Collection Structure

**Postman Collection:**
```json
{
  "info": { "name": "User API" },
  "item": [
    {
      "name": "Get User",
      "request": {
        "method": "GET",
        "url": "{{baseUrl}}/users/{{userId}}"
      }
    }
  ]
}
```

**Karate Feature:**
```gherkin
Feature: User API

  Scenario: Get User
    Given path 'users', userId
    When method get
```

### Variable Mapping

| Postman Variable | Karate Equivalent |
|------------------|-------------------|
| `{{variable}}` | `#(variable)` or direct use |
| Collection variable | Background variable |
| Environment variable | Config/Background variable |
| Global variable | Config variable |

**Postman:**
```
{{baseUrl}}/users/{{userId}}
```

**Karate:**
```gherkin
Background:
  * url baseUrl
  * def userId = 1

Scenario: Get user
  Given path 'users', userId
```

### Request Conversion

**Postman Request:**
```json
{
  "method": "POST",
  "url": "{{baseUrl}}/users",
  "header": [
    { "key": "Content-Type", "value": "application/json" },
    { "key": "Authorization", "value": "Bearer {{token}}" }
  ],
  "body": {
    "mode": "raw",
    "raw": "{\n  \"name\": \"John\",\n  \"email\": \"john@example.com\"\n}"
  }
}
```

**Karate Test:**
```gherkin
Background:
  * url baseUrl
  * def token = 'your-token'
  * header Authorization = 'Bearer ' + token

Scenario: Create user
  Given path 'users'
  And header Content-Type = 'application/json'
  And request { name: 'John', email: 'john@example.com' }
  When method post
```

### Pre-request Scripts

**Postman Pre-request:**
```javascript
// Generate timestamp
pm.environment.set("timestamp", new Date().getTime());

// Generate random email
pm.environment.set("email", `test${Math.random()}@example.com`);
```

**Karate Equivalent:**
```gherkin
Background:
  * def timestamp = function(){ return java.lang.System.currentTimeMillis() }
  * def randomEmail = function(){ return 'test' + Math.random() + '@example.com' }

Scenario: Use dynamic values
  * def currentTime = timestamp()
  * def email = randomEmail()
  Given request { timestamp: currentTime, email: email }
```

### Test Scripts (Assertions)

**Postman Test:**
```javascript
pm.test("Status code is 200", function () {
    pm.response.to.have.status(200);
});

pm.test("Response has id", function () {
    var jsonData = pm.response.json();
    pm.expect(jsonData.id).to.be.a('number');
});

pm.test("Name is correct", function () {
    var jsonData = pm.response.json();
    pm.expect(jsonData.name).to.equal("John");
});
```

**Karate Test:**
```gherkin
Then status  200
And match response.id == '#number'
And match response.name == 'John'
```

### Environment Variables

**Postman Environment:**
```json
{
  "name": "Production",
  "values": [
    { "key": "baseUrl", "value": "https://api.example.com" },
    { "key": "apiKey", "value": "secret123" }
  ]
}
```

**Karate Config:**
```javascript
// karate-config.js
function fn() {
  var env = karate.env || 'dev';
  var config = {
    baseUrl: 'https://api.example.com',
    apiKey: 'secret123'
  };
  return config;
}
```

**Or Background:**
```gherkin
Background:
  * url 'https://api.example.com'
  * def apiKey = 'secret123'
  * header X-API-Key = apiKey
```

## Script Conversion Patterns

### Save Response Data

**Postman:**
```javascript
var jsonData = pm.response.json();
pm.environment.set("userId", jsonData.id);
```

**Karate:**
```gherkin
* def userId = response.id
```

### Conditional Logic

**Postman:**
```javascript
if (pm.response.code === 200) {
    pm.environment.set("success", true);
} else {
    pm.environment.set("success", false);
}
```

**Karate:**
```gherkin
* def success = responseStatus == 200
```

### Iteration and Arrays

**Postman:**
```javascript
var items = pm.response.json().items;
items.forEach(function(item) {
    pm.test(`Item ${item.id} has name`, function() {
        pm.expect(item.name).to.be.a('string');
    });
});
```

**Karate:**
```gherkin
And match each response.items == { id: '#number', name: '#string' }
```

### Dynamic URL Construction

**Postman:**
```javascript
pm.request.url = `${pm.environment.get("baseUrl")}/users/${pm.environment.get("userId")}`;
```

**Karate:**
```gherkin
Given url baseUrl
And path 'users', userId
```

## Complete Conversion Example

**Postman Collection:**
```json
{
  "info": { "name": "Product API" },
  "variable": [
    { "key": "baseUrl", "value": "https://api.shop.com" }
  ],
  "item": [
    {
      "name": "Create Product",
      "request": {
        "method": "POST",
        "url": "{{baseUrl}}/products",
        "header": [
          { "key": "Content-Type", "value": "application/json" }
        ],
        "body": {
          "raw": "{\"name\":\"Mouse\",\"price\":29.99}"
        }
      },
      "event": [
        {
          "listen": "test",
          "script": {
            "exec": [
              "pm.test('Status 201', () => pm.response.to.have.status(201));",
              "pm.environment.set('productId', pm.response.json().id);"
            ]
          }
        }
      ]
    },
    {
      "name": "Get Product",
      "request": {
        "method": "GET",
        "url": "{{baseUrl}}/products/{{productId}}"
      }
    }
  ]
}
```

**Karate Feature:**
```gherkin
@productApi
Feature: Product API

  Background:
    * url 'https://api.shop.com'
    * header Content-Type = 'application/json'

  Scenario: Create and retrieve product
    # Create product
    Given path 'products'
    And request { name: 'Mouse', price: 29.99 }
    When method post
    Then status 201
    * def productId = response.id
    
    # Get product
    Given path 'products', productId
    When method get
    Then status 200
    And match response.id == productId
    And match response.name =='Mouse'
```

## Best Practices

1. **Use file attachments**: Share Postman collection as file for better conversion
2. **Simplify scripts**: Karate's native assertions are more concise than Postman tests
3. **Leverage Karate features**: Replace complex scripts with built-in Karate capabilities
4. **Organize variables**: Use Background for collection-level variables
5. **Scenario chaining**: Karate allows passing data between scenarios more easily
6. **Remove redundancy**: Karate's DSL often makes verbose Postman code unnecessary

## Migration Checklist

- [ ] Export Postman collection as JSON
- [ ] Export Postman environment as JSON (if applicable)
- [ ] Map collection variables to Karate Background
- [ ] Convert requests to Karate Given/When/Then syntax
- [ ] Transform test scripts to Karate match assertions
- [ ] Convert pre-request scripts to Karate JavaScript functions
- [ ] Replace Postman variables with Karate syntax
- [ ] Test converted scenarios
- [ ] Organize into logical feature files

## References

- Karate DSL: https://docs.karatelabs.io/
- Postman Collections: https://learning.postman.com/docs/collections/collections-overview/
