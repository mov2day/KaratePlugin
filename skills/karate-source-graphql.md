---
name: karate-source-graphql
description: Karate v2 GraphQL tests - text queries, variables, data/errors assertions, file-based queries
---
Generate only from supplied operations and schema. Never add fields to a selection set that the schema or sample does not show.

## Query with variables
Define queries with `text` (GraphQL is not JSON); send `{ query, variables }` as one POST.
```gherkin
Background:
  * url baseUrl

Scenario: Query hero by id
  Given path 'graphql'
  And text query =
    """
    query GetHero($heroId: Int!) {
      hero(id: $heroId) { name height mass }
    }
    """
  And def variables = { heroId: 1001 }
  And request { query: '#(query)', variables: '#(variables)' }
  When method post
  Then status 200
  And match response.errors == '#notpresent'
  And match response.data.hero == { name: '#string', height: '#number', mass: '#number' }
```
- Use variables for ids, filters and search terms; do not splice values into the query text.
- Reusable or long queries live in `.graphql` / `.gql` files; `* def query = read('classpath:queries/get-hero.graphql')` returns text.
- Mutations follow the same shape. Capture returned ids with `* def id = response.data.createUser.id`.
- A GraphQL server usually answers 200 even on failure, so also assert `errors`.

## Error scenarios
Only for errors the schema or samples evidence (invalid input, unauthorized, not found).
```gherkin
Then status 200
And match response.errors == '#[_ > 0]'
And match each response.errors contains { message: '#string' }
And match response.data == '#null'
```
Adjust the last line only if the evidence shows `data` is partially filled.

## Validation
- Arrays: `match response.data.users == '#[3]'`, `match each response.data.users == { id: '#number', name: '#string' }`.
- Deep paths: `karate.jsonPath(response, '$.data.users[*].posts[*]')`.
- Optional or nullable fields use `##`; large ids as strings.
- Auth: `configure auth` or a header from `karate.sysenv`; never a literal token.

## Dynamic queries
Use `replace` with `<token>` placeholders to vary the query text; an Outline works too (`<heroName>` inside the text block).
```gherkin
And text template =
  """
  { hero(id: <heroId>) { name } }
  """
And replace template
  | token  | value |
  | heroId | 1001  |
And request { query: '#(template)' }
```

## Rules
- V2-ASSERT-001 and V2-ASSERT-002: assert status, then `data` shape and absence of `errors`.
```gherkin
# BAD: status only
When method post
Then status 200
# GOOD
And match response.errors == '#notpresent'
And match response.data == '#object'
```
