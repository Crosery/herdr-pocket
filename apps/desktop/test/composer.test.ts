// Unit tests for desktop IME-safe Enter handling (src/lib/composerKeys.ts) and
// media/file classification helpers (src/lib/dropPreview.ts). Run with `pnpm test`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  IME_GUARD_MS,
  MAX_TEXTAREA_PX,
  MIN_TEXTAREA_PX,
  composerEnterAction,
  createImeGate,
  resizeComposerTextarea,
} from "../src/lib/composerKeys.ts";
import {
  dropKindOf,
  extensionOf,
  formatDropBytes,
  kindBadge,
  looksBinary,
  mediaTypeFor,
} from "../src/lib/dropPreview.ts";

test("composerEnterAction: active IME composition and WKWebView post-compositionend Enter never send", () => {
  const gate = createImeGate();

  // Normal Enter sends when not composing.
  assert.equal(
    composerEnterAction({ key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }, gate, 1000),
    "submit",
  );

  // Shift+Enter inserts a newline.
  assert.equal(
    composerEnterAction({ key: "Enter", shiftKey: true, altKey: false, ctrlKey: false, metaKey: false }, gate, 1000),
    "pass",
  );

  // isComposing / keyCode 229 / gate.composing pass through to the IME.
  assert.equal(
    composerEnterAction(
      { key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: true },
      gate,
      1000,
    ),
    "pass",
  );
  assert.equal(
    composerEnterAction(
      { key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, keyCode: 229 },
      gate,
      1000,
    ),
    "pass",
  );
  assert.equal(
    composerEnterAction(
      { key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false },
      { composing: true, compositionEndedAt: 0 },
      1000,
    ),
    "pass",
  );

  // macOS WKWebView fires compositionend milliseconds before keydown("Enter") when committing
  // raw English words like "dsh" in Pinyin: swallowed cleanly, neither sending nor inserting a newline.
  const justCommitted = { composing: false, compositionEndedAt: 5000 };
  assert.equal(
    composerEnterAction({ key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }, justCommitted, 5003),
    "swallow",
  );
  assert.equal(
    composerEnterAction(
      { key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false },
      justCommitted,
      5000 + IME_GUARD_MS - 1,
    ),
    "swallow",
  );

  // Once the 80 ms guard window passes, pressing Enter submits normally.
  assert.equal(
    composerEnterAction(
      { key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false },
      justCommitted,
      5000 + IME_GUARD_MS,
    ),
    "submit",
  );

  // Repeat Enter, Alt+Enter, Ctrl+Meta+Enter swallow; Cmd/Ctrl+Enter submit; non-Enter passes.
  assert.equal(
    composerEnterAction({ key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, repeat: true }, gate, 6000),
    "swallow",
  );
  assert.equal(
    composerEnterAction({ key: "Enter", shiftKey: false, altKey: true, ctrlKey: false, metaKey: false }, gate, 6000),
    "swallow",
  );
  assert.equal(
    composerEnterAction({ key: "Enter", shiftKey: false, altKey: false, ctrlKey: true, metaKey: true }, gate, 6000),
    "swallow",
  );
  assert.equal(
    composerEnterAction({ key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: true }, gate, 6000),
    "submit",
  );
  assert.equal(
    composerEnterAction({ key: "a", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }, gate, 6000),
    "pass",
  );

  // Alt+Enter and Cmd/Ctrl+Enter trigger soft steer send when allowSteer=true, and still honor IME guard.
  assert.equal(
    composerEnterAction({ key: "Enter", shiftKey: false, altKey: true, ctrlKey: false, metaKey: false }, gate, 6000, true),
    "steer",
  );
  assert.equal(
    composerEnterAction({ key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: true }, gate, 6000, true),
    "steer",
  );
  assert.equal(
    composerEnterAction(
      { key: "Enter", shiftKey: false, altKey: true, ctrlKey: false, metaKey: false, isComposing: true },
      gate,
      6000,
      true,
    ),
    "pass",
  );
  assert.equal(
    composerEnterAction(
      { key: "Enter", shiftKey: false, altKey: true, ctrlKey: false, metaKey: false },
      justCommitted,
      5005,
      true,
    ),
    "swallow",
  );
});

test("dropPreview: medium classification, MIME inference, extension badges, byte sizes and binary guard", () => {
  assert.equal(extensionOf("foo/bar.TSX"), "tsx");
  assert.equal(extensionOf(".gitignore"), "");

  assert.equal(dropKindOf("shot.webp", "image/webp"), "image");
  assert.equal(dropKindOf("demo.mp4", ""), "video");
  assert.equal(dropKindOf("voice.mp3", ""), "audio");
  assert.equal(dropKindOf("spec.pdf", ""), "pdf");
  assert.equal(dropKindOf("brief.md", ""), "text");
  assert.equal(dropKindOf("metrics.csv", "application/octet-stream"), "text");
  assert.equal(dropKindOf("proposal.docx", ""), "document");
  assert.equal(dropKindOf("bundle.tgz", ""), "archive");
  assert.equal(dropKindOf("Makefile", ""), "file");

  assert.equal(mediaTypeFor("spec.pdf", "text/plain"), "application/pdf");
  assert.equal(mediaTypeFor("clip.mp4", ""), "video/mp4");
  assert.equal(kindBadge("metrics.csv"), "CSV");
  assert.equal(kindBadge(".gitignore"), "");
  assert.equal(kindBadge("archive.tar.gz"), "GZ");
  assert.equal(formatDropBytes(245), "245 B");
  assert.equal(formatDropBytes(1536), "1.5 KB");
  assert.equal(looksBinary("hello\nworld"), false);
  assert.equal(looksBinary("abc\u0000def"), true);
  assert.equal(looksBinary("bad\uFFFDutf8"), true);
});

test("AgentsView & AssistantView keep composer textarea uncontrolled during voice/IME composition", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const composerSrc = readFileSync(resolve(root, "src/lib/composerKeys.ts"), "utf8");
  assert.equal(composerSrc.includes("if (evComposing)"), true);
  assert.equal(composerSrc.includes("defaultValue: value"), true);
  assert.equal(composerSrc.includes("resizeComposerTextarea(el, false)"), true);
  const agentsSrc = readFileSync(resolve(root, "src/views/AgentsView.tsx"), "utf8");
  assert.equal(agentsSrc.includes("composer.clearValue()"), true);
  assert.equal(/<textarea[\s\S]{0,400}\{\.\.\.composer\.textareaProps\}[\s\S]{0,600}value=\{/.test(agentsSrc), false);
  const assistantSrc = readFileSync(resolve(root, "src/views/AssistantView.tsx"), "utf8");
  assert.equal(assistantSrc.includes("clearComposerRef.current()"), true);
  assert.equal(/<textarea[\s\S]{0,200}\{\.\.\.composer\.textareaProps\}[\s\S]{0,200}value=\{/.test(assistantSrc), false);
});

test("resizeComposerTextarea always collapses empty input to single line and guards against collapsed-width bloat (image-138 regression)", () => {
  const makeFakeTextarea = (opts: {
    value: string;
    clientWidth: number;
    clientHeight: number;
    scrollHeight: number;
    scrollTop?: number;
    height?: string;
    overflowY?: string;
  }) => {
    const el = {
      value: opts.value,
      clientWidth: opts.clientWidth,
      clientHeight: opts.clientHeight,
      scrollHeight: opts.scrollHeight,
      scrollLeft: 0,
      scrollTop: opts.scrollTop ?? 0,
      style: {
        height: opts.height ?? `${opts.clientHeight}px`,
        overflowY: opts.overflowY ?? "hidden",
      },
    };
    return el as unknown as HTMLTextAreaElement;
  };

  // 1. Empty value MUST collapse from 200px back to MIN_TEXTAREA_PX even if scrollHeight is stale or composing is true!
  const emptyAfterDictation = makeFakeTextarea({
    value: "",
    clientWidth: 700,
    clientHeight: 200,
    scrollHeight: 240,
    scrollTop: 80,
    height: "200px",
    overflowY: "auto",
  });
  resizeComposerTextarea(emptyAfterDictation, true);
  assert.equal(emptyAfterDictation.style.height, `${MIN_TEXTAREA_PX}px`);
  assert.equal(emptyAfterDictation.style.overflowY, "hidden");
  assert.equal(emptyAfterDictation.scrollTop, 0);

  const emptyWhileHidden = makeFakeTextarea({
    value: "",
    clientWidth: 0,
    clientHeight: 200,
    scrollHeight: 260,
    height: "200px",
  });
  resizeComposerTextarea(emptyWhileHidden, false);
  assert.equal(emptyWhileHidden.style.height, `${MIN_TEXTAREA_PX}px`);
  assert.equal(emptyWhileHidden.style.overflowY, "hidden");

  // 2. Non-empty text in a hidden/collapsed container (clientWidth < 32) must NOT overwrite height with bloated scrollHeight.
  const collapsedNarrow = makeFakeTextarea({
    value: "hello",
    clientWidth: 8,
    clientHeight: 36,
    scrollHeight: 300,
    height: "36px",
  });
  resizeComposerTextarea(collapsedNarrow, false);
  assert.equal(collapsedNarrow.style.height, "36px");

  // 3. Multi-line non-empty text grows cleanly up to MAX_TEXTAREA_PX and enables vertical scroll when exceeding it.
  const tallText = makeFakeTextarea({
    value: "line\n".repeat(12),
    clientWidth: 700,
    clientHeight: 36,
    scrollHeight: 280,
    scrollTop: 42,
    height: "36px",
  });
  resizeComposerTextarea(tallText, false);
  assert.equal(tallText.style.height, `${MAX_TEXTAREA_PX}px`);
  assert.equal(tallText.style.overflowY, "auto");
  assert.equal(tallText.scrollTop, 42);
});
