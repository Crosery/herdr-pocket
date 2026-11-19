import type { Lang } from "./config";

// Chinese is the source language and lives in index.html; English lives here.
// At boot the Chinese markup is captured from the DOM so switching back is lossless.
const en: Record<string, string> = {
  "nav.skip": "Skip to content",
  "nav.how": "How it works",
  "nav.views": "Features",
  "nav.assistant": "Assistant",
  "nav.deploy": "Deploy",
  "nav.faq": "FAQ",
  "hero.pill": "Open source · Self-hosted · Cross-platform",
  "hero.title": "All your coding agents,<br /><em>in your pocket.</em>",
  "hero.sub":
    "Herdr Pocket connects the Claude Code, Codex, Gemini, OpenCode… sessions running in herdr to Android, iOS, HarmonyOS NEXT and Windows / macOS / Linux desktops: live status, readable conversations, a real terminal. Xiaoyang, the assistant, keeps watch and tells you the moment something finishes or gets stuck.",
  "hero.cta1": "Get started",
  "hero.cta2": "Watch the 90-second intro",
  "hero.needs": "You need three things:",
  "hero.need1": "Your own server",
  "hero.need2": "Mobile or desktop app",
  "hero.need3": "Computers running herdr",
  "parts.eyebrow": "Three parts",
  "parts.title": "One server, mobile & desktop apps,<br />and each of your computers",
  "parts.lead":
    "The server sits in the middle: mobile apps, desktops and every computer connect only to it, so they never need to share a network. Set them up in order, 1, 2, 3, and every agent on every computer shows up in every client.",
  "parts.where": "Runs on",
  "parts.s.t": "Server",
  "parts.s.k": "the relay",
  "parts.s.w": "Your own server (Linux)",
  "parts.s.d": "The hub between phone and computers: it relays status, conversations and terminals, and runs the Xiaoyang assistant and voice calls. Your data only passes through your server.",
  "parts.s.a": "Deploy with one command",
  "parts.p.t": "Clients",
  "parts.p.k": "Mobile & Desktop",
  "parts.p.w": "Android / iOS / HarmonyOS NEXT / Windows / macOS / Linux",
  "parts.p.d": "See every agent's status, conversation and terminal, reply and press keys, get alerts, and talk to Xiaoyang. Scan the server's QR code once to connect.",
  "parts.p.a": "Download and connect",
  "parts.c.t": "Computers",
  "parts.c.w": "Every computer that runs herdr (macOS, Linux, Windows)",
  "parts.c.d": "Stays running in the background, sends the agents in this computer's herdr to the server, and hands them what you send from the phone.",
  "parts.c.a": "One command per computer",
  "ui.copy": "Copy",
  "vendors.title": "If it runs in herdr, it shows up in your pocket",
  statement:
    "You don't have to babysit your desk. When an agent finishes, gets stuck, or waits for your OK, your pocket knows first. Glance, reply, hit enter, and the work keeps moving.",
  "how.eyebrow": "How it works",
  "how.title": "Computers → server → phone, one live line",
  "how.s1.t": "Agents keep running on every computer",
  "how.s1.d":
    "Run your agents in herdr like always. Install the computer part once on each machine; it reads the local agents in the background and sends snapshots to the server.",
  "how.s2.t": "Your own server",
  "how.s2.d":
    "The server (the relay) runs on your own machine: long-lived WebSockets with compression. Device tokens are stored only as hashes, and agent ownership is rewritten from the connection identity, so no computer can impersonate another.",
  "how.s3.t": "The phone sees everything, live",
  "how.s3.d":
    "Pair the phone once with a QR code and every agent on every computer appears in one list. Conversations and terminals stream live, with polling as automatic recovery.",
  "how.s4.t": "And you steer from your pocket",
  "how.s4.d":
    "Reply, press Esc, start a new agent, or just hand it to Xiaoyang: commands travel back the same way. Computers can call each other's agents from the CLI, with read-only mode and device allowlists when you want them.",
  "how.pc2": "Linux workstation",
  "how.pc3": "Cloud VM",
  "how.relay": "Server",
  "how.relayAt": "your server",
  "how.online": "Connected to the server",
  "views.eyebrow": "Four views in your pocket",
  "views.title": "See it all at a glance, take over in one tap",
  "views.list.k": "Agent list",
  "views.list.t": "Every computer, sorted by what needs you",
  "views.list.d":
    "Needs you, working, done, idle: grouped on one screen. Each agent wears its own avatar so Claude Code and Codex are recognisable at a glance, with the computer and turn count beside it.",
  "views.chat.k": "Conversation",
  "views.chat.t": "A formatted conversation, not a wall of escape codes",
  "views.chat.d":
    "Tool calls fold into cards, failures stand out, thinking stays quietly in the background. To chime in, just reply like a chat.",
  "views.term.k": "Terminal",
  "views.term.t": "A real terminal you can type into",
  "views.term.d":
    "The live terminal screen, with typing that goes straight to the agent. A compact in-app keyboard puts Esc, Tab, arrows, Enter and Ctrl+C one tap away without the system keyboard covering the screen, so menus and interrupts never need the desk.",
  "views.pair.k": "Devices",
  "views.pair.t": "Scan once and a new computer joins",
  "views.pair.d":
    "After the install command, a new computer prints a QR code; scan it with a connected phone and tap Allow. Every QR is a plain https link any camera can open. Invite codes are single-use and expire after 10 minutes, and phones can invite phones too.",
  "as.eyebrow": "Xiaoyang, your assistant",
  "as.title": "Xiaoyang keeps watch <em>and gets things done</em>",
  "as.lead":
    "The first screen in the app is Xiaoyang. Say the word and she does it: messages an agent, presses keys, creates a space, or starts any installed agent on any computer with a task, then tells you what really happened. When an agent finishes or gets stuck, she lets you know first.",
  "as.p1.t": "Just ask",
  "as.p1.d": "“Who's waiting on me?” “What finished?” “What did today cost?” She checks every computer, then answers, with costs split by agent, space or computer.",
  "as.p2.t": "She reaches out",
  "as.p2.d":
    "When an agent finishes or gets stuck she messages you; ask her to watch one and she calls you when it's done. Alerts land in the notification shade even with the app closed, over a persistent connection on the phone, not Google push.",
  "as.p3.t": "She remembers, and digs in",
  "as.p3.d": "“Remind me to check the deploy in half an hour.” And when something breaks, ask “where did it get stuck?”: she reads the relay, computer and phone logs.",
  "as.p4.t": "She just does it, and tells it straight",
  "as.p4.d":
    "Sending text, pressing keys, creating a space, starting any installed agent (Claude Code, Codex, Gemini, Kimi…): she does it, then tells you how it really went, like “Sent, no reply yet” or “It's busy, so it's queued in the input box.” Rather be asked first? Turn it on in settings; it's off by default.",
  "as.p5.t": "Bring your own model",
  "as.p5.d":
    "Supports 5 protocols—OpenAI Chat, OpenAI Responses (Codex), Anthropic, Google Gemini native and local Ollama—with built-in presets (Xiaomi MiMo, DeepSeek, Qwen, Kimi, GLM, OpenRouter) and 1-tap upstream model auto-scanning.",
  "call.eyebrow": "Voice calls",
  "call.title": "Too lazy to type?<br />Give Xiaoyang a call.",
  "call.lead":
    "Real-time voice calls supporting MOSS-Live and OpenAI Realtime, with on-device voiceprint lock and call noise suppression. Ask “what finished?” on a walk; she checks, then tells you out loud. Audio goes through your own relay and API keys never leave your server.",
  "call.hint": "Six faces follow the call state. Tap one to try it.",
  "ft.eyebrow": "Details",
  "ft.title": "The little things, already handled",
  "ft.cloud": "Cloud VM",
  "ft.1.t": "Many computers, one list",
  "ft.1.d": "Home, office and cloud machines each run their own agents; the phone merges them into one list and shows who is online.",
  "ft.2.t": "Compact in-app keyboard",
  "ft.2.d": "Esc, Tab, arrows and Ctrl+C one tap away, and the system keyboard no longer covers the terminal.",
  "ft.3.t": "No Google push needed",
  "ft.3.d": "A persistent connection delivers alerts directly; just allow background running on stricter Android skins.",
  "ft.4.t": "Tokens stored as hashes",
  "ft.4.d": "A device token is shown once at pairing; the server keeps only its SHA-256, and revoking disconnects immediately.",
  "ft.5.t": "One-time QR pairing",
  "ft.5.d": "Each QR is an https link any camera opens. Codes are single-use, expire in 10 minutes, and lock out after repeated failures.",
  "ft.6.t": "Computers call each other",
  "ft.6.d":
    "From one computer's terminal, read and steer the agents on another. <code>--read-only</code> allows viewing only; <code>--allow</code> limits control to chosen devices.",
  "ft.cli": "run the tests",
  "ft.7.t": "Deploy your way",
  "ft.7.d": "Docker, Cloudflare, or a single install command. Your server, your rules.",
  "ft.8.t": "In-app updates",
  "ft.8.d": "New versions arrive from GitHub Releases; one tap to update.",
  "ft.new": "New version",
  "ft.9.t": "Light and dark",
  "ft.9.d": "A soft pink interface that stays easy on the eyes at 2 a.m.",
  "ft.10.t": "Compressed in transit",
  "ft.10.d": "WebSocket compression makes terminal screens and conversations several times smaller on the wire.",
  "ft.11.t": "Know what it costs",
  "ft.11.d": "Xiaoyang breaks spending down by agent, space and computer.",
  "ft.12.t": "All the logs in one place",
  "ft.12.at": "your-server",
  "ft.12.d": "Relay, computer and phone logs all collect on your relay. Query them with <code>herdr-pocket logs</code>, ask Xiaoyang “where did it get stuck?”, or open the simple <code>/admin</code> web dashboard on your relay.",
  "ft.13.k": "Ask before acting",
  "ft.13.t": "Rather confirm first? Fine",
  "ft.13.d": "By default she just acts. Turn on Ask before acting and she checks with you each time. Voice calls never stop to wait.",
  "video.eyebrow": "Intro film",
  "video.title": "Herdr Pocket in 90 seconds",
  "dp.eyebrow": "Get started",
  "dp.title": "Three steps to your own pocket",
  "dp.field.label": "Your server address",
  "dp.field.help": "The phone and every computer connect to it. Type it once and the commands below include it; it's kept only in this browser.",
  "dp.more": "Details",
  "dp.1.t": "Deploy the server",
  "dp.1.k": "on your own server",
  "dp.1.d": "Pick one of three routes. On first start it prints a one-time setup QR code or setup code for your first phone.",
  "dp.1.fine": "Once it's running, the log dashboard is at",
  "dp.tab.script": "Install script",
  "dp.2.t": "Bring each computer online",
  "dp.2.k": "with herdr",
  "dp.2.d": "Installs the computer part, <code>herdr-pocket</code>, registers this computer with your server and keeps it online in the background.",
  "dp.2.scan": "When a QR code appears in the terminal, scan it with your connected phone and tap Allow.",
  "dp.2.later": "Later, <code>herdr-pocket update</code> updates it and <code>herdr-pocket status</code> shows how it's doing.",
  "dp.3.t": "Install the app",
  "dp.3.d": "Scan the setup QR code from step 1 with the phone's camera to open a connect page; install the app, tap the button on that page, and you're connected.",
  "dp.3.cta": "Download clients",
  "dp.3.more": "Only have a setup code? Enter it in the app together with the server address. New versions update from inside the app.",
  "dp.dl.android": "arm64 APK · in-app self-update",
  "dp.dl.harmony": "HarmonyOS Stage-model HAP",
  "dp.dl.ios": "AltStore / SideStore / TrollStore sideload",
  "dp.dl.macos": "Apple Silicon (arm64) & Intel (x64)",
  "dp.dl.windows": "x64 NSIS setup & MSI",
  "dp.dl.linux": "x64 AppImage & Debian package",
  "dp.3.fine": "Requires herdr. On macOS and Linux the installer brings its own Node.js when there's no 22.18 or newer; on Windows it always does. Neither needs administrator rights.",
  "faq.eyebrow": "FAQ",
  "faq.title": "Questions you might have",
  "faq.1.q": "Are HarmonyOS NEXT, iPhone, and desktop supported?",
  "faq.1.a":
    "Yes, all platforms ship together in each release: Android (.apk), HarmonyOS NEXT (.hap, signed with DevEco Studio), unsigned iOS sideload (.ipa for AltStore / SideStore / TrollStore / Xcode), plus macOS (arm64 / x64 .dmg), Windows (x64 -setup.exe / .msi) and Linux (x64 .AppImage / .deb) with consistent pink UI.",
  "faq.2.q": "Which agents can I see?",
  "faq.2.a":
    "Anything running in herdr: Claude Code, Codex, Gemini, OpenCode, Kimi, Qwen, Cursor Agent, Droid, CodeBuddy, Qoder, omp, pi and more, plus plain terminal programs. Recognised agents get their own avatar. Xiaoyang can also start any agent CLI installed on a computer for you.",
  "faq.3.q": "Do I have to host a server?",
  "faq.3.a": "Yes. You deploy the relay yourself and your data only passes through your server. Docker Compose, the install script or Cloudflare Tunnel all work.",
  "faq.4.q": "Can the relay see my content?",
  "faq.4.a":
    "Yes. This version has no end-to-end encryption and the relay sees plaintext, so run it on a server you trust and always use HTTPS. Device tokens are stored only as hashes and can be revoked at any time.",
  "faq.5.q": "Does Xiaoyang act directly?",
  "faq.5.a":
    "Yes, when you ask. She sends text, presses keys, creates spaces and starts agents, then tells you the real result, like “Sent, no reply yet” or “It's busy, so it's queued in the input box.” To approve each action first, turn on Ask before acting in settings (off by default); during voice calls she never stops to wait. For a view-only phone, see the next question.",
  "faq.6.q": "Which models power the assistant and voice?",
  "faq.6.a":
    "The text assistant supports OpenAI Chat, OpenAI Responses, Anthropic, Google Gemini native and local Ollama (with built-in presets for Xiaomi MiMo, DeepSeek, Qwen, Kimi, GLM, SiliconFlow, Volcengine Ark, OpenRouter and more), plus 1-tap upstream model auto-scanning in the apps and /admin. Voice calls support MOSS-Live and OpenAI Realtime. Without them you simply have no assistant or voice; everything else works.",
  "faq.7.q": "Do alerts arrive when the app is closed?",
  "faq.7.a":
    "Yes. A persistent service on the phone stays connected to your relay, with no Google push involved. Some Android skins need you to allow background running.",
  "faq.8.q": "Can the phone watch without controlling?",
  "faq.8.a":
    "Yes. Run <code>herdr-pocket run --read-only</code> on a computer to allow viewing only, or <code>--allow</code> to let only chosen devices control it.",
  "faq.9.q": "Where do I look when something breaks?",
  "faq.9.a": "Logs from the relay, the computers and the phones all collect on your relay. Filter them by time, device or level with <code>herdr-pocket logs</code>, ask Xiaoyang “where did it get stuck?”, or open the simple <code>/admin</code> web dashboard on your relay.",
  "faq.10.q": "Can I modify it and use it?",
  "faq.10.a": "Yes, for personal and commercial use alike. Herdr Pocket is open source under AGPL-3.0: if you modify it and offer it as a service, you have to publish your changes.",
  "final.title": "Tonight, let the agents run in peace.",
  "final.lead": "Open source and self-hosted. Up and running in minutes.",
  "final.cta1": "Star on GitHub",
  "final.cta2": "Start deploying",
  "footer.tag": "Every coding agent on every computer, in your pocket.",
  "footer.project": "Project",
  "footer.releases": "Releases",
  "footer.issues": "Issues",
  "footer.learn": "Learn",
  "footer.note": "Herdr Pocket is open source and works together with herdr.",
};

const zh: Record<string, string> = {};
let current: Lang = "zh";
const listeners = new Set<(l: Lang) => void>();

export function initI18n(): Lang {
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = el.dataset.i18n!;
    if (!(key in zh)) zh[key] = el.innerHTML.trim();
  }
  const l = document.documentElement.dataset.lang === "en" ? "en" : "zh";
  setLang(l, false);
  return l;
}

export function getLang(): Lang {
  return current;
}

export function setLang(l: Lang, persist = true): void {
  current = l;
  const root = document.documentElement;
  root.dataset.lang = l;
  root.lang = l === "zh" ? "zh-CN" : "en";
  const dict = l === "zh" ? zh : en;
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const v = dict[el.dataset.i18n!] ?? zh[el.dataset.i18n!];
    if (v != null && el.innerHTML !== v) el.innerHTML = v;
  }
  document.title =
    l === "zh" ? "Herdr Pocket · 把所有电脑上的 coding agent 装进口袋" : "Herdr Pocket · Every coding agent, in your pocket";
  if (persist) {
    try {
      localStorage.setItem("hp-lang", l);
    } catch {}
  }
  for (const fn of listeners) fn(l);
}

export function onLang(fn: (l: Lang) => void): void {
  listeners.add(fn);
}

/** Pick a string for the current language. */
export function t(zhText: string, enText: string): string {
  return current === "zh" ? zhText : enText;
}
