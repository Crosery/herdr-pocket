import assert from "node:assert/strict";
import test from "node:test";
import { extractImageTargets } from "../src/lib/chatImages.ts";

test("extractImageTargets extracts local markdown, file URIs, and paths while skipping http URLs", () => {
  const hits = extractImageTargets([
    "Generated ![shot](file:///Users/demo/screen-1.png) and also /tmp/diagram.webp",
    "Ignore https://example.com/remote.png and check artifacts/chart.jpg?v=1",
    "[Image #1] ~/Desktop/capture.JPG",
  ]);
  assert.deepEqual(hits, [
    "file:///Users/demo/screen-1.png",
    "/tmp/diagram.webp",
    "artifacts/chart.jpg",
    "~/Desktop/capture.JPG",
  ]);
});
