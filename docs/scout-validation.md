# Scout preview validation — 12–13 September 2026

The implementation was tested locally with Google Chrome **152.0.7977.83**, Microsoft Edge **153.0.4234.32**, and Java 21. Tests used disposable profiles and a local checkout fixture.

| Check | Result |
|---|---|
| Dedicated Chrome and Edge | Passed: capture actions/API responses, infer cart-ID dependency, replay with fresh IDs, and report closed tabs. |
| SSO-shaped local fixture | Passed in both browsers: redirects, login popup, manual password/MFA form input exclusion, expired session pause, reauthentication resume, refresh, and logout. |
| Existing-tab companion | Passed in both actual browsers: authenticated loopback pairing, existing sign-in retained, action/network capture, browser variations, account change, and clean detach with the tab left open. |
| Seeded checkout defect | Baseline passed; repeated checkout failed the confirmed `orderCount <= 1` assertion. Both passed after the fixture's idempotency fix. |
| Generated Karate suite | Executed independently: failed on the seeded defect, then passed both scenarios after the fixture fix. Fresh cart IDs were linked during execution. |
| Independent authentication | Generated authenticated suite refused execution without an auth helper; passed with a separately configured fixture. Browser cookies were not copied into generated files. |
| Privacy and connection boundaries | Passed: sign-in capture gate, sensitive headers/body keys removed, out-of-scope origins rejected, one-time pairing key invalidated, different extension origin refused, and no arbitrary evaluation endpoint. |
| Failure classification | Passed: expired sign-in pauses; missing required bodies are inconclusive; cancellation makes no verification claim. |
| HAR fallback | Passed: base64 JSON decoding, MIME restoration, malformed timestamp rejection, failed response handling, scoped import, and draft/authentication requirements. |
| UI | Passed: browser choice and command payloads, separate browser/Karate labels, branch evidence inspection, and no horizontal overflow at 1360px and 390px. |
| Extension regression/build | `npm run verify` passed, including execution tests, AI routing, Scout model/session/bridge tests, types, lint, and package audit. Lint reports warnings and no errors. |

The companion test harness loads the extension through the browser's extension-testing interface into **temporary profiles**. Those testing flags and the test-only service-worker driver are absent from Scout's production adapters and packaged companion.

## Pilot still required

These local fixtures do not establish compatibility with a particular company's identity provider, device compliance, passkeys, conditional-access configuration, or managed extension policy. Before advertising such compatibility, run a managed-browser pilot covering policy denial, real MFA/passkeys, login popups, device-bound sessions, account switching, refresh/logout, unavailable bodies, closed tabs, and revoked debugging permissions. Firefox, Safari, frame actions, and specialized browsers remain outside live v1 support; use approved HAR exports where appropriate.

See [Scout setup](scout.md) for the runnable checks and companion installation steps. No package has been published to a marketplace.
