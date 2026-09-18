# Windsurf — Starter Prompt

**Setup:** copy `.windsurfrules` to your project root (or paste its contents into Windsurf's workspace/global rules). Then use a prompt below in Cascade.

## Full audit
```
Follow the React Native Performance Audit Skill (SKILL.md + AGENTS.md / .windsurfrules).

Open and read package.json, App.tsx, src/navigation, src/screens, src/components,
and src/store before editing. Detect RN version, package manager, state/navigation
libs, list components, and native modules.

Locate the real bottleneck, present a short fix plan FIRST, then apply only safe,
surgical fixes that preserve behavior. Show the diff plus the validation commands
(typecheck, lint, test, release build) together. End with a client-ready report:
Summary, Issues+severity, Files Changed, Fixes, Validation, Manual Testing Steps,
Remaining Risks, Next Steps.

Don't overuse memoization, swap FlatList→FlashList without measuring, toggle Hermes
blindly, or remove analytics/monitoring.
```

## Targeted: slow startup
```
Follow the RN Performance Audit Skill. Cold start is slow. Audit App.tsx, root
providers, startup API calls, storage reads, and RootNavigator. Defer non-critical
work, keep behavior identical, validate in a RELEASE build, and report cold-start
before/after.
```

## Targeted: memory leak
```
Follow the RN Performance Audit Skill. Memory climbs as I navigate. Use
checklists/memory-leak-checklist.md to audit useEffect cleanup, listeners, timers,
subscriptions, async requests, and media resources. Propose the fixes as a diff and
tell me how to confirm with the profiler.
```

> Have Cascade read the target files first, then propose edits. Review diffs before applying — AGENTS.md / .windsurfrules define the non-negotiables.
