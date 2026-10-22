Feature: Pet Store Collection

  Background:
    * def baseUrl = 'http://localhost:8080/api/v1'
    * def authToken = 'test-token'

  Scenario: List pets
    Given url 'http://localhost:8080'
    And path 'api', 'v1', 'pets'
    And param limit = 5
    And header Accept = 'application/json'
    When method GET
    Then status 200
  Scenario: Create pet
    Given url 'http://localhost:8080'
    And path 'api', 'v1', 'pets'
    And header Content-Type = 'application/json'
    And request {
  "name": "Buddy",
  "tag": "dog"
}
    When method POST
    Then status 201