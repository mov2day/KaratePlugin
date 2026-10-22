Feature: GraphQL API

  Background:
    * url graphqlEndpoint
    * def headers = { 'Content-Type': 'application/json' }

  @positive @query
  Scenario: Query book - success
    Given path 'graphql'
    And request
    """
    { "query": "query { book(id: $id) { id __typename } }", "variables": {"id":"test-id-123"} }
    """
    When method POST
    Then status 200
    And match response.data.book == '#present'
    And match response.errors == '#notpresent'

  @negative @query
  Scenario: Query book - missing required arguments
    Given path 'graphql'
    And request
    """
    { "query": "query { book { id __typename } }" }
    """
    When method POST
    Then status 200
    And match response.errors == '#present'
    And match response.errors[0].message == '#present'

  @positive @query
  Scenario: Query books - success
    Given path 'graphql'
    And request
    """
    { "query": "query { books(limit: $limit, genre: $genre) { id __typename } }", "variables": {"limit":"10","genre":"test-value"} }
    """
    When method POST
    Then status 200
    And match response.data.books == '#present'
    And match response.errors == '#notpresent'

  @positive @mutation
  Scenario: Mutation addBook - success
    Given path 'graphql'
    And request
    """
    { "query": "mutation { addBook(title: $title, author: $author) { id __typename } }", "variables": {"title":"test-value","author":"test-value"} }
    """
    When method POST
    Then status 200
    And match response.data.addBook == '#present'
    And match response.errors == '#notpresent'

  @negative @mutation
  Scenario: Mutation addBook - missing required arguments
    Given path 'graphql'
    And request
    """
    { "query": "mutation { addBook { id __typename } }" }
    """
    When method POST
    Then status 200
    And match response.errors == '#present'
    And match response.errors[0].message == '#present'

  @positive @mutation
  Scenario: Mutation deleteBook - success
    Given path 'graphql'
    And request
    """
    { "query": "mutation { deleteBook(id: $id) { boolean } }", "variables": {"id":"test-id-123"} }
    """
    When method POST
    Then status 200
    And match response.data.deleteBook == '#present'
    And match response.errors == '#notpresent'

  @negative @mutation
  Scenario: Mutation deleteBook - missing required arguments
    Given path 'graphql'
    And request
    """
    { "query": "mutation { deleteBook { boolean } }" }
    """
    When method POST
    Then status 200
    And match response.errors == '#present'
    And match response.errors[0].message == '#present'
