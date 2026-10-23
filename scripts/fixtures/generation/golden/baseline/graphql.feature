Feature: GraphQL API
  Generated from a GraphQL schema. Authentication is not part of a schema: configure it in karate-config or a common auth feature.

  Background:
    * url baseUrl

  @positive @op=book
  Scenario: Query book - success
    # source: Query book
    Given path 'graphql'
    And text query =
    """
      query Book($id: ID!) {
        book(id: $id) {
          id
          title
          author
          genre
        }
      }
    """
    And def variables = { id: 'sample' }
    And request { query: '#(query)', variables: '#(variables)' }
    When method post
    Then status 200
    And match response.errors == '#notpresent'
    And match response.data.book == '#present'

  @negative @op=book
  Scenario: Query book - missing required variable id
    # source: Query book
    Given path 'graphql'
    And text query =
    """
      query Book($id: ID!) {
        book(id: $id) {
          id
          title
          author
          genre
        }
      }
    """
    And request { query: '#(query)' }
    When method post
    # GraphQL over HTTP: request errors arrive as 200 or 400 depending on the server
    Then assert responseStatus == 200 || responseStatus == 400
    And match response.errors == '#[_ > 0]'

  @positive @op=books
  Scenario: Query books - success
    # source: Query books
    Given path 'graphql'
    And text query =
    """
      query Books($limit: Int) {
        books(limit: $limit) {
          id
          title
          author
          genre
        }
      }
    """
    And def variables = { limit: 10 }
    And request { query: '#(query)', variables: '#(variables)' }
    When method post
    Then status 200
    And match response.errors == '#notpresent'
    And match response.data.books == '##[]'

  @positive @op=addBook
  Scenario: Mutation addBook - success
    # source: Mutation addBook
    Given path 'graphql'
    And text query =
    """
      mutation AddBook($title: String!, $author: String!) {
        addBook(title: $title, author: $author) {
          id
          title
          author
          genre
        }
      }
    """
    And def variables = { title: 'Sample name', author: 'sample' }
    And request { query: '#(query)', variables: '#(variables)' }
    When method post
    Then status 200
    And match response.errors == '#notpresent'
    And match response.data.addBook == '#present'

  @negative @op=addBook
  Scenario: Mutation addBook - missing required variable title
    # source: Mutation addBook
    Given path 'graphql'
    And text query =
    """
      mutation AddBook($title: String!, $author: String!) {
        addBook(title: $title, author: $author) {
          id
          title
          author
          genre
        }
      }
    """
    And def variables = { author: 'sample' }
    And request { query: '#(query)', variables: '#(variables)' }
    When method post
    # GraphQL over HTTP: request errors arrive as 200 or 400 depending on the server
    Then assert responseStatus == 200 || responseStatus == 400
    And match response.errors == '#[_ > 0]'

  @positive @op=deleteBook
  Scenario: Mutation deleteBook - success
    # source: Mutation deleteBook
    Given path 'graphql'
    And text query =
    """
      mutation DeleteBook($id: ID!) {
        deleteBook(id: $id)
      }
    """
    And def variables = { id: 'sample' }
    And request { query: '#(query)', variables: '#(variables)' }
    When method post
    Then status 200
    And match response.errors == '#notpresent'
    And match response.data.deleteBook == '##boolean'

  @negative @op=deleteBook
  Scenario: Mutation deleteBook - missing required variable id
    # source: Mutation deleteBook
    Given path 'graphql'
    And text query =
    """
      mutation DeleteBook($id: ID!) {
        deleteBook(id: $id)
      }
    """
    And request { query: '#(query)' }
    When method post
    # GraphQL over HTTP: request errors arrive as 200 or 400 depending on the server
    Then assert responseStatus == 200 || responseStatus == 400
    And match response.errors == '#[_ > 0]'
