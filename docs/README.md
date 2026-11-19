# Herdr Pocket documentation

- [Project guide](../AGENTS.md) — architecture, commands, runtime topology, and safety boundaries.
- User/developer README: [English](../README.md) · [简体中文](../README.zh-CN.md) — setup, pairing, relay, hostd, and mobile overview.
- [README images](readme/) — hero, architecture diagram, feature grid and screenshot showcase used by both READMEs; regenerate with `cd docs/readme/build && pnpm install && pnpm build`.
- [Mobile app README](../apps/mobile/README.md) — Expo development, routes, deep links, Android APK & iOS IPA builds, and native voice/downloader modules.
- [Desktop app](../apps/desktop/) & [HarmonyOS NEXT shell](../apps/harmony/) — Tauri v2 desktop client (macOS, Windows, Linux) and Stage-Model ArkTS shell sharing the same web bundle.
- [Deployment units](../deploy/) — systemd relay, Caddy reverse proxy, launchd hostd, and environment template.
- [Deploy and update](deploy/README.md) — one-command installers, Docker/Caddy/Cloudflare Tunnel, Fly.io, other platforms, computers, updates and releases.
- [Relay configuration](config.md) — text-model providers and fallback, voice providers, the optional config file.
- [Design canvas](design/canvas.html) — interaction rationale and Android screen reference.
- [Brand assets](brand/) — logo, adaptive icon, mascot, and stickers.
- [Screenshots](screenshots/) — demo-mode screens used by the README and the site (no real data).

## Contract ownership

The source of truth for cross-process behavior is `packages/protocol/src/index.ts`. Relay forwarding lives in `apps/relay/src/server.ts`; computer-side adapters and handlers live in `apps/hostd/src`; WebSocket/RPC clients live in `apps/mobile/src/lib/relay.ts` (Android & iOS) and `apps/desktop/src/lib/relay.ts` (Desktop & HarmonyOS NEXT). Update those together when a wire message changes.

## Operational notes

The relay is a server-side production service and the host daemon is a per-computer service. Health, service state, and real-device connectivity must be checked separately. A successful emulator build does not prove a real phone is connected, and a host daemon's local `connected` state does not prove the public relay is healthy.
