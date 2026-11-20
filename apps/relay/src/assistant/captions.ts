/**
 * Pacing of the assistant's growing caption during a call. The voice service sends
 * a piece of the transcript every few characters, faster than the voice speaks it;
 * passing each one on made the phone re-lay out its captions dozens of times a
 * second. Each caption carries the whole text so far, so only the newest needs to go.
 */

/** At most one caption update per answer in this window. */
export const CAPTION_GAP_MS = 200;

export class CaptionPacer {
  private sentAt = new Map<string, number>();
  private waiting = new Map<string, { timer: ReturnType<typeof setTimeout>; send: () => void }>();

  private readonly gapMs: number;
  private readonly now: () => number;

  constructor(gapMs = CAPTION_GAP_MS, now: () => number = Date.now) {
    this.gapMs = gapMs;
    this.now = now;
  }

  /** Sends now when the answer's last caption is old enough, otherwise once it is (only the newest `send` runs). */
  push(key: string, send: () => void): void {
    const pending = this.waiting.get(key);
    if (pending) {
      pending.send = send;
      return;
    }
    const wait = (this.sentAt.get(key) ?? -Infinity) + this.gapMs - this.now();
    if (wait <= 0) {
      this.mark(key);
      send();
      return;
    }
    const entry = {
      send,
      timer: setTimeout(() => {
        this.waiting.delete(key);
        this.mark(key);
        entry.send();
      }, wait),
    };
    this.waiting.set(key, entry);
  }

  /** A final caption or a cut supersedes what is waiting for this answer. */
  cancel(key: string): void {
    const pending = this.waiting.get(key);
    if (pending) clearTimeout(pending.timer);
    this.waiting.delete(key);
    this.sentAt.delete(key);
  }

  clear(): void {
    for (const p of this.waiting.values()) clearTimeout(p.timer);
    this.waiting.clear();
    this.sentAt.clear();
  }

  private mark(key: string): void {
    this.sentAt.delete(key);
    this.sentAt.set(key, this.now());
    // Answers that were never finished (the call moved on) must not pile up.
    if (this.sentAt.size > 100) this.sentAt.delete(this.sentAt.keys().next().value!);
  }
}
