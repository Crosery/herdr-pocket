<p align="center">
  <a href="https://crosery.github.io/herdr-pocket/">
    <img src="docs/readme/logo.png" alt="Herdr Pocket logo" width="112" height="112" />
  </a>
</p>

<h1 align="center">Herdr Pocket</h1>

<p align="center">
  <strong>Every coding agent on every computer, in your pocket.</strong><br />
  Remote control Claude Code, Codex, Gemini CLI, OpenCode, OMP, and shells across iOS, Android, HarmonyOS NEXT, macOS, Windows, Linux, and Web.
</p>

<p align="center">
  <a href="https://github.com/Crosery/herdr-pocket/releases"><img alt="Latest Release" src="https://img.shields.io/github/v/release/Crosery/herdr-pocket?style=flat-square&label=release&color=e85d93" /></a>
  <a href="https://github.com/Crosery/herdr-pocket/actions/workflows/ci.yml"><img alt="CI Status" src="https://img.shields.io/github/actions/workflow/status/Crosery/herdr-pocket/ci.yml?branch=main&style=flat-square&label=ci" /></a>
  <a href="LICENSE"><img alt="License AGPL-3.0-only" src="https://img.shields.io/badge/license-AGPL--3.0--only-241b2c?style=flat-square" /></a>
  <a href="#downloads"><img alt="Platforms" src="https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20iOS%20%7C%20Android%20%7C%20HarmonyOS%20NEXT-3b2d4a?style=flat-square" /></a>
</p>

<p align="center">
  <strong>English</strong> &middot;
  <a href="README.zh-CN.md">简体中文</a> &middot;
  <a href="#quickstart">Quickstart</a> &middot;
  <a href="#downloads">Downloads</a> &middot;
  <a href="docs/deploy/README.md">Self-Hosting</a> &middot;
  <a href="https://crosery.github.io/herdr-pocket/">Website</a>
</p>

<br />

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/readme/preview-dark.webp" />
    <source media="(prefers-color-scheme: light)" srcset="docs/readme/preview-light.webp" />
    <img alt="Herdr Pocket workspace across desktop split workbench and mobile client" src="docs/readme/preview-light.webp" width="100%" />
  </picture>
</p>

## Highlights

- **Zero-Wrapper CLI Compatibility** — Keep running Claude Code, Codex, Gemini CLI, OpenCode, OMP, or plain shells inside `herdr` on macOS, Linux, and Windows. Pocket attaches via live PTY sockets and Uniflo transcripts with a unified `/` & `\` command palette across mobile and desktop.
- **v3 Split Workbench & Per-Terminal 60 FPS Portals** — Side-by-side chat diffs and live xterm panes, one-click Git Worktree branch isolation, and pane-scoped floating portals (`SessionPortalPiP`) strictly bound to the originating terminal — including live `ego-browser` TaskSpace status and instant human takeover.
- **Xiaoyang Assistant & Realtime Voice** — Proactive 7-state completion and blocker notices, non-intrusive `/btw` side queries on live sessions, and walking-friendly voice calls with on-device noise suppression and voiceprint lock.
- **Space Browser & Opt-In Plugins (`false` by default)** — Isolated multi-space browser tabs with optional Shadow-DOM virtual cursor and CAPTCHA/password guards. Built-in plugins (`browser_act`, `inspect_workspace`, SSRF-safe `fetch_webpage`, sealed-secret webhooks) stay completely disabled until enabled.
- **Self-Hosted Relay + Encrypted P2P Direct Links** — Controlled computers open zero inbound ports. LAN, Tailscale, and WireGuard peers upgrade automatically to direct ChaCha20-Poly1305 / WebRTC streams, with your self-hosted relay as seamless fallback.

## Quickstart

### 1. Deploy Your Relay

Supports Docker, native Node + systemd, Fly.io, Render, Kubernetes, and Cloudflare Tunnel with no open firewall ports ([Deployment Guide](docs/deploy/README.md)):

```sh
curl -fsSL https://raw.githubusercontent.com/Crosery/herdr-pocket/main/scripts/install-relay.sh | sudo bash -s -- --domain pocket.example.com
```

### 2. Connect Each Computer (`hostd`)

**macOS / Linux:**

```sh
curl -fsSL https://raw.githubusercontent.com/Crosery/herdr-pocket/main/scripts/install-host.sh | bash -s -- --server https://pocket.example.com
```

**Windows (PowerShell):**

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Crosery/herdr-pocket/main/scripts/install-host.ps1))) -Server https://pocket.example.com
```

*Mainland China mirror tip:* prepend `https://ghfast.top/` before the script URL, or run `herdr-pocket update --probe` to benchmark the fastest release mirror automatically.

### 3. Pair Any Client

Install a native build from [Downloads](#downloads), pair once with `herdr-pocket pair` (QR code or invite link), or open `https://<your-relay>/app/` in any browser.

## Downloads

Automated builds are published to [GitHub Releases](https://github.com/Crosery/herdr-pocket/releases) with `SHA256SUMS` and Chinese/English release notes.

| Platform | Target / Format | Direct Download | Notes |
| --- | --- | --- | --- |
| **macOS** | Apple Silicon (`arm64`) `.dmg` | [herdr-pocket-0.2.60-macos-arm64.dmg](https://github.com/Crosery/herdr-pocket/releases/download/v0.2.60/herdr-pocket-0.2.60-macos-arm64.dmg) | Tauri v2 desktop app |
| **macOS** | Intel (`x64`) `.dmg` | [herdr-pocket-0.2.60-macos-x64.dmg](https://github.com/Crosery/herdr-pocket/releases/download/v0.2.60/herdr-pocket-0.2.60-macos-x64.dmg) | Tauri v2 desktop app |
| **Windows** | `x64` NSIS Installer `.exe` | [herdr-pocket-0.2.60-windows-x64-setup.exe](https://github.com/Crosery/herdr-pocket/releases/download/v0.2.60/herdr-pocket-0.2.60-windows-x64-setup.exe) | Recommended installer |
| **Windows** | `x64` MSI Package `.msi` | [herdr-pocket-0.2.60-windows-x64.msi](https://github.com/Crosery/herdr-pocket/releases/download/v0.2.60/herdr-pocket-0.2.60-windows-x64.msi) | Silent / enterprise rollout |
| **Linux** | `x64` `.AppImage` | [herdr-pocket-0.2.60-linux-x64.AppImage](https://github.com/Crosery/herdr-pocket/releases/download/v0.2.60/herdr-pocket-0.2.60-linux-x64.AppImage) | Portable bundle |
| **Linux** | `x64` Debian / Ubuntu `.deb` | [herdr-pocket-0.2.60-linux-x64.deb](https://github.com/Crosery/herdr-pocket/releases/download/v0.2.60/herdr-pocket-0.2.60-linux-x64.deb) | `apt` / `dpkg` package |
| **Android** | `arm64` `.apk` | [herdr-pocket-0.2.60-android-arm64.apk](https://github.com/Crosery/herdr-pocket/releases/download/v0.2.60/herdr-pocket-0.2.60-android-arm64.apk) | In-app updates & voice calls |
| **HarmonyOS NEXT** | `arm64` `.hap` | [herdr-pocket-0.2.60-harmonyos-arm64.hap](https://github.com/Crosery/herdr-pocket/releases/download/v0.2.60/herdr-pocket-0.2.60-harmonyos-arm64.hap) | Stage-model ArkTS client |
| **iOS** | `arm64` `.ipa` | [herdr-pocket-0.2.60-ios-arm64.ipa](https://github.com/Crosery/herdr-pocket/releases/download/v0.2.60/herdr-pocket-0.2.60-ios-arm64.ipa) | AltStore / SideStore / TrollStore |
| **Relay & Hostd** | Cross-platform `.tar.gz` | [herdr-pocket-0.2.60.tar.gz](https://github.com/Crosery/herdr-pocket/releases/download/v0.2.60/herdr-pocket-0.2.60.tar.gz) | Used by `install-host` & `herdr-pocket update` |

## Architecture & Security

```mermaid
flowchart LR
  Clients["Clients: iOS · Android · HarmonyOS NEXT · Desktop · Web"]
  Relay["Self-Hosted Relay (wss + Assistant + /app)"]
  Hostd["Computer hostd (PTY + Uniflo + P2P Portal + Browser)"]
  Agents["CLI Agents: Claude Code · Codex · Gemini · OpenCode · OMP"]

  Clients <-->|"TLS WebSocket (outbound)"| Relay
  Relay <-->|"TLS WebSocket (outbound, no open PC ports)"| Hostd
  Clients <-.->|"Direct Encrypted P2P (LAN / Tailscale / WebRTC)" .-> Hostd
  Hostd <--> Agents
```

- **Workspace layout**:
  - `packages/protocol`: versioned device, agent, conversation, RPC, stream, and portal wire contracts.
  - `apps/relay`: Node.js + SQLite WebSocket/HTTP relay, hashed (`SHA-256`) device tokens, sealed `<db>.key` assistant settings, and H5 bundle (`/app/`).
  - `apps/hostd`: per-computer daemon bridging `hc` PTY sockets, Uniflo transcripts, Git worktrees, strict per-terminal Portal streams, and opt-in `herdr-pocket browser` automation.
  - `apps/desktop`, `apps/mobile`, `apps/harmony`: Tauri v2 desktop, Expo SDK 58 mobile, and HarmonyOS NEXT ArkTS clients.
- **Security & trust boundaries**:
  - **Relay trust model**: Traffic is authenticated per device and encrypted over TLS in transit (direct links use encrypted ChaCha20-Poly1305 / DTLS). Because the relay forwards frames when P2P is unavailable, self-hosting keeps every credential and stream strictly under your own infrastructure.
  - **Zero-trust plugin defaults**: All AI Browser & Xiaoyang plugins ship `false` by default; outbound fetches enforce DNS/IP SSRF validation against loopback, link-local, and private ranges; API keys and webhook secrets are encrypted at rest and masked on read.

<details>
<summary>Opt-in Browser CLI (<code>herdr-pocket browser</code>) &amp; Xiaoyang Plugins</summary>

Drive Space Browser sessions from scripts or agent hooks once `plugins.aiBrowser` is enabled:

```sh
herdr-pocket browser status --json
herdr-pocket browser open http://localhost:3000 --space work --page app
herdr-pocket browser snapshot --space work --json
herdr-pocket browser click @e12 --space work --label "Submit login form"
herdr-pocket browser fill @e14 "hello" --space work
herdr-pocket browser handoff --space work --reason "Need human SMS verification"
herdr-pocket browser resume --space work
```

</details>

## Development

```sh
pnpm install
pnpm typecheck
pnpm --filter @herdr-pocket/relay test
pnpm --filter @herdr-pocket/hostd test
pnpm --dir apps/desktop typecheck && pnpm --dir apps/desktop test
pnpm --dir apps/mobile typecheck
```

See [AGENTS.md](AGENTS.md), [docs/README.md](docs/README.md), and [docs/design/ui-component-rules.md](docs/design/ui-component-rules.md) for UI primitive rules, build targets, and release conventions.

## License

Copyright © 2026 Crosery

Herdr Pocket is released under the [GNU Affero General Public License v3.0 only](LICENSE) (AGPL-3.0-only):

- You may freely use, study, modify and redistribute it, including commercially.
- If you distribute a modified version (an installer, an image, an archive), you must include the complete source under the same license.
- Even if you only deploy a modified relay or app for others to use over a network, without distributing the program, you must make the modified source available to those users. This is where the AGPL is stricter than the GPL.
- You may not fold it, or any part of it, into a closed-source product.
- This license grants no trademark rights to the “Herdr Pocket” name or logo. If you publish a modified version, give it a different name and package name, so nobody mistakes it for the official one.

**Additional permission under AGPL-3.0 section 7.** The website in `apps/site` may be combined with GSAP (distributed under its own “Standard no-charge” license), and the intro video project in `apps/site/video` with Remotion (distributed under the Remotion License), without those libraries falling under the AGPL. They keep their own terms: Remotion, for example, requires a paid company license above a certain team size. Neither library is used by the relay, the computer daemon or the mobile and desktop client apps.
