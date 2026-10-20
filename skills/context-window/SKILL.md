---
name: context-window
description: Inspect a thread's context window with the `bb context-window` CLI — used tokens, free space, provider breakdown, and the estimated pi split. Use when the user asks how full a context window is, what is taking the space, why a thread is near compaction, or whether to compact.
---

# Context window

`bb context-window show` prints the latest recorded context usage for one
thread: the total, the window size, the share used, free space, and — when the
data exists — a category breakdown with sub-entries.

## Commands

| Command | Effect |
| --- | --- |
| `bb context-window show [thread-id]` | Human-readable report. Without an id, uses `BB_THREAD_ID`. |
| `bb context-window show [thread-id] --json` | The same report as JSON, for code. |

## Read the report

- **Reported by the provider**: the agent sent a context snapshot. Category
  counts are exact for that snapshot.
- **Estimated split**: pi reports only the used total. The plugin reads the pi
  session file (the system prompt sections, tool schemas, AGENTS.md files,
  skills, compaction summary, and messages still in context) and scales those
  proportions to the reported total. Read it as proportions, not exact counts.
- **Total only**: the provider reports no breakdown and no readable session
  exists. Only used/window is available.
- **Free space**: the window minus used tokens. Compaction happens as this
  shrinks.
- **Compactions**: how many compactions the thread has recorded. A compaction
  summary is part of the used context; the messages before the compaction are
  not.

## Procedure

1. Run `bb context-window show --json` when the caller needs numbers; run the
   plain command when a person reads it.
2. Quote the exact fields: `usedTokens`, `contextWindowTokens`, `categories`,
   `compactions`, and `detail`.
3. Do not add the numbers up across categories unless `source` is `provider`;
   an estimated split rounds to the provider total.
4. If `source` is `none`, say that a breakdown is not available. Do not invent
   one.

## Related commands

- `bb thread context <id>` prints only the used/window totals that BB records.
- `bb thread compact <id>` asks an idle thread to compact its context.
- `bb thread clear <id>` clears the model context.

## Rules

- Treat the report as read-only. Do not edit the pi session file or BB's
  database.
- The pi estimate depends on the session file for that provider thread. If BB
  runs the thread on another machine, the file is not on this host and the
  report says so.
