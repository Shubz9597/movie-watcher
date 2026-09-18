# FlatList / SectionList Checklist

Use this when the bottleneck is a list: laggy scroll, dropped frames on fling, slow first paint of the list, or jank while loading more.

## Diagnose First
- [ ] Confirmed the lag is in the list (profiler / observed dropped frames), not the screen around it
- [ ] Measured in **release** (or at least noted it's a debug reading)
- [ ] Row count and item shape known (fixed height? images? nested lists?)

## Structure
- [ ] Using `FlatList`/`SectionList` (NOT `ScrollView` + `.map()`) for large or unbounded data
- [ ] No nested vertical FlatLists (flatten data or use `SectionList` instead)
- [ ] No `ScrollView` wrapping a FlatList of the same scroll direction

## Keys & renderItem
- [ ] `keyExtractor` returns a **stable, unique** id (not the array index for dynamic data)
- [ ] `renderItem` is a **stable reference** (defined outside render, or `useCallback`), not inline
- [ ] The row component is wrapped in `React.memo`
- [ ] The row receives **stable props** (no new object/array/function literals each render)
- [ ] No per-row inline arrow functions for `onPress` etc. — pass `item.id` and a stable handler

## Layout & Windowing
- [ ] `getItemLayout` provided when rows have a **fixed/known height** (skips measurement)
- [ ] `initialNumToRender` set to roughly one screenful (not the default if rows are tall/heavy)
- [ ] `maxToRenderPerBatch` tuned (lower for heavy rows to reduce frame drops)
- [ ] `windowSize` tuned (default 21; lower to cut memory, raise to reduce blank cells)
- [ ] `updateCellsBatchingPeriod` tuned if batching causes jank
- [ ] `removeClippedSubviews` considered (Android especially) — but verify it doesn't blank rows

## Data Loading
- [ ] Pagination / infinite scroll via `onEndReached` (+ sensible `onEndReachedThreshold`)
- [ ] No full-list re-fetch on every scroll
- [ ] No `setState` on every scroll event (throttle / use `scrollEventThrottle` / move to Reanimated)

## Images In Rows
- [ ] Thumbnails, not full-resolution images, in rows
- [ ] Image caching in place for remote images
- [ ] Fixed image dimensions (avoid layout thrash)

## Before Reaching For FlashList
- [ ] FlatList confirmed as the bottleneck **after** the above are applied and measured
- [ ] Trade-off explained (API differences, `estimatedItemSize`, extra dependency)
- [ ] Decision recorded in the report with the measurement that justified it

## Validate
- [ ] Re-measured scroll in release after changes
- [ ] `typecheck` / `lint` pass
- [ ] Manual scroll test on a low-end device (or noted as needed)
