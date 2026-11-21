import assert from "node:assert/strict";
import test from "node:test";
import type { Agent, Device, SpaceInfo } from "@herdr-pocket/protocol";
import { buildHostSpaces, spaceColorVars } from "../src/shell/spaceSync.ts";

const devices: Record<string, Device> = {
  mac1: { id: "mac1", name: "Mac", kind: "host", platform: "darwin", online: true, createdAt: 1, lastSeenAt: 1 },
};

const mkAgent = (id: string, where: string, status: Agent["status"]): Agent => ({
  key: `mac1/hc:${id}`,
  localId: id,
  source: "hc",
  deviceId: "mac1",
  harness: "claude",
  title: id,
  where,
  status,
  updatedAt: 100,
});

test("spaceColorVars maps Herdr ansi1..ansi6 and raw hex cleanly", () => {
  assert.deepEqual(spaceColorVars("ansi6"), {
    fg: "#06b6d4",
    bg: "color-mix(in srgb, #06b6d4 18%, transparent)",
  });
  assert.deepEqual(spaceColorVars("#ec4899"), {
    fg: "#ec4899",
    bg: "color-mix(in srgb, #ec4899 18%, transparent)",
  });
  assert.equal(spaceColorVars(undefined), null);
});

test("buildHostSpaces preserves exact Herdr order, empty spaces, colors, and appends orphans", () => {
  const hostSpaces: SpaceInfo[] = [
    { id: "sp1", name: "First", folder: "/a", tabs: 1, terminals: 1, color: "ansi6", active: true },
    { id: "sp2", name: "Empty", folder: "/b", tabs: 0, terminals: 0, color: "ansi3" },
    { id: "sp3", name: "Third", folder: "/c", tabs: 2, terminals: 2, color: "ansi5" },
  ];
  const hostAgents: Agent[] = [
    mkAgent("a3", "Third / tab1", "blocked"),
    mkAgent("a1", "First / tab1", "idle"),
    mkAgent("a4", "Orphan / tab1", "working"),
  ];
  const res = buildHostSpaces("mac1", hostSpaces, hostAgents, devices);
  assert.deepEqual(
    res.map((s) => ({ name: s.name, count: s.count, blocked: s.blocked, best: s.best, color: s.color })),
    [
      { name: "First", count: 1, blocked: 0, best: "idle", color: "ansi6" },
      { name: "Empty", count: 0, blocked: 0, best: "idle", color: "ansi3" },
      { name: "Third", count: 1, blocked: 1, best: "blocked", color: "ansi5" },
      { name: "Orphan", count: 1, blocked: 0, best: "working", color: undefined },
    ],
  );
});
