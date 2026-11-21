// Unit tests for desktop IME-safe Enter handling (src/lib/composerKeys.ts) and
// media/file classification helpers (src/lib/dropPreview.ts). Run with `pnpm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { IME_GUARD_MS, composerEnterAction, createImeGate } from "../src/lib/composerKeys.ts";
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

  // Alt+Enter triggers immediate steer send only when allowSteer=true, and still honors IME composition guard.
  assert.equal(
    composerEnterAction({ key: "Enter", shiftKey: false, altKey: true, ctrlKey: false, metaKey: false }, gate, 6000, true),
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
