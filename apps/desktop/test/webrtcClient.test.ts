import assert from "node:assert/strict";
import { test } from "node:test";
import { WEBRTC_CHUNK_CHARS } from "@herdr-pocket/protocol";
import { mergeWebRtcCandidates, splitWebRtcRpcPayload } from "../src/lib/direct.ts";
import { buildPortalP2pUrl } from "../src/lib/portalClient.ts";

test("splitWebRtcRpcPayload respects both character and UTF-8 byte bounds and handles surrogate pairs", () => {
  const emojiText = "🎉🚀".repeat(8000); // 16k chars, 32k code units, ~64 KB UTF-8
  const parts = splitWebRtcRpcPayload(emojiText, WEBRTC_CHUNK_CHARS, 44 * 1024);
  assert.ok(parts.length >= 2);
  const enc = new TextEncoder();
  for (const p of parts) {
    assert.ok(enc.encode(p).byteLength <= 44 * 1024);
    assert.ok(p.length <= WEBRTC_CHUNK_CHARS);
  }
  assert.equal(parts.join(""), emojiText);
});

test("mergeWebRtcCandidates injects trickled candidates before end-of-candidates and strips virtual/TUN IPs", () => {
  const baseSdp = [
    "v=0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "a=candidate:1 1 udp 2130706431 198.18.0.1 5555 typ host",
    "a=candidate:2 1 udp 2130706431 192.168.1.50 5556 typ host",
    "a=end-of-candidates",
    "",
  ].join("\r\n");

  const merged = mergeWebRtcCandidates(baseSdp, [
    "candidate:2 1 udp 2130706431 192.168.1.50 5556 typ host",
    "candidate:3 1 udp 1694498815 123.45.67.89 41234 typ srflx raddr 192.168.1.50 rport 5556",
    "candidate:4 1 udp 2130706431 169.254.10.1 5557 typ host",
  ]);

  assert.equal(merged.includes("198.18.0.1"), false);
  assert.equal(merged.includes("169.254.10.1"), false);
  assert.equal(merged.includes("123.45.67.89 41234 typ srflx"), true);
  assert.ok(merged.indexOf("123.45.67.89") < merged.indexOf("a=end-of-candidates"));
  assert.equal(merged.match(/192\.168\.1\.50/g)?.length, 2); // host candidate + srflx raddr
});

test("buildPortalP2pUrl blocks non-loopback HTTP URLs on https:// browser origins while allowing loopback", () => {
  const g = globalThis as unknown as { window?: { location?: { protocol?: string } } };
  const prevWin = g.window;
  try {
    g.window = { location: { protocol: "https:" } };
    assert.equal(
      buildPortalP2pUrl("h1", { token: "tok", entryPath: "a.mp4", port: 7421, addrs: ["192.168.1.10"] }, { addr: "192.168.1.10", port: 7421 }),
      null,
    );
    assert.equal(
      buildPortalP2pUrl("h1", { token: "tok", entryPath: "a.mp4", port: 7421, addrs: ["127.0.0.1"] }, { addr: "127.0.0.1", port: 7421 }),
      "http://127.0.0.1:7421/v1/portal-fs/tok/a.mp4",
    );
  } finally {
    if (prevWin === undefined) delete g.window;
    else g.window = prevWin;
  }
});
