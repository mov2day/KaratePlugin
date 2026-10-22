# Karate skills

The Karate v2 skill pack that grounds AI generation lives in [`skills/`](../../skills) at the repository root.
`skills/manifest.json` lists each skill, when it applies (source mode and task), its priority and its size budget.
Edit those files, not this folder. Each skill stays under 5,000 characters, cites the quality-gate rule IDs from
`src/generation/quality/rules.ts`, and was verified against Karate 2.1.4.
