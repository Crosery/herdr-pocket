import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { WebSocket, WebSocketServer } from "ws";
import { LIVE_CLIENT_ACTIONS, type ClientAiTelemetry, type LogEntry } from "@herdr-pocket/protocol";
import { Relay } from "../src/server.ts";
import { CallTelemetry, cleanPhoneMessage } from "../src/assistant/live.ts";
import type { EventInput } from "../src/eventlog.ts";
import type { Llm } from "../src/assistant/llm.ts";

const ADMIN = "admin-telemetry-test-token-012345";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pcm16 = (samples: number, value: number): Buffer => {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(value, i * 2);
  return b;
};

class Sock {
  frames: any[] = [];
  binary: Buffer[] = [];
  private waiters: Array<{ pred: (f: any) => boolean; resolve: (f: any) => void }> = [];
  ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (d, isBinary) => {
      if (isBinary) {
        this.binary.push(Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer));
        return;
      }
      const f = JSON.parse(d.toString());
      const w = this.waiters.find((x) => x.pred(f));
      if (w) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(f);
      } else this.frames.push(f);
    });
  }
  static open(url: string): Promise<Sock> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const s = new Sock(ws);
      ws.once("open", () => resolve(s));
      ws.once("error", reject);
    });
  }
  next(pred: (f: any) => boolean, ms = 3000): Promise<any> {
    const hit = this.frames.find(pred);
    if (hit) {
      this.frames.splice(this.frames.indexOf(hit), 1);
      return Promise.resolve(hit);
    }
    const err = new Error(`timeout waiting for ${pred.toString().slice(0, 120)}`);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(err), ms);
      this.waiters.push({ pred, resolve: (f) => (clearTimeout(t), resolve(f)) });
    });
  }
  send(f: unknown) {
    this.ws.send(JSON.stringify(f));
  }
}

test("cleanPhoneMessage: client.ai_telemetry is in LIVE_CLIENT_ACTIONS and always returns null so MOSS-Live never sees it", () => {
  assert.ok((LIVE_CLIENT_ACTIONS as readonly string[]).includes("client.ai_telemetry"));
  const payload: ClientAiTelemetry = {
    stage: "utterance",
    route: "speaker",
    sv_score: 0.81,
    tse_atten_db: -1.5,
    enh_dbfs: -18.2,
  };
  assert.equal(cleanPhoneMessage({ action: "client.ai_telemetry", data: payload }, () => "t1"), null);
  // Even if run_id and turn_id were attached, it must never slip through the playback.* branch.
  assert.equal(cleanPhoneMessage({ action: "client.ai_telemetry", run_id: "r1", turn_id: "t1", data: payload }, () => "t1"), null);
  // Existing phone controls still pass cleanly.
  assert.deepEqual(cleanPhoneMessage({ action: "mic_state", enabled: false }, () => undefined), { action: "mic_state", enabled: false });
});

test("CallTelemetry: deterministic PCM continuity/clarity math, rate-limiting,log fallback, and <20us per frame", () => {
  let clock = 10_000;
  const events: EventInput[] = [];
  const logs: string[] = [];
  const tel = new CallTelemetry({
    callId: "c1234567",
    provider: "moss-live",
    deviceId: "dev_phone",
    log: (m) => logs.push(m),
    event: (e) => events.push(e),
    now: () => clock,
    windowMs: 0,
  });

  // 20 ms frame before session ready -> counted as pre_ready_dropped_ms.
  tel.onPreReadyBinary(pcm16(320, 4000));
  tel.onReady();

  // Frame 1 at t=10000: 20 ms (320 samples) at amplitude 16384 (-6.02 dBFS).
  tel.onRxPcm(pcm16(320, 16384));
  // Frame 2 at t=10020 (20 ms gap): 20 ms exact digital zero (2 hops of 160 samples).
  clock += 20;
  tel.onRxPcm(pcm16(320, 0));
  // Frame 3 at t=10150 (130 ms gap -> >80 ms stall): 20 ms with 2 clipped extremes and rest 16384.
  clock += 130;
  const f3 = pcm16(320, 16384);
  f3.writeInt16LE(32767, 0);
  f3.writeInt16LE(-32768, 2);
  tel.onRxPcm(f3);

  tel.flushWindow();
  const winEv = events.find((e) => e.data?.stage === "rx_window")!;
  assert.ok(winEv);
  assert.equal(winEv.kind, "live.ai");
  assert.equal(winEv.level, "warn");
  assert.equal(winEv.device, "dev_phone");
  assert.equal(winEv.data!.callId, "c1234567");
  assert.equal(winEv.data!.rx_frames, 3);
  assert.equal(winEv.data!.rx_audio_ms, 60);
  assert.equal(winEv.data!.rx_gap_max_ms, 130);
  assert.equal(winEv.data!.rx_gaps_over_80ms, 1);
  assert.equal(winEv.data!.rx_zero_ratio, 0.333);
  assert.equal(winEv.data!.rx_clipped_samples, 2);
  assert.equal(winEv.data!.rx_peak_dbfs, 0);
  assert.ok(Number(winEv.data!.rx_active_dbfs) > -6.1 && Number(winEv.data!.rx_active_dbfs) < -5.9);

  // Mute pause should not register as a network stall gap.
  tel.onMicState(false);
  clock += 5000;
  tel.onMicState(true);
  tel.onRxPcm(pcm16(320, 8192));
  clock += 20;
  tel.onRxPcm(pcm16(320, 8192));

  // Rate limit: max 60 client.ai_telemetry events per 60s window.
  const beforeAi = events.length;
  for (let i = 0; i < 75; i++) {
    tel.onClientTelemetry({
      action: "client.ai_telemetry",
      data: {
        stage: "utterance",
        sv_score: 0.72,
        tse_atten_db: -2.1,
        text: "MUST_BE_STRIPPED_IF_MISUSED",
      },
    });
  }
  const aiLogged = events.slice(beforeAi);
  // 60 utterance events + 1 rate_limited warning = 61 events; 15 dropped.
  assert.equal(aiLogged.filter((e) => e.data?.stage === "utterance").length, 60);
  assert.equal(aiLogged.filter((e) => e.data?.stage === "rate_limited").length, 1);
  assert.ok(!JSON.stringify(aiLogged).includes("MUST_BE_STRIPPED_IF_MISUSED"));

  // Next minute window resets budget; warn thresholds trigger warn level.
  clock += 60_000;
  tel.onClientTelemetry({
    action: "client.ai_telemetry",
    data: { stage: "periodic", tse_rtf: 0.9, ws_gap_max_ms: 40, tse_overruns: 0 },
  });
  assert.equal(events[events.length - 1]!.level, "warn");

  tel.onStop("挂断了");
  const sum = events.find((e) => e.data?.stage === "call_summary")!;
  assert.equal(sum.data!.pre_ready_dropped_ms, 20);
  assert.equal(sum.data!.rx_frames, 5);
  assert.equal(sum.data!.rx_audio_ms, 100);
  assert.equal(sum.data!.rx_gap_max_ms, 130);
  assert.equal(sum.data!.rx_gaps_over_80ms, 1);
  assert.equal(sum.data!.client_ai_events, 76);
  assert.equal(sum.data!.client_ai_dropped, 15);

  // Fallback to `log` when `event` is omitted in standalone unit tests.
  const fallbackLogs: string[] = [];
  const fb = new CallTelemetry({ callId: "fb01", provider: "moss-live", deviceId: "d1", log: (m) => fallbackLogs.push(m), windowMs: 0 });
  fb.onClientTelemetry({ action: "client.ai_telemetry", data: { stage: "init", route: "bt" } });
  fb.onStop("ok");
  assert.ok(fallbackLogs.every((l) => l.startsWith("live.ai: ")));

  // Zero-copy PCM analyzer speed benchmark: 2,000 x 20ms frames must average well under 20 microseconds/frame.
  const benchBuf = pcm16(320, 12000);
  const benchTel = new CallTelemetry({ callId: "bench", provider: "moss-live", deviceId: "d1", log: () => {}, event: () => {}, windowMs: 0 });
  benchTel.onReady();
  for (let i = 0; i < 200; i++) benchTel.onRxPcm(benchBuf); // warm up JIT
  const t0 = performance.now();
  const N = 2000;
  for (let i = 0; i < N; i++) benchTel.onRxPcm(benchBuf);
  const usPerFrame = ((performance.now() - t0) * 1000) / N;
  assert.ok(usPerFrame < 20, `expected <20us/frame, got ${usPerFrame.toFixed(2)}us/frame`);
});

test("MOSS-Live end-to-end telemetry: EventLog live.ai correlation, upstream protection, turn latencies, privacy, and /admin hint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pocket-live-tel-"));
  const moss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => moss.once("listening", () => r()));
  const mossPort = (moss.address() as { port: number }).port;
  const llm: Llm = async () => ({ content: [{ type: "text", text: "好" }], stopReason: "end_turn", model: "test" });
  const relay = new Relay({
    dbPath: join(dir, "t.db"),
    adminToken: ADMIN,
    log: () => {},
    llm,
    live: {
      url: `ws://127.0.0.1:${mossPort}/v1/live`,
      apiKey: "moss-secret-key",
      model: "moss-live-1.0",
      refreshGapMs: 0,
    },
  });
  const base = `http://127.0.0.1:${await relay.listen(0, "127.0.0.1")}`;

  const api = async (path: string, init: { token?: string; body?: unknown } = {}) => {
    const res = await fetch(base + path, {
      method: init.body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, text, json };
  };

  try {
    // 1. Admin panel `#kind` placeholder highlights live.ai & voice.ai.
    const adminRes = await api("/admin");
    assert.equal(adminRes.status, 200);
    assert.match(adminRes.text, /placeholder="类别，如 live\.ai、voice\.ai、assistant、rpc"/);

    // 2. Pair phone and open MOSS-Live call.
    const code = (await api("/v1/pair/codes", { token: ADMIN, body: { kind: "viewer" } })).json.code;
    const phone = (await api("/v1/pair", { body: { code, name: "Tuning Phone", kind: "viewer" } })).json as {
      token: string;
      device: { id: string };
    };

    const upstream = new Promise<Sock>((resolve) => moss.once("connection", (ws) => resolve(new Sock(ws))));
    const call = await Sock.open(`${base.replace("http", "ws")}/v1/assistant/live?token=${encodeURIComponent(phone.token)}`);
    const up = await upstream;
    await up.next((f) => f.action === "attach_session");

    // Send pre-ready binary PCM (20ms = 640 bytes) + init telemetry before `session.updated`.
    call.ws.send(pcm16(320, 5000));
    call.send({
      action: "client.ai_telemetry",
      data: {
        stage: "init",
        route: "speaker",
        denoise_model: "dpdfnet_baseline",
        tse_enabled: true,
        sv_enabled: true,
        enroll_ms: 3000,
        threshold: 0.56,
        prototypes_count: 5,
      } satisfies ClientAiTelemetry,
    });

    up.send({ action: "session_attached", data: { session_id: "s1", memory_scope: "session", delegation: "client" } });
    await up.next((f) => f.action === "session.update");
    up.send({ action: "session.updated", data: { error: "", tools: [] } });
    await call.next((f) => f.action === "relay.state" && f.data.state === "ready");
    assert.equal(up.binary.length, 0, "pre-ready PCM must not be sent upstream");

    // 3. Stream PCM with an >80ms network gap + exact-zero gated hop + client AI utterance/periodic telemetry.
    call.ws.send(pcm16(320, 12000)); // active speech (-8.72 dBFS)
    await sleep(95); // triggers rx_gaps_over_80ms
    call.ws.send(pcm16(320, 12000));
    call.ws.send(pcm16(320, 0)); // exact-zero silenced frame

    call.send({
      action: "client.ai_telemetry",
      data: {
        stage: "utterance",
        kind: "owner",
        pass: true,
        sv_score: 0.81,
        sv_raw: 0.77,
        sv_proto: 0.88,
        sv_sess: 0.82,
        sv_ms: 16.5,
        used_ms: 1500,
        raw_dbfs: -20.5,
        tse_dbfs: -21.8,
        enh_dbfs: -17.4,
        tse_atten_db: -1.3,
      } satisfies ClientAiTelemetry,
    });
    call.send({
      action: "client.ai_telemetry",
      data: {
        stage: "periodic",
        frames_in: 250,
        frames_out: 250,
        ws_gap_max_ms: 34,
        dpdf_us_avg: 390,
        tse_ms_avg: 12.4,
        tse_rtf: 0.31,
        tse_overruns: 1, // > 0 -> warn level
      } satisfies ClientAiTelemetry,
    });
    await sleep(25);

    // 4. Drive MOSS-Live turn: speech.started -> speech.stopped -> transcript.done & revised -> audio.started -> interrupted.
    const PRIVATE_USER_SPEECH = "绝密私密口令不要写进日志9527";
    const PRIVATE_ASSISTANT_CUT = "绝密助手回答片段8848";

    up.send({ action: "input.speech.started", data: { turn: 1 } });
    await call.next((f) => f.action === "input.speech.started");
    call.ws.send(pcm16(320, 12000));
    await sleep(35);

    up.send({ action: "input.speech.stopped", data: { turn: 1 } });
    await call.next((f) => f.action === "input.speech.stopped");
    await sleep(25);

    up.send({ action: "input.transcript.done", data: { text: PRIVATE_USER_SPEECH, turn: 1 } });
    await call.next((f) => f.action === "input.transcript.done");
    up.send({ action: "input.transcript.revised", data: { text: `${PRIVATE_USER_SPEECH}！`, previous: PRIVATE_USER_SPEECH, turn: 1 } });
    await call.next((f) => f.action === "input.transcript.revised");
    await sleep(25);

    up.send({ action: "response.audio.started", data: { run_id: "run_1", turn_id: "1" } });
    await call.next((f) => f.action === "response.audio.started");
    up.send({ action: "response.interrupted", data: { reason: "playback_timeout", run_id: "run_1", turn_id: "1", text: PRIVATE_ASSISTANT_CUT } });
    await call.next((f) => f.action === "response.interrupted");

    call.send({ action: "relay.hangup" });
    await call.next((f) => f.action === "relay.state" && f.data.state === "closed");
    await sleep(20);

    // 5. Verify upstream never received client.ai_telemetry.
    assert.ok(!up.frames.some((f) => f.action === "client.ai_telemetry"));

    // 6. Query all logs and live.ai logs.
    const allLogs = (await api("/v1/logs?since=1h&limit=2000", { token: ADMIN })).json.entries as LogEntry[];
    assert.ok(!allLogs.some((e) => /dropped malformed/i.test(e.msg)), "client.ai_telemetry must not log dropped malformed");
    assert.ok(!JSON.stringify(allLogs).includes("绝密助手回答片段"), "raw interrupted assistant transcript must never leak to EventLog");

    const aiLogs = (await api(`/v1/logs?kind=live.ai&device=${phone.device.id}`, { token: ADMIN })).json.entries as LogEntry[];
    const sanitizedAiLogs = aiLogs.map(({ ts: _ts, id: _id, ...rest }) => rest);
    assert.ok(!JSON.stringify(sanitizedAiLogs).includes("绝密私密口令"), "raw user transcript must never leak into live.ai telemetry");
    assert.ok(!JSON.stringify(sanitizedAiLogs).includes("9527"), "raw user transcript digits must never leak into live.ai telemetry");
    assert.ok(!JSON.stringify(sanitizedAiLogs).includes("绝密助手回答片段"), "raw assistant transcript must never leak into live.ai telemetry");
    assert.ok(!JSON.stringify(allLogs.filter((e) => e.kind !== "live.heard")).includes("绝密私密口令"));
    assert.ok(aiLogs.length >= 9, `expected >=9 live.ai events, got ${aiLogs.length}`);
    const callIds = new Set(aiLogs.map((e) => e.data?.callId).filter(Boolean));
    assert.equal(callIds.size, 1, "all live.ai entries for one call share the same callId");
    assert.ok(aiLogs.every((e) => e.device === phone.device.id && e.kind === "live.ai"));

    const byStage = (stage: string) => aiLogs.find((e) => e.data?.stage === stage);
    const initEv = byStage("init")!;
    assert.equal(initEv.level, "info");
    assert.equal(initEv.data!.route, "speaker");
    assert.equal(initEv.data!.denoise_model, "dpdfnet_baseline");

    const uttEv = byStage("utterance")!;
    assert.equal(uttEv.level, "info");
    assert.equal(uttEv.data!.sv_score, 0.81);
    assert.equal(uttEv.data!.tse_atten_db, -1.3);

    const perEv = byStage("periodic")!;
    assert.equal(perEv.level, "warn", "tse_overruns > 0 must mark periodic telemetry as warn");

    const startEv = byStage("speech_started")!;
    assert.equal(startEv.data!.turn, 1);
    assert.equal(startEv.data!.sv_score, 0.81);
    assert.ok(Number(startEv.data!.rx_active_dbfs) > -15);

    const stopEv = byStage("speech_stopped")!;
    assert.ok(Number(stopEv.data!.speech_ms) >= 25);

    const asrEv = byStage("asr_done")!;
    assert.equal(asrEv.data!.chars, Array.from(PRIVATE_USER_SPEECH).length);
    assert.ok(Number(asrEv.data!.speech_ms) >= 25);
    assert.ok(Number(asrEv.data!.asr_ms) >= 15);
    assert.equal(asrEv.data!.sv_score, 0.81);
    assert.equal(asrEv.data!.tse_atten_db, -1.3);

    const revEv = byStage("asr_revised")!;
    assert.equal(revEv.data!.chars, Array.from(`${PRIVATE_USER_SPEECH}！`).length);

    const ttfaEv = byStage("ttfa")!;
    assert.equal(ttfaEv.data!.run_id, "run_1");
    assert.ok(Number(ttfaEv.data!.ttfa_ms) >= 40);

    const intEv = byStage("interrupted")!;
    assert.equal(intEv.level, "warn", "playback_timeout interruption must log as warn");
    assert.equal(intEv.data!.reason, "playback_timeout");
    assert.equal(intEv.data!.run_id, "run_1");
    assert.equal(intEv.data!.last_sv_score, 0.81);
    assert.equal(intEv.data!.last_tse_atten_db, -1.3);

    const sumEv = byStage("call_summary")!;
    assert.equal(sumEv.data!.provider, "moss-live");
    assert.equal(sumEv.data!.turns, 1);
    assert.equal(sumEv.data!.pre_ready_dropped_ms, 20);
    assert.equal(sumEv.data!.rx_frames, 4);
    assert.equal(sumEv.data!.rx_audio_ms, 80);
    assert.ok(Number(sumEv.data!.rx_gap_max_ms) >= 80);
    assert.ok(Number(sumEv.data!.rx_gaps_over_80ms) >= 1);
    assert.equal(sumEv.data!.rx_zero_ratio, 0.25); // 1 silent frame out of 4 frames (2 zero hops out of 8 hops)
    assert.ok(Number(sumEv.data!.asr_avg_ms) >= 15);
    assert.ok(Number(sumEv.data!.ttfa_avg_ms) >= 40);
    assert.equal(sumEv.data!.interruptions, 1);
    assert.equal(sumEv.data!.route, "speaker");
    assert.equal(sumEv.data!.sv_score, 0.81);
  } finally {
    await relay.close();
    await new Promise<void>((r) => moss.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenAI Realtime end-to-end telemetry parity: client.ai_telemetry recorded locally and never forwarded upstream", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pocket-rt-tel-"));
  const rt = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => rt.once("listening", () => r()));
  const rtPort = (rt.address() as { port: number }).port;
  const llm: Llm = async () => ({ content: [{ type: "text", text: "好" }], stopReason: "end_turn", model: "test" });
  const relay = new Relay({
    dbPath: join(dir, "t.db"),
    adminToken: ADMIN,
    log: () => {},
    llm,
    live: {
      provider: "openai-realtime",
      url: `ws://127.0.0.1:${rtPort}/v1/realtime`,
      apiKey: "rt-secret-key",
      model: "gpt-realtime",
      transcribeModel: "gpt-4o-mini-transcribe",
      refreshGapMs: 0,
    },
  });
  const base = `http://127.0.0.1:${await relay.listen(0, "127.0.0.1")}`;

  const api = async (path: string, init: { token?: string; body?: unknown } = {}) => {
    const res = await fetch(base + path, {
      method: init.body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    return (await res.json()) as any;
  };

  try {
    const code = (await api("/v1/pair/codes", { token: ADMIN, body: { kind: "viewer" } })).code;
    const phone = (await api("/v1/pair", { body: { code, name: "RT Phone", kind: "viewer" } })) as {
      token: string;
      device: { id: string };
    };

    const upstream = new Promise<Sock>((resolve) => rt.once("connection", (ws) => resolve(new Sock(ws))));
    const call = await Sock.open(`${base.replace("http", "ws")}/v1/assistant/live?token=${encodeURIComponent(phone.token)}`);
    const up = await upstream;
    await up.next((f) => f.type === "session.update");
    up.send({ type: "session.updated", session: {} });
    await call.next((f) => f.action === "relay.state" && f.data.state === "ready");

    call.ws.send(pcm16(320, 9000));
    call.send({
      action: "client.ai_telemetry",
      data: { stage: "utterance", sv_score: 0.76, tse_atten_db: -2.0, route: "wired" },
    });
    up.send({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    await call.next((f) => f.action === "input.speech.started");
    await sleep(20);
    up.send({ type: "input_audio_buffer.speech_stopped", item_id: "u1" });
    await call.next((f) => f.action === "input.speech.stopped");
    up.send({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "私密实时文本ABC" });
    await call.next((f) => f.action === "input.transcript.done");

    call.send({ action: "relay.hangup" });
    await call.next((f) => f.action === "relay.state" && f.data.state === "closed");
    await sleep(20);

    assert.ok(!up.frames.some((f) => f.action === "client.ai_telemetry" || f.type === "client.ai_telemetry"));
    const aiLogs = (await api(`/v1/logs?kind=live.ai&device=${phone.device.id}`, { token: ADMIN })).entries as LogEntry[];
    assert.ok(aiLogs.some((e) => e.data?.stage === "utterance" && e.data?.provider === "openai-realtime" && e.data?.sv_score === 0.76));
    assert.ok(aiLogs.some((e) => e.data?.stage === "asr_done" && e.data?.chars === 9));
    assert.ok(aiLogs.some((e) => e.data?.stage === "call_summary" && e.data?.rx_audio_ms === 20));
    assert.ok(!JSON.stringify(aiLogs).includes("私密实时文本ABC"));
  } finally {
    await relay.close();
    await new Promise<void>((r) => rt.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
