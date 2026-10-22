Feature: Petstore Secured
  Auto-generated Karate tests from OpenAPI specification

  @system
  Scenario: Health check (public)
    Given path '/health'
    When method GET
    Then status 200
    And match response contains { status: '#notnull' }

  @system
  Scenario: Health check (public) - Method Not Allowed
    # Verify 405 when using wrong HTTP method (DELETE)
    Given path '/health'
    When method DELETE
    Then status 405

  @system
  Scenario: Health check (public) - Unauthorized Access
    # Verify 401 when no authentication is provided
    Given path '/health'
    And header Authorization = ''
    When method GET
    Then status 401

  @pets
  Scenario: Upload a pet photo
    Given path '/pets/{petId}/photo'
    And def petId = 123
    When method POST
    Then status 200
    And match response contains { url: '#notnull' }

  @pets
  Scenario: Upload a pet photo - Invalid Request Body
    # Verify 400 when request body is invalid
    Given path '/pets/{petId}/photo'
    And request { invalid: true }
    When method POST
    Then status 400

  @pets
  Scenario: Upload a pet photo - Not Found
    # Verify 404 for non-existent resource
    Given path '/pets/99999999/photo'
    When method POST
    Then status 404

  @pets
  Scenario: Upload a pet photo - Method Not Allowed
    # Verify 405 when using wrong HTTP method (GET)
    Given path '/pets/{petId}/photo'
    When method GET
    Then status 405

  @pets
  Scenario: Upload a pet photo - Empty Request Body
    # Verify behavior with empty request body
    Given path '/pets/{petId}/photo'
    And request {}
    When method POST
    Then assert responseStatus == 400 || responseStatus == 422

  @pets
  Scenario: Upload a pet photo - Unauthorized Access
    # Verify 401 when no authentication is provided
    Given path '/pets/{petId}/photo'
    And header Authorization = ''
    When method POST
    Then status 401

  @pets
  Scenario: Upload a pet photo - SQL Injection in Path
    # Verify protection against SQL injection in path parameters
    Given path '/pets/1' OR '1'='1/photo'
    When method POST
    Then assert responseStatus == 400 || responseStatus == 404

  @pets
  Scenario: List all pets
    Given path '/pets'
    And param 'limit' = 10
    When method GET
    Then status 200

  @pets
  Scenario: List all pets - Method Not Allowed
    # Verify 405 when using wrong HTTP method (DELETE)
    Given path '/pets'
    When method DELETE
    Then status 405

  @pets
  Scenario: List all pets - Unauthorized Access
    # Verify 401 when no authentication is provided
    Given path '/pets'
    And header Authorization = ''
    When method GET
    Then status 401

  @pets
  Scenario: Create a pet
    Given path '/pets'
    And request
    """
{
  "name": "Buddy",
  "tag": "dog",
  "status": "available"
}
    """
    When method POST
    Then status 201
    And match response contains { id: '#notnull', name: '#notnull', tag: '#notnull', status: '#notnull' }

  @pets
  Scenario: Create a pet - Invalid Request Body
    # Verify 400 when request body is invalid
    Given path '/pets'
    And request { invalid: true }
    When method POST
    Then status 400

  @pets
  Scenario: Create a pet - Method Not Allowed
    # Verify 405 when using wrong HTTP method (GET)
    Given path '/pets'
    When method GET
    Then status 405

  @pets
  Scenario: Create a pet - Empty Request Body
    # Verify behavior with empty request body
    Given path '/pets'
    And request {}
    When method POST
    Then assert responseStatus == 400 || responseStatus == 422

  @pets
  Scenario: Create a pet - Unauthorized Access
    # Verify 401 when no authentication is provided
    Given path '/pets'
    And header Authorization = ''
    When method POST
    Then status 401

  @pets
  Scenario: Get pet by ID
    Given path '/pets/{petId}'
    And def petId = 123
    When method GET
    Then status 200
    And match response contains { id: '#notnull', name: '#notnull', tag: '#notnull', status: '#notnull' }

  @pets
  Scenario: Get pet by ID - Not Found
    # Verify 404 for non-existent resource
    Given path '/pets/99999999'
    When method GET
    Then status 404

  @pets
  Scenario: Get pet by ID - Method Not Allowed
    # Verify 405 when using wrong HTTP method (DELETE)
    Given path '/pets/{petId}'
    When method DELETE
    Then status 405

  @pets
  Scenario: Get pet by ID - Unauthorized Access
    # Verify 401 when no authentication is provided
    Given path '/pets/{petId}'
    And header Authorization = ''
    When method GET
    Then status 401

  @pets
  Scenario: Get pet by ID - SQL Injection in Path
    # Verify protection against SQL injection in path parameters
    Given path '/pets/1' OR '1'='1'
    When method GET
    Then assert responseStatus == 400 || responseStatus == 404

  @pets
  Scenario: Update a pet
    Given path '/pets/{petId}'
    And def petId = 123
    And request
    """
{
  "name": "Buddy",
  "tag": "dog",
  "status": "available"
}
    """
    When method PUT
    Then status 200

  @pets
  Scenario: Update a pet - Invalid Request Body
    # Verify 400 when request body is invalid
    Given path '/pets/{petId}'
    And request { invalid: true }
    When method PUT
    Then status 400

  @pets
  Scenario: Update a pet - Not Found
    # Verify 404 for non-existent resource
    Given path '/pets/99999999'
    When method PUT
    Then status 404

  @pets
  Scenario: Update a pet - Method Not Allowed
    # Verify 405 when using wrong HTTP method (GET)
    Given path '/pets/{petId}'
    When method GET
    Then status 405

  @pets
  Scenario: Update a pet - Empty Request Body
    # Verify behavior with empty request body
    Given path '/pets/{petId}'
    And request {}
    When method PUT
    Then assert responseStatus == 400 || responseStatus == 422

  @pets
  Scenario: Update a pet - Unauthorized Access
    # Verify 401 when no authentication is provided
    Given path '/pets/{petId}'
    And header Authorization = ''
    When method PUT
    Then status 401

  @pets
  Scenario: Update a pet - SQL Injection in Path
    # Verify protection against SQL injection in path parameters
    Given path '/pets/1' OR '1'='1'
    When method PUT
    Then assert responseStatus == 400 || responseStatus == 404

  @pets
  Scenario: Delete a pet
    Given path '/pets/{petId}'
    And def petId = 123
    When method DELETE
    Then status 204

  @pets
  Scenario: Delete a pet - Not Found
    # Verify 404 for non-existent resource
    Given path '/pets/99999999'
    When method DELETE
    Then status 404

  @pets
  Scenario: Delete a pet - Method Not Allowed
    # Verify 405 when using wrong HTTP method (GET)
    Given path '/pets/{petId}'
    When method GET
    Then status 405

  @pets
  Scenario: Delete a pet - Unauthorized Access
    # Verify 401 when no authentication is provided
    Given path '/pets/{petId}'
    And header Authorization = ''
    When method DELETE
    Then status 401

  @pets
  Scenario: Delete a pet - SQL Injection in Path
    # Verify protection against SQL injection in path parameters
    Given path '/pets/1' OR '1'='1'
    When method DELETE
    Then assert responseStatus == 400 || responseStatus == 404
