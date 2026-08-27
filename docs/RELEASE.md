# Karate Test Management 2.0 Release Runbook

This runbook is for the single stable Marketplace release of version 2.0.0.
Do not publish until every item below is complete.

## Pre-publish checks

1. Confirm the archived rollback package exists locally:
   `karate-test-generator-1.5.2.vsix`
2. Verify its SHA-256 checksum is
   `d7c9787fe86474dda489e1230cb0c2afc4cbd8b35ba36bb5a19d3fac68fd4c9e`.
3. Confirm Vercel Hobby project `karate-telemetry-collector` has its free
   Vercel KV/Upstash integration providing `KV_REST_API_URL` and
   `KV_REST_API_TOKEN`. Confirm the endpoint rejects malformed events and
   accepts a valid redacted activation event.
4. Confirm `karateDsl.telemetry.endpoint` remains set to the official deployed
   HTTPS URL for release validation. Telemetry remains off by default and the
   extension must continue to activate and run commands if that endpoint is
   unavailable.
5. Run `npm run verify`, then package a fresh VSIX with `npx vsce package`.
6. Run the extension-host suite in a desktop environment where Electron starts
   successfully. The current automation host can verify the package but aborts
   before suite execution, so it is not evidence for this check.
7. Manually smoke-test the six management areas in light and dark VS Code
   themes: Overview, Test Library, Runs, Quality, Create & Import, Operations.

## Publish and monitor

1. Publish the verified 2.0.0 VSIX to the stable Marketplace channel.
2. Publish the 2.0.0 release notes with the migration, data-location, and
   telemetry privacy notes.
3. For the first 48–72 hours, alert on every error event. Treat
   `migration_failed` as the highest priority and review shell and command
   error rates by area each day.

## Rollback rehearsal

1. In a disposable VS Code profile, install the archived 1.5.2 VSIX.
2. Open a migrated workspace and confirm `.karate-test-history/` is still
   present and read-only evidence; v2 data stays in
   `.karate-test-management/`.
3. Use VS Code's **Extensions: Install Another Version** to return from 2.0.0
   to 1.5.2, then restart the window.
4. Confirm existing feature files and legacy history remain intact. Do not
   delete `.karate-test-management/`; it is the v2 audit trail and is
   Git-tracked entity data.
5. If rollback is required after publish, choose the pre-agreed hotfix path:
   revert-and-patch for a release regression, or forward-fix for a contained
   defect. Tell affected users to install 1.5.2 while the hotfix is prepared.
