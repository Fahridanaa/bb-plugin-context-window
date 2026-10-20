const OPEN_TRIGGER_SELECTOR = "[data-bb-context-window-trigger]";
const NATIVE_TRIGGER_SELECTOR = 'button[aria-label^="Context window "]';

type ContentScriptContext = {
  signal: AbortSignal;
};

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
    findOpenTrigger(trigger)?.click();
  };

  document.addEventListener("click", onClick, true);
  context.signal.addEventListener(
    "abort",
    () => document.removeEventListener("click", onClick, true),
    { once: true },
  );
}
