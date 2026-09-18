# Antigravity — Starter Prompt

**Setup:** place `AGENTS.md` (ideally the whole skill folder) at your project root — Antigravity reads `AGENTS.md` as its behavior contract. Then use a prompt below.

## Full audit
```
Follow the React Native Performance Audit Skill in this repo (SKILL.md + AGENTS.md).

Read package.json, App.tsx, src/navigation, src/screens, src/components, and
src/store before editing. Detect RN version, package manager, state/navigation
libs, list components, and native modules.

Locate the real bottleneck (name the screen/action; note debug vs release),
present a short fix plan first, then apply only safe, surgical fixes that preserve
behavior. Validate with typecheck, lint, tests, and a release build where possible.
Finish with a client-ready report (Summary, Issues+severity, Files Changed, Fixes,
Validation, Manual Testing Steps, Remaining Risks, Next Steps).

Constraints: no over-memoization, no FlatList→FlashList swap without measuring, no
blind Hermes toggle, no removing analytics/monitoring, no behavior changes.
```

## Targeted: slow list
```
Follow the RN Performance Audit Skill. The <ScreenName> FlatList stutters on scroll
in release. Use checklists/flatlist-checklist.md. Stabilize renderItem +
keyExtractor, memoize the row, use thumbnails, tune list windowing. Validate and
report. Only consider FlashList if FlatList is still the bottleneck after measuring.
```

## Targeted: navigation perf
```
Follow the RN Performance Audit Skill. Navigation transitions feel slow. Audit
screen mount logic, focus effects refiring API calls, expensive headers, large
route params, and lazy-loading. Apply safe fixes, validate, and report.
```

> If the agent can't run a shell command, have it output the exact validation commands and mark results "unverified until run." Review all edits against the hard rules in AGENTS.md.
