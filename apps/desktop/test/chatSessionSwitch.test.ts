import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConvEvent } from "@herdr-pocket/protocol";
import {
  createBufferedEventMerger,
  reconcileSessionEventsBatch,
  resolveSessionTrackTransition,
  type SessionOwner,
} from "../src/lib/chatFold.ts";
import { agentSpaceTopologySig, countsAsDeliveredStreamEvent } from "../src/lib/relay.ts";

const mkUser = (id: string, session: string, ts: number, pos: string, text: string): ConvEvent => ({
  id,
  session,
  ts,
  pos,
  kind: "user_message",
  text,
});

const mkAssistant = (id: string, session: string, ts: number, pos: string, text: string): ConvEvent => ({
  id,
  session,
  ts,
  pos,
  kind: "assistant_message",
  text,
});

test("resolveSessionTrackTransition: transient undefined preserves previous sessionKey so subsequent switch clears old session", () => {
  const agentKey = "mac1/hc:t1fs";
  const sessionA = "claude:6de030f5";
  const sessionB = "claude:9cd03921";

  let track: SessionOwner = { agentKey, sessionKey: sessionA };
  let owner: SessionOwner = { agentKey, sessionKey: sessionA };

  // 1. Transient undefined during `/new`, `/clear`, hostd restart, or Uniflo refresh.
  const t1 = resolveSessionTrackTransition(track, owner, agentKey, undefined);
  assert.equal(t1.switched, false);
  assert.equal(t1.nextTrack.sessionKey, sessionA);
  assert.equal(t1.nextOwner.sessionKey, sessionA);
  track = t1.nextTrack;
  owner = t1.nextOwner;

  // 2. Empty/whitespace string is also treated as transient missing sessionKey.
  const t2 = resolveSessionTrackTransition(track, owner, agentKey, "   ");
  assert.equal(t2.switched, false);
  assert.equal(t2.nextTrack.sessionKey, sessionA);
  assert.equal(t2.nextOwner.sessionKey, sessionA);
  track = t2.nextTrack;
  owner = t2.nextOwner;

  // 3. New session arrives -> MUST detect switch instead of treating as first load!
  const t3 = resolveSessionTrackTransition(track, owner, agentKey, sessionB);
  assert.equal(t3.switched, true);
  assert.deepEqual(t3.nextTrack, { agentKey, sessionKey: sessionB });
  assert.deepEqual(t3.nextOwner, { agentKey, sessionKey: sessionB });
});

test("resolveSessionTrackTransition: handles direct switch, agent switch, and initial session binding", () => {
  // Initial mount with undefined -> first real session is not a switch
  const init = resolveSessionTrackTransition(
    { agentKey: "mac1/hc:t1fs", sessionKey: null },
    { agentKey: "mac1/hc:t1fs", sessionKey: null },
    "mac1/hc:t1fs",
    "claude:6de030f5",
  );
  assert.equal(init.switched, false);
  assert.equal(init.nextOwner.sessionKey, "claude:6de030f5");

  // Direct switch A -> B
  const direct = resolveSessionTrackTransition(
    init.nextTrack,
    init.nextOwner,
    "mac1/hc:t1fs",
    "claude:9cd03921",
  );
  assert.equal(direct.switched, true);
  assert.equal(direct.nextOwner.sessionKey, "claude:9cd03921");

  // Agent switch (even when new agent has no sessionKey yet)
  const agentSwitch = resolveSessionTrackTransition(
    direct.nextTrack,
    direct.nextOwner,
    "mac1/hc:other",
    undefined,
  );
  assert.equal(agentSwitch.switched, true);
  assert.deepEqual(agentSwitch.nextTrack, { agentKey: "mac1/hc:other", sessionKey: null });
  assert.deepEqual(agentSwitch.nextOwner, { agentKey: "mac1/hc:other", sessionKey: null });
});

test("image-2.png scenario: Session A (pos 4672406, 18:55) -> transient undefined -> Session B (pos 86466, 14:08) cleanly shows only Session B", () => {
  const agentKey = "mac1/hc:t1fs";
  const sessionA = "claude:6de030f5";
  const sessionB = "claude:9cd03921";
  const tsYesterday1855 = Date.parse("2026-11-27T18:55:00+08:00");
  const tsToday1408 = Date.parse("2026-11-28T14:08:00+08:00");

  const sessionAEvents: ConvEvent[] = [
    mkUser("a-u1", sessionA, tsYesterday1855 - 10_000, "4672100", "昨天的任务"),
    mkAssistant("a-m1", sessionA, tsYesterday1855, "4672406", "昨天 18:55 的旧回复"),
  ];
  const sessionBEvents: ConvEvent[] = [
    mkUser("b-u1", sessionB, tsToday1408 - 5_000, "86200", "今天 14:08 的新任务"),
    mkAssistant("b-m1", sessionB, tsToday1408, "86466", "今天 14:08 的新回复"),
  ];

  // Initial state: Chat loaded Session A
  let track: SessionOwner = { agentKey, sessionKey: sessionA };
  let owner: SessionOwner = { agentKey, sessionKey: sessionA };
  let events: ConvEvent[] = [];

  const loadA = reconcileSessionEventsBatch({
    kind: "initial",
    prevEvents: events,
    owner,
    track,
    requestAgentKey: agentKey,
    requestSessionKey: sessionA,
    responseSessionKey: sessionA,
    responseEvents: sessionAEvents,
    more: true,
    nextBefore: "4672000",
  });
  assert.equal(loadA.action, "merge");
  events = loadA.events;
  owner = loadA.nextOwner;
  assert.deepEqual(events.map((e) => e.id), ["a-u1", "a-m1"]);
  assert.equal(loadA.olderCursor, "4672000");

  // Step 1: `/new` causes transient agent.sessionKey === undefined
  const tDrop = resolveSessionTrackTransition(track, owner, agentKey, undefined);
  assert.equal(tDrop.switched, false);
  track = tDrop.nextTrack;
  owner = tDrop.nextOwner;
  assert.equal(track.sessionKey, sessionA);

  // Step 2: New session B arrives on agent.sessionKey -> detected as switch, state reset!
  const tNew = resolveSessionTrackTransition(track, owner, agentKey, sessionB);
  assert.equal(tNew.switched, true);
  track = tNew.nextTrack;
  owner = tNew.nextOwner;
  events = [];

  // Step 3: Initial page for Session B lands (with lower pos=86466 < 4672406)
  const loadB = reconcileSessionEventsBatch({
    kind: "initial",
    prevEvents: events,
    owner,
    track,
    requestAgentKey: agentKey,
    requestSessionKey: sessionB,
    responseSessionKey: sessionB,
    responseEvents: sessionBEvents,
    more: false,
    nextBefore: null,
    forceReplace: tNew.switched,
  });
  assert.equal(loadB.action, "replace");
  assert.equal(loadB.olderCursor, null);
  assert.deepEqual(loadB.events.map((e) => e.id), ["b-u1", "b-m1"]);
  assert.equal(loadB.events.some((e) => e.session === sessionA), false);
});

test("reconcileSessionEventsBatch: res.sessionKey mismatch on initial/reopened/poll/recovery REPLACES instead of merging", () => {
  const agentKey = "mac1/hc:t1fs";
  const sessionA = "claude:6de030f5";
  const sessionB = "claude:9cd03921";
  const ownerA: SessionOwner = { agentKey, sessionKey: sessionA };

  const staleEvents: ConvEvent[] = [
    mkUser("a-u1", sessionA, 1_000, "4672100", "old prompt"),
    mkAssistant("a-m1", sessionA, 2_000, "4672406", "old reply at 18:55"),
  ];
  const freshEvents: ConvEvent[] = [
    mkUser("b-u1", sessionB, 9_000, "86200", "new prompt"),
    mkAssistant("b-m1", sessionB, 10_000, "86466", "new reply at 14:08"),
  ];

  for (const kind of ["initial", "reopened", "poll", "recovery"] as const) {
    const res = reconcileSessionEventsBatch({
      kind,
      prevEvents: staleEvents,
      owner: ownerA,
      track: ownerA,
      requestAgentKey: agentKey,
      requestSessionKey: sessionA,
      responseSessionKey: sessionB,
      responseEvents: freshEvents,
      more: true,
      nextBefore: "86000",
    });

    assert.equal(res.action, "replace", `kind=${kind} must replace on sessionKey mismatch`);
    assert.equal(res.sessionChanged, true, `kind=${kind} must flag sessionChanged`);
    assert.deepEqual(res.nextOwner, { agentKey, sessionKey: sessionB });
    assert.equal(res.olderCursor, "86000");
    assert.deepEqual(
      res.events.map((e) => e.id),
      ["b-u1", "b-m1"],
      `kind=${kind} must NOT keep old session events with higher pos`,
    );
  }

  // Empty new session on poll/recovery also clears stale events cleanly
  const emptySwitch = reconcileSessionEventsBatch({
    kind: "poll",
    prevEvents: staleEvents,
    owner: ownerA,
    track: ownerA,
    requestAgentKey: agentKey,
    requestSessionKey: sessionA,
    responseSessionKey: sessionB,
    responseEvents: [],
    more: false,
    nextBefore: null,
  });
  assert.equal(emptySwitch.action, "replace");
  assert.equal(emptySwitch.sessionChanged, true);
  assert.deepEqual(emptySwitch.events, []);
  assert.equal(emptySwitch.olderCursor, null);

  // Late response from old session S1 arriving AFTER owner already switched to S2 MUST be discarded.
  const lateS1 = reconcileSessionEventsBatch({
    kind: "initial",
    prevEvents: freshEvents,
    owner: { agentKey, sessionKey: sessionB },
    track: { agentKey, sessionKey: sessionB },
    requestAgentKey: agentKey,
    requestSessionKey: sessionA,
    responseSessionKey: sessionA,
    responseEvents: staleEvents,
    more: true,
    nextBefore: "4672000",
  });
  assert.equal(lateS1.action, "discard");
  assert.equal(lateS1.sessionChanged, false);
  assert.deepEqual(lateS1.nextOwner, { agentKey, sessionKey: sessionB });
  assert.equal(lateS1.events, freshEvents);
});

test("reconcileSessionEventsBatch: loadOlder discards stale or mismatched session responses and merges matching pages", () => {
  const agentKey = "mac1/hc:t1fs";
  const sessionA = "claude:6de030f5";
  const sessionB = "claude:9cd03921";

  const currentB: ConvEvent[] = [
    mkUser("b-u2", sessionB, 10_000, "86466", "latest B"),
  ];
  const oldSessionAPage: ConvEvent[] = [
    mkUser("a-u0", sessionA, 1_000, "4670000", "stale A older page"),
  ];

  // Case 1: loadOlder was requested for Session A, but session switched to Session B while in flight
  const switchedInFlight = reconcileSessionEventsBatch({
    kind: "older",
    prevEvents: currentB,
    owner: { agentKey, sessionKey: sessionB },
    track: { agentKey, sessionKey: sessionB },
    requestAgentKey: agentKey,
    requestSessionKey: sessionA,
    responseSessionKey: sessionA,
    responseEvents: oldSessionAPage,
    more: true,
    nextBefore: "4660000",
    beforeCursor: "4672000",
  });
  assert.equal(switchedInFlight.action, "discard");
  assert.equal(switchedInFlight.events, currentB);
  assert.equal(switchedInFlight.olderCursor, undefined);

  // Case 2: Track/owner still on Session A, but hostd already switched and returned Session B for loadOlder
  const hostSwitched = reconcileSessionEventsBatch({
    kind: "older",
    prevEvents: oldSessionAPage,
    owner: { agentKey, sessionKey: sessionA },
    track: { agentKey, sessionKey: sessionA },
    requestAgentKey: agentKey,
    requestSessionKey: sessionA,
    responseSessionKey: sessionB,
    responseEvents: currentB,
    more: false,
    nextBefore: null,
    beforeCursor: "4672000",
  });
  assert.equal(hostSwitched.action, "discard");
  assert.equal(hostSwitched.events, oldSessionAPage);
  assert.equal(hostSwitched.olderCursor, undefined);

  // Case 3: Agent switched while loadOlder was in flight
  const agentSwitched = reconcileSessionEventsBatch({
    kind: "older",
    prevEvents: currentB,
    owner: { agentKey: "mac1/hc:other", sessionKey: sessionB },
    track: { agentKey: "mac1/hc:other", sessionKey: sessionB },
    requestAgentKey: agentKey,
    requestSessionKey: sessionB,
    responseSessionKey: sessionB,
    responseEvents: oldSessionAPage,
    more: true,
    nextBefore: "100",
    beforeCursor: "86466",
  });
  assert.equal(agentSwitched.action, "discard");

  // Case 4: Valid same-session loadOlder prepends cleanly and updates cursor
  const olderB: ConvEvent[] = [mkUser("b-u1", sessionB, 9_000, "86200", "earlier B")];
  const validOlder = reconcileSessionEventsBatch({
    kind: "older",
    prevEvents: currentB,
    owner: { agentKey, sessionKey: sessionB },
    track: { agentKey, sessionKey: sessionB },
    requestAgentKey: agentKey,
    requestSessionKey: sessionB,
    responseSessionKey: sessionB,
    responseEvents: olderB,
    more: true,
    nextBefore: "86000",
    beforeCursor: "86466",
  });
  assert.equal(validOlder.action, "merge");
  assert.deepEqual(validOlder.events.map((e) => e.id), ["b-u1", "b-u2"]);
  assert.equal(validOlder.olderCursor, "86000");
});

test("createBufferedEventMerger: onInitialPage with replace clears queued pre-switch liveBatch and signals replace", async () => {
  const calls: Array<{ ids: string[]; replace: boolean }> = [];
  const merger = createBufferedEventMerger((batch, options) => {
    calls.push({ ids: batch.map((e) => e.id), replace: Boolean(options?.replace) });
  }, 5000);

  // Simulate already-ready merger (un-hibernated tab with old events) receiving a stale live frame
  merger.onInitialReady();
  merger.onStreamEvent(mkAssistant("stale-live", "claude:6de030f5", 100, "4672406", "stale"));

  // Before the 16ms live flush fires, initial page arrives with a new session (replace: true)
  merger.onInitialPage([mkAssistant("fresh-page", "claude:9cd03921", 200, "86466", "fresh")], { replace: true });

  await new Promise((r) => setTimeout(r, 30));
  merger.dispose();

  assert.deepEqual(calls, [{ ids: ["fresh-page"], replace: true }]);
});

test("relay helpers: agentSpaceTopologySig ignores status/cost/context churn and detects where/cwd/key changes", () => {
  const base = [
    { key: "mac1/hc:t1", where: "Main / tab1", cwd: "/repo/a" },
    { key: "mac1/hc:t2", where: "Main / tab2", cwd: "/repo/b" },
  ];
  const sameTopo = [
    { key: "mac1/hc:t1", where: "Main / tab1", cwd: "/repo/a" },
    { key: "mac1/hc:t2", where: "Main / tab2", cwd: "/repo/b" },
  ];
  assert.equal(agentSpaceTopologySig(base), agentSpaceTopologySig(sameTopo));

  const movedSpace = [
    { key: "mac1/hc:t1", where: "Other / tab1", cwd: "/repo/a" },
    { key: "mac1/hc:t2", where: "Main / tab2", cwd: "/repo/b" },
  ];
  assert.notEqual(agentSpaceTopologySig(base), agentSpaceTopologySig(movedSpace));

  const changedCwd = [
    { key: "mac1/hc:t1", where: "Main / tab1", cwd: "/repo/c" },
    { key: "mac1/hc:t2", where: "Main / tab2", cwd: "/repo/b" },
  ];
  assert.notEqual(agentSpaceTopologySig(base), agentSpaceTopologySig(changedCwd));

  const addedAgent = [
    ...base,
    { key: "mac1/hc:t3", where: "Main / tab3", cwd: "/repo/d" },
  ];
  assert.notEqual(agentSpaceTopologySig(base), agentSpaceTopologySig(addedAgent));
});

test("relay helpers: countsAsDeliveredStreamEvent only counts actual terminal output frames for terminal streams", () => {
  assert.equal(countsAsDeliveredStreamEvent("terminal", { kind: "terminal_data", data: "aGk=" }), true);
  assert.equal(countsAsDeliveredStreamEvent("terminal", { kind: "terminal", screen: { text: "hi" } }), true);
  assert.equal(countsAsDeliveredStreamEvent("terminal", { kind: "terminal_rows", lines: ["hi"] }), true);

  assert.equal(countsAsDeliveredStreamEvent("terminal", { kind: "stale" }), false);
  assert.equal(countsAsDeliveredStreamEvent("terminal", { kind: "alive" }), false);
  assert.equal(countsAsDeliveredStreamEvent("terminal", { kind: "portal_event", event: {} }), false);
  assert.equal(countsAsDeliveredStreamEvent("terminal", { kind: "queue", items: [] }), false);
  assert.equal(countsAsDeliveredStreamEvent("terminal", null), false);

  // Non-terminal streams still count normally
  assert.equal(countsAsDeliveredStreamEvent("session", { kind: "session", event: {} }), true);
  assert.equal(countsAsDeliveredStreamEvent("session", { kind: "stale" }), true);
});
