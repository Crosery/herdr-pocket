import assert from "node:assert/strict";
import test from "node:test";
import { native } from "../src/lib/native.ts";
import {
  computePlayoutStartTime,
  createEchoGate,
  createHudSyncScheduler,
  createPlayoutTracker,
  ECHO_BARGE_IN_HOLDOVER_MS,
  ECHO_TAIL_GUARD_MS,
  shouldPublishMeterUpdate,
} from "../src/lib/voiceCall.ts";

const dbfs = (db: number) => Math.pow(10, db / 20);

test("createEchoGate blocks -28 dBFS echo and 260ms tail, allows quiet speech when silent", () => {
  const gate = createEchoGate();
  const echoRms = dbfs(-28); // ~0.0398 < 0.045
  const quietSpeechRms = dbfs(-40); // 0.01

  // Quiet speech passes immediately when speaker is silent.
  const quietSilent = gate.evaluate({
    frameRms: quietSpeechRms,
    outRms: 0,
    speakerPlaying: false,
    lastSpeakerEndedAt: null,
    aecMode: "webrtc-aec",
    now: 100,
  });
  assert.equal(quietSilent.allow, true);
  assert.equal(quietSilent.speakerActive, false);

  // While speaker is playing, -28 dBFS echo is gated to silence.
  for (let i = 0; i < 6; i++) {
    const res = gate.evaluate({
      frameRms: echoRms,
      outRms: 0.08,
      speakerPlaying: true,
      lastSpeakerEndedAt: null,
      aecMode: "webrtc-aec",
      now: 1000 + i * 20,
    });
    assert.equal(res.allow, false);
    assert.equal(res.speakerActive, true);
    assert.equal(res.consecutiveLoudFrames, 0);
  }

  // Within 260ms acoustic tail after speaker stops, -28 dBFS echo stays blocked.
  const tailBlocked = gate.evaluate({
    frameRms: echoRms,
    outRms: 0,
    speakerPlaying: false,
    lastSpeakerEndedAt: 1200,
    aecMode: "webrtc-aec",
    now: 1200 + ECHO_TAIL_GUARD_MS - 1,
  });
  assert.equal(tailBlocked.allow, false);
  assert.equal(tailBlocked.speakerActive, true);

  // Once >= 260ms has passed after speaker stops, quiet user speech passes cleanly.
  const tailCleared = gate.evaluate({
    frameRms: quietSpeechRms,
    outRms: 0,
    speakerPlaying: false,
    lastSpeakerEndedAt: 1200,
    aecMode: "webrtc-aec",
    now: 1200 + ECHO_TAIL_GUARD_MS,
  });
  assert.equal(tailCleared.allow, true);
  assert.equal(tailCleared.speakerActive, false);
});

test("createEchoGate allows -18 dBFS 3-frame barge-in with 280ms holdover and resets cleanly", () => {
  const gate = createEchoGate();
  const bargeRms = dbfs(-18); // ~0.1259

  // Frames 1 and 2 are held back until 3 consecutive loud frames (60ms) confirm barge-in.
  const f1 = gate.evaluate({
    frameRms: bargeRms,
    outRms: 0.1,
    speakerPlaying: true,
    lastSpeakerEndedAt: null,
    aecMode: "webrtc-aec",
    now: 2000,
  });
  assert.equal(f1.allow, false);
  assert.equal(f1.consecutiveLoudFrames, 1);

  const f2 = gate.evaluate({
    frameRms: bargeRms,
    outRms: 0.1,
    speakerPlaying: true,
    lastSpeakerEndedAt: null,
    aecMode: "webrtc-aec",
    now: 2020,
  });
  assert.equal(f2.allow, false);
  assert.equal(f2.consecutiveLoudFrames, 2);

  const f3 = gate.evaluate({
    frameRms: bargeRms,
    outRms: 0.1,
    speakerPlaying: true,
    lastSpeakerEndedAt: null,
    aecMode: "webrtc-aec",
    now: 2040,
  });
  assert.equal(f3.allow, true);
  assert.equal(f3.bargeInActive, true);
  assert.equal(f3.consecutiveLoudFrames, 3);

  // Brief dip between syllables remains open during the 280ms holdover (until 2040 + 280 = 2320).
  const dipInHoldover = gate.evaluate({
    frameRms: 0.01,
    outRms: 0.1,
    speakerPlaying: true,
    lastSpeakerEndedAt: null,
    aecMode: "webrtc-aec",
    now: 2040 + ECHO_BARGE_IN_HOLDOVER_MS - 10,
  });
  assert.equal(dipInHoldover.allow, true);
  assert.equal(dipInHoldover.bargeInActive, true);

  // After 280ms holdover expires, gate closes again while speaker is active.
  const holdoverExpired = gate.evaluate({
    frameRms: 0.01,
    outRms: 0.1,
    speakerPlaying: true,
    lastSpeakerEndedAt: null,
    aecMode: "webrtc-aec",
    now: 2040 + ECHO_BARGE_IN_HOLDOVER_MS,
  });
  assert.equal(holdoverExpired.allow, false);
  assert.equal(holdoverExpired.bargeInActive, false);

  // Reset clears any active barge-in/holdover state immediately.
  for (let i = 0; i < 3; i++) {
    gate.evaluate({
      frameRms: bargeRms,
      outRms: 0.1,
      speakerPlaying: true,
      lastSpeakerEndedAt: null,
      aecMode: "webrtc-aec",
      now: 3000 + i * 20,
    });
  }
  gate.reset();
  const afterReset = gate.evaluate({
    frameRms: 0.01,
    outRms: 0.1,
    speakerPlaying: true,
    lastSpeakerEndedAt: null,
    aecMode: "webrtc-aec",
    now: 3060,
  });
  assert.equal(afterReset.allow, false);
  assert.equal(afterReset.bargeInActive, false);

  // cpal-fallback requires >= max(0.13, outRms * 2.4) for 4 consecutive frames.
  for (let i = 0; i < 3; i++) {
    const c = gate.evaluate({
      frameRms: 0.25,
      outRms: 0.1,
      speakerPlaying: true,
      lastSpeakerEndedAt: null,
      aecMode: "cpal-fallback",
      now: 4000 + i * 20,
    });
    assert.equal(c.allow, false);
  }
  const c4 = gate.evaluate({
    frameRms: 0.25,
    outRms: 0.1,
    speakerPlaying: true,
    lastSpeakerEndedAt: null,
    aecMode: "cpal-fallback",
    now: 4060,
  });
  assert.equal(c4.allow, true);
  assert.equal(c4.consecutiveLoudFrames, 4);
});

test("createPlayoutTracker waits for last queued chunk on response.audio.done and suppresses completed on stop", () => {
  const tracker = createPlayoutTracker();

  assert.equal(tracker.enqueueChunk("run-1", "turn-1", 40), true);
  assert.equal(tracker.enqueueChunk("run-1", "turn-1", 40), true);
  assert.equal(tracker.enqueueChunk("run-1", "turn-1", 40), true);

  // response.audio.done arrives before chunks finish playing: must wait.
  const doneEarly = tracker.markAudioDone("run-1", "turn-1");
  assert.equal(doneEarly.emitCompleted, false);
  assert.equal(doneEarly.allIdle, false);

  assert.deepEqual(tracker.onChunkEnded("run-1"), {
    runCompleted: false,
    turnId: "turn-1",
    allIdle: false,
  });
  assert.deepEqual(tracker.onChunkEnded("run-1"), {
    runCompleted: false,
    turnId: "turn-1",
    allIdle: false,
  });
  assert.deepEqual(tracker.onChunkEnded("run-1"), {
    runCompleted: true,
    turnId: "turn-1",
    allIdle: true,
  });

  // Duplicate audio.done does not double-emit playback.completed.
  assert.equal(tracker.markAudioDone("run-1", "turn-1").emitCompleted, false);

  // Run with 0 queued chunks completes immediately on markAudioDone.
  assert.deepEqual(tracker.markAudioDone("run-empty", "turn-empty"), {
    emitCompleted: true,
    allIdle: true,
  });

  // Interrupted run emits playback.stopped with playedMs and NEVER emits playback.completed.
  assert.equal(tracker.enqueueChunk("run-2", "turn-2", 60), true);
  assert.equal(tracker.enqueueChunk("run-2", "turn-2", 60), true);
  const stopRes = tracker.markStopped("run-2", "turn-2");
  assert.equal(stopRes.playedMs, 120);
  assert.equal(stopRes.turnId, "turn-2");
  assert.equal(stopRes.allIdle, true);
  assert.equal(tracker.isStopped("run-2"), true);
  assert.equal(tracker.enqueueChunk("run-2", "turn-2", 40), false);
  assert.equal(tracker.onChunkEnded("run-2").runCompleted, false);
  assert.equal(tracker.markAudioDone("run-2", "turn-2").emitCompleted, false);

  // 65ms lead cushion at start/underrun, exact concatenation when buffered ahead.
  assert.ok(Math.abs(computePlayoutStartTime(1.0, 0) - 1.065) < 1e-9);
  assert.ok(Math.abs(computePlayoutStartTime(1.0, 1.004) - 1.065) < 1e-9);
  assert.ok(Math.abs(computePlayoutStartTime(1.0, 1.105) - 1.105) < 1e-9);
});

test("12.5 Hz meter delta filter and 85 ms HUD sync scheduler throttle routine updates", () => {
  assert.equal(shouldPublishMeterUpdate({ micLevel: 0.1, outLevel: 0 }, { micLevel: 0.115, outLevel: 0 }), false);
  assert.equal(shouldPublishMeterUpdate({ micLevel: 0.1, outLevel: 0 }, { micLevel: 0.125, outLevel: 0 }), true);
  assert.equal(shouldPublishMeterUpdate({ micLevel: 0.1, outLevel: 0.2 }, { micLevel: 0.1, outLevel: 0.22 }), true);

  let fakeNow = 1000;
  const emits: boolean[] = [];
  const scheduler = createHudSyncScheduler((open) => emits.push(open), () => fakeNow, 85);

  scheduler.markOpened();
  assert.deepEqual(emits, [true]);

  // First state key sync flushes immediately.
  scheduler.sync("ready|idle|false");
  assert.equal(emits.length, 2);

  // Meter-only updates inside 85ms window are suppressed (scheduled trailing instead of immediate spam).
  fakeNow = 1030;
  scheduler.sync("ready|idle|false");
  fakeNow = 1060;
  scheduler.sync("ready|idle|false");
  assert.equal(emits.length, 2);

  // Once >= 85ms has elapsed, meter update goes through.
  fakeNow = 1090;
  scheduler.sync("ready|idle|false");
  assert.equal(emits.length, 3);

  // State/phase/caption transition flushes immediately regardless of 85ms window.
  fakeNow = 1100;
  scheduler.sync("ready|speaking|false");
  assert.equal(emits.length, 4);

  scheduler.dispose();
});

test("native DSP bindings degrade cleanly outside Tauri", async () => {
  const openInfo = await native.voiceCallDspOpen();
  assert.deepEqual(openInfo, { active: false, badge: null });

  const proc = await native.voiceCallDspProcess("AAAA");
  assert.deepEqual(proc, { pcmBase64: "AAAA", level: 0 });

  await native.voiceCallDspClose();
});
