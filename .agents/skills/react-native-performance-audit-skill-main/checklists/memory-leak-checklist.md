# Memory Leak Checklist

Use this when the app grows in memory over time, slows down after navigating between screens repeatedly, crashes after extended use, or logs "Can't perform a React state update on an unmounted component."

## Symptoms To Confirm First
- [ ] Memory climbs across repeated navigation / list scrolling (profiler: Android Studio Profiler / Xcode Instruments)
- [ ] Slowdown or crash appears only after extended use
- [ ] Console warns about state updates on unmounted components
- [ ] Listeners/timers suspected (sockets, Firebase, location, BLE, intervals)

## useEffect Cleanup
- [ ] Every `useEffect` that subscribes/opens/starts something returns a cleanup function
- [ ] Cleanup actually tears down the exact thing it created (matched add/remove pairs)
- [ ] Dependency arrays correct (no stale closures re-subscribing endlessly)

## Event Listeners
- [ ] `addEventListener` paired with `removeEventListener` (or the returned `remove()` called)
- [ ] `AppState`, `Dimensions`, `Keyboard`, `Linking`, `BackHandler` listeners removed
- [ ] DeviceEventEmitter / NativeEventEmitter subscriptions removed

## Timers
- [ ] `setTimeout` cleared with `clearTimeout`
- [ ] `setInterval` cleared with `clearInterval`
- [ ] `requestAnimationFrame` cancelled with `cancelAnimationFrame`
- [ ] `InteractionManager.runAfterInteractions` handles cancelled if needed

## Subscriptions
- [ ] WebSocket connections closed on unmount
- [ ] Firebase listeners (`onSnapshot`, `on`, `onAuthStateChanged`, RTDB refs) unsubscribed
- [ ] Redux/Zustand/RxJS subscriptions unsubscribed
- [ ] Push notification / messaging listeners removed

## Navigation
- [ ] `navigation.addListener('focus'/'blur'/'beforeRemove')` returns unsubscribe and it's called
- [ ] `useFocusEffect` cleanup returned
- [ ] No listeners re-registered on every focus without cleanup

## Async Requests
- [ ] Fetches aborted with `AbortController` on unmount where relevant
- [ ] `isMounted` guard or abort used before `setState` after `await`
- [ ] Promises don't capture and retain large objects unnecessarily

## Native / Media Resources
- [ ] Video/audio players released (`release()` / pause + unload)
- [ ] Camera / BLE / location sessions stopped on unmount
- [ ] Large images / blobs released; no growing in-memory caches
- [ ] Large arrays / maps not retained after the screen unmounts

## Validate
- [ ] Re-ran the repeated-navigation / scroll scenario and watched memory stabilize
- [ ] `typecheck` / `lint` pass
- [ ] Noted any leak that still needs real-device profiling to confirm
