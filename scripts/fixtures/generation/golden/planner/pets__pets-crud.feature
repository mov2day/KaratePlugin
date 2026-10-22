Feature: Pets API - CRUD lifecycle
  Generated from petstore (openapi)

  Background:
    * url baseUrl
    * callonce read('classpath:common/auth.feature')

  @ignore @positive @op=createPet @domain=pets @crud @lock=pets
  Scenario: Pets lifecycle - create, read, update, delete
    # Draft: DELETE /pets/{petId}: Requires apiKeyAuth; common/auth.feature configures bearerAuth
    # source: POST /pets
    # Covers: GET /pets/{petId}, PUT /pets/{petId}, DELETE /pets/{petId}
    * def payload = karate.copy(read('classpath:data/pets.json')['createPet'])
    * set payload.name = 'Buddy-' + karate.uuid()
    Given path 'pets'
    And request payload
    When method post
    Then status 201
    And match response == read('classpath:schemas/pets.json')
    * def petId = response.id
    Given path 'pets', petId
    When method get
    Then status 200
    And match response == read('classpath:schemas/pets.json')
    And match response.name == payload.name
    * def updatePayload = karate.copy(read('classpath:data/pets.json')['updatePet'])
    * set updatePayload.name = 'Buddy-' + karate.uuid()
    Given path 'pets', petId
    And request updatePayload
    When method put
    Then status 200
    And match response == read('classpath:schemas/pets-update-pet.json')
    And match response.name == updatePayload.name
    Given path 'pets', petId
    When method delete
    Then status 204
    Given path 'pets', petId
    When method get
    Then status 404
