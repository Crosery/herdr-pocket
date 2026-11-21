import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";
import {
  clearComposerDraft,
  getComposerDraft,
  resetComposerDraftsForTest,
  setComposerDraftAttachments,
  setComposerDraftText,
} from "../src/lib/composerDrafts";

const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

beforeEach(() => {
  store.clear();
  resetComposerDraftsForTest();
});

test("preserves unsent text and attachments independently per agent across tab switches", () => {
  setComposerDraftText("host1/hc:t1", "继续修复 P2P 文件鉴权");
  setComposerDraftAttachments("host1/hc:t1", [
    {
      id: "att-1",
      name: "shot.png",
      mime: "image/png",
      size: 1200,
      kind: "image",
      dataBase64: "AAAA",
    },
  ]);

  setComposerDraftText("host1/hc:t2", "切换另一个对话框");

  assert.equal(getComposerDraft("host1/hc:t2").text, "切换另一个对话框");
  assert.equal(getComposerDraft("host1/hc:t2").attachments.length, 0);

  const restored = getComposerDraft("host1/hc:t1");
  assert.equal(restored.text, "继续修复 P2P 文件鉴权");
  assert.equal(restored.attachments.length, 1);
  assert.equal(restored.attachments[0]?.name, "shot.png");

  clearComposerDraft("host1/hc:t1");
  assert.equal(getComposerDraft("host1/hc:t1").text, "");
  assert.equal(getComposerDraft("host1/hc:t1").attachments.length, 0);
  assert.equal(getComposerDraft("host1/hc:t2").text, "切换另一个对话框");
});
