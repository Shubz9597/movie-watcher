# Cursor — Starter Prompt

**Setup:** copy `.cursor/rules/rn-performance.mdc` into your project's `.cursor/rules/` so the rule applies automatically when you touch screens, components, lists, or app entry/config files. Then paste a prompt below into Cursor chat (Agent mode).

## Full audit
```
Follow the React Native Performance Audit Skill in SKILL.md + AGENTS.md.

Read package.json, App.tsx, src/navigation, src/screens, src/components, and
src/store before proposing anything. Detect RN version, package manager,
state/navigation libs, list components, and native modules.

Then locate the real bottleneck, present a short fix plan first, and apply only
safe, surgical fixes that preserve behavior. Show me the diff plus the exact
validation commands (typecheck, lint, test, release build) in the same response.
Finish with a client-ready report.

Rules: don't overuse useMemo/useCallback/React.memo, don't swap FlatList→FlashList
without measuring, don't toggle Hermes blindly, don't remove analytics/monitoring.
```

## Targeted: slow list
```
Follow the RN Performance Audit Skill. The open FlatList screen stutters on scroll.
Use checklists/flatlist-checklist.md. Propose a diff that stabilizes renderItem +
keyExtractor, memoizes the row, uses thumbnails, and tunes list windowing — plus
the validation commands. Keep behavior identical.
```

## Targeted: re-render hunt
```
Follow the RN Performance Audit Skill. This screen re-renders too much. Identify
the unstable props / context updates causing it, propose a minimal diff (stable
props, selectors, targeted memoization where it measurably helps), and tell me
how to confirm with the React DevTools Profiler.
```

> Cursor works best when it has read the files first — ask it to open the relevant screen and its row/child components before it edits. Review the diff before accepting; the skill's hard rules in AGENTS.md are the guardrails.
