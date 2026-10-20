import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { mountContextControlClick } from "../content/context-control.ts";

type State = "closed" | "open-plugin" | "open-other";

type Options = {
  state?: State;
  heading?: "on" | "off";
  hide?: boolean;
};

const THREAD_KEY = "bb.thread.fixedPanelTabsState-thr_test-1";

function rect(x: number) {
  return {
    x,
    y: 80,
    width: 20,
    height: 20,
    top: 80,
    left: x,
    right: x + 20,
    bottom: 100,
    toJSON: () => ({}),
  } as DOMRect;
}

function makeHide(window: Window, x: number, onClick: () => void) {
  const button = window.document.createElement("button") as unknown as HTMLButtonElement;
  button.setAttribute("aria-label", "Hide right panel (Ctrl + J)");
  button.getBoundingClientRect = () => rect(x);
  button.addEventListener("click", onClick);
  return button;
}

function fixture(options: Options = {}) {
  const window = new Window({ url: "http://localhost/threads/thr_test" });
  globalThis.window = window as unknown as Window & typeof globalThis;
  globalThis.document = window.document as unknown as Document;
  globalThis.location = window.location as unknown as Location;
  globalThis.localStorage = window.localStorage as unknown as Storage;
  globalThis.Element = window.Element as unknown as typeof Element;
  globalThis.HTMLElement = window.HTMLElement as unknown as typeof HTMLElement;
  globalThis.MouseEvent = window.MouseEvent as unknown as typeof MouseEvent;

  const document = window.document;
  const native = document.createElement("button") as unknown as HTMLButtonElement;
  native.setAttribute("aria-label", "Context window 12% used");
  native.setAttribute("data-testid", "native");
  document.body.append(native);

  let opened = 0;
  const openTrigger = document.createElement("button") as unknown as HTMLButtonElement;
  openTrigger.setAttribute("data-bb-context-window-trigger", "");
  openTrigger.addEventListener("click", () => opened++);
  document.body.append(openTrigger);

  let closed = 0;
  if (options.hide !== false) {
    document.body.append(makeHide(window, 80, () => closed++));
  }

  if (options.heading) {
    const heading = document.createElement("h2");
    heading.textContent = "Current context window";
    heading.getBoundingClientRect = () => rect(options.heading === "on" ? 300 : 2000);
    document.body.append(heading);
  }

  if (options.state === "open-plugin" || options.state === "open-other") {
    localStorage.setItem(
      THREAD_KEY,
      JSON.stringify({
        secondary: {
          isOpen: true,
          activeTabId:
            options.state === "open-plugin"
              ? "plugin-panel:context-window%3Acontext-window%3A:none"
              : "thread-info",
        },
      }),
    );
  }

  const controller = new AbortController();
  mountContextControlClick({ signal: controller.signal });

  return {
    window,
    native,
    openTrigger,
    opened: () => opened,
    closed: () => closed,
    cleanup: () => {
      controller.abort();
      window.close();
    },
  };
}

test("a closed panel opens on a control click", (t) => {
  const f = fixture();
  t.after(f.cleanup);

  f.native.click();

  assert.equal(f.opened(), 1);
  assert.equal(f.closed(), 0);
});

test("an open plugin panel closes on a control click", (t) => {
  const f = fixture({ state: "open-plugin" });
  t.after(f.cleanup);

  f.native.click();

  assert.equal(f.closed(), 1);
  assert.equal(f.opened(), 0);
});

test("another open panel tab opens the plugin panel", (t) => {
  const f = fixture({ state: "open-other" });
  t.after(f.cleanup);

  f.native.click();

  assert.equal(f.opened(), 1);
  assert.equal(f.closed(), 0);
});

test("an on-screen heading counts as open without stored state", (t) => {
  const f = fixture({ heading: "on" });
  t.after(f.cleanup);

  f.native.click();

  assert.equal(f.closed(), 1);
  assert.equal(f.opened(), 0);
});

test("an off-screen heading does not count as open", (t) => {
  const f = fixture({ heading: "off" });
  t.after(f.cleanup);

  f.native.click();

  assert.equal(f.opened(), 1);
  assert.equal(f.closed(), 0);
});

test("only the visible hide control is clicked", (t) => {
  const f = fixture({ state: "open-plugin", hide: false });
  t.after(f.cleanup);

  let offscreen = 0;
  let visible = 0;
  f.window.document.body.append(makeHide(f.window, 2000, () => offscreen++));
  f.window.document.body.append(makeHide(f.window, 80, () => visible++));

  f.native.click();

  assert.equal(visible, 1);
  assert.equal(offscreen, 0);
  assert.equal(f.opened(), 0);
});

test("a non-primary click is ignored", (t) => {
  const f = fixture({ state: "open-plugin" });
  t.after(f.cleanup);

  f.native.dispatchEvent(
    new f.window.MouseEvent("click", { button: 2, bubbles: true, cancelable: true }),
  );

  assert.equal(f.closed(), 0);
  assert.equal(f.opened(), 0);
});
