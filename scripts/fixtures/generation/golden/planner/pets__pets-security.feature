Feature: Pets API - Security
  Generated from petstore (openapi)

  Background:
    * url baseUrl

  @security @op=listPets @domain=pets
  Scenario: List all pets - rejects an unauthenticated request with 401
    # source: GET /pets
    Given path 'pets'
    And param limit = 10
    When method get
    Then status 401

  @security @op=createPet @domain=pets
  Scenario: Create a pet - rejects an unauthenticated request with 401
    # source: POST /pets
    * def payload = karate.copy(read('classpath:data/pets.json')['createPet'])
    * set payload.name = 'Buddy-' + karate.uuid()
    Given path 'pets'
    And request payload
    When method post
    Then status 401

  @security @op=deletePet @domain=pets
  Scenario: Delete a pet - rejects an unauthenticated request with 401
    # source: DELETE /pets/{petId}
    * def petId = 1
    Given path 'pets', petId
    When method delete
    Then status 401

  @security @op=getPetById @domain=pets
  Scenario: Get pet by ID - rejects an unauthenticated request with 401
    # source: GET /pets/{petId}
    * def petId = 1
    Given path 'pets', petId
    When method get
    Then status 401

  @security @op=updatePet @domain=pets
  Scenario: Update a pet - rejects an unauthenticated request with 401
    # source: PUT /pets/{petId}
    * def petId = 1
    * def payload = karate.copy(read('classpath:data/pets.json')['updatePet'])
    * set payload.name = 'Buddy-' + karate.uuid()
    Given path 'pets', petId
    And request payload
    When method put
    Then status 401
