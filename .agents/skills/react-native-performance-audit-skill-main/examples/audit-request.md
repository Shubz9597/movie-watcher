# Example: Kicking Off an Audit

This shows what a good audit request looks like and how the agent should respond before touching code.

## A minimal request (works fine)

> Use the React Native Performance Audit Skill. My app feels slow. Find what's wrong and fix the safe stuff.

The agent should not block on this. It detects the project and proceeds with best-practice assumptions, asking only blocking questions.

## A good, detailed request (preferred)

> Use the React Native Performance Audit Skill.
>
> - **RN:** 0.74, no Expo
> - **Package manager:** yarn
> - **State:** Redux Toolkit + RTK Query
> - **Navigation:** React Navigation (native stack)
> - **Problem:** The Feed screen (`src/screens/Feed/FeedScreen.tsx`) stutters while scrolling, especially on a Samsung A14.
> - **Build:** happens in release too, worse on low-end.
> - **Lists:** FlatList with image cards.
>
> Audit the Feed screen, fix the safe issues without changing behavior, and give me a client-ready report.

## How the agent should respond (before editing)

1. **Confirm detection** — RN version, package manager, state lib, navigation lib, list components, native modules.
2. **Locate the bottleneck** — Feed screen, scroll action, Android low-end, reproduces in release → category: **lists + images + rendering**.
3. **Present a short fix plan first** (no edits yet):

   > **Plan**
   > - **Issues suspected:** inline `renderItem`, non-memoized row, missing `keyExtractor` stability, full-res images in cards, possible per-scroll `setState`.
   > - **Files likely affected:** `src/screens/Feed/FeedScreen.tsx`, `src/components/FeedCard.tsx`.
   > - **Fix strategy:** stabilize `renderItem`, memoize `FeedCard`, add stable `keyExtractor`, thumbnail images, tune list windowing.
   > - **Testing strategy:** typecheck + lint; re-measure scroll in release; manual scroll test on A14.
   > - **Risk:** Low — no behavior change.

4. **Apply fixes** surgically, then **validate**, then **report** using the Output Format in `SKILL.md`.

See `flatlist-audit.md` and `startup-performance-audit.md` for worked before/after code, and `final-report-example.md` for the report shape.
