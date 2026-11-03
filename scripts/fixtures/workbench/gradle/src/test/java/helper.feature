Feature: Java helper

Scenario: helper interop
  * def Util = Java.type('com.example.Util')
  * def greeting = Util.greet('Ada Lovelace')
  * match greeting == 'hi ada-lovelace'
