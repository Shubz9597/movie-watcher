# Worked Example: FlatList Audit (Feed Screen)

A realistic before/after for a stuttering feed list. The fixes are surgical and preserve behavior.

## Symptom
Feed stutters while scrolling, worse on a low-end Android device, reproduces in release.

## Before

```tsx
// src/screens/Feed/FeedScreen.tsx  (BEFORE)
export default function FeedScreen() {
  const { data: posts = [] } = useGetFeedQuery();
  const [liked, setLiked] = useState<Record<string, boolean>>({});

  return (
    <FlatList
      data={posts}
      // ❌ inline renderItem -> new function every render
      renderItem={({ item }) => (
        // ❌ non-memoized row + inline onPress -> new closure per row
        <FeedCard
          post={item}
          liked={!!liked[item.id]}
          onPress={() => setLiked(s => ({ ...s, [item.id]: !s[item.id] }))}
        />
      )}
      // ❌ index key is unstable for a paginated/refreshing list
      keyExtractor={(_, index) => String(index)}
    />
  );
}
```

```tsx
// src/components/FeedCard.tsx  (BEFORE)
export function FeedCard({ post, liked, onPress }) {
  return (
    <Pressable onPress={onPress} style={styles.card}>
      {/* ❌ full-resolution remote image in a list row */}
      <Image source={{ uri: post.imageUrl }} style={styles.image} />
      <Text>{post.title}</Text>
    </Pressable>
  );
}
```

## Issues Found
| # | Issue | Severity |
|---|-------|----------|
| 1 | Inline `renderItem` — new function each render, defeats row bailout | High |
| 2 | `FeedCard` not memoized + inline `onPress` — every row re-renders on any state change | High |
| 3 | Index-based `keyExtractor` — wrong recycling on pagination/refresh | Medium |
| 4 | Full-resolution images in rows — decode cost + memory pressure | High |
| 5 | No list-window tuning / `getItemLayout` for fixed-height cards | Medium |

## After

```tsx
// src/screens/Feed/FeedScreen.tsx  (AFTER)
const CARD_HEIGHT = 280;

export default function FeedScreen() {
  const { data: posts = [] } = useGetFeedQuery();
  const [liked, setLiked] = useState<Record<string, boolean>>({});

  // ✅ stable handler; row gets item.id, not a fresh closure
  const toggleLike = useCallback((id: string) => {
    setLiked(s => ({ ...s, [id]: !s[id] }));
  }, []);

  // ✅ stable renderItem
  const renderItem = useCallback(
    ({ item }: { item: Post }) => (
      <FeedCard post={item} liked={!!liked[item.id]} onToggleLike={toggleLike} />
    ),
    [liked, toggleLike],
  );

  // ✅ stable, unique keys
  const keyExtractor = useCallback((item: Post) => item.id, []);

  // ✅ fixed-height rows -> skip measurement
  const getItemLayout = useCallback(
    (_: unknown, index: number) => ({
      length: CARD_HEIGHT,
      offset: CARD_HEIGHT * index,
      index,
    }),
    [],
  );

  return (
    <FlatList
      data={posts}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      getItemLayout={getItemLayout}
      initialNumToRender={6}
      maxToRenderPerBatch={6}
      windowSize={9}
      removeClippedSubviews
    />
  );
}
```

```tsx
// src/components/FeedCard.tsx  (AFTER)
// ✅ memoized row; only re-renders when its own props change
export const FeedCard = React.memo(function FeedCard({
  post,
  liked,
  onToggleLike,
}: {
  post: Post;
  liked: boolean;
  onToggleLike: (id: string) => void;
}) {
  return (
    <Pressable onPress={() => onToggleLike(post.id)} style={styles.card}>
      {/* ✅ request a thumbnail sized for the row, not the original */}
      <Image source={{ uri: post.thumbnailUrl ?? post.imageUrl }} style={styles.image} />
      <Text>{post.title}</Text>
    </Pressable>
  );
});
```

## Why each change is safe
- Behavior is identical — same data, same like-toggle, same layout.
- `getItemLayout` is only added because card height is fixed (`CARD_HEIGHT`).
- No new dependency added. FlashList was **not** introduced — FlatList is fine once rows stop re-rendering and images are thumbnailed.

## Validation
- `yarn tsc --noEmit` — pass
- `yarn lint` — pass
- Release APK rebuilt; scroll re-measured on the Samsung A14 → dropped frames during fling reduced noticeably (record before/after numbers from the profiler).
- Manual: scroll fast top→bottom, like several posts, pull-to-refresh — all behave as before.

## Notes
If, after these changes, the list is still the bottleneck **measured in release**, then consider FlashList — and record the measurement that justifies the extra dependency. See `checklists/flatlist-checklist.md`.
