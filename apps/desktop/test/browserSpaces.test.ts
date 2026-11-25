import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import {
  browserSpacesStore,
  closeBrowserTab,
  controlAiBrowserSpace,
  createUserBrowserSpace,
  deleteBrowserSpace,
  openBrowserTab,
  removeBrowserBookmark,
  selectBrowserSpace,
  selectBrowserTab,
  updateBrowserTab,
} from "../src/lib/browserSpaces.ts";

afterEach(() => {
  const cur = browserSpacesStore.get();
  for (const sp of [...cur.spaces]) {
    if (sp.id !== "default") deleteBrowserSpace(sp.id);
  }
  for (const bm of [...browserSpacesStore.get().bookmarks]) {
    removeBrowserBookmark(bm.url);
  }
  selectBrowserSpace("default");
});

test("multi-space and multi-tab lifecycle keeps default space resilient", () => {
  const init = browserSpacesStore.get();
  assert.equal(init.activeSpaceId, "default");
  assert.equal(init.spaces.length, 1);

  const work = createUserBrowserSpace("研发预览", "https://localhost:3000");
  assert.equal(browserSpacesStore.get().activeSpaceId, work.id);
  assert.equal(work.tabs.length, 1);

  const tab2 = openBrowserTab(work.id, "https://pocket.example.com/docs", "Docs");
  const cur = browserSpacesStore.get();
  const foundWork = cur.spaces.find((s) => s.id === work.id);
  assert.ok(foundWork);
  assert.equal(foundWork.tabs.length, 2);
  assert.equal(foundWork.activeTabId, tab2);

  selectBrowserTab(work.id, work.tabs[0]!.id);
  assert.equal(
    browserSpacesStore.get().spaces.find((s) => s.id === work.id)?.activeTabId,
    work.tabs[0]!.id,
  );

  // Closing the last tab of a user space deletes that space; default space cannot be deleted.
  closeBrowserTab(work.id, tab2);
  closeBrowserTab(work.id, work.tabs[0]!.id);
  assert.equal(browserSpacesStore.get().spaces.some((s) => s.id === work.id), false);
  assert.equal(browserSpacesStore.get().activeSpaceId, "default");

  deleteBrowserSpace("default");
  assert.equal(browserSpacesStore.get().spaces.some((s) => s.id === "default"), true);
});

test("bookmarks track https updates and AI ownership transitions handle handoff/takeover/resume", () => {
  const sp = createUserBrowserSpace("AI Task");
  const tabId = sp.activeTabId;

  updateBrowserTab(tabId, { url: "about:blank", title: "Blank" });
  assert.equal(browserSpacesStore.get().bookmarks.length, 0);

  updateBrowserTab(tabId, { url: "https://github.com/Crosery/herdr-pocket", title: "Herdr Pocket" });
  assert.deepEqual(browserSpacesStore.get().bookmarks, [
    { url: "https://github.com/Crosery/herdr-pocket", title: "Herdr Pocket" },
  ]);

  removeBrowserBookmark("https://github.com/Crosery/herdr-pocket");
  assert.equal(browserSpacesStore.get().bookmarks.length, 0);

  controlAiBrowserSpace(sp.id, "handoff", "需要人工验证码");
  let updated = browserSpacesStore.get().spaces.find((s) => s.id === sp.id)!;
  assert.equal(updated.ownership, "agentHandoff");
  assert.equal(updated.handoffReason, "需要人工验证码");

  controlAiBrowserSpace(sp.id, "takeover");
  updated = browserSpacesStore.get().spaces.find((s) => s.id === sp.id)!;
  assert.equal(updated.ownership, "user");
  assert.equal(updated.handoffReason, undefined);

  controlAiBrowserSpace(sp.id, "resume");
  updated = browserSpacesStore.get().spaces.find((s) => s.id === sp.id)!;
  assert.equal(updated.ownership, "agentWorking");
});
