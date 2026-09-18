# Master Performance Audit Checklist

Work top to bottom. Tick only what you actually verified. Note debug vs release for every performance observation.

## 0. Project Detection
- [ ] Confirmed RN project (`react-native` in `package.json`)
- [ ] React Native version recorded
- [ ] Expo SDK version recorded (if Expo)
- [ ] Package manager identified (npm / yarn / pnpm / bun)
- [ ] State library identified (Redux / Zustand / Context / MobX / React Query / Apollo)
- [ ] Navigation library identified
- [ ] List components identified (FlatList / SectionList / FlashList / RecyclerListView)
- [ ] Native modules identified (camera, maps, video, audio, BLE, payments, Firebase, push, location, ML)
- [ ] Bottleneck located: screen, action, platform, debug/release, low-end device or not

## 1. Startup
- [ ] `App.tsx` free of heavy synchronous logic
- [ ] No blocking startup API calls before first render
- [ ] No synchronous storage reads on the critical path
- [ ] Splash not held longer than needed
- [ ] Root providers are lean (not re-rendering the whole tree)
- [ ] Analytics / background services deferred after first render
- [ ] No `console.log` left in production
- [ ] Debug-only tools excluded from release

## 2. Rendering
- [ ] No unnecessary re-renders (verified with profiler / why-did-you-render)
- [ ] Heavy children receive stable object/array/function props
- [ ] No inline functions passed into heavy lists
- [ ] `React.memo` used only where it measurably helps
- [ ] `useMemo` / `useCallback` used correctly, not everywhere
- [ ] Expensive calculations moved out of render
- [ ] Large components split where it reduces re-render scope
- [ ] Context not used for frequently-changing state without selectors

## 3. FlatList / SectionList
- [ ] FlatList (not ScrollView) used for large data
- [ ] Stable `keyExtractor`
- [ ] `renderItem` is stable (not inline) and rows are memoized
- [ ] `getItemLayout` provided for fixed-height rows
- [ ] `initialNumToRender`, `maxToRenderPerBatch`, `windowSize`, `updateCellsBatchingPeriod` tuned
- [ ] Pagination / infinite loading where data is large
- [ ] Thumbnails (not full-res images) in rows
- [ ] No nested FlatLists / no per-scroll state updates
- [ ] FlashList considered only after measuring FlatList as the bottleneck

## 4. Images & Assets
- [ ] Local images sized for actual display
- [ ] Remote images resized / thumbnailed for lists
- [ ] Caching strategy in place where needed
- [ ] PNGs compressed / WebP used where supported
- [ ] No large base64 images
- [ ] Below-the-fold images lazy-loaded

## 5. State Management
- [ ] Selectors used (components don't subscribe to too much state)
- [ ] No unnecessary global state
- [ ] Derived data memoized, not recomputed every render
- [ ] Server state in a cache lib (React Query / Apollo), not manual global state
- [ ] Large datasets normalized

## 6. Navigation
- [ ] No heavy logic on screen mount
- [ ] Focus effects don't refire API calls unnecessarily
- [ ] Headers are not expensive
- [ ] Large objects not passed through route params
- [ ] Expensive screens lazy-loaded where possible
- [ ] Navigation listeners cleaned up

## 7. Animations & Gestures
- [ ] Animations native-driven where possible
- [ ] Reanimated worklets used for complex gestures/animations
- [ ] No state updates on every frame
- [ ] Heavy JS work kept off the animation path

## 8. Memory Leaks
- [ ] Event listeners removed in cleanup
- [ ] Timers / intervals cleared
- [ ] WebSocket / Firebase / navigation subscriptions unsubscribed
- [ ] Async requests aborted / guarded against unmounted updates
- [ ] Media (video/audio) and large arrays released
- [ ] (See `memory-leak-checklist.md` for the deep pass)

## 9. Native Modules
- [ ] Native-heavy features reviewed (camera, maps, video, audio, BLE, payments, Firebase, push, location, ML)
- [ ] No heavy work on the main thread blocking nav/render
- [ ] No obvious memory pressure from native resources

## 10. Hermes & JS Loading
- [ ] Hermes status checked (not blindly toggled)
- [ ] Bundle size reviewed; large / unused deps flagged
- [ ] Dynamic imports used where useful
- [ ] Release build behavior considered

## 11. Release Validation
- [ ] Performance judged from release, not debug (see `release-validation-checklist.md`)
- [ ] `npm run typecheck` / `lint` / `test` run where available
- [ ] Android release build attempted where possible
- [ ] iOS `pod install` / build attempted where possible
- [ ] Profiler trace captured where available

## Final
- [ ] Fix plan presented before editing
- [ ] Edits surgical and behavior-preserving
- [ ] Manual testing steps written
- [ ] Remaining risks listed
- [ ] Report is client-ready (Summary, Issues+severity, Files Changed, Fixes, Validation, Manual Steps, Risks, Next Steps)
