# Worked Example: Startup Performance Audit

A realistic before/after for slow cold start (long splash, white screen, late first paint).

## Symptom
Cold start takes ~4–5s before the first screen is interactive; worse on low-end Android, reproduces in release.

## Before

```tsx
// App.tsx  (BEFORE)
export default function App() {
  const [ready, setReady] = useState(false);

  // ❌ blocking the first render on network + sync storage + analytics
  useEffect(() => {
    (async () => {
      await analytics.init();                 // ❌ heavy, not needed for first paint
      const token = AsyncStorage.getItem('@token'); // ❌ awaited serially below
      const profile = await api.get('/me');   // ❌ blocking API call before UI
      await preloadEverything();              // ❌ preloads data for screens not shown yet
      setReady(true);
    })();
  }, []);

  if (!ready) return <SplashScreen />;        // ❌ splash held until ALL of the above finishes

  // ❌ deep, expensive provider stack wrapping everything
  return (
    <ReduxProvider store={store}>
      <QueryClientProvider client={qc}>
        <ThemeProvider>
          <AnalyticsProvider>
            <FeatureFlagsProvider>            {/* ❌ blocks render fetching flags */}
              <NavigationContainer>
                <RootNavigator />
              </NavigationContainer>
            </FeatureFlagsProvider>
          </AnalyticsProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ReduxProvider>
  );
}
```

## Issues Found
| # | Issue | Severity |
|---|-------|----------|
| 1 | `await api.get('/me')` blocks first paint on the network | Critical |
| 2 | `analytics.init()` + `preloadEverything()` run before UI is shown | High |
| 3 | Splash held until all startup work completes | High |
| 4 | Feature flags fetched synchronously in a provider, gating render | High |
| 5 | All screens eagerly imported by `RootNavigator` (large initial bundle) | Medium |

## After

```tsx
// App.tsx  (AFTER)
export default function App() {
  // ✅ render the app shell immediately; do non-critical work after first paint
  useEffect(() => {
    InteractionManager.runAfterInteractions(() => {
      analytics.init();        // ✅ deferred, fire-and-forget
      preloadEverything();     // ✅ deferred
    });
  }, []);

  // ✅ providers stay, but the blocking flag fetch is gone (flags load with a default)
  return (
    <ReduxProvider store={store}>
      <QueryClientProvider client={qc}>
        <ThemeProvider>
          <NavigationContainer>
            <RootNavigator />
          </NavigationContainer>
        </ThemeProvider>
      </QueryClientProvider>
    </ReduxProvider>
  );
}
```

```tsx
// Profile data: fetched by the screen that needs it, not at startup.
// src/screens/Profile/ProfileScreen.tsx
const { data: profile } = useQuery({ queryKey: ['me'], queryFn: () => api.get('/me') });
```

```tsx
// Feature flags: non-blocking, with safe defaults.
// src/providers/FeatureFlags.tsx
const flags = useFeatureFlags(); // returns defaults immediately, refreshes in background
```

```tsx
// src/navigation/RootNavigator.tsx  (AFTER)
// ✅ lazy-load heavy, rarely-first screens to shrink the initial bundle
const SettingsScreen = React.lazy(() => import('../screens/Settings/SettingsScreen'));
```

## Why each change is safe
- The same data still loads — it's just moved off the cold-start critical path.
- Feature flags use documented defaults until the background refresh lands; behavior is unchanged for users.
- Lazy screens render exactly the same; only their import is deferred.
- No analytics/monitoring removed — only deferred a few hundred ms.

## Validation
- `yarn tsc --noEmit` / `yarn lint` / `yarn test` — pass
- Built the **release** app and timed cold start before/after (record the numbers; e.g. with `adb shell am start -W ...` on Android, or Instruments on iOS).
- Confirmed splash no longer waits on the network; first screen paints, data fills in.
- Manual: airplane mode cold start still shows the UI (instead of a stuck splash).

## Notes
Measure cold start in **release** only. Debug startup includes the dev bundle download and is not representative. See `checklists/release-validation-checklist.md`.
