// bb-plugin-context-window — frontend entry.
//
// The report lives in a thread panel. BB's context popover is the entry point:
// a content script adds a "Full breakdown" button, and a hidden thread header
// action opens the panel when that button asks it to.

import { definePluginApp, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { ContextPanel } from "./components/context/context-panel";
import { mountContextPopoverAction } from "./content/context-popover";

function OpenPanelBridge() {
  const navigate = useBbNavigate();

  return (
    <button
      type="button"
      hidden
      data-bb-context-window-trigger=""
      onClick={(event) => {
        event.stopPropagation();
        navigate.openThreadPanel({
          actionId: "context-window",
          title: "Context window",
        });
      }}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "context-window-open",
    title: "Context window",
    component: OpenPanelBridge,
  });

  app.slots.threadPanelAction({
    id: "context-window",
    title: "Context window",
    icon: "Gauge",
    component: ContextPanel,
    layout: "padded",
  });

  app.contentScripts.register({
    id: "context-popover-action",
    mount: mountContextPopoverAction,
  });
});
