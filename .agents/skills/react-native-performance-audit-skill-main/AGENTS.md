# AGENTS.md — React Native Performance Audit Skill

This file tells any AI coding agent (Claude Code, Cursor, Windsurf, Antigravity, Cline, or any agent-based IDE) how to behave when the **react-native-performance-audit** skill is active. Read it together with `SKILL.md`.

> **Scope:** React Native projects only (a `package.json` with `react-native`, optionally Expo). Covers JS/TS app code plus the `android/` and `ios/` native projects where they affect performance.

---

## Core Behavior When This Skill Is Active

1. **Find the real bottleneck — do not blindly optimize.**
   Every fix must trace back to a concrete, named cause (a heavy `renderItem`, an unstable prop, a missing cleanup, a blocking startup call). Do not sprinkle `useMemo`/`useCallback`/`React.memo` "just in case." Premature memoization is a defect, not a fix.

2. **Never claim performance is fixed without validation.**
   A change that "looks faster" is not proof. Validate what you can: `npm run typecheck`, `npm run lint`, `npm test`, a release build, and — when available — a profiler trace (React DevTools Profiler, Hermes profiler, Android Studio Profiler, Xcode Instruments). If you cannot run a check, give the exact command and mark the result **"unverified until run."**

3. **Always separate debug-mode from release-mode performance.**
   Debug JS is dramatically slower than release (no Hermes optimizations, dev warnings, remote debugging). Never judge final performance from a debug build. State clearly which mode each observation came from, and prefer release builds for final verdicts.

4. **Make surgical edits only.**
   Touch the minimum needed to fix the identified bottleneck. No refactors, no reformatting, no dependency churn, no architecture changes "while you're in there." Follow the project's existing patterns (TS vs JS, state library, navigation library, list component).

5. **Protect the project.**
   Do not remove business logic, change app behavior, break Android/iOS builds, touch signing configs, or change package name / bundle identifier. Do not remove existing analytics, crash reporting, or monitoring without explicit approval.

6. **Be careful and honest with dependencies and Hermes.**
   Do not add heavy libraries (e.g. FlashList, an image cache, a state library) without a measured reason — and explain the trade-off. Do not blindly enable or disable Hermes; check the RN version and platform support first.

7. **Prefer small, measurable wins over risky rewrites.**
   A stabilized `renderItem` plus a `keyExtractor` plus correct list-window tuning beats "rewrite the screen." Stage changes so each can be measured and reverted independently.

---

## Files To Read Before Editing

```
package.json
yarn.lock | package-lock.json | pnpm-lock.yaml | bun.lockb
app.json | app.config.js
index.js | index.ts
App.js | App.tsx
metro.config.js
babel.config.js
tsconfig.json
src/navigation/*
src/screens/*        (focus on the reported slow screen)
src/components/*      (focus on heavy / list-row components)
src/store/*          (state management)
src/hooks/*
src/services/*
android/app/build.gradle
android/gradle.properties
ios/Podfile
```

---

## Decision Order (Always)

```
1. Confirm RN project + detect RN version, Expo SDK, package manager,
   state library, navigation library, list components, native modules.
2. Reproduce / locate the bottleneck: which screen, which action, which
   platform, debug vs release, low-end device or not.
3. Categorize: startup | rendering | lists | images | state | navigation |
   animations | memory | native module | bundle size | release-build issue.
4. Present a short fix plan (issues, files affected, strategy, test plan, risk)
   BEFORE editing.
5. Apply focused, safe fixes that match project conventions.
6. VALIDATE: typecheck + lint + tests + release build where possible +
   profiler trace where available. Mark anything you couldn't run.
7. Report using SKILL.md Output Format (Summary, Issues Found w/ severity,
   Files Changed, Fixes Applied, Validation, Manual Testing Steps,
   Remaining Risks, Next Steps) — client-ready.
```

---

## Tool / Environment Specific Guidance

- **Claude Code:** Read files with Read/Grep before editing. Run lint/typecheck/test/builds via Bash. Use plan-first (EnterPlanMode) before broad changes; present the fix plan, then apply.
- **Cursor / Windsurf / Antigravity / Cline:** Open and read every file in "Files To Read" before proposing edits. Present a diff plus the validation commands in the same response. Use the matching file in `prompts/` as a starting point.
- **Agents without shell access:** Produce exact edits + copy-paste validation/build commands, and mark results **"needs user verification."**

---

## Hard Rules (Do Not Violate)

- Do **not** optimize without naming the bottleneck first.
- Do **not** overuse `useMemo` / `useCallback` / `React.memo`, or add them without a measured reason.
- Do **not** swap FlatList → FlashList (or add any heavy library) without explaining why and measuring the bottleneck first.
- Do **not** blindly enable/disable Hermes — check RN version and platform support.
- Do **not** claim performance is fixed without testing; do **not** judge final performance from a debug build.
- Do **not** remove business logic or change app behavior without permission.
- Do **not** break Android or iOS builds, change signing configs, or modify package name / bundle identifier.
- Do **not** remove existing analytics, crash reporting, or monitoring without approval.
- Do **proceed** with documented best-practice assumptions when info is sufficient; ask only blocking questions.

---

## Definition of Done

Complete only when:
- The reported bottleneck is identified and traced to specific code, **and**
- Fixes are surgical, match project conventions, and preserve behavior, **and**
- Validation has been run (typecheck/lint/test/release build/profiler where possible) or unrun checks are explicitly flagged "unverified until run," **and**
- The report includes Summary, Issues Found (with severity), Files Changed, Fixes Applied, Validation, Manual Testing Steps, Remaining Risks, and Next Steps — and is client-ready.
