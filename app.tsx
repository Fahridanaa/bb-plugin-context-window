// bb-plugin-context-window — frontend entry.
//
// The report lives in a thread panel. BB's context control is the entry point:
// hover opens BB's own popover, and a content script opens the panel on click
// through a hidden thread-scoped action.

import { definePluginApp, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { ContextPanel } from "./components/context/context-panel";
import { mountContextControlClick } from "./content/context-control";

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
    id: "context-control-click",
    mount: mountContextControlClick,
  });
});
