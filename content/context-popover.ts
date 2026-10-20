const POPOVER_SELECTOR = '[class*="@container/context-window"]';
const ACTION_ATTRIBUTE = "data-bb-context-window-action";
const OPEN_TRIGGER_SELECTOR = "[data-bb-context-window-trigger]";
const NATIVE_TRIGGER_SELECTOR = 'button[aria-label^="Context window "]';

type ContentScriptContext = {
  signal: AbortSignal;
};

let activeNativeTrigger: HTMLElement | null = null;

function findOpenTrigger(): HTMLElement | null {
  let node: Element | null = activeNativeTrigger;
  while (node) {
    const found = node.querySelector(OPEN_TRIGGER_SELECTOR);
    if (found instanceof HTMLElement) return found;
    node = node.parentElement;
  }
  const fallback = document.querySelector(OPEN_TRIGGER_SELECTOR);
  return fallback instanceof HTMLElement ? fallback : null;
}

function createAction(): HTMLElement {
  const row = document.createElement("div");
  row.setAttribute(ACTION_ATTRIBUTE, "");
  row.className = "mt-2 flex justify-end";

  const button = document.createElement("button");
  button.type = "button";
  button.className =
    "flex cursor-pointer items-center gap-1.5 rounded-xs text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:pointer-coarse:py-1 max-md:pointer-coarse:text-sm";
  button.textContent = "Full breakdown";
  button.title = "Open the full context breakdown";
  button.setAttribute("aria-label", "Open the full context breakdown");
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    findOpenTrigger()?.click();
  });

  row.append(button);
  return row;
}

export function mountContextPopoverAction(context: ContentScriptContext) {
  let disposed = false;
  let scheduled = false;

  const inject = () => {
    if (disposed) return;
    for (const popover of Array.from(
      document.querySelectorAll<HTMLElement>(POPOVER_SELECTOR),
    )) {
      if (popover.querySelector(`[${ACTION_ATTRIBUTE}]`)) continue;
      popover.append(createAction());
    }
  };

  const schedule = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      inject();
    });
  };

  const onPointerOver = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const trigger = target.closest(NATIVE_TRIGGER_SELECTOR);
    if (trigger instanceof HTMLElement) activeNativeTrigger = trigger;
  };

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("pointerover", onPointerOver, true);
  inject();

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    document.removeEventListener("pointerover", onPointerOver, true);
    for (const action of Array.from(
      document.querySelectorAll(`[${ACTION_ATTRIBUTE}]`),
    )) {
      action.remove();
    }
  };

  context.signal.addEventListener("abort", cleanup, { once: true });
  return cleanup;
}
