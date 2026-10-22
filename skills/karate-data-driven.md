---
name: karate-data-driven
description: Karate v2 data-driven tests - Scenario Outline columns as variables, type hints, __row/__num, tables, faker/uuid, copy
---
Use an Outline when one flow runs over several data rows; otherwise write separate scenarios.

## Scenario Outline
Every Examples column is bound as a variable named after its header. Reference the variable; use `<col>` only for text templating (scenario names, URL fragments).
```gherkin
Scenario Outline: Get user <id>
  Given path 'users', id
  When method get
  Then status 200
  And match response.name == expectedName

  Examples:
    | id | expectedName  |
    | 1  | Leanne Graham |
    | 2  | Ervin Howell  |
```
- A `!` header (`count!`) evaluates the cell as JavaScript: numbers, booleans, arrays, objects. Without it every cell is a string.
- `__row` is the whole row as JSON; `__num` is the row index from 0.
```gherkin
Scenario Outline: Create post
  Given path 'posts'
  And request __row
  When method post
  Then status 201

  Examples:
    | title!       | userId! |
    | 'First Post' | 1       |
    | 'Second'     | 2       |
```
- Examples can load a file: `| read('classpath:test-data/posts.json') |`.
- Tag an Examples block (`@slow`) to filter its rows independently.
- All steps stay above the first `Examples:`.

## Tables and loops
```gherkin
* table users
  | name    | age |
  | 'Alice' | 30  |
  | 'Bob'   | 25  |
* def results = call read('create-user.feature') users
* match results == '#[2]'
```
Strings in `table` cells are quoted. `call` with an array runs the feature once per element; its keys become variables. Read CSV with `read('classpath:test-data/users.csv')`.

## Unique test data
Parallel scenarios must not collide, so generate values.
```gherkin
* def id = karate.uuid()
* def name = karate.faker.firstName()
* def email = karate.faker.email()
* def age = karate.faker.randomInt(18, 65)
* def code = karate.faker.alphanumeric(12)
```

## Shared data
Loaded file data is cached and shared. Clone before changing it.
```gherkin
* def base = read('classpath:data/users/valid-user.json')
* def user = karate.copy(base)
* set user.name = 'Jane'
```

## Rules
- V2-GHERKIN-001: Outline steps stay above `Examples:`; nothing follows the table.
- V2-DUP-001: put a column in the name so generated scenarios are distinguishable and unique.
```gherkin
# BAD: same name for different outlines
Scenario Outline: Get user
# GOOD
Scenario Outline: Get user <id>
```
