import { spawn, type ChildProcess } from "node:child_process";
import type { TerminalDisplay } from "@herdr-pocket/protocol";
import { KittyHostStream } from "./kittyHost.ts";
import { defaultHcBin } from "./platform.ts";
import { Screen } from "./vt.ts";

/** Frame kinds of `hc connect` in framed mode (herdr-app src/hc.rs). */
const DATA = 0;
const CREDIT = 1;
const CLOSE = 2;
const RESIZE = 3;
const FACTS = 5;
const AUTOMATIC_INPUT = 6;
const HEADER = 9;

/** Decodes whether the terminal most recently enabled (`?2004h`) or disabled (`?2004l`) bracketed paste. */
export function scanBracketedPaste(chunk: string, prev: boolean): boolean {
  const onIdx = chunk.lastIndexOf("\x1b[?2004h");
  const offIdx = chunk.lastIndexOf("\x1b[?2004l");
  if (onIdx < 0 && offIdx < 0) return prev;
  return onIdx > offIdx;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

function sanitizeDisplay(d?: TerminalDisplay): Record<string, unknown> | undefined {
  if (!d || typeof d !== "object") return undefined;
  const out: Record<string, unknown> = {};
  if (typeof d.fg === "string" && HEX_COLOR.test(d.fg)) out.fg = d.fg;
  if (typeof d.bg === "string" && HEX_COLOR.test(d.bg)) out.bg = d.bg;
  if (typeof d.cursor === "string" && HEX_COLOR.test(d.cursor)) out.cursor = d.cursor;
  if (Array.isArray(d.cell) && d.cell.length === 2) {
    const w = clampInt(d.cell[0], 1, 200, 0);
    const h = clampInt(d.cell[1], 1, 200, 0);
    if (w > 0 && h > 0) out.cell = [w, h];
  }
  return Object.keys(out).length ? out : undefined;
}

function encode(channel: number, kind: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(HEADER);
  h.writeUInt32LE(channel, 0);
  h[4] = kind;
  h.writeUInt32LE(payload.length, 5);
  return Buffer.concat([h, payload]);
}

export interface ScreenSnapshot {
  /** Screen (and history above it) with SGR colors; one line per row. */
  ansi: string;
  text: string;
  cols: number;
  rows: number;
  altScreen?: boolean;
  bracketedPaste?: boolean;
}

/** One paint of a watched terminal: the `ansi` of a snapshot as its lines. */
export interface ScreenLines {
  lines: string[];
  /** Plain text of the same rows, only when the watch asked for it. */
  text?: string;
  cols: number;
  rows: number;
}

/**
 * Colored screen snapshots from herdr-core. Keeps one framed `hc connect`
 * open; each snapshot attaches as a watch-only observer (never types or
 * resizes), replays the paint into a screen model, then detaches.
 */
const WATCH_MIN_INTERVAL_MS = 100;

export class HcScreens {
  private hcBin: string;
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private replies = new Map<number, (msg: any) => void>();
  private streams = new Map<number, (kind: number, payload: Buffer) => void>();
  private early = new Map<number, Array<[number, Buffer]>>();
  private supportsAutoInput = false;

  constructor(hcBin = defaultHcBin()) {
    this.hcBin = hcBin;
  }

  private connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const child = spawn(this.hcBin, ["connect"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      this.child = child;
      let framed = false;
      child.stdout!.on("data", (d: Buffer) => {
        this.buf = Buffer.concat([this.buf, d]);
        if (!framed) {
          const nl = this.buf.indexOf(10);
          if (nl < 0) return;
          const hello = JSON.parse(this.buf.subarray(0, nl).toString());
          this.buf = this.buf.subarray(nl + 1);
          if (hello.error) {
            reject(new Error(hello.error.message ?? "hc refused hello"));
            child.kill();
            return;
          }
          const features = hello.result?.features;
          this.supportsAutoInput = Array.isArray(features) && features.includes("automatic_input");
          framed = true;
          resolve();
        }
        this.drain();
      });
      const lost = () => {
        if (this.child !== child) return;
        this.child = null;
        this.ready = null;
        this.supportsAutoInput = false;
        this.buf = Buffer.alloc(0);
        for (const r of this.replies.values()) r({ error: { message: "lost hc" } });
        this.replies.clear();
        for (const s of this.streams.values()) s(CLOSE, Buffer.alloc(0));
        this.streams.clear();
        this.early.clear();
        if (!framed) reject(new Error("hc connect exited"));
      };
      child.stdin?.on("error", () => lost());
      child.on("exit", lost);
      child.on("error", lost);
      if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
        try {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "hello", params: { framed: true } })}\n`, (err) => {
            if (err) lost();
          });
        } catch {
          lost();
        }
      }
    });
    return this.ready;
  }

  private drain(): void {
    while (this.buf.length >= HEADER) {
      const channel = this.buf.readUInt32LE(0);
      const kind = this.buf[4]!;
      const len = this.buf.readUInt32LE(5);
      if (this.buf.length < HEADER + len) return;
      const payload = this.buf.subarray(HEADER, HEADER + len);
      this.buf = this.buf.subarray(HEADER + len);
      if (channel === 0) {
        let msg: any;
        try {
          msg = JSON.parse(payload.toString());
        } catch {
          continue;
        }
        const r = typeof msg.id === "number" ? this.replies.get(msg.id) : undefined;
        if (r) {
          this.replies.delete(msg.id);
          r(msg);
        }
        continue;
      }
      const s = this.streams.get(channel);
      if (s) s(kind, Buffer.from(payload));
      else this.early.set(channel, [...(this.early.get(channel) ?? []), [kind, Buffer.from(payload)]]);
    }
  }

  private send(channel: number, kind: number, payload: Buffer): void {
    const child = this.child;
    const stdin = child?.stdin;
    if (!child || !stdin || stdin.destroyed || !stdin.writable) return;
    try {
      stdin.write(encode(channel, kind, payload), (err) => {
        if (err && this.child === child) {
          this.child = null;
          this.ready = null;
          this.supportsAutoInput = false;
          this.buf = Buffer.alloc(0);
          for (const r of this.replies.values()) r({ error: { message: "lost hc" } });
          this.replies.clear();
          for (const s of this.streams.values()) s(CLOSE, Buffer.alloc(0));
          this.streams.clear();
          this.early.clear();
        }
      });
    } catch {
      if (this.child === child) {
        this.child = null;
        this.ready = null;
        this.supportsAutoInput = false;
      }
    }
  }

  private async call(method: string, params: unknown, timeoutMs = 8000): Promise<any> {
    await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.replies.delete(id);
        reject(new Error(`${method}: no reply from hc`));
      }, timeoutMs);
      this.replies.set(id, (msg) => {
        clearTimeout(t);
        if (msg.error) reject(new Error(msg.error.message ?? `${method} failed`));
        else resolve(msg.result);
      });
      this.send(0, DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
    });
  }

  /**
   * Attaches as an observer, waits until the paint settles (quietMs without
   * new bytes, at most maxMs), and returns the rendered screen.
   */
  async snapshot(terminal: string, history = 200, quietMs = 60, maxMs = 1500): Promise<ScreenSnapshot> {
    // Observers see the terminal at its own size; cols/rows here are only required fields.
    const r = await this.call("terminal.attach", { terminal, cols: 80, rows: 24, history, observe: true });
    const channel: number = r.channel;
    const cols: number = r.terminal?.cols ?? 80;
    const rows: number = r.terminal?.rows ?? 24;
    const screen = new Screen(cols, rows, history);
    const decoder = new TextDecoder("utf-8");

    await new Promise<void>((resolve) => {
      let quiet: NodeJS.Timeout | undefined;
      const done = () => {
        clearTimeout(quiet);
        clearTimeout(cap);
        this.streams.delete(channel);
        resolve();
      };
      const cap = setTimeout(done, maxMs);
      const onFrame = (kind: number, payload: Buffer) => {
        if (kind === CLOSE) return done();
        if (kind !== DATA) return;
        screen.write(decoder.decode(payload, { stream: true }));
        clearTimeout(quiet);
        quiet = setTimeout(done, quietMs);
      };
      this.streams.set(channel, onFrame);
      for (const [kind, p] of this.early.get(channel) ?? []) onFrame(kind, p);
      this.early.delete(channel);
      const credit = Buffer.alloc(4);
      credit.writeUInt32LE(8 * 1024 * 1024);
      this.send(channel, CREDIT, credit);
      quiet = setTimeout(done, Math.max(quietMs, 600)); // first paint may take a moment
    });
    this.send(channel, CLOSE, Buffer.alloc(0));
    return {
      ansi: screen.toAnsi(history),
      text: screen.toText(history),
      cols,
      rows,
      altScreen: screen.isAltScreen,
      bracketedPaste: screen.bracketedPaste,
    };
  }

  /**
   * Keep one observer attached and emit coalesced screen paints. The returned
   * stop function closes that observer; it is safe to call more than once.
   */
  async watch(
    terminal: string,
    history: number,
    onUpdate: (paint: ScreenLines) => void,
    onError: (error: Error) => void,
    opts: { text?: boolean } = {},
  ): Promise<() => void> {
    const r = await this.call("terminal.attach", { terminal, cols: 80, rows: 24, history, observe: true });
    const channel: number = r.channel;
    const cols: number = r.terminal?.cols ?? 80;
    const rows: number = r.terminal?.rows ?? 24;
    const screen = new Screen(cols, rows, history);
    const decoder = new TextDecoder("utf-8");
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let lastAt = 0;
    let last: string[] | undefined;
    const emit = () => {
      timer = undefined;
      if (stopped) return;
      const lines = screen.ansiLines(history);
      // Spinners and cursor blinks repaint without changing what is shown.
      if (last && last.length === lines.length && lines.every((l, i) => l === last![i])) return;
      last = lines;
      lastAt = Date.now();
      onUpdate({ lines, text: opts.text === false ? undefined : screen.toText(history), cols, rows });
    };
    const finish = () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      this.streams.delete(channel);
      this.send(channel, CLOSE, Buffer.alloc(0));
    };
    const onFrame = (kind: number, payload: Buffer) => {
      if (stopped) return;
      if (kind === CLOSE) {
        finish();
        return;
      }
      if (kind !== DATA) return;
      screen.write(decoder.decode(payload, { stream: true }));
      // First paint goes out at once; after that at most ~10 frames a second.
      if (!timer) timer = setTimeout(emit, Math.max(40, WATCH_MIN_INTERVAL_MS - (Date.now() - lastAt)));
    };
    this.streams.set(channel, onFrame);
    for (const [kind, p] of this.early.get(channel) ?? []) onFrame(kind, p);
    this.early.delete(channel);
    const credit = Buffer.alloc(4);
    credit.writeUInt32LE(32 * 1024 * 1024);
    this.send(channel, CREDIT, credit);
    // Caller can stop synchronously even while the initial frame is arriving.
    return finish;
  }

  private inputs = new Map<
    string,
    { channel: Promise<number>; firstPaint: Promise<void>; bracketedPaste: boolean; automaticInput: boolean; timer?: NodeJS.Timeout }
  >();
  private activeRaw = new Map<
    string,
    Set<{ channel: number; cols: number; rows: number; bracketedPaste: boolean; automaticInput: boolean }>
  >();

  /**
   * Attaches to a terminal and streams raw PTY/VT bytes (`TerminalDataEvent` upstream)
   * with initial scrollback and optional viewer display facts, enabling Kitty graphics,
   * text sizing (OSC 66), and keyboard protocol pass-through in desktop clients.
   */
  async watchRaw(
    terminal: string,
    opts: { cols?: number; rows?: number; history?: number; display?: TerminalDisplay },
    onData: (chunk: Buffer, cols: number, rows: number) => void,
    _onError: (error: Error) => void,
  ): Promise<() => void> {
    const reqCols = clampInt(opts.cols, 20, 500, 80);
    const reqRows = clampInt(opts.rows, 5, 200, 24);
    const history = clampInt(opts.history, 0, 4000, 2000);
    const display = sanitizeDisplay(opts.display);
    const r = await this.call("terminal.attach", {
      terminal,
      cols: reqCols,
      rows: reqRows,
      history,
      observe: false,
      ...(display ? { display } : {}),
    });
    const channel: number = r.channel;
    const automaticInput = this.supportsAutoInput && Boolean(r.automatic_input);
    let curCols: number = clampInt(r.terminal?.cols, 20, 500, reqCols);
    let curRows: number = clampInt(r.terminal?.rows, 5, 200, reqRows);
    const rawEntry = { channel, cols: curCols, rows: curRows, bracketedPaste: false, automaticInput };
    let set = this.activeRaw.get(terminal);
    if (!set) {
      set = new Set();
      this.activeRaw.set(terminal, set);
    }
    set.add(rawEntry);

    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let consumedBytes = 0;
    let lastEmitAt = 0;
    const MAX_CHUNK = 192 * 1024;
    const kittyStream = new KittyHostStream();

    const flush = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (!pending.length || stopped) {
        pending = [];
        pendingBytes = 0;
        return;
      }
      const combined = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      lastEmitAt = Date.now();
      for (let off = 0; off < combined.length; off += MAX_CHUNK) {
        onData(combined.subarray(off, off + MAX_CHUNK), curCols, curRows);
      }
    };

    const finish = () => {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      pending = [];
      pendingBytes = 0;
      const curSet = this.activeRaw.get(terminal);
      if (curSet) {
        curSet.delete(rawEntry);
        if (!curSet.size) this.activeRaw.delete(terminal);
      }
      this.streams.delete(channel);
      this.send(channel, CLOSE, Buffer.alloc(0));
    };

    const onFrame = (kind: number, payload: Buffer) => {
      if (stopped) return;
      if (kind === CLOSE) {
        if (pending.length) flush();
        finish();
        return;
      }
      if (kind === RESIZE && payload.length >= 4) {
        curCols = clampInt(payload.readUInt16LE(0), 20, 500, curCols);
        curRows = clampInt(payload.readUInt16LE(2), 5, 200, curRows);
        rawEntry.cols = curCols;
        rawEntry.rows = curRows;
        return;
      }
      if (kind !== DATA) return;
      if (payload.length) {
        consumedBytes += payload.length;
        if (consumedBytes >= 4 * 1024 * 1024) {
          const ack = Buffer.alloc(4);
          ack.writeUInt32LE(consumedBytes);
          consumedBytes = 0;
          this.send(channel, CREDIT, ack);
        }
        const processed = kittyStream.push(payload);
        if (processed.autoReplies.length) {
          const replyKind = automaticInput ? AUTOMATIC_INPUT : DATA;
          for (const reply of processed.autoReplies) {
            this.send(channel, replyKind, reply);
          }
        }
        if (processed.outBytes.length) {
          rawEntry.bracketedPaste = scanBracketedPaste(processed.outBytes.toString("utf8"), rawEntry.bracketedPaste);
          pending.push(processed.outBytes);
          pendingBytes += processed.outBytes.length;
        }
      }
      if (!pendingBytes) return;
      const elapsed = Date.now() - lastEmitAt;
      if (pendingBytes >= MAX_CHUNK || elapsed >= 12) {
        flush();
      } else if (!timer) {
        timer = setTimeout(flush, 8);
      }
    };

    this.streams.set(channel, onFrame);
    for (const [kind, p] of this.early.get(channel) ?? []) onFrame(kind, p);
    this.early.delete(channel);
    const credit = Buffer.alloc(4);
    credit.writeUInt32LE(16 * 1024 * 1024);
    this.send(channel, CREDIT, credit);
    return finish;
  }

  /** Resizes active raw attachments (or opens a brief attach) and updates display facts. */
  async resize(terminal: string, cols: number, rows: number, display?: TerminalDisplay): Promise<void> {
    const c = clampInt(cols, 20, 500, 80);
    const r = clampInt(rows, 5, 200, 24);
    const d = sanitizeDisplay(display);
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt16LE(c, 0);
    sizeBuf.writeUInt16LE(r, 2);

    const active = this.activeRaw.get(terminal);
    if (active?.size) {
      for (const entry of active) {
        if (d) this.send(entry.channel, FACTS, Buffer.from(JSON.stringify(d)));
        this.send(entry.channel, RESIZE, sizeBuf);
        entry.cols = c;
        entry.rows = r;
      }
      return;
    }

    const existingInput = this.inputs.get(terminal);
    if (existingInput) {
      const ch = await existingInput.channel;
      if (d) this.send(ch, FACTS, Buffer.from(JSON.stringify(d)));
      this.send(ch, RESIZE, sizeBuf);
      return;
    }

    const res = await this.call("terminal.attach", {
      terminal,
      cols: c,
      rows: r,
      history: 0,
      observe: false,
      ...(d ? { display: d } : {}),
    });
    const ch: number = res.channel;
    this.early.delete(ch);
    this.streams.delete(ch);
    if (d) this.send(ch, FACTS, Buffer.from(JSON.stringify(d)));
    this.send(ch, CLOSE, Buffer.alloc(0));
  }

  private refreshInputIdleTimer(
    terminal: string,
    entry: { channel: Promise<number>; firstPaint: Promise<void>; bracketedPaste: boolean; automaticInput: boolean; timer?: NodeJS.Timeout },
    ch: number,
  ): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (this.inputs.get(terminal) !== entry) return;
      this.inputs.delete(terminal);
      this.streams.delete(ch);
      this.send(ch, CLOSE, Buffer.alloc(0));
    }, 20_000);
    entry.timer.unref?.();
  }

  private openInputEntry(
    terminal: string,
    cols: number,
    rows: number,
  ): { channel: Promise<number>; firstPaint: Promise<void>; bracketedPaste: boolean; automaticInput: boolean; timer?: NodeJS.Timeout } {
    const existing = this.inputs.get(terminal);
    if (existing) return existing;

    let resolveFirstPaint!: () => void;
    let paintDone = false;
    let paintTimer: NodeJS.Timeout | undefined;
    const donePaint = () => {
      if (paintDone) return;
      paintDone = true;
      if (paintTimer) clearTimeout(paintTimer);
      resolveFirstPaint();
    };
    const firstPaint = new Promise<void>((resolve) => {
      resolveFirstPaint = resolve;
    });

    const entry: {
      channel: Promise<number>;
      firstPaint: Promise<void>;
      bracketedPaste: boolean;
      automaticInput: boolean;
      timer?: NodeJS.Timeout;
    } = {
      channel: Promise.resolve(0),
      firstPaint,
      bracketedPaste: false,
      automaticInput: false,
    };

    const channel = this.call("terminal.attach", { terminal, cols, rows, observe: false, resumed: true }).then((r) => {
      const ch: number = r.channel;
      entry.automaticInput = this.supportsAutoInput && Boolean(r.automatic_input);
      const onFrame = (kind: number, payload: Buffer) => {
        if (kind === DATA) {
          if (payload.length) {
            entry.bracketedPaste = scanBracketedPaste(payload.toString("utf8"), entry.bracketedPaste);
          }
          donePaint();
          return;
        }
        if (kind !== CLOSE) return;
        donePaint();
        this.streams.delete(ch);
        clearTimeout(entry.timer);
        if (this.inputs.get(terminal) === entry) this.inputs.delete(terminal);
      };
      this.streams.set(ch, onFrame);
      for (const [k, p] of this.early.get(ch) ?? []) onFrame(k, p);
      this.early.delete(ch);
      const credit = Buffer.alloc(4);
      credit.writeUInt32LE(64 * 1024 * 1024);
      this.send(ch, CREDIT, credit);
      if (!paintDone) {
        paintTimer = setTimeout(donePaint, 100);
        paintTimer.unref?.();
      }
      return ch;
    });
    entry.channel = channel;
    this.inputs.set(terminal, entry);
    channel.catch(() => {
      donePaint();
      clearTimeout(entry.timer);
      if (this.inputs.get(terminal) === entry) this.inputs.delete(terminal);
    });
    return entry;
  }

  /**
   * Pastes structured chat text (optionally wrapped in bracketed paste when the terminal
   * opted into `?2004h`) and presses Enter directly on the human input stream, so delivery
   * never blocks on draft quiet timers or `"blocked"` (`需要你`) refusals.
   */
  async paste(terminal: string, text: string, cols: number, rows: number, enter = true): Promise<void> {
    let ch: number;
    let bracketedPaste = false;
    let sharedEntry:
      | { channel: Promise<number>; firstPaint: Promise<void>; bracketedPaste: boolean; automaticInput: boolean; timer?: NodeJS.Timeout }
      | undefined;

    const active = this.activeRaw.get(terminal);
    let latest: { channel: number; cols: number; rows: number; bracketedPaste: boolean; automaticInput?: boolean } | undefined;
    if (active?.size) {
      for (const item of active) latest = item;
    }
    if (latest) {
      ch = latest.channel;
      bracketedPaste = latest.bracketedPaste;
    } else {
      sharedEntry = this.openInputEntry(terminal, cols, rows);
      [ch] = await Promise.all([sharedEntry.channel, sharedEntry.firstPaint]);
      bracketedPaste = sharedEntry.bracketedPaste;
    }

    const clean = text.replace(/\x1b\[20[01]~/g, "");
    if (clean.length > 0) {
      const payload = bracketedPaste
        ? `\x1b[200~${clean.replace(/\r?\n/g, "\r")}\x1b[201~`
        : clean.replace(/\r\n/g, "\n");
      this.send(ch, DATA, Buffer.from(payload, "utf8"));
    }
    if (enter) {
      if (clean.length > 0) {
        await new Promise((r) => setTimeout(r, 140));
      }
      this.send(ch, DATA, Buffer.from("\r", "utf8"));
    }
    if (sharedEntry) {
      this.refreshInputIdleTimer(terminal, sharedEntry, ch);
    }
  }

  /**
   * Types into a terminal the way the person at it would: raw bytes on an
   * attached (not observing) stream, so text of any script arrives at once and
   * in order. Reuses an open raw stream channel when attached.
   * When `auto` is true and `hc` supports `AUTOMATIC_INPUT` on this channel,
   * terminal protocol responses travel via `AUTOMATIC_INPUT (6)`.
   */
  async input(terminal: string, data: string, cols: number, rows: number, auto = false): Promise<void> {
    const active = this.activeRaw.get(terminal);
    if (active?.size) {
      let latest: { channel: number; cols: number; rows: number; bracketedPaste: boolean; automaticInput: boolean } | undefined;
      for (const entry of active) latest = entry;
      if (latest) {
        const kind = auto && latest.automaticInput ? AUTOMATIC_INPUT : DATA;
        this.send(latest.channel, kind, Buffer.from(data, "utf8"));
        return;
      }
    }
    const entry = this.openInputEntry(terminal, cols, rows);
    const ch = await entry.channel;
    const kind = auto && entry.automaticInput ? AUTOMATIC_INPUT : DATA;
    this.send(ch, kind, Buffer.from(data, "utf8"));
    this.refreshInputIdleTimer(terminal, entry, ch);
  }

  stop(): void {
    for (const s of this.inputs.values()) clearTimeout(s.timer);
    this.inputs.clear();
    this.activeRaw.clear();
    this.child?.kill();
  }
}
