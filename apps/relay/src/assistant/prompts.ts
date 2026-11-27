/**
 * Every prompt the assistant uses. The wording comes from
 * docs/design/assistant-persona-harness.md (section 5, with the warmer tone
 * of section 8 applied); the texts themselves are in ./prompts/*.md, and a
 * phone can change each of them (Settings -> 提示词).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HERDR_COMMANDS, type PromptId, type PromptView } from "@herdr-pocket/protocol";

/**
 * History older than this is written in the previous voice and would pull the
 * model back to it: only later items are given to the model (4.8). Set it to
 * the moment the prompts change. The app's own history is not affected.
 */
export const PROMPT_EPOCH = Date.parse("2026-11-19T19:48:00+08:00");

export type Occasion = "text" | "call" | "woken";

/**
 * The texts live in ./prompts/<id>.md (the defaults the relay ships with);
 * a phone can replace any of them (setPromptEdits, kept by the relay). This
 * file only fills the slots and puts the parts together.
 */
const ORDER: PromptId[] = ["base", "act_direct", "act_ask", "text", "cards_direct", "cards_ask", "call", "persona", "voice_rules", "woken"];

const NAME = { slot: "{{name}}", means: "小羊的名字" };
const META: Record<PromptId, Omit<PromptView, "id" | "text" | "defaultText" | "edited" | "updatedAt" | "updatedBy">> = {
  base: { title: "性格和办事规矩", about: "打字和通话都用：它是谁、怎么说话、怎么查、怎么传话。", group: "性格与规矩", slots: [NAME, { slot: "{{acting}}", means: "下面“动手”两条里按设置选的一条" }] },
  act_direct: { title: "动手：直接办", about: "“动手前先问我”关着时（通话里总是这样），怎么替你动手。", group: "性格与规矩", slots: [] },
  act_ask: { title: "动手：先问再办", about: "“动手前先问我”开着时，先生成待确认操作再问你。", group: "性格与规矩", slots: [] },
  text: { title: "文字聊天", about: "打字聊天时回答的长短和格式。", group: "文字聊天", slots: [{ slot: "{{cards}}", means: "下面两条“卡片”里按设置选的一条" }] },
  cards_direct: { title: "卡片：直接办", about: "直接办完后，聊天里的卡片怎么配一句话。", group: "文字聊天", slots: [] },
  cards_ask: { title: "卡片：等你确认", about: "带“确认 / 取消”的卡片出来时，怎么配一句话。", group: "文字聊天", slots: [] },
  call: { title: "通话：后台查和办", about: "通话里后台去查、去办，带回“台词 / --- / 备查”。", group: "通话", slots: [] },
  persona: { title: "通话：语音的人设", about: "电话里出声的那个语音模型是谁、怎么说话。", group: "通话", slots: [NAME] },
  voice_rules: { title: "通话：语音怎么干活", about: "语音模型什么自己答、什么交给后台、结果回来怎么说。", group: "通话", slots: [] },
  woken: { title: "被叫醒", about: "agent 停下时去看一眼，回来写成通知。", group: "被叫醒", slots: [] },
};

const DEFAULTS = Object.fromEntries(ORDER.map((id) => [id, readFileSync(new URL(`./prompts/${id}.md`, import.meta.url), "utf8").replace(/\n$/, "")])) as Record<PromptId, string>;

/**
 * A private folder on the server (POCKET_PROMPTS_DIR): its `<id>.md` files
 * replace the shipped defaults, so a deployment can keep its own wording out
 * of the repository. Returns the ids it replaced.
 */
export function usePromptDir(dir: string): PromptId[] {
  const used: PromptId[] = [];
  for (const id of ORDER) {
    try {
      DEFAULTS[id] = readFileSync(join(dir, `${id}.md`), "utf8").replace(/\r\n/g, "\n").replace(/\n$/, "");
      used.push(id);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return used;
}

/** One phone edit of a prompt, as the relay keeps it. */
export interface PromptEdit {
  text: string;
  updatedAt: number;
  updatedBy: string;
}

let edits: Partial<Record<PromptId, PromptEdit>> = {};

/** The phone edits in force (the relay calls this at start and after every change). */
export function setPromptEdits(next: Partial<Record<PromptId, PromptEdit>>): void {
  edits = { ...next };
}

export function isPromptId(id: unknown): id is PromptId {
  return typeof id === "string" && (ORDER as string[]).includes(id);
}

/** The text in force for one prompt. */
export function promptText(id: PromptId): string {
  return edits[id]?.text ?? DEFAULTS[id];
}

/** What a phone shows and edits, in list order. */
export function promptViews(): PromptView[] {
  return ORDER.map((id) => promptView(id));
}

export function promptView(id: PromptId): PromptView {
  const e = edits[id];
  return { id, ...META[id], text: e?.text ?? DEFAULTS[id], defaultText: DEFAULTS[id], edited: !!e, ...(e ? { updatedAt: e.updatedAt, updatedBy: e.updatedBy } : {}) };
}

/** Slots are plain text: a missing one leaves that part out, an unknown one stays as written. */
function fill(text: string, slots: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (all, k: string) => (k in slots ? slots[k]! : all));
}

/**
 * 5.1: fixed part, then the occasion, then the snapshot. `confirm`: the person
 * wants to be asked before anything is done (typed chats only; calls never wait).
 */
export function systemPrompt(name: string, occasion: Occasion, board: string, opts: { confirm?: boolean } = {}): string {
  const ask = !!opts.confirm && occasion !== "call";
  const base = fill(promptText("base"), { name, acting: promptText(ask ? "act_ask" : "act_direct") });
  const occ = fill(promptText(occasion), { cards: promptText(ask ? "cards_ask" : "cards_direct") });
  return [base, occ, board].filter((x) => x.trim()).join("\n\n");
}

/** 5.2: a task handed over by the voice. */
export function delegateAsk(name: string, objective: string, context: Array<{ role: string; content: string }>): string {
  const lines = context.map((c) => `${c.role === "user" ? "我" : name}：${c.content}`).join("\n");
  return [`[通话中] 语音模型转来的，是我刚才的意思：\n${objective}`, lines ? `通话里最近几句：\n${lines}` : "", "（按“台词 / --- / 备查”的格式回。）"].filter(Boolean).join("\n\n");
}

/** 5.3: MOSS-Live `persona.prompt`. */
export function personaPrompt(name: string): string {
  return fill(promptText("persona"), { name });
}

/** 5.4: MOSS-Live `instructions`; empty slots leave with their titles. */
export function voiceInstructions(slots: { board: string; pending: string[]; recent: string }): string {
  return [
    promptText("voice_rules"),
    slots.board.trim() ? `【现况】\n${slots.board.trim()}` : "",
    slots.pending.length ? `【要告诉我的事】\n${slots.pending.join("\n")}` : "",
    slots.recent.trim() ? `【刚才文字里聊过】\n${slots.recent.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** 5.5: material for a wake-up. Sections without content leave with their titles. */
function sections(head: string[], parts: Array<[string, string | undefined]>): string {
  return [head.join("\n"), ...parts.filter(([, body]) => body && body.trim()).map(([title, body]) => `${title}\n${body!.trim()}`)].join("\n\n");
}

export function wakeFinished(m: {
  handle: string;
  harness: string;
  device: string;
  duration: string;
  subagents: number;
  key: string;
  reminder?: string;
  asked?: string;
  /** The person's own words behind `asked`, when the assistant relayed it. */
  spoken?: string;
  first?: string;
  said?: string;
  did?: string;
  terminal?: string;
}): string {
  return sections(
    [`[叫醒] ${m.handle} 停下来了。`, `程序：${m.harness} | 电脑：${m.device} | 这一轮跑了：${m.duration} | 还在跑的子 agent：${m.subagents} 个`, `key：${m.key}`],
    [
      ["我之前交代你的：", m.reminder],
      ["我让它做的：", m.asked],
      ["我交代时的原话（你整理成上面那条发给它的）：", m.spoken],
      ["最初的任务：", m.first],
      ["它最后说的：", m.said],
      ["它最后做的：", m.did],
      ["它的终端最后 40 行：", m.terminal],
    ],
  );
}

export function wakeBlocked(m: { handle: string; harness: string; device: string; duration: string; key: string; reminder?: string; wants?: string; terminal?: string }): string {
  return sections(
    [
      `[叫醒] ${m.handle} 标为在等我，已经等了 ${m.duration}。先对照终端最后几行核实它是不是真的停在审批、提问或报错等待：若是，结论写“要你定”；若终端只是空闲提示符、已经做完或仅后台任务正常在跑（误报），按实际写“不用说”“还在跑”或“成了”，不要编造它在等你审批。不用工具，直接按格式回。`,
      `程序：${m.harness} | 电脑：${m.device}`,
      `key：${m.key}`,
    ],
    [
      ["我之前交代你的：", m.reminder],
      ["它想执行的：", m.wants],
      ["它的终端最后 40 行：", m.terminal],
    ],
  );
}

export function wakeBatch(handles: string[], said: Array<{ handle: string; text: string }>): string {
  return sections(
    [
      `[叫醒] ${handles.length} 个 agent 在十秒内都停了：${handles.join("、")}。`,
      "先看是不是同一个原因（额度用完、断网、电脑睡了这一类）。是的话，那一句只说原因和什么时候能恢复；不是的话，说最要紧的那个。结论按整体情况选。",
    ],
    [["其中三个最后说的：", said.map((s) => `${s.handle}：${s.text}`).join("\n")]],
  );
}

/** 5.6: the command list inside the `herdr_do` description. */
export function herdrCommandList(): string {
  const one = (k: string) => `${k}(${HERDR_COMMANDS[k as keyof typeof HERDR_COMMANDS].args.join(", ")})`;
  const direct = Object.keys(HERDR_COMMANDS).filter((k) => !HERDR_COMMANDS[k as keyof typeof HERDR_COMMANDS].confirm);
  const gated = Object.keys(HERDR_COMMANDS).filter((k) => HERDR_COMMANDS[k as keyof typeof HERDR_COMMANDS].confirm);
  const about = (k: string) => HERDR_COMMANDS[k as keyof typeof HERDR_COMMANDS].about;
  return [
    "直接执行（随时能改回去）：",
    "- space.rename / tab.rename：给空间 / 标签改名。",
    "- space.move / tab.move：调整空间 / 标签的顺序。",
    "- space.select / tab.select / pane.focus / pane.zoom / agent.focus：只改电脑屏幕上显示什么。人不在电脑前时用不上，明说要切才用。",
    ...["tab.settle", "tab.unsettle", "terminal.pin", "terminal.keep", "terminal.park"].filter((k) => direct.includes(k)).map((k) => `- ${k}：${about(k)}`),
    "",
    "会结束或启动程序（按设置直接执行，或先生成待确认操作）：",
    "- space.close / tab.close / pane.close：关掉，里面的终端会结束。",
    "- pane.split：分出一格，并在里面启动一个程序。",
    "",
    `参数：${[...direct, ...gated].map(one).join("、")}。`,
  ].join("\n");
}
