# SYNTAX TEST "source.karate-dsl" "Karate grammar"
# a comment
# <- source.karate-dsl comment.line.number-sign.karate
@smoke @env=dev
# <- source.karate-dsl entity.name.tag.karate
Feature: Users
# <- source.karate-dsl keyword.other.section.karate

  Background:
  # ^^^^^^^^^^ source.karate-dsl keyword.other.section.karate
    * url 'http://localhost'
    # <- source.karate-dsl keyword.control.step.karate
    #  ^^^ source.karate-dsl support.function.step.karate
    #      ^^^^^^^^^^^^^^^^^ source.karate-dsl string.quoted.single.karate

  Scenario: get user
    Given path 'users', 1
    #     ^^^^ source.karate-dsl support.function.step.karate
    When method get
    Then status 200
    * match response.id == 1
    #     ^^^^^ source.karate-dsl support.function.step.karate
    #                   ^^ source.karate-dsl keyword.operator.match.karate
    * match response contains only { id: '#number', name: '#string' }
    #                 ^^^^^^^^^^^^^ source.karate-dsl keyword.operator.match.karate
    * match each response == { id: '#number' }
    * def x = karate.get('foo')
    #         ^^^^^^^^^ source.karate-dsl support.function.builtin.karate
    * def y = read('data.json')
    * def z = { a: '#(x)', b: '##(y)' }
    #               ^^^^ source.karate-dsl variable.other.embedded.karate

  Scenario Outline: many
  # ^^^^^^^^^^^^^^ source.karate-dsl keyword.other.section.karate
    * def n = <id>
    Examples:
      | id |
      # <- source.karate-dsl punctuation.separator.table.karate
      | 1  |
