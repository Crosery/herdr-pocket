/**
 * Text typed into an agent while it was in a turn. Claude Code and programs
 * like it hold such text in their input box until the turn ends, so "sent" is
 * not "read": the phone and the assistant should see that it is waiting.
 *
 * An entry goes away when the agent's conversation shows the text as a user
 * message (it was taken), when the agent stopped and then started working
 * again (it took the waiting input), after it has stayed stopped for a while
 * without a conversation to check, or when it is very old or the agent is gone.
 */
import { sameMessage, splitFiles, type Agent, type ConvEvent } from "@herdr-pocket/protocol";

export interface Waiting {
  id: string;
  text: string;
  at: number;
  /** When the agent was first seen stopped after this was typed. */
  stoppedAt?: number;
}

export interface InputWaitsOptions {
  /** Stopped this long with no conversation to check: taken or dropped, either way not waiting. */
  idleGraceMs?: number;
  /** Same, for agents whose conversation is checked (it had its chance to show up there). */
  sessionGraceMs?: number;
  maxAgeMs?: number;
  /** How long typed text gets to show up on the screen before its absence counts. */
  landMs?: number;
}

const fold = (s: string) => s.replace(/\s+/g, "");

function formatWaitPreview(raw: string): string {
  const { text, count } = splitFiles(raw);
  const words = text.replace(/\s+/g, " ").trim();
  return count ? [words, `图片 ×${count}`].filter(Boolean).join(" · ") : words;
}

function sameQueuedPreview(a: string, b: string): boolean {
  if (a === b || sameMessage(a, b)) return true;
  const fa = fold(splitFiles(a).text || a);
  const fb = fold(splitFiles(b).text || b);
  if (!fa || !fb) return false;
  if (fa === fb) return true;
  if ((a.endsWith("…") || a.endsWith("...")) && fb.startsWith(fa.replace(/(?:\.\.\.|…)+$/, ""))) return true;
  if ((b.endsWith("…") || b.endsWith("...")) && fa.startsWith(fb.replace(/(?:\.\.\.|…)+$/, ""))) return true;
  return false;
}

function mergeQueuedLists(...lists: ReadonlyArray<ReadonlyArray<string> | undefined>): string[] {
  const out: string[] = [];
  for (const list of lists) {
    if (!list?.length) continue;
    for (const raw of list) {
      const clean = raw.replace(/\s+/g, " ").trim();
      if (!clean) continue;
      const existingIdx = out.findIndex((item) => sameQueuedPreview(item, clean));
      if (existingIdx >= 0) {
        const prev = out[existingIdx]!;
        if ((prev.endsWith("…") || prev.endsWith("...")) && !clean.endsWith("…") && !clean.endsWith("...") && clean.length > prev.length) {
          out[existingIdx] = clean;
        }
        continue;
      }
      out.push(clean);
      if (out.length >= 20) return out;
    }
  }
  return out;
}

export class InputWaits {
  private byAgent = new Map<string, Waiting[]>();
  private screenQueued = new Map<string, string[]>();
  private opts: InputWaitsOptions;

  constructor(opts: InputWaitsOptions = {}) {
    this.opts = opts;
  }

  get size(): number {
    return this.byAgent.size;
  }

  /** Records text typed while the agent was working; returns how many now wait there. */
  add(agentKey: string, id: string, text: string, at: number): number {
    const list = this.byAgent.get(agentKey) ?? [];
    list.push({ id, text: text.slice(0, 2000), at });
    this.byAgent.set(agentKey, list);
    return list.length;
  }

  list(agentKey: string): Waiting[] {
    return this.byAgent.get(agentKey) ?? [];
  }

  setScreenQueued(agentKey: string, items: string[]): boolean {
    const clean = items.map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 20);
    const prev = this.screenQueued.get(agentKey);
    if (clean.length === 0) {
      if (!prev) return false;
      this.screenQueued.delete(agentKey);
      return true;
    }
    if (prev && prev.length === clean.length && prev.every((v, i) => v === clean[i])) return false;
    this.screenQueued.set(agentKey, clean);
    return true;
  }

  pruneScreenQueued(activeKeys: Set<string>): boolean {
    let changed = false;
    for (const key of [...this.screenQueued.keys()]) {
      if (!activeKeys.has(key)) {
        this.screenQueued.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  /** The agents with their `queued` fields set (or cleared). */
  decorate(agents: Agent[]): Agent[] {
    return agents.map((a) => {
      const list = this.byAgent.get(a.key);
      const waitTexts = list?.length ? list.map((w) => formatWaitPreview(w.text)).filter(Boolean) : undefined;
      const screenList = a.status === "working" || a.status === "blocked" ? this.screenQueued.get(a.key) : undefined;
      const items = mergeQueuedLists(a.queuedItems, waitTexts, screenList);
      if (!items.length && !list?.length) return a;
      const first = list?.[0];
      const head = items[0] ?? (first ? formatWaitPreview(first.text) : "");
      return {
        ...a,
        queued: Math.max(items.length, list?.length ?? 0),
        ...(items.length ? { queuedItems: items } : {}),
        queuedText: Array.from(head).length > 80 ? `${Array.from(head).slice(0, 80).join("")}…` : head,
        ...(first?.at !== undefined ? { queuedSince: first.at } : a.queuedSince !== undefined ? { queuedSince: a.queuedSince } : {}),
      };
    });
  }

  /**
   * Drops what the agents have taken. True when anything changed.
   * `screen` gives an agent's visible screen: text waiting in a program's input
   * box is on it, so text that is no longer anywhere on it was taken (Claude
   * Code takes typed text in the middle of a turn, not only at its end).
   */
  async settle(
    agents: Agent[],
    events: (sessionKey: string) => Promise<ConvEvent[]>,
    now: number,
    screen?: (agent: Agent) => Promise<string | undefined>,
  ): Promise<boolean> {
    let changed = false;
    for (const [key, list] of [...this.byAgent]) {
      const a = agents.find((x) => x.key === key);
      if (!a) {
        this.byAgent.delete(key);
        changed = true;
        continue;
      }
      let said: Array<{ raw: string; folded: string }> = [];
      if (a.sessionKey) {
        try {
          const oldest = Math.min(...list.map((w) => w.at));
          said = (await events(a.sessionKey))
            .filter((e) => (e.kind === "user_message" || e.kind === "system") && (!e.ts || e.ts >= oldest - 10_000))
            .map((e) => {
              const raw = e.kind === "user_message" ? `${e.text}${e.injected ?? ""}` : e.kind === "system" ? e.text : "";
              return { raw, folded: fold(raw) };
            });
        } catch {
          said = [];
        }
      }
      let shown: string | undefined;
      // Only once the text had time to land (the send queue types it in after this was recorded).
      if (screen && list.some((w) => now - w.at > (this.opts.landMs ?? 8_000))) {
        try {
          const s = await screen(a);
          shown = s === undefined ? undefined : fold(s);
          // Claude Code shows a long paste as "[Pasted text #1 +12 lines]": its words aren't on screen.
          if (shown?.includes("[Pastedtext")) shown = undefined;
        } catch {
          shown = undefined;
        }
      }
      const grace = a.sessionKey ? (this.opts.sessionGraceMs ?? 90_000) : (this.opts.idleGraceMs ?? 20_000);
      const keep = list.filter((w) => {
        const parsed = splitFiles(w.text);
        const head = fold(parsed.text).slice(0, 30);
        if (said.some((s) => (parsed.count > 0 && sameMessage(s.raw, w.text, true)) || (head && s.folded.includes(head)))) return false;
        // Programs clip long input in their box: look for its start only.
        const screenHead = fold(parsed.text).slice(0, 12);
        if (shown !== undefined && now - w.at > (this.opts.landMs ?? 8_000)) {
          if (screenHead ? !shown.includes(screenHead) : !shown.includes("[Image#") && !shown.includes(fold(w.text).slice(0, 12))) return false;
        }
        if (now - w.at > (this.opts.maxAgeMs ?? 2 * 3_600_000)) return false;
        if (a.status === "working") {
          // Stopped and then working again: the program took what was waiting.
          if (w.stoppedAt !== undefined) return false;
          return true;
        }
        if (a.status === "blocked") return true;
        w.stoppedAt ??= now;
        return now - w.stoppedAt < grace;
      });
      if (keep.length !== list.length) changed = true;
      if (keep.length) this.byAgent.set(key, keep);
      else this.byAgent.delete(key);
    }
    return changed;
  }
}
