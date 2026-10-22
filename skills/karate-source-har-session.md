---
name: karate-source-har-session
description: Convert captured HAR or recorded session traffic to Karate v2 scenarios using only evidenced requests and values
---
The capture is the only evidence. Convert what was observed; add no endpoints, headers or fields.

## Selection and order
- Keep API calls (XHR/fetch, JSON or form bodies). Drop static assets, analytics, fonts, images and preflight OPTIONS.
- Keep the observed order. One scenario per user flow; repeated identical calls collapse into one step.
- Name scenarios after the flow, unique per feature.

## Dynamic values
Values that differ between runs must not be hard-coded: ids, tokens, timestamps, nonces, session cookies.
- Server-generated id in a later request: capture it from the earlier response.
- Client-generated unique value: `karate.uuid()` or `karate.faker.*`.
```gherkin
Background:
  * url baseUrl

Scenario: Create then fetch an order
  Given path 'orders'
  And request { sku: 'A-100', qty: 2 }
  When method post
  Then status 201
  And match response == { id: '#string', sku: 'A-100', qty: 2 }
  * def orderId = response.id

  Given path 'orders', orderId
  When method get
  Then status 200
  And match response.id == orderId
```
- Assert the observed status. Assert body fields as markers (`#string`, `#number`, `#uuid`) unless the value is stable and meaningful.
- Large ids beyond 2^53: keep as strings.

## Headers, cookies and secrets
- Drop browser noise (User-Agent, Sec-*, Accept-Encoding, Host, Content-Length, Origin, Referer).
- Keep meaningful business headers (Content-Type, Accept, custom X-*).
- Authorization, Cookie, Set-Cookie and any token or password: replace with `karate.sysenv(...)` or a config variable; never copy the captured value.
- Host and scheme become `url baseUrl`; only the path remains in the scenario.

## Unsupported or ambiguous
WebSocket, binary uploads, server-sent events, requests whose response was not captured: skip the step and leave a `# NOT CAPTURED: <reason>` comment. Use `@ignore` on a scenario that cannot be completed from evidence.

## Rules
- V2-SEC-001: captured credentials are never emitted.
```gherkin
# BAD
* header Authorization = 'Bearer eyJhbGciOiJIUzI1NiJ9abc'
# GOOD
* header Authorization = 'Bearer ' + karate.sysenv('SESSION_TOKEN')
```
- V2-NUM-001: captured ids above 2^53-1 are quoted strings.
- V2-DUP-001: de-duplicate repeated flows; scenario names stay unique.
