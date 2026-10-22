---
name: karate-assertions-schemas
description: Karate v2 match and schema patterns - full-response schemas, optional fields, within, match each, soft assertions, failure labels
---
Assert status first, then the body shape. Prefer `match` over `assert` (it prints expected vs actual); use `assert` only for numeric comparisons.

## Schemas
Match the whole response with markers instead of picking fields one by one.
```gherkin
Then status 200
And match response ==
  """
  {
    id: '#number',
    name: '#string',
    email: '#regex .+@.+',
    nickname: '##string',
    tags: '#[] #string',
    address: '#object'
  }
  """
```
- `##string` means the key may be absent or null; `##null` matches both.
- `#null` needs the key present; `#notpresent` needs it absent; `#present` accepts any value.
- Lists: `'#[]'`, `'#[10]'`, `'#[_ > 5]'`, `'#[] #object'`.
- Constraints: `'#number? _ > 0'`, `'#string? _.length > 0'`, `'#? _ >= 18 && _ <= 100'`.
- Other fields of the same object: `'#? _ == $.celsius * 1.8 + 32'`.

## Reusable schemas
Compose with `#(name)`; use a bare name after `#[]`.
```gherkin
* def itemSchema = { id: '#number', name: '#string' }
* def orderSchema = { orderId: '#number', items: '#[] itemSchema' }
* match response == orderSchema
* match each response.items == itemSchema
```
An optional nested schema must be paren-wrapped so `##` survives the `def`:
`* def s = ({ details: '##(detailsSchema)' })`.

## Subsets, ranges, lists
- `match response contains { id: 1 }` for a subset; `contains only`, `contains any`, `!contains` for lists.
- `match each response contains { id: '#number' }` checks every element.
- Ranges: `match response.score within { low: 0, high: 100 }` and `!within`.

## Failure output
Every `match` reports all mismatching paths in one diff. A comment directly above a `match` or `assert` becomes its failure label.
```gherkin
# order total must equal the sum of items
* match response.total == expectedTotal
```
Soft assertions collect several failures in one run; they are restored at scenario end:
```gherkin
* configure continueOnStepFailure = true
* match response.name == 'Alice'
* match response.age == 30
* configure continueOnStepFailure = false
```

## Rules
- V2-ASSERT-001: every scenario that calls `method` asserts the status.
```gherkin
# BAD
When method get
# GOOD
When method get
Then status 200
```
- V2-ASSERT-002: a 2xx scenario also asserts the body.
```gherkin
# BAD: only status
Then status 200
# GOOD
Then status 200
And match response == { id: '#number', name: '#string' }
```
- V2-NUM-001: integers above 2^53-1 are quoted strings.
```gherkin
# BAD
* def id = 9007199254740993
# GOOD
* def id = '9007199254740993'
```
