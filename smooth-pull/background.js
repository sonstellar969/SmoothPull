"use strict";

const reloadingTabs = new Set();

browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "pull-to-refresh-reload" || sender.tab?.id == null) {
    return;
  }

  const tabId = sender.tab.id;
  if (reloadingTabs.has(tabId)) return;
  reloadingTabs.add(tabId);

  // Reload the tab that originated the gesture, rather than relying on a
  // page-level location.reload() call from the content script.
  return browser.tabs.reload(tabId).catch(() => {
    reloadingTabs.delete(tabId);
  });
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") reloadingTabs.delete(tabId);
});
