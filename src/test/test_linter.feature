Feature: Bad Practices Validation

  # K009: File name should be 'bad-practices.feature' (This file is 'test_linter.feature')

@smoke @core # K010: Tags should be on separate line
  Scenario: Test with multiple errors # K002: Duplicate Scenario Name (used below)
Given url 'https://api.bad.com' # K001: Hardcoded URL, K006: Indentation error (0 spaces)
    And  def my_var = 123 # K007: Snake case variable
    When method GET # K006: Indentation error (4 spaces, allowed but inconsistent?) we enforce 2 or 4.
    Then status 200

  Scenario: Empty Scenario # K003: No steps
    
  Scenario: Test with multiple errors # K002: Duplicate Scenario Name
    Givenpath 'users' # K008: Typo in keyword
    When method POST
