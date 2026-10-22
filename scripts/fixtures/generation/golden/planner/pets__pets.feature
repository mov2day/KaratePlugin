Feature: Pets API
  Generated from petstore (openapi)

  Background:
    * url baseUrl
    * callonce read('classpath:common/auth.feature')

  @positive @op=listPets @domain=pets
  Scenario: List all pets - returns 200
    # source: GET /pets
    Given path 'pets'
    And param limit = 10
    When method get
    Then status 200
    And match each response == read('classpath:schemas/pets.json')

  @positive @op=createPet @domain=pets
  Scenario: Create a pet - returns 201
    # source: POST /pets
    * def payload = karate.copy(read('classpath:data/pets.json')['createPet'])
    * set payload.name = 'Buddy-' + karate.uuid()
    Given path 'pets'
    And request payload
    When method post
    Then status 201
    And match response == read('classpath:schemas/pets.json')

  @edge @op=createPet @domain=pets
  Scenario Outline: Create a pet - accepts every allowed value of 'status'
    # source: POST /pets
    * def payload = karate.copy(read('classpath:data/pets.json')['createPet'])
    * set payload.name = 'Buddy-' + karate.uuid()
    * set payload.status = statusValue
    Given path 'pets'
    And request payload
    When method post
    Then status 201
    And match response == read('classpath:schemas/pets.json')

    Examples:
      | statusValue |
      | available   |
      | pending     |
      | sold        |

  @positive @op=getPetById @domain=pets
  Scenario: Get pet by ID - returns 200
    # source: GET /pets/{petId}
    # Assumes a resource with this id exists in the target environment
    * def petId = 1
    Given path 'pets', petId
    When method get
    Then status 200
    And match response == read('classpath:schemas/pets.json')

  @negative @op=getPetById @domain=pets
  Scenario: Get pet by ID - returns 404 for an unknown id
    # source: GET /pets/{petId}
    * def petId = 999999999
    Given path 'pets', petId
    When method get
    Then status 404

  @positive @op=updatePet @domain=pets
  Scenario: Update a pet - returns 200
    # source: PUT /pets/{petId}
    # Assumes a resource with this id exists in the target environment
    * def petId = 1
    * def payload = karate.copy(read('classpath:data/pets.json')['updatePet'])
    * set payload.name = 'Buddy-' + karate.uuid()
    Given path 'pets', petId
    And request payload
    When method put
    Then status 200
    And match response == read('classpath:schemas/pets-update-pet.json')

  @edge @op=updatePet @domain=pets
  Scenario Outline: Update a pet - accepts every allowed value of 'status'
    # source: PUT /pets/{petId}
    # Assumes a resource with this id exists in the target environment
    * def petId = 1
    * def payload = karate.copy(read('classpath:data/pets.json')['updatePet'])
    * set payload.name = 'Buddy-' + karate.uuid()
    * set payload.status = statusValue
    Given path 'pets', petId
    And request payload
    When method put
    Then status 200
    And match response == read('classpath:schemas/pets-update-pet.json')

    Examples:
      | statusValue |
      | available   |
      | pending     |
      | sold        |

  @ignore @positive @op=uploadPetPhoto @domain=pets
  Scenario: Upload a pet photo
    # Draft: Unsupported request body content type: multipart/form-data (multipart form data is not generated)
    # source: POST /pets/{petId}/photo
    * def petId = 1
    Given path 'pets', petId, 'photo'
    When method post
    Then status 200
