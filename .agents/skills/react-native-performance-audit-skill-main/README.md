# React Native Performance Audit Skill (AI Skill)

A reusable AI coding skill that helps any agent **audit, improve, and validate** React Native app performance — slow startup, laggy lists, unnecessary re-renders, memory leaks, heavy images, slow navigation, oversized bundles, Hermes config, native-module bottlenecks, and **release-mode** validation.

It is built to find the **real** bottleneck (not blindly optimize), apply **safe, surgical** fixes that preserve behavior, and **validate** results — never claiming "fixed" from a debug build alone.

> **Repo:** https://github.com/ahtishamshahzad/react-native-performance-audit-skill
> **Compatible agents:** Claude Code, Cursor, Windsurf, Antigravity, Cline, Codex, Gemini CLI, GitHub Copilot, OpenCode, and any agent that reads `SKILL.md` / `AGENTS.md`.

---

## Quick install (recommended) — `skills` CLI

The fastest way. Works for 70+ agents (Claude Code, Cursor, Windsurf, Antigravity, Codex, Gemini CLI, Copilot, …). Run this in your project root:

```bash
npx skills add ahtishamshahzad/react-native-performance-audit-skill
```

This clones the skill and installs it into the right place for every agent it detects (e.g. `./.agents/skills/…`, symlinked into Claude Code / Windsurf / Devin). No manual copying needed.

### Local vs global scope

| Scope | Command | Where it installs | Use when |
|-------|---------|-------------------|----------|
| **Local** (one project) | `npx skills add ahtishamshahzad/react-native-performance-audit-skill` (run inside the project — default) | `./.agents/skills/…` in that repo | You want the skill pinned to a specific RN app. |
| **Global** (all projects) | `npx skills add ahtishamshahzad/react-native-performance-audit-skill -g` | `~/.agents/skills/…` (symlinked into Claude Code, Cursor, Windsurf, Antigravity, Codex, Gemini CLI, Copilot, Devin, OpenCode) | You want it available everywhere. |
| **Both** | run the global command once, then the local command in each project | both locations | Available everywhere, plus pinned per-project. |

Handy flags: `--all` (all skills + all agents, no prompts), `-a '*'` (all agents), `-y` (skip prompts), `--copy` (copy instead of symlink). List installs with `npx skills list -g` (global) or `npx skills list` (project).

Other useful CLI commands:

```bash
npx skills list      # see installed skills
npx skills find       # search the skills.sh directory interactively
npx skills update     # update installed skills
npx skills remove react-native-performance-audit   # uninstall
```

> ⚠️ Skills run with full agent permissions — review `SKILL.md` before use.

---

## What This Skill Helps With

* Audit React Native app performance
* Identify slow screens and heavy components
* Detect unnecessary re-renders
* Optimize FlatList and SectionList usage
* Review Hermes and JavaScript loading configuration
* Check memory leaks from listeners, timers, subscriptions, and async tasks
* Review image loading and asset optimization
* Check navigation performance
* Review state management performance
* Validate performance in release builds
* Generate a client-ready performance audit report

## Best For

* React Native production apps
* Apps with slow startup time
* Apps with laggy lists or scrolling issues
* Apps with heavy screens or poor navigation performance
* Apps with memory leaks or crashes
* Apps preparing for release
* Apps being upgraded or modernized
* Client projects that need a professional performance report

---

## Manual install — clone the repo

If you prefer to clone and wire it up yourself:

```bash
# 1. Clone
git clone https://github.com/ahtishamshahzad/react-native-performance-audit-skill.git
cd react-native-performance-audit-skill

# 2a. Install globally for Claude Code (auto-discovered on next start)
bash install.sh
#     → copies to ~/.claude/skills/react-native-performance-audit/

# 2b. OR install for one project only (Claude Code)
mkdir -p /path/to/your-rn-app/.claude/skills
cp -R . /path/to/your-rn-app/.claude/skills/react-native-performance-audit
```

**Claude Code scopes (manual):** global = `~/.claude/skills/<name>/` (via `install.sh`); local = `<project>/.claude/skills/<name>/`. Claude Code auto-discovers either. You can have both at once — the project copy takes precedence in that project.

---

## Per-tool setup (manual, if not using the CLI)

### Claude Code
```bash
bash install.sh
```
Copies the skill to `~/.claude/skills/react-native-performance-audit/`; Claude Code auto-discovers it by `name`/`description`. For project scope, copy the folder into `<project>/.claude/skills/` instead.

### Cursor
Copy `.cursor/rules/rn-performance.mdc` into your project's `.cursor/rules/` directory. Cursor applies it automatically when you touch screens, components, lists, or app entry/config files.

### Windsurf
Copy `.windsurfrules` to your project root, or paste its contents into Windsurf's workspace/global rules.

### Cline / Antigravity / other agents
Place `AGENTS.md` (ideally the whole folder) at the project root — these tools read `AGENTS.md` as their behavior contract. Any agent can also simply be told: *"follow SKILL.md in this folder."* Ready-to-paste starters live in `prompts/`.

---

## Contents

```
react-native-performance-audit-skill/
├── SKILL.md                              # The skill (purpose, 11 audit areas, workflow, rules, checklist, examples)
├── AGENTS.md                             # How agents should behave when this skill is active
├── README.md                             # This file
├── LICENSE                               # MIT
├── install.sh                            # Installs the skill globally for Claude Code
├── .cursor/rules/rn-performance.mdc      # Cursor rule adapter
├── .windsurfrules                        # Windsurf rules adapter
├── checklists/
│   ├── performance-checklist.md          # Master audit checklist (all 11 areas)
│   ├── flatlist-checklist.md             # FlatList / SectionList checklist
│   ├── memory-leak-checklist.md          # Cleanup & leak checklist
│   └── release-validation-checklist.md   # Debug-vs-release & build validation
├── examples/
│   ├── audit-request.md                  # How a user kicks off an audit
│   ├── flatlist-audit.md                 # Worked FlatList before/after
│   ├── startup-performance-audit.md      # Worked startup audit
│   └── final-report-example.md           # Filled-in client-ready report
└── prompts/
    ├── cursor-prompt.md
    ├── claude-code-prompt.md
    ├── windsurf-prompt.md
    └── antigravity-prompt.md
```

---

## What this skill does (in short)

1. Detects the project (RN version, Expo, package manager, state/navigation libs, list components, native modules).
2. Locates the **real** bottleneck — which screen, action, platform, and whether it's debug or release.
3. Categorizes it: startup, rendering, lists, images, state, navigation, animations, memory, native module, bundle size, or release-build issue.
4. Applies **safe, surgical** fixes that match the project's conventions and preserve behavior.
5. **Validates** with typecheck / lint / tests / release build / profiler where possible — never claims success from a debug build alone.
6. Produces a **client-ready** report (issues + severity, files changed, fixes, validation, manual test steps, risks, next steps).

See `SKILL.md` for the full workflow, rules, and validation checklist.

---

## License

MIT — see [`LICENSE`](./LICENSE).
