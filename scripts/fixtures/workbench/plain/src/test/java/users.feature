Feature: Users

Background:
  * url baseUrl

Scenario: create and fetch a user
  Given path 'users'
  And request { name: 'Ada', email: 'ada@example.com' }
  When method post
  Then status 201
  * def userId = response.id
  Given path 'users', userId
  When method get
  Then match response.name == 'Ada'
