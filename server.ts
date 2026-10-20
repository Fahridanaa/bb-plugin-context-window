// bb-plugin-context-window — backend.
//
// The frontend asks for one report per thread. Providers that attach a
// context-window snapshot (ACP/Amp, Claude Code) get their breakdown passed
// through unchanged. pi reports only used/window, so this server reads the pi
// session file BB already keeps on disk and estimates the split, scaled to the
// total pi reported. A realtime signal tells open meters and panels to refetch
// when a thread's event sequence advances.

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { allocateCategories, buildPiCategories } from "./lib/context-estimate.ts";
import { parsePiSession, totalWeight, type PiSessionSummary } from "./lib/pi-session.ts";

const REALTIME_CHANNEL = "context-changed";
const SESSION_MAX_BYTES = 96 * 1024 * 1024;
const CACHE_LIMIT = 60;
const PUBLISH_THROTTLE_MS = 2_000;

const contextEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
  tokens: z.number().int().min(0),
});

const contextCategorySchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["used", "free", "reserved", "deferred"]),
  tokens: z.number().int().min(0),
  entries: z.array(contextEntrySchema),
});

export const contextReportSchema = z.object({
  threadId: z.string(),
  providerId: z.string(),
  model: z.string().nullable(),
  source: z.enum(["provider", "estimated", "none"]),
  contextWindowTokens: z.number().int().positive().nullable(),
  usedTokens: z.number().int().min(0).nullable(),
  estimated: z.boolean(),
  categories: z.array(contextCategorySchema),
  compactions: z.number().int().min(0),
  compactAtTokens: z.number().int().positive().nullable(),
  capturedAt: z.string().nullable(),
  detail: z.string().nullable(),
  sessionPath: z.string().nullable(),
});

export type ContextReport = z.infer<typeof contextReportSchema>;

export const rpcContract = defineRpcContract({
  context_report: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: contextReportSchema,
  },
});

interface ThreadSignals {
  providerThreadId: string | null;
  compactions: number;
}

interface CachedSession {
  key: string;
  summary: PiSessionSummary;
}

function sanitizeSessionId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function sessionDirs(bb: BbPluginApi): string[] {
  const dirs: string[] = [];
  const override = process.env.BB_PI_BRIDGE_SESSION_DIR?.trim();
  if (override) dirs.push(resolve(override));
  dirs.push(join(homedir(), ".bb", "pi-bridge-sessions"));
  try {
    dirs.push(join(bb.server.experimental_dataDir, "pi-bridge-sessions"));
  } catch {
    // Bind-gated: the data dir is unavailable before the server listens.
  }
  return [...new Set(dirs.filter((dir) => dir.length > 0))];
}

function clampTokens(value: number): number {
  return Math.max(0, Math.round(value));
}

/**
 * A provider's snapshot usually reports free space itself. When it does not,
 * derive it from the window so the bar and the legend agree.
 */
function addFreeSpace(
  categories: ContextReport["categories"],
  windowTokens: number | null,
): ContextReport["categories"] {
  if (windowTokens === null) return categories;
  if (categories.some((category) => category.kind === "free")) return categories;
  const occupied = categories
    .filter((category) => category.kind !== "deferred")
    .reduce((total, category) => total + category.tokens, 0);
  const free = Math.max(0, windowTokens - occupied);
  if (free === 0) return categories;
  return [
    ...categories,
    {
      id: "free",
      label: "Free space",
      kind: "free",
      tokens: free,
      entries: [],
    },
  ];
}

function formatTokens(value: number | null): string {
  if (value === null) return "?";
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(tokens: number, window: number | null): string {
  if (window === null || window <= 0) return "—";
  const percent = (tokens / window) * 100;
  return `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

function formatReport(report: ContextReport): string {
  const lines: string[] = [];
  const identity = [
    report.threadId,
    report.providerId,
    report.model ?? "model not reported",
  ].join(" · ");
  lines.push(identity);
  const share =
    report.usedTokens === null
      ? "no usage recorded"
      : `${formatTokens(report.usedTokens)} / ${formatTokens(report.contextWindowTokens)} tokens (${formatPercent(report.usedTokens, report.contextWindowTokens)})`;
  const flags = [
    report.source === "provider" ? "provider report" : null,
    report.source === "estimated" ? "estimated split" : null,
    report.compactions > 0 ? `${report.compactions} compaction(s)` : null,
  ].filter((flag): flag is string => flag !== null);
  lines.push([share, ...flags].join(" · "));
  lines.push("");
  for (const category of report.categories) {
    lines.push(
      `${formatTokens(category.tokens).padStart(10)}  ${formatPercent(
        category.tokens,
        report.contextWindowTokens,
      ).padStart(6)}  ${category.label}`,
    );
    for (const entry of category.entries) {
      lines.push(
        `${formatTokens(entry.tokens).padStart(10)}  ${formatPercent(
          entry.tokens,
          report.contextWindowTokens,
        ).padStart(6)}  · ${entry.label}`,
      );
    }
  }
  if (report.detail !== null) {
    lines.push("");
    lines.push(report.detail);
  }
  return lines.join("\n");
}

export default async function plugin(bb: BbPluginApi) {
  const sessionCache = new Map<string, CachedSession>();
  const lastPublish = new Map<string, number>();

  async function readThreadSignals(threadId: string): Promise<ThreadSignals> {
    try {
      const [contextEvents, compactionEvents] = await Promise.all([
        bb.sdk.threads.events.list({
          threadId,
          types: ["thread/identity", "thread/contextWindowUsage/updated"],
          order: "desc",
          limit: "40",
        }),
        bb.sdk.threads.events.list({
          threadId,
          types: ["thread/compacted", "thread/context/cleared"],
          order: "desc",
          limit: "100",
        }),
      ]);
      let providerThreadId: string | null = null;
      for (const event of contextEvents) {
        const data = event.data as { providerThreadId?: unknown };
        if (
          typeof data.providerThreadId === "string" &&
          data.providerThreadId.length > 0
        ) {
          providerThreadId = data.providerThreadId;
          break;
        }
      }
      // A clear starts a new context: compactions before it no longer count.
      let compactions = 0;
      for (const event of compactionEvents) {
        if (event.type === "thread/context/cleared") break;
        if (event.type === "thread/compacted") compactions += 1;
      }
      return { providerThreadId, compactions };
    } catch (cause) {
      bb.log.warn(
        `Could not read thread events for ${threadId}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      return { providerThreadId: null, compactions: 0 };
    }
  }

  async function readPiSession(
    providerThreadId: string,
  ): Promise<{ path: string; summary: PiSessionSummary } | null> {
    const fileName = `${sanitizeSessionId(providerThreadId)}.jsonl`;
    for (const dir of sessionDirs(bb)) {
      const path = resolve(dir, fileName);
      // The provider sanitizes ids, but keep the read inside the session dir.
      if (!path.startsWith(`${resolve(dir)}${sep}`)) continue;
      let size: number;
      let mtimeMs: number;
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        size = info.size;
        mtimeMs = info.mtimeMs;
      } catch {
        continue;
      }
      if (size > SESSION_MAX_BYTES) {
        bb.log.warn(`pi session is too large to parse: ${path} (${size} bytes)`);
        return null;
      }
      const key = `${path}:${mtimeMs}:${size}`;
      const cached = sessionCache.get(path);
      if (cached !== undefined && cached.key === key) return { path, summary: cached.summary };
      try {
        const text = await readFile(path, "utf8");
        const summary = parsePiSession(text);
        sessionCache.set(path, { key, summary });
        if (sessionCache.size > CACHE_LIMIT) {
          const oldest = sessionCache.keys().next().value;
          if (oldest !== undefined) sessionCache.delete(oldest);
        }
        return { path, summary };
      } catch (cause) {
        bb.log.warn(
          `Could not read the pi session ${path}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
        return null;
      }
    }
    return null;
  }

  async function buildReport(threadId: string): Promise<ContextReport> {
    const [thread, context, signals] = await Promise.all([
      bb.sdk.threads.get({ threadId }),
      bb.sdk.threads.context({ threadId }),
      readThreadSignals(threadId),
    ]);
    const providerId = thread.providerId;
    const usage = context.usage;
    const modelContextWindow =
      usage !== null && usage.modelContextWindow > 0
        ? Math.round(usage.modelContextWindow)
        : null;
    const usedTokens =
      usage !== null && usage.usedTokens !== null
        ? clampTokens(usage.usedTokens)
        : null;

    if (usage === null) {
      return {
        threadId,
        providerId,
        model: null,
        source: "none",
        contextWindowTokens: modelContextWindow,
        usedTokens: null,
        estimated: false,
        categories: [],
        compactions: signals.compactions,
        compactAtTokens: null,
        capturedAt: null,
        detail: "No context is recorded for this thread yet. Send a message, then refresh.",
        sessionPath: null,
      };
    }

    const snapshot = usage.snapshot;
    if (snapshot !== undefined && snapshot.categories.length > 0) {
      const windowTokens =
        snapshot.contextWindowTokens > 0
          ? Math.round(snapshot.contextWindowTokens)
          : modelContextWindow;
      return {
        threadId,
        providerId,
        model: snapshot.model,
        source: "provider",
        contextWindowTokens: windowTokens,
        usedTokens: usedTokens ?? clampTokens(snapshot.usedTokens),
        estimated: snapshot.estimated,
        categories: addFreeSpace(
          snapshot.categories.map((category) => ({
            id: category.id,
            label: category.label,
            kind: category.kind,
            tokens: clampTokens(category.tokens),
            entries: category.entries.map((entry) => ({
              id: entry.id,
              label: entry.label,
              tokens: clampTokens(entry.tokens),
            })),
          })),
          windowTokens,
        ),
        compactions: signals.compactions,
        compactAtTokens:
          snapshot.autoCompactAtTokens === null
            ? null
            : Math.round(snapshot.autoCompactAtTokens),
        capturedAt: snapshot.capturedAt,
        detail: null,
        sessionPath: null,
      };
    }

    if (providerId === "pi") {
      if (signals.providerThreadId === null) {
        return {
          threadId,
          providerId,
          model: null,
          source: "none",
          contextWindowTokens: modelContextWindow,
          usedTokens,
          estimated: usage.estimated,
          categories: [],
          compactions: signals.compactions,
          compactAtTokens: null,
          capturedAt: null,
          detail:
            "pi reports only the used total, and its session id is not recorded yet, so no breakdown is available.",
          sessionPath: null,
        };
      }
      const session = await readPiSession(signals.providerThreadId);
      if (session === null) {
        return {
          threadId,
          providerId,
          model: null,
          source: "none",
          contextWindowTokens: modelContextWindow,
          usedTokens,
          estimated: usage.estimated,
          categories: [],
          compactions: signals.compactions,
          compactAtTokens: null,
          capturedAt: null,
          detail:
            "pi reports only the used total. Its session file is not on this host, so no breakdown is available.",
          sessionPath: null,
        };
      }
      const summary = session.summary;
      const categories = buildPiCategories(summary);
      const anchor = usedTokens ?? summary.lastPromptTokens;
      const estimatedUsed =
        anchor ?? Math.round(totalWeight(summary) / 4);
      const tokenCategories =
        estimatedUsed > 0 ? allocateCategories(categories, estimatedUsed) : [];
      const output: ContextReport["categories"] = tokenCategories.map(
        (category) => ({
          id: category.id,
          label: category.label,
          kind: "used" as const,
          tokens: category.tokens,
          entries: category.entries,
        }),
      );
      if (modelContextWindow !== null) {
        output.push({
          id: "free",
          label: "Free space",
          kind: "free",
          tokens: Math.max(0, modelContextWindow - estimatedUsed),
          entries: [],
        });
      }
      const anchorNote =
        usedTokens !== null
          ? `scaled to the ${formatTokens(usedTokens)} tokens pi reported`
          : summary.lastPromptTokens !== null
            ? `scaled to the ${formatTokens(summary.lastPromptTokens)} prompt tokens in the session's last request`
            : "scaled from the session text at four characters per token";
      return {
        threadId,
        providerId,
        model: summary.model,
        source: "estimated",
        contextWindowTokens: modelContextWindow,
        usedTokens: estimatedUsed,
        estimated: true,
        categories: output,
        compactions: signals.compactions,
        compactAtTokens: null,
        capturedAt: summary.capturedAt,
        detail: `pi does not report a category breakdown. This split comes from the pi session file, ${anchorNote}; tokenizers differ, so read it as proportions, not exact counts.`,
        sessionPath: session.path,
      };
    }

    return {
      threadId,
      providerId,
      model: null,
      source: "none",
      contextWindowTokens: modelContextWindow,
      usedTokens,
      estimated: usage.estimated,
      categories: [],
      compactions: signals.compactions,
      compactAtTokens: null,
      capturedAt: null,
      detail: `${providerId} reports the used total but no category breakdown for this thread.`,
      sessionPath: null,
    };
  }

  bb.rpc.register(rpcContract, {
    context_report: ({ threadId }) => buildReport(threadId),
  });

  const usage = [
    "Usage:",
    "  bb context-window show [thread-id] [--json]",
    "",
    "Without a thread id, uses BB_THREAD_ID (the thread an agent is in).",
  ].join("\n");

  bb.cli.register({
    name: "context-window",
    summary: "Show how a thread's context window is used",
    commands: [
      {
        name: "show",
        summary: "Print the context breakdown for a thread",
        usage: "bb context-window show [thread-id] [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const args = argv.filter((argument) => !argument.startsWith("--"));
      const [command, ...rest] = args;
      if (command === undefined || command === "help") {
        return { exitCode: 0, stdout: usage };
      }
      if (command !== "show" || rest.length > 1) {
        return { exitCode: 1, stderr: usage };
      }
      const threadId = rest[0] ?? process.env.BB_THREAD_ID;
      if (threadId === undefined || threadId.trim() === "") {
        return {
          exitCode: 1,
          stderr:
            'No thread id. Pass one, or run this from a thread context where BB_THREAD_ID is set.',
        };
      }
      try {
        const report = await buildReport(threadId.trim());
        return {
          exitCode: 0,
          stdout: json ? JSON.stringify(report, null, 2) : formatReport(report),
        };
      } catch (cause) {
        return {
          exitCode: 1,
          stderr: cause instanceof Error ? cause.message : String(cause),
        };
      }
    },
  });

  // Coalesce a busy thread's event stream into at most one signal per thread
  // per throttle window. The signal carries no data; clients refetch.
  bb.events.on("experimental_thread.events", ({ thread }) => {
    const now = Date.now();
    const previous = lastPublish.get(thread.id) ?? 0;
    if (now - previous < PUBLISH_THROTTLE_MS) return;
    if (lastPublish.size > 500) {
      for (const [id, at] of lastPublish) {
        if (now - at > 60_000) lastPublish.delete(id);
      }
    }
    lastPublish.set(thread.id, now);
    bb.realtime.publish(REALTIME_CHANNEL, { threadId: thread.id });
  });

  bb.onDispose(() => {
    sessionCache.clear();
    lastPublish.clear();
  });
}
