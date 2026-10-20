const OPEN_TRIGGER_SELECTOR = "[data-bb-context-window-trigger]";
const NATIVE_TRIGGER_SELECTOR = 'button[aria-label^="Context window "]';
const PANEL_TAB_ID = "plugin-panel:context-window";
const PANEL_STATE_PREFIX = "bb.thread.fixedPanelTabsState-";

type ContentScriptContext = {
  signal: AbortSignal;
};

type PanelState = {
  secondary?: {
    isOpen?: boolean;
    activeTabId?: string;
  };
};

function currentThreadId(): string | null {
  const match = location.pathname.match(/\/threads\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function panelStateSaysOpen(): boolean {
  const threadId = currentThreadId();
  if (!threadId) return false;
  const prefix = `${PANEL_STATE_PREFIX}${threadId}-`;
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(prefix)) continue;
    try {
      const state = JSON.parse(localStorage.getItem(key) ?? "null") as
        | PanelState
        | null;
      if (
        state?.secondary?.isOpen === true &&
        state.secondary.activeTabId?.includes(PANEL_TAB_ID)
      ) {
        return true;
      }
    } catch {
      // Ignore malformed host state.
    }
  }
  return false;
}

function headingIsOnScreen(): boolean {
  for (const heading of Array.from(document.querySelectorAll("h2"))) {
    if (heading.textContent?.trim() !== "Current context window") continue;
    const rect = heading.getBoundingClientRect();
    return (
      heading.checkVisibility() &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.left < window.innerWidth &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight
    );
  }
  return false;
}

function panelIsOpen(): boolean {
  return panelStateSaysOpen() || headingIsOnScreen();
}

function closePanel(): boolean {
  const hide = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      'button[aria-label^="Hide right panel"]',
    ),
  ).find((button) => {
    const rect = button.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.left < window.innerWidth &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight
    );
  });
  if (!hide) return false;
  hide.click();
  return true;
}

function findOpenTrigger(trigger: HTMLElement): HTMLElement | null {
  let node: Element | null = trigger;
  while (node) {
    const found = node.querySelector(OPEN_TRIGGER_SELECTOR);
    if (found instanceof HTMLElement) return found;
    node = node.parentElement;
  }
  const fallback = document.querySelector(OPEN_TRIGGER_SELECTOR);
  return fallback instanceof HTMLElement ? fallback : null;
}

export function mountContextControlClick(context: ContentScriptContext) {
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const trigger = target.closest(NATIVE_TRIGGER_SELECTOR);
    if (!(trigger instanceof HTMLElement)) return;
    event.preventDefault();
    event.stopPropagation();
    if (panelIsOpen() && closePanel()) return;
    findOpenTrigger(trigger)?.click();
  };

  document.addEventListener("click", onClick, true);
  context.signal.addEventListener(
    "abort",
    () => document.removeEventListener("click", onClick, true),
    { once: true },
  );
}
