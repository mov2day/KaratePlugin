---
name: karate-business-invariants
description: Turning API descriptions, enums and examples into safe Karate v2 assertions for the enrich-business task, with the AI-proposed comment convention
---
Add a scenario or assertion only when the supplied business context justifies it. Put `# AI-proposed: <reason>` on its own line directly above every scenario you add (and above each assertion you add to an existing scenario). The reason cites the evidence, for example the description or enum it comes from. Existing scenarios, steps, tags and `# source:` comments stay exactly as they are.

## Rules
- Assert enum fields as membership in the documented values, not one specific value.
- Assert documented invariants (totals, counts, ranges, ordering a description states) and response quality (ids present, list elements in the documented shape, documented formats).
- Add state and permission scenarios only as a description states them, using documented endpoints.
- Reuse a documented example as the request body and assert the fields it implies.
- Do not assert exact message or error text, timestamps, generated ids, counts that depend on other data, or order the description does not guarantee.
- Do not add endpoints, fields, files or schemas the context does not state. Never remove, loosen or un-ignore existing content.

## Examples
Enum membership:
```gherkin
# AI-proposed: description says status is one of pending, paid, shipped
* match response.status == '#? ["pending","paid","shipped"].includes(_)'
```
Documented range:
```gherkin
# AI-proposed: quantity is documented as 1..100
* match response.quantity == '#? _ >= 1 && _ <= 100'
```
Echo of a documented example:
```gherkin
# AI-proposed: create returns the submitted name
* match response.name == payload.name
```
Sum invariant from a description:
```gherkin
# AI-proposed: description says total equals the sum of item prices
* def sum = response.items.reduce((a, i) => a + i.price, 0)
* match response.total == sum
```
Documented error shape without its text:
```gherkin
# AI-proposed: 404 documents an error object with a message
Then status 404
And match response.message == '#string'
```
A new scenario that uses a documented query parameter and enum:
```gherkin
# AI-proposed: status is a documented filter with the value paid
Scenario: filter orders by paid status
  Given path 'orders'
  And param status = 'paid'
  When method get
  Then status 200
  And match each response contains { status: 'paid' }
```
