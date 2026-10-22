Feature: System API
  Generated from petstore (openapi)

  Background:
    * url baseUrl

  @positive @op=getHealth @domain=system
  Scenario: Health check (public) - returns 200
    # source: GET /health
    Given path 'health'
    When method get
    Then status 200
    And match response == read('classpath:schemas/system.json')
