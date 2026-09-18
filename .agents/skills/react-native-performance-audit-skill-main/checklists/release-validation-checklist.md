# Release Validation Checklist

**Never judge performance from a debug build.** Debug JS runs without Hermes optimizations, with dev warnings, and (sometimes) over a remote debugger — it can be many times slower than release. Use this checklist before reporting any performance verdict.

## Why Debug ≠ Release
- [ ] Aware that debug numbers are not representative of shipped performance
- [ ] Remote JS debugging turned OFF when measuring (it murders performance)
- [ ] Each performance observation in the report is labeled **debug** or **release**

## Static Checks (always run if available)
- [ ] `npm run typecheck` (or `tsc --noEmit`) — passes
- [ ] `npm run lint` — passes
- [ ] `npm test` — passes
- [ ] No new `console.log` on hot paths or in production code

## Android Release Build
```bash
cd android
./gradlew clean
./gradlew assembleRelease   # APK
./gradlew bundleRelease     # AAB for Play
```
- [ ] Release APK / AAB builds successfully
- [ ] Hermes status confirmed (do not toggle blindly)
- [ ] App launched from the release build and the slow scenario re-measured
- [ ] Tested (or flagged to test) on a **low-end** device, not just a flagship

## iOS Release Build
```bash
cd ios
pod install
# then: Xcode → Product → Scheme → Edit Scheme → Run → Release,
# or archive with the Release configuration.
```
- [ ] `pod install` succeeds
- [ ] App built/run with the **Release** scheme (not Debug)
- [ ] Slow scenario re-measured in Release

## Bundle / Size
- [ ] Bundle size reviewed (use existing project tooling; add an analyzer only if useful)
- [ ] Large or unused dependencies flagged
- [ ] Dynamic imports applied where they meaningfully reduce the initial bundle

## Profiling (where available)
- [ ] React Native DevTools Profiler — re-render counts / commit times
- [ ] Hermes profiler — JS CPU
- [ ] Android Studio Profiler — CPU / memory
- [ ] Xcode Instruments — Time Profiler / Allocations / Leaks
- [ ] Flipper or Sentry performance — only if already integrated

## Reporting
- [ ] Before/after measurements captured for the fixed scenario (release where possible)
- [ ] Any check you couldn't run is listed and marked **"unverified until run"** with the exact command
- [ ] Remaining risks that need real-device or production monitoring are called out
