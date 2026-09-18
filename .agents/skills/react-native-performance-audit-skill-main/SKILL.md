---
name: react-native-performance-audit
title: React Native Performance Audit Skill
description: Audit, improve, and validate React Native app performance. Use when an RN app has slow startup, laggy scrolling, FlatList/SectionList issues, unnecessary re-renders, slow navigation, heavy screens, memory leaks, large bundle size, or poor Android/iOS release performance — and you need real bottlenecks found, safe fixes applied, and results validated in release mode.
version: 1.0.0
platform: react-native
tags: [react-native, expo, performance, flatlist, rendering, re-renders, memory-leak, hermes, bundle-size, startup, navigation, profiling, audit, validation]
compatible_with: [claude-code, cursor, windsurf, antigravity, cline, generic-agent]
---

# React Native Performance Audit Skill

> **Scope:** This skill is for **React Native** apps (a JS/TS project with `package.json` containing `react-native`, optionally Expo). It covers startup, rendering, lists, images, state, navigation, animations, memory, native modules, Hermes, bundle size, and **release-build** validation. It is an audit-and-fix skill, not a rewrite tool.

## Skill Name

React Native Performance Audit Skill

## Skill Purpose

This skill helps an AI coding agent audit, improve, and validate the performance of a React Native application.

Use this skill when a React Native app has:

* Slow startup
* Laggy scrolling
* FlatList or SectionList performance issues
* Unnecessary re-renders
* Slow navigation transitions
* Heavy screens
* Memory leaks
* Large bundle size
* Poor Android or iOS release performance
* Native module bottlenecks
* Performance warnings from users, clients, QA, or production monitoring tools

The goal is not to blindly optimize everything. The goal is to **identify the real bottlenecks, apply safe fixes, and validate the result properly.**

## Supported Project Types

This skill can be used with:

* React Native CLI apps
* Expo apps
* Bare Expo apps
* Android-only React Native apps
* iOS-only React Native apps
* Cross-platform React Native apps
* TypeScript or JavaScript projects

## Input Requirements

Before starting, ask the user for any available details:

* React Native version
* Expo SDK version, if applicable
* Android/iOS target platforms
* Main performance problem
* Device where the issue happens
* Debug build or release build
* Screens affected by the issue
* Video or screenshot, if available
* Package manager: npm, yarn, pnpm, or bun
* State management library: Redux, Zustand, Context, MobX, React Query, Apollo, etc.
* Navigation library
* List components used: FlatList, SectionList, FlashList, RecyclerListView
* Native modules used: camera, maps, video, audio, BLE, payments, Firebase, push notifications, etc.

If enough information is available, continue with best-practice assumptions. **Do not block progress with unnecessary questions.**

## Files To Inspect

The AI agent should inspect these files when available:

* `package.json`
* `yarn.lock`, `package-lock.json`, `pnpm-lock.yaml`, or `bun.lockb`
* `app.json` or `app.config.js`
* `index.js` or `index.ts`
* `App.js` or `App.tsx`
* `metro.config.js`
* `babel.config.js`
* `tsconfig.json`
* `src/navigation/*`
* `src/screens/*`
* `src/components/*`
* `src/store/*`
* `src/hooks/*`
* `src/services/*`
* `android/app/build.gradle`
* `android/build.gradle`
* `android/gradle.properties`
* `ios/Podfile`
* `ios/*.xcodeproj`
* `ios/*.xcworkspace`

## Performance Areas To Audit

### 1. Startup Performance

Check:

* Heavy logic inside `App.tsx`
* Blocking startup API calls
* Synchronous storage reads
* Unnecessary splash delay
* Large initial bundles
* Expensive root providers
* Heavy navigation initialization
* Large images loaded on first screen
* Console logs in production
* Debug-only tools included in release

Recommend:

* Lazy loading screens
* Moving non-critical work after first render
* Deferring analytics or background services
* Reducing root provider complexity
* Removing unused imports
* Ensuring release build testing

### 2. Rendering Performance

Check:

* Unnecessary re-renders
* Components receiving unstable object/array/function props
* Inline functions in heavy lists
* Missing `React.memo` where useful
* Incorrect use of `useMemo` or `useCallback`
* Large components that should be split
* Expensive calculations inside render
* Context providers causing full-tree re-renders

Recommend:

* Memoize only when useful
* Keep props stable for heavy children
* Move expensive calculations out of render
* Split large components
* Use selectors for global state
* Avoid overusing Context for frequently changing state

### 3. FlatList and SectionList Performance

Check:

* FlatList used instead of ScrollView for large data
* Missing stable `keyExtractor`
* Heavy `renderItem`
* Inline `renderItem`
* Missing `getItemLayout` for fixed-height rows
* Bad `initialNumToRender`
* Bad `maxToRenderPerBatch`
* Bad `windowSize`
* Bad `updateCellsBatchingPeriod`
* Missing pagination
* Large images inside list items
* Nested FlatLists
* Anonymous functions inside list rows
* Expensive row components
* Unnecessary state updates on scroll

Recommend:

* Use stable keys
* Memoize row components
* Keep `renderItem` stable
* Use `getItemLayout` when item height is fixed
* Tune `initialNumToRender`, `maxToRenderPerBatch`, `windowSize`, and `updateCellsBatchingPeriod`
* Use pagination or infinite loading
* Use thumbnails instead of full-size images
* Consider FlashList only after measuring and confirming FlatList is a bottleneck

### 4. Images and Assets

Check:

* Oversized local images
* Large remote images
* Missing caching strategy
* Full-resolution images in list rows
* Uncompressed PNGs
* Heavy SVGs
* Base64 images
* Images loaded before needed

Recommend:

* Resize images for actual display size
* Use WebP where supported
* Use thumbnails for lists
* Use caching libraries when needed
* Lazy-load below-the-fold images
* Avoid base64 for large images

### 5. State Management

Check:

* Large Redux/Zustand/Context updates
* Components subscribing to too much state
* Missing selectors
* Unnecessary global state
* Storing derived data unnecessarily
* Recomputing filtered/sorted data every render
* Server state stored manually instead of using cache libraries

Recommend:

* Use selectors
* Keep server state separate from UI state
* Use React Query/Apollo cache where appropriate
* Avoid putting everything in global state
* Memoize derived data carefully
* Normalize large datasets

### 6. Navigation Performance

Check:

* Heavy logic in screen mount
* API calls firing repeatedly on focus
* Expensive header components
* Slow transitions
* Large params passed through navigation
* Screens not lazy-loaded
* Event listeners not cleaned up

Recommend:

* Move heavy work after transition
* Use focus effects carefully
* Avoid passing large objects in route params
* Clean up listeners
* Lazy-load expensive screens where possible

### 7. Animations and Gestures

Check:

* JS-thread animations
* Heavy state updates during gestures
* Layout animations causing jank
* Gesture handlers causing re-renders
* Reanimated not used for complex animations
* Animation logic mixed with heavy JS work

Recommend:

* Use native-driven animations where possible
* Use Reanimated worklets for complex gestures/animations
* Avoid state updates on every frame
* Keep animation work off the JS thread where possible

### 8. Memory Leaks

Check:

* Event listeners not removed
* Timers not cleared
* Intervals not cleared
* WebSocket subscriptions not closed
* Firebase listeners not unsubscribed
* Navigation listeners not cleaned up
* Async requests updating unmounted components
* Large arrays retained in memory
* Image memory pressure
* Video/audio resources not released

Recommend:

* Add proper cleanup in `useEffect`
* Abort fetch requests when needed
* Unsubscribe from listeners
* Clear timers
* Release media resources
* Avoid retaining unnecessary references

### 9. Native Modules

Check native-heavy features:

* Camera
* Maps
* Video
* Audio
* BLE
* Payments
* Firebase
* Push notifications
* Location tracking
* Background tasks
* ML/AI modules

Review whether these modules run heavy work on the main thread, cause memory pressure, or block navigation/rendering.

### 10. Hermes and JavaScript Loading

Check:

* Hermes enabled or disabled
* React Native version
* Bundle size
* Large dependencies
* Unused libraries
* Dynamic imports where useful
* Release build behavior

**Do not blindly enable or disable Hermes.** Check the current project version and platform support first.

### 11. Release Build Validation

The AI agent **must not judge performance only from debug mode.**

When possible, validate using release builds:

```bash
cd android
./gradlew assembleRelease
./gradlew bundleRelease
```

For iOS:

```bash
cd ios
pod install
```

Then validate using Xcode archive or release scheme.

## Commands To Run When Possible

### General

```bash
npm run lint
npm run typecheck
npm test
```

### Android

```bash
cd android
./gradlew clean
./gradlew assembleRelease
```

### iOS

```bash
cd ios
pod install
```

### Bundle Analysis

Use available project tools to inspect bundle size. If no bundle analyzer exists, recommend adding one only if useful.

### Performance Testing

Use available tools such as:

* React Native DevTools Profiler
* Hermes profiler
* Android Studio Profiler
* Xcode Instruments
* Flipper, if already supported
* Sentry performance/profiling, if already integrated
* Expo tools, if using Expo

## Rules and Constraints

* Do not blindly optimize without identifying the bottleneck.
* Do not add heavy libraries without a clear reason.
* Do not replace FlatList with FlashList without explaining why.
* Do not overuse `useMemo`, `useCallback`, or `React.memo`.
* Do not remove business logic.
* Do not change app behavior without permission.
* Do not break Android or iOS builds.
* Do not change signing configs.
* Do not modify package name or bundle identifier.
* Do not remove existing analytics, crash reporting, or monitoring without approval.
* Do not claim performance is fixed without testing.
* Always distinguish between debug-mode and release-mode performance.
* Prefer small, measurable improvements over risky rewrites.
* Follow the existing project architecture.
* Keep code clean, readable, and maintainable.

## Execution Workflow

### Step 1: Understand The Problem

Identify:

* Which screen is slow
* What action causes lag
* Which platform is affected
* Whether it happens in debug or release
* Whether it happens on low-end devices
* Whether the issue is startup, scrolling, rendering, memory, API, or navigation

### Step 2: Inspect Project Structure

Review project files, dependencies, navigation, screens, components, state management, and native modules.

### Step 3: Identify Bottlenecks

Categorize issues as:

* Startup
* Rendering
* Lists
* Images
* State management
* Navigation
* Animations
* Memory
* Native module
* Bundle size
* Release build issue

### Step 4: Create A Fix Plan

Before editing, provide a short plan:

* Issues found
* Files likely affected
* Fix strategy
* Testing strategy
* Risk level

### Step 5: Apply Safe Fixes

Make focused improvements only.

Examples:

* Memoize heavy list rows
* Stabilize `renderItem`
* Add `keyExtractor`
* Add `getItemLayout`
* Tune FlatList props
* Move expensive calculations outside render
* Clean up listeners/timers
* Optimize image usage
* Avoid unnecessary global state updates
* Defer non-critical startup work

### Step 6: Validate

Run available checks:

* TypeScript
* Lint
* Unit tests
* Android release build
* iOS build/pod install
* Manual test steps
* Performance profiling if available

### Step 7: Final Report

Provide a clear final report.

## Output Format

After completing the task, respond with:

### Summary

Explain what was reviewed and what was improved.

### Issues Found

List each issue with severity:

* Critical
* High
* Medium
* Low

### Files Changed

List changed files and why each file changed.

### Fixes Applied

Explain the performance improvements.

### Validation

List commands run and results.

### Manual Testing Steps

Provide clear steps to test the affected screens.

### Remaining Risks

Mention anything still needing real-device testing or production monitoring.

### Next Steps

Recommend what to do next.

## Validation Checklist

Before final response, complete this checklist:

* Project structure reviewed
* React Native version checked
* Expo version checked, if applicable
* Navigation reviewed
* Heavy screens reviewed
* FlatList/SectionList usage reviewed
* Image usage reviewed
* State management reviewed
* Native modules reviewed
* Memory leak risks reviewed
* Hermes configuration checked
* Debug vs release mode considered
* Android build checked where possible
* iOS build checked where possible
* TypeScript/lint checked where possible
* Manual testing steps provided
* Final report is client-ready

## Example Prompts

### Example 1

> Use the React Native Performance Audit Skill to audit my app startup time. Check `App.tsx`, navigation, root providers, API calls, storage reads, and release build configuration. Provide a report with safe fixes and validation steps.

### Example 2

> Use the React Native Performance Audit Skill to review this FlatList screen. Optimize scrolling, `renderItem`, `keyExtractor`, memoization, image loading, pagination, and list configuration without changing business logic.

### Example 3

> Use the React Native Performance Audit Skill to check memory leaks in my React Native app. Review `useEffect` cleanup, timers, event listeners, Firebase listeners, WebSockets, navigation listeners, and async requests.

### Example 4

> Use the React Native Performance Audit Skill to create a client-ready performance audit report for this project. Include issues found, severity, affected files, recommended fixes, validation commands, and next steps.

## Supporting Files In This Skill

* `AGENTS.md` — behavior contract for AI agents when this skill is active.
* `checklists/performance-checklist.md` — master audit checklist (all 11 areas).
* `checklists/flatlist-checklist.md` — list-specific checklist.
* `checklists/memory-leak-checklist.md` — cleanup and leak checklist.
* `checklists/release-validation-checklist.md` — debug-vs-release and build validation.
* `examples/` — worked audit request, FlatList audit, startup audit, and a final report.
* `prompts/` — ready-to-paste starter prompts for Cursor, Claude Code, Windsurf, and Antigravity.
