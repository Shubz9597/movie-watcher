# Claude Code — Starter Prompt

Paste one of these into Claude Code. The skill auto-activates by `name`/`description`, but naming it makes intent explicit.

## Full audit
```
Use the React Native Performance Audit Skill (follow SKILL.md + AGENTS.md).

Audit this React Native app for performance. Read package.json, App.tsx,
src/navigation, src/screens, src/components, and src/store first. Detect RN
version, package manager, state/navigation libs, list components, and native
modules.

Then:
1. Locate the real bottleneck (name the screen/action; note debug vs release).
2. Present a short fix plan BEFORE editing (issues, files, strategy, tests, risk).
3. Apply only safe, surgical fixes that preserve behavior.
4. Validate: run typecheck, lint, tests, and a release build where possible.
5. Give a client-ready report (Summary, Issues+severity, Files Changed, Fixes,
   Validation, Manual Testing Steps, Remaining Risks, Next Steps).

Do not overuse memoization, swap FlatList→FlashList without measuring, toggle
Hermes blindly, or remove analytics/monitoring.
```

## Targeted: slow list
```
Use the React Native Performance Audit Skill. The <ScreenName> FlatList stutters
on scroll (low-end Android, reproduces in release). Read the screen + row
component, follow checklists/flatlist-checklist.md, fix the safe issues
(stable renderItem/keyExtractor, memoized row, thumbnails, list-window tuning),
validate, and report. Only suggest FlashList if FlatList is still the bottleneck
after measuring.
```

## Targeted: slow startup
```
Use the React Native Performance Audit Skill. Cold start is slow. Audit App.tsx,
root providers, startup API calls, storage reads, and RootNavigator. Defer
non-critical work, keep behavior identical, validate in a RELEASE build, and
report cold-start before/after.
```

## Targeted: memory leak
```
Use the React Native Performance Audit Skill. Memory grows as I navigate
between screens. Follow checklists/memory-leak-checklist.md: audit useEffect
cleanup, listeners, timers, subscriptions (WebSocket/Firebase/navigation),
async requests, and media resources. Fix leaks, validate, and report.
```

> Tip: in Claude Code, let it run `npm run typecheck`, `npm run lint`, `npm test`, and `./gradlew assembleRelease` via Bash so the report's Validation section is real, not assumed.
