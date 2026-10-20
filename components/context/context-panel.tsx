import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_useProviders,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { ContextReport, rpcContract } from "../../server";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { cn } from "../../lib/utils";

const numberFormat = new Intl.NumberFormat();
const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

type Category = ContextReport["categories"][number];

function formatTokens(value: number | null): string {
  return value === null ? "—" : numberFormat.format(value);
}

function formatPercent(tokens: number, window: number | null): string {
  if (window === null || window <= 0) return "—";
  const percent = (tokens / window) * 100;
  return `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

/**
 * Category colors come from the host theme's ANSI palette, which every BB
 * theme defines. Custom palettes therefore recolor the bar with the rest of
 * the app instead of fighting a hardcoded list.
 */
function colorFor(category: Category, index: number): string {
  if (category.kind === "free") return "var(--muted)";
  if (category.kind === "deferred") return "var(--muted-foreground)";
  const id = category.id.toLowerCase();
  if (/free|space/.test(id)) return "var(--muted)";
  if (/mcp|extension/.test(id)) return "var(--ansi-5)";
  if (/tool/.test(id)) return "var(--ansi-1)";
  if (/system/.test(id)) return "var(--ansi-4)";
  if (/compact|summary/.test(id)) return "var(--ansi-2)";
  if (/memor|agent|instruction|project/.test(id)) return "var(--ansi-3)";
  if (/skill/.test(id)) return "var(--ansi-6)";
  if (/message|conversation|history/.test(id)) return "var(--ansi-8)";
  const palette = [
    "var(--ansi-4)",
    "var(--ansi-1)",
    "var(--ansi-3)",
    "var(--ansi-5)",
    "var(--ansi-6)",
    "var(--ansi-2)",
    "var(--ansi-8)",
  ];
  return palette[index % palette.length] ?? "var(--ansi-4)";
}

function useContextReport(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [report, setReport] = useState<ContextReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const request = useRef(0);
  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(connection === "connected");

  const load = useCallback(() => {
    const id = request.current + 1;
    request.current = id;
    setLoading(true);
    setError(null);
    rpc.call("context_report", { threadId }).then(
      (next) => {
        if (request.current !== id) return;
        setReport(next);
        setLoading(false);
      },
      (cause: unknown) => {
        if (request.current !== id) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      },
    );
  }, [rpc, threadId]);

  useEffect(() => {
    load();
  }, [load]);

  // A reconnect can miss signals; reconcile once the socket is back.
  useEffect(() => {
    const connected = connection === "connected";
    if (connected && !wasConnected.current) load();
    wasConnected.current = connected;
  }, [connection, load]);

  const onSignal = useCallback(
    (payload: unknown) => {
      const signal = payload as { threadId?: unknown } | null;
      if (signal?.threadId === threadId) load();
    },
    [load, threadId],
  );
  useRealtime("context-changed", onSignal);

  return { report, error, loading, reload: load };
}

function PanelSkeleton() {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4" aria-busy="true">
      <div className="h-4 w-44 animate-pulse rounded bg-muted" />
      <div className="h-7 w-64 animate-pulse rounded bg-muted" />
      <div className="h-2.5 w-full animate-pulse rounded bg-muted" />
      <div className="space-y-3 pt-2">
        {["82%", "64%", "71%", "52%", "38%"].map((width) => (
          <div
            key={width}
            className="h-4 animate-pulse rounded bg-muted"
            style={{ width }}
          />
        ))}
      </div>
    </div>
  );
}

function BreakdownBar({
  categories,
  windowTokens,
  compactAtTokens,
}: {
  categories: Category[];
  windowTokens: number | null;
  compactAtTokens: number | null;
}) {
  const segments = categories.filter(
    (category) =>
      category.kind !== "free" &&
      category.kind !== "deferred" &&
      category.tokens > 0,
  );
  const segmentTotal = segments.reduce(
    (total, category) => total + category.tokens,
    0,
  );
  // The track's remaining width is free space; draw only used and reserved
  // space, so free is never painted twice.
  const denominator = Math.max(windowTokens ?? 0, segmentTotal, 1);
  const marker =
    compactAtTokens !== null && compactAtTokens > 0 && compactAtTokens < denominator
      ? Math.min(100, Math.max(0, (compactAtTokens / denominator) * 100))
      : null;
  const summary =
    segments.length === 0
      ? "No context used"
      : segments
          .map(
            (category) =>
              `${category.label}: ${formatTokens(category.tokens)} tokens`,
          )
          .join(", ");

  return (
    <div
      className="relative h-2.5 w-full overflow-hidden rounded-sm bg-muted"
      role="img"
      aria-label={summary}
    >
      <div className="flex h-full w-full">
        {segments.map((category, index) => (
          <span
            key={category.id}
            className="h-full first:rounded-l-sm"
            style={{
              width: `${(category.tokens / denominator) * 100}%`,
              backgroundColor: colorFor(category, index),
            }}
          />
        ))}
      </div>
      {marker === null ? null : (
        <span
          className="absolute top-0 h-full w-px bg-foreground/70"
          style={{ left: `${marker}%` }}
          title={`Auto-compact at ${formatTokens(compactAtTokens)} tokens`}
        />
      )}
    </div>
  );
}

function CategoryRow({
  category,
  windowTokens,
  color,
}: {
  category: Category;
  windowTokens: number | null;
  color: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const entries = category.entries.filter((entry) => entry.tokens > 0);
  const limit = 8;
  const hidden = Math.max(0, entries.length - limit);
  const visible = expanded ? entries : entries.slice(0, limit);

  return (
    <li className="py-2">
      <div className="flex items-baseline gap-3">
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 translate-y-[-1px] rounded-[3px] border border-border/60"
          style={{ backgroundColor: color }}
        />
        <span className="min-w-0 flex-1 truncate text-sm">{category.label}</span>
        <span className="shrink-0 text-sm tabular-nums">
          {formatTokens(category.tokens)}
        </span>
        <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {formatPercent(category.tokens, windowTokens)}
        </span>
      </div>
      {visible.length === 0 ? null : (
        <ul className="ml-[5px] mt-1 space-y-0.5 border-l border-border pl-3">
          {visible.map((entry) => (
            <li
              key={entry.id}
              className="flex items-baseline gap-3 text-xs text-muted-foreground"
            >
              <span className="min-w-0 flex-1 truncate" title={entry.label}>
                {entry.label}
              </span>
              <span className="shrink-0 tabular-nums">
                {formatTokens(entry.tokens)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {hidden === 0 ? null : (
        <button
          type="button"
          className="ml-[23px] mt-1 cursor-pointer text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : `Show ${hidden} more`}
        </button>
      )}
    </li>
  );
}

function reportCategories(report: ContextReport): Category[] {
  if (report.categories.length > 0) return report.categories;
  if (report.usedTokens === null) return [];
  const list: Category[] = [
    {
      id: "in-context",
      label: "In context",
      kind: "used",
      tokens: report.usedTokens,
      entries: [],
    },
  ];
  if (report.contextWindowTokens !== null) {
    list.push({
      id: "free",
      label: "Free space",
      kind: "free",
      tokens: Math.max(
        0,
        report.contextWindowTokens - report.usedTokens,
      ),
      entries: [],
    });
  }
  return list;
}

export function ContextPanel({ threadId }: { threadId: string }) {
  const { providers } = experimental_useProviders();
  const { report, error, loading, reload } = useContextReport(threadId);
  const providerName =
    report === null
      ? "Provider"
      : (providers.find((provider) => provider.id === report.providerId)
          ?.displayName ?? report.providerId);
  const categories = useMemo(
    () => (report === null ? [] : reportCategories(report)),
    [report],
  );
  const deferred = categories.filter(
    (category) => category.kind === "deferred" && category.tokens > 0,
  );
  const legend = categories.filter(
    (category) => category.kind !== "deferred" && category.tokens > 0,
  );

  if (report === null) {
    if (loading) return <PanelSkeleton />;
    return (
      <div className="mx-auto w-full max-w-2xl space-y-3">
        <div
          role="alert"
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-destructive"
        >
          {error ?? "The context report is not available."}
        </div>
        <Button variant="outline" size="sm" onClick={reload}>
          <Icon name="RotateCcw" className="size-3.5" />
          Retry
        </Button>
      </div>
    );
  }

  const windowTokens = report.contextWindowTokens;
  const used = report.usedTokens;
  const percent =
    used === null ? "—" : formatPercent(used, windowTokens);
  const sourceLabel =
    report.source === "provider"
      ? report.estimated
        ? "Estimated by the provider"
        : "Reported by the provider"
      : report.source === "estimated"
        ? "Estimated split"
        : "Total only";
  const captured =
    report.capturedAt === null
      ? null
      : timeFormat.format(new Date(report.capturedAt));
  const meta = [
    report.model,
    report.compactions > 0
      ? `${report.compactions} compaction${report.compactions === 1 ? "" : "s"}`
      : null,
    report.compactAtTokens !== null
      ? `compacts at ${formatTokens(report.compactAtTokens)}`
      : null,
    captured === null ? null : `captured ${captured}`,
  ].filter((item): item is string => item !== null);
  const note =
    report.detail ??
    (report.source === "provider"
      ? "The provider reports a snapshot per turn. Short spikes between snapshots may not appear."
      : null);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">Current context window</h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {providerName}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="-mr-1 size-7 shrink-0 text-muted-foreground"
          aria-label="Refresh context report"
          onClick={reload}
          disabled={loading}
        >
          <Icon
            name="RotateCcw"
            className={cn("size-3.5", loading && "animate-spin")}
          />
        </Button>
      </header>

      <section aria-labelledby="context-total">
        <div className="flex items-baseline justify-between gap-4">
          <div
            id="context-total"
            className="text-2xl font-medium tracking-tight tabular-nums"
          >
            {formatTokens(used)}
            <span className="text-muted-foreground">
              {" / "}
              {formatTokens(windowTokens)} tokens
            </span>
          </div>
          <div className="shrink-0 text-sm tabular-nums text-muted-foreground">
            {percent}
          </div>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {sourceLabel}
          {meta.length === 0 ? null : ` · ${meta.join(" · ")}`}
        </p>
        <div className="mt-3">
          <BreakdownBar
            categories={categories}
            windowTokens={windowTokens}
            compactAtTokens={report.compactAtTokens}
          />
        </div>
      </section>

      {legend.length === 0 ? null : (
        <section aria-label="Breakdown">
          <ul className="divide-y divide-border border-y border-border">
            {legend.map((category, index) => (
              <CategoryRow
                key={category.id}
                category={category}
                windowTokens={windowTokens}
                color={colorFor(category, index)}
              />
            ))}
          </ul>
        </section>
      )}

      {deferred.length === 0 ? null : (
        <section aria-label="Available on demand">
          <h3 className="border-b border-border pb-1 text-xs font-medium text-muted-foreground">
            Available on demand
          </h3>
          <ul>
            {deferred.map((category, index) => (
              <CategoryRow
                key={category.id}
                category={category}
                windowTokens={windowTokens}
                color={colorFor(category, index)}
              />
            ))}
          </ul>
        </section>
      )}

      {note === null ? null : (
        <p className="text-xs leading-relaxed text-muted-foreground">{note}</p>
      )}
    </div>
  );
}
