# Karate Scout

**Sign in normally, show Scout how your app works, and watch it build and test the journey.**

Open **Karate Scout: Teach a Browser Journey** from the Command Palette, or choose **Scout** in Test Management. **Create & Import → Teach a browser journey** opens the same workspace.

## Teach your first journey

1. Choose installed **Google Chrome** or **Microsoft Edge**, enter your test application's URL, and select **Open browser**. Scout opens a dedicated profile for that application origin. Optional `karateDsl.scout.chromePath` and `karateDsl.scout.edgePath` settings select the actual installed executable.
2. Sign in normally. Complete redirects, login popups, MFA, passkeys, and company prompts yourself. Do not start teaching until you reach your application.
3. Add any separate API origins to the connection settings; exclude identity-provider origins. Select **Start teaching**, demonstrate one focused REST/JSON journey, and select **Stop teaching**.
4. Inspect the live action/API map and inferred data links. Confirm the baseline HTTP statuses and add business expectations using response JSON pointers, such as `/orderCount` **At most** `1`. Resolve any ambiguous data links.
5. Before state-changing exploration, provide a reset page URL that prepares fresh test data, or explicitly confirm that the journey creates fresh data on every run. Reset pages are navigated in the connected browser before every variation. Keep exploration on a test environment.
6. Select **Propose variations**. Review and confirm the expected behavior of each proposed variation, discard any that do not apply, then run the confirmed variations. A failed executed assertion creates a branch with request/response evidence. A suggestion alone is never a finding.
7. Select **Save Karate suite**. Review the generated files, configure supported API authentication if needed, and select **Verify in Karate**.

AI proposals are optional. When enabled, sanitized captured actions and API data are sent to the existing selected AI provider. The browser bridge and journey storage require no hosted Scout service. Use the local provider option if application data must remain on your computer.

## Existing signed-in tabs and company browsers

Choose **Connect my signed-in tab** when the application needs an existing profile or company-managed browser. Where company policy permits:

1. Select **Get companion files** and choose a folder.
2. In the selected browser, open `chrome://extensions` or `edge://extensions`. Enable Developer mode and use **Load unpacked** to choose that folder. Managed deployment must use your administrator's approved extension process.
3. In Scout, choose the same browser, application URL, and permitted origins, then select **Get pairing details**.
4. Open the companion from the browser toolbar **on your signed-in application tab**. Paste the local endpoint and temporary key. Select **Connect this tab**.
5. Return to Scout and start teaching. The pairing key expires after five minutes and is replaced by an in-memory session credential after one successful pairing.

Opening `popup.html` as a local file is only a visual preview; it cannot connect a browser tab. The companion must be loaded as a browser extension.

The local bridge binds only to `127.0.0.1`, authenticates every call, and accepts the paired extension origin. It scopes capture and interaction to selected application origins. It does not offer an arbitrary script execution API. **Disconnect browser** detaches the companion while leaving your existing tab and sign-in intact. **Stop teaching** stops recording but retains the connection for exploration; disconnect when you finish working with the journey. Closing the tab, revoking access, or losing the connection is reported in Scout.

If browser policy refuses automation, debugging, or extension access, Scout reports the failure. It does not change browser policies or try another access route. Ask your administrator about permitted access, or use HAR import if export is allowed.

## Authentication and verification

| Label | Evidence |
|---|---|
| Verified in browser | The taught baseline's confirmed expectations passed in the selected browser session. Individual variation outcomes remain separate. |
| Verified in Karate | All exported, confirmed scenarios passed independently in Karate. Draft or skipped scenarios do not establish complete verification. |
| Authentication setup required | Independent authentication has not been configured or established. Browser SSO is not copied to the suite. |

If navigation leaves the application or an unexpected `401`/`403` occurs, Scout pauses for sign-in/access review rather than reporting an application defect. Reauthenticate in the selected browser and resume. The interrupted variation restarts from its reset/fresh-data checkpoint. Missing controls, unavailable responses, and browser-side validation without an API response are **inconclusive**.

Passwords, MFA fields, common credential keys, authorization/cookie headers, recognized sign-in routes, and excluded origins are filtered from journey recordings and AI context. Add `data-scout-private` to application elements whose actions must be omitted. Review captured data before sharing: custom sensitive fields and unusual identity-provider routes need explicit application-origin/exclusion choices. Dedicated profiles retain their sign-in in VS Code's extension storage; companion sign-in remains in the user's browser. Pairing credentials are never saved in journey files.

For an independently runnable API suite, set `karateDsl.scout.authFixture` to an application's **supported** Karate authentication helper, for example `classpath:auth/test-account.feature`. The helper returns `headers` and/or `cookies`, and may return an `origins` map. Read its credentials from your secret manager or environment; do not paste captured browser credentials. An optional `karateDsl.scout.resetFixture` prepares data before each scenario. Mark authentication as unnecessary only for an API that truly supports unauthenticated execution.

Generated suites contain `journey.feature`, inert JSON test data, reusable setup/reset helpers, and a README. Response IDs are linked into subsequent bodies, paths, and query parameters. Unconfirmed expectations, ambiguous bindings, missing evidence, or redacted input create draft scenarios tagged `@ignore`. Changing journey settings requires a fresh export before independent verification. Saving and reopening `.scout.json` files preserves the journey as a draft and clears imported verification claims; **Reconnect this journey** uses the recorded browser and origin.

Browser-bound/device-bound sessions may never be portable to independent Karate execution. CI readiness requires a passing independent run with authentication appropriate for that CI environment; the browser label alone makes no CI claim.

## Sample checkout

Select **Try the sample shop**. Start teaching, change quantity to `2`, create a cart, and check out once. Stop and confirm the observed baseline. The sample supplies a local reset page and needs no authentication.

Propose variations. For **Repeat Check out**, confirm HTTP `200` with `/orderCount` **At most** `1`. The sample intentionally creates a duplicate order. Scout's executed assertion detects it, and the generated Karate scenario reproduces it. Boundary variations also expose the sample's intentionally missing quantity validation.

## HAR fallback and v1 limits

HAR import supports approved exports from Firefox, Safari, specialized browsers, and policy-restricted environments. Select only application API origins. Imported output is an **inferred API sequence**: it does not establish browser actions, reusable authentication, or verified tests. Authentication headers are discarded and sensitive bodies are redacted. Review and confirm expectations before enabling API scenarios.

This release focuses on one REST/JSON journey, main-document click/fill/select/check actions, and bounded baseline/required-field/numeric-boundary/repeat variations. Actions inside frames, complex drag/drop, native application dialogs, and browser journeys spanning unrelated application tabs are outside v1. Authentication popups can be completed manually before teaching. Binary/large/unavailable response bodies produce limitations. Live capture is capped at 300 requests, 500 actions, and 256 KiB per body, with a bounded session buffer.

## Validation

- `npm run test:scout`: privacy, scope, dependencies, draft generation, expectation/reset guards, expiry/resume, cancellation, reconnect, authenticated companion protocol, and lost connection handling.
- `npm run test:scout:browsers`: actual installed Chrome and Edge, disposable profiles, local sign-in/MFA fixture, recording/replay, refresh/logout/session expiry, and generated Karate tests failing before the checkout fix and passing afterward. Requires Java and installed browsers.
- `npm run test:scout:companion`: companion integration using disposable extension-testing profiles. Testing flags belong only to the test harness and are never used by Scout's connection adapters.
- `npm run test:scout:ui`: browser selection, command payloads, verification labels, evidence inspection, and wide/compact screenshots in `output/playwright/scout`.
- `npm run verify`: existing extension regression checks plus Scout's model/session/protocol tests, build, types, lint, and package checks.

Real company SSO, passkeys, device compliance, and managed-browser permission policies require a managed-browser pilot before advertising organization-wide compatibility. Local sign-in fixtures cannot establish those guarantees.

References: [Playwright browsers](https://playwright.dev/docs/browsers), [Chrome default-profile debugging restrictions](https://developer.chrome.com/blog/remote-debugging-port), [Chrome debugger extension permissions](https://developer.chrome.com/docs/extensions/reference/api/debugger), [Microsoft token protection](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-token-protection).
