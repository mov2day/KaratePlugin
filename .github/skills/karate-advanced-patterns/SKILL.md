---
name: karate-advanced-patterns
description: Advanced Karate patterns including JavaScript functions, data-driven testing, parallel execution, and configuration management. Use for complex test scenarios and optimizations.
---

# Karate Advanced Patterns

Advanced techniques and patterns for sophisticated Karate test automation.

## When to use this skill

Use this skill when you need to:
- Write JavaScript functions in Karate
- Implement data-driven testing with external data
- Configure parallel execution
- Handle complex data transformations
- Manage test configurations across environments

## JavaScript Functions in Karate

### Inline JavaScript

```gherkin
# Simple function
* def generateUUID = function(){ return java.util.UUID.randomUUID() + '' }
* def uuid = generateUUID()

# Function with parameters
* def fullName = function(first, last){ return first + ' ' + last }
* match fullName('John', 'Doe') == 'John Doe'

# Function for data transformation
* def toUpperCase = function(str){ return str.toUpperCase() }
* def name = toUpperCase('john')
And match name == 'JOHN'
```

### External JavaScript Files

**utils.js:**
```javascript
function generateEmail(name) {
  return name.toLowerCase() + '@example.com';
}

function getCurrentTimestamp() {
  return new Date().getTime();
}
```

**Feature file:**
```gherkin
Background:
  * def utils = read('classpath:utils.js')

Scenario: Use external functions
  * def email = utils.generateEmail('JohnDoe')
  * def timestamp = utils.getCurrentTimestamp()
```

### Java Interop

```gherkin
# Call Java static methods
* def timestamp = java.lang.System.currentTimeMillis()
* def uuid = java.util.UUID.randomUUID()

# Create Java objects
* def SimpleDateFormat = Java.type('java.text.SimpleDateFormat')
* def formatter = new SimpleDateFormat('yyyy-MM-dd')
```

## Data-Driven Testing

### Scenario Outline with Examples

```gherkin
Scenario Outline: Validate user creation with various inputs
  Given path 'users'
  And request { name: '<name>', age: <age>, email: '<email>' }
  When method post
  Then status <expectedStatus>
  
  Examples:
    | name  | age | email              | expectedStatus |
    | John  | 25  | john@example.com   | 201            |
    | Alice | 30  | alice@test.com     | 201            |
    | Bob   | -1  | bob@test.com       | 400            |
    | Test  | 20  | invalid-email      | 400            |
```

### Reading External Data Files

**CSV File (users.csv):**
```csv
name,email,age
John,john@example.com,25
Alice,alice@test.com,30
Bob,bob@test.com,35
```

**Feature:**
```gherkin
Scenario: Create users from CSV
  * def users = read('users.csv')
  * def user = users[0]
  Given path 'users'
  And request user
  When method post
  Then status 201
```

**JSON File (testdata.json):**
```json
[
  { "name": "John", "email": "john@example.com" },
  { "name": "Alice", "email": "alice@test.com" }
]
```

**Feature:**
```gherkin
Scenario: Create users from JSON
  * def users = read('testdata.json')
  * def createUser = function(user){ karate.call('create-user.feature', user) }
  * karate.forEach(users, createUser)
```

### Dynamic Scenario Creation

```gherkin
Scenario: Create multiple users dynamically
  * def users = [{ name: 'John' }, { name: 'Alice' }, { name: 'Bob' }]
  * def result = karate.mapWithKey(users, 'user', 'create-user.feature')
  * match each result == { id: '#number', name: '#string' }
```

## Parallel Execution

### Configuration

**pom.xml (Maven):**
```xml
<configuration>
  <threads>4</threads>
  <parallel>methods</parallel>
</configuration>
```

**karate-config.js:**
```javascript
function fn() {
  karate.configure('connectTimeout', 5000);
  karate.configure('readTimeout', 5000);
  return { threads: 4 };
}
```

### Thread-Safe Tests

```gherkin
# Each scenario should be independent
Scenario: Create unique user
  * def uniqueId = java.util.UUID.randomUUID()
  * def email = 'user-' + uniqueId + '@example.com'
  Given request { email: email }
  When method post
  Then status 201
```

## Configuration Management

### Environment-Specific Config

**karate-config.js:**
```javascript
function fn() {
  var env = karate.env || 'dev';
  var config = {
    baseUrl: 'http://localhost:8080'
  };
  
  if (env == 'dev') {
    config.baseUrl = 'http://dev.example.com';
  } else if (env == 'test') {
    config.baseUrl = 'http://test.example.com';
  } else if (env == 'prod') {
    config.baseUrl = 'https://api.example.com';
  }
  
  return config;
}
```

**Run with environment:**
```bash
mvn test -Dkarate.env=test
```

### Conditional Configuration

```gherkin
Background:
  * def config = karate.callSingle('classpath:karate-config.js')
  * url config.baseUrl
  * configure retry = { count: 3, interval: 2000 }
  * configure ssl = true
```

## Advanced Assertions

### Fuzzy Matching

```gherkin
# Contains check (ignore extra fields)
And match response contains { name: 'John' }

# Deep contains (nested)
And match response contains deep { user: { name: 'John' } }

# Only check specified fields
And match response.user contains only { name: '#string', email: '#string' }
```

### Schema Validation with Optional Fields

```gherkin
And match response ==
  """
  {
    id: '#number',
    name: '#string',
    email: '#string',
    phone: '##string',        # Optional string
    middleName: '##string',   # Optional string
    age: '##number'           # Optional number
  }
  """
```

### Match Each for Array Validation

```gherkin
# Validate each item matches schema
And match each response.items == { id: '#number', name: '#string' }

# Validate each item with condition
And match each response.items contains { active: true }
```

## Reusable Features

### Call Another Feature

**create-user.feature:**
```gherkin
Feature: Reusable user creation

Scenario: Create user
  Given path 'users'
  And request __arg
  When method post
  Then status 201
```

**Main feature:**
```gherkin
Scenario: Use reusable feature
  * def user = { name: 'John', email: 'john@example.com' }
  * call read('create-user.feature') user
  * def userId = response.id
```

### Call Once (Singleton)

```gherkin
# Execute only once across all scenarios
Background:
  * def authToken = karate.callSingle('get-auth-token.feature')
  * header Authorization = 'Bearer ' + authToken.token
```

## Performance Testing Patterns

### Response Time Assertions

```gherkin
* def responseTime = karate.get('responseTime')
* assert responseTime < 2000   # Less than 2 seconds
```

### Retry Configuration

```gherkin
# Retry failed requests
* configure retry = { count: 3, interval: 1000 }

Given path 'users'
When method get
And retry until responseStatus == 200
Then match response == '#[]'
```

## Complete Advanced Example

```gherkin
@advanced @regression
Feature: Advanced Product Management

  Background:
    * def utils = read('classpath:utils.js')
    * def config = karate.callSingle('classpath:karate-config.js')
    * url config.baseUrl
    * header Content-Type = 'application/json'
    * configure retry = { count: 2, interval: 1000 }

  Scenario: Create and manage products with external data
    # Read test data
    * def products = read('products.json')
    
    # Create products in parallel
    * def createProduct = 
      """
      function(product) {
        var result = karate.call('create-product.feature', product);
        return result.response.id;
      }
      """
    * def productIds = karate.map(products, createProduct)
    * match productIds == '#[]'
    * match productIds.length == products.length
    
    # Verify all products exist
    * def verifyProduct = 
      """
      function(id) {
        karate.set('productId', id);
        var response = karate.call('get-product.feature');
        return response.responseStatus == 200;
      }
      """
    * def results = karate.map(productIds, verifyProduct)
    * match results == '#[true]'

  Scenario: Data-driven validation from CSV
    * def testCases = read('test-cases.csv')
    
    * def runTest = 
      """
      function(testCase) {
        karate.set('input', testCase);
        karate.call('validate-product.feature');
      }
      """
    * karate.forEach(testCases, runTest)
```

## Best Practices

1. **Keep functions simple**: Complex logic should be in Java classes
2. **Use external files**: Separate data, functions, and reusable features
3. **Independent scenarios**: Each scenario should be runnable in parallel
4. **Configuration management**: Use karate-config.js for environment-specific settings
5. **Retry wisely**: Use retry for flaky endpoints, not as error handling
6. **Performance consideration**: Monitor response times in key scenarios

## References

- Official Documentation: https://docs.karatelabs.io/
- JavaScript in Karate: Use for transformations and utilities
- Parallel execution: Scale tests efficiently
- Data-driven: External data sources (CSV, JSON, Excel)
