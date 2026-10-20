// bb-plugin-context-window — frontend entry.
//
// Two surfaces, one report:
//   - a meter in every thread header (used %, colored by pressure),
//   - a full panel tab with the category breakdown and sub-entries.
// Both refetch when the server's throttled "context-changed" signal names
// their thread.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { ContextPanel } from "./components/context/context-panel";
import { Icon } from "./components/ui/icon";
import { cn } from "./lib/utils";

const numberFormat = new Intl.NumberFormat();

interface HeaderUsage {
  used: number;
  window: number;
  estimated: boolean;
}

function toneFor(percent: number): string {
  if (percent >= 90) return "text-destructive";
  if (percent >= 75) return "text-warning-text";
  return "text-muted-foreground";
}

/**
 * A 16px ring plus the percentage in the thread header. A click opens the
 * Context window panel tab. Compact viewports drop the ring and keep the
 * number, so the control stays narrow.
 */
function HeaderMeter({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const [usage, setUsage] = useState<HeaderUsage | null>(null);
  const latest = useRef(0);
  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(connection === "connected");

  const fetchUsage = useCallback(() => {
    const request = latest.current + 1;
    latest.current = request;
    sdk.threads.context({ threadId }).then(
      (response) => {
        if (latest.current !== request) return;
        const next = response.usage;
        setUsage(
          next === null
            ? null
            : {
                used: next.usedTokens,
                window: next.modelContextWindow,
                estimated: next.estimated,
              },
        );
      },
      () => {
        // A failed read leaves the last known value in place; the panel shows
        // the full error when the user opens it.
      },
    );
  }, [sdk, threadId]);

  useEffect(() => {
    setUsage(null);
    fetchUsage();
  }, [fetchUsage]);

  // A reconnect can miss signals; reconcile once the socket is back.
  useEffect(() => {
    const connected = connection === "connected";
    if (connected && !wasConnected.current) fetchUsage();
    wasConnected.current = connected;
  }, [connection, fetchUsage]);

  const onSignal = useCallback(
    (payload: unknown) => {
      const signal = payload as { threadId?: unknown } | null;
      if (signal?.threadId === threadId) fetchUsage();
    },
    [fetchUsage, threadId],
  );
  useRealtime("context-changed", onSignal);

  const percent =
    usage === null || usage.window <= 0
      ? null
      : Math.min(100, Math.max(0, (usage.used / usage.window) * 100));
  const rounded = percent === null ? null : Math.round(percent);
  const tone = percent === null ? "text-muted-foreground" : toneFor(percent);
  const label =
    usage === null
      ? "Context window"
      : `Context window ${rounded}% used, ${numberFormat.format(
          usage.used,
        )} of ${numberFormat.format(usage.window)} tokens${
          usage.estimated ? ", estimated" : ""
        }`;

  const open = () => {
    navigate.openThreadPanel({
      actionId: "context-window",
      title: "Context window",
    });
  };

  return (
    <button
      type="button"
      onClick={open}
      title={label}
      aria-label={label}
      className="-m-1 inline-flex h-8 w-auto cursor-pointer items-center justify-center gap-1.5 rounded-full px-2 transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {rounded === null || !isCompactViewport ? (
        <Ring percent={percent} tone={tone} />
      ) : null}
      {rounded !== null ? (
        <span className={cn("text-xs tabular-nums", tone)}>{rounded}%</span>
      ) : null}
    </button>
  );
}

function Ring({ percent, tone }: { percent: number | null; tone: string }) {
  const radius = 6.5;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - (percent === null ? 0 : percent / 100));
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("size-4 shrink-0", tone)}
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        strokeWidth="3"
        className="stroke-border-hairline"
      />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "context-window-meter",
    title: "Context window",
    component: HeaderMeter,
  });

  app.slots.threadPanelAction({
    id: "context-window",
    title: "Context window",
    icon: "Gauge",
    component: ContextPanel,
    layout: "padded",
  });
});
