See how a thread's context window is used, without leaving the thread.

## What you get

- A live meter in the thread header with the used percentage. Click it to open
  the Context window panel.
- A full breakdown: total used, window size, percent used and left, a stacked
  bar over the whole window, and every category with its tokens and share.
- Sub-entries where the provider or session file has them: system prompt
  sections, builtin and extension tool schemas, AGENTS.md files, loaded
  skills, compaction summary, and messages.
- Free space and reserved space, so you can see how close the thread is to
  compaction.
- An **Estimated** label when the split is derived. Pi reports only the used
  total; the plugin reads the pi session file and scales its proportions to
  that total, so the split is honest about being an estimate.

## How it works

The plugin reads the context usage that BB already records for the thread. For
providers that report a category snapshot, it shows that snapshot directly. For
pi, it parses the provider session file and allocates the reported total across
the parts of the prompt that are still in context. Nothing leaves the machine,
and the plugin needs no account or API key.

## For agents

The bundled skill explains `bb context-window show [thread-id] [--json]`, which
reports the same numbers in the terminal.
