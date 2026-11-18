# Herdr Pocket — Android app

Android-only (`app.json` → `"platforms": ["android"]`). Expo SDK 58 + expo-router + react-native-paper (MD3). Watches and drives the herdr agents on every computer registered with your relay.

## Run

```sh
cd apps/mobile
npm install                 # standalone install (not part of the pnpm workspace)
npx expo start              # then press `a`, or:
adb reverse tcp:8081 tcp:8081
adb shell am start -a android.intent.action.VIEW -d exp://127.0.0.1:8081 host.exp.exponent
```

Every native module used here ships in Expo Go (SDK 58), so no development build is needed for day-to-day work.
Installable APK: `npx expo run:android --variant release` locally, or `npx eas-cli@latest build -p android --profile preview`.

On first launch the app offers **扫码配对** (the QR carries server + code, nothing to type). The fallback is one input that takes a pair link, `server code`, or a bare code plus the server URL (no default server); the last real server is remembered, so re-pairing only needs a new code. To try the UI with no server, tap **先逛逛演示数据** (uses `mock://demo`, see `src/lib/mock.ts`).

Deep links (scheme `herdrpocket`, registered as an Android intent filter):

| Link | Opens |
| --- | --- |
| `herdrpocket://pair?server=<url>&code=<CODE>` | this phone joins straight away (an invite QR) |
| `herdrpocket://join?server=<url>&id=<ID>` | asks whether to let another device in (the QR `herdr-pocket up` shows) |
| `herdrpocket://agent/<urlencoded agent key>?tab=chat\|terminal\|info` | an agent |
| `herdrpocket://devices`, `herdrpocket://settings` | tabs |

In Expo Go replace `herdrpocket://` with `exp://127.0.0.1:8081/--/`.

## Layout

```
src/app/                 routes (expo-router)
  _layout.tsx            fonts, theme, query client, relay link bootstrap
  connect.tsx            onboarding: server URL + pair code / QR
  scan.tsx  pair.tsx     QR scanner, deep-link pairing
  pair-new.tsx           invite: one QR + code that adds a phone (scan) or a computer (command)
  join.tsx               approve a device that showed a join QR (herdrpocket://join?server=&id=)
  (tabs)/index.tsx       Agents hub: overview, filters, search, grouped by computer
  (tabs)/devices.tsx     devices, online state, revoke (long press)
  (tabs)/settings.tsx    server/latency, theme, accent, text size, re-pair
  agent/[key].tsx        agent detail: 对话 / 终端 / 信息 + composer with quick keys
src/components/          ui.tsx (Card, StatusPill, BreathingDot, Sheep…), agents.tsx, chat.tsx, detail.tsx
src/lib/                 relay.ts (WebSocket + RPC + REST), store.ts (zustand), mock.ts, auth.ts (SecureStore), format.ts, harness.ts, session.ts
src/theme/               tokens.ts (palette, radii, motion, fonts), theme.tsx (Paper theme, window background)
docs/screenshots/        Android emulator screenshots (Android 14, 1080×2400)
```

The wire contract is `packages/protocol/src/index.ts`, resolved by Metro (`metro.config.js`) and `tsconfig.json` paths.

## Relay expectations

- `POST /v1/pair` `{code,name,kind:"viewer",platform}` → `{device, token}`; token kept in SecureStore. When the phone already holds a token for the same relay it sends it as `Authorization: Bearer`, and the relay replaces that registration instead of adding a second device.
- `GET /v1/ws?token=` WebSocket; the app sends `hello`, `ping` (every 20 s) and `rpc`; it handles `welcome`, `snapshot`, `device`, `device_removed`, `agents`, `rpc_result`, `pong`, `error`.
- Close code **4001** (also 4401) means the token was revoked: the app stops reconnecting and asks to re-pair. A token revoked while the app was closed is refused at the WebSocket upgrade (plain close), so after a close with no `welcome` the app asks `GET /v1/devices`; a 401 there is treated the same way.
- Signing out (设置 → 重新配对) calls `DELETE /v1/devices/<own id>` first (best effort, 4 s cap).
- `POST /v1/pair/codes` `{}` (an invite for any kind of device) and `DELETE /v1/devices/:id` with `Authorization: Bearer <token>`.
- `GET /v1/join/:id`, `POST /v1/join/:id/approve|deny` with `Authorization: Bearer <token>` to let in a device that asked to join.

## Agent screen

- 对话: 新建 Agent 后直接打开对话，空会话可以直接输入。手机发出的消息立即出现，并显示发送、排队或待确认状态。断线后会补拉会话记录。如果发送结果未知，重发前会提示可能重复。工具调用和思考过程保留折叠展示。
- 终端: key bar only; the keyboard button opens a one-line box that sends with Enter. 对话: message box only; the keyboard button shows the key bar.
- “实时” means the stream is open, not that frames keep arriving: an unchanged screen sends nothing.

## Fonts

ZCOOL KuaiLe (headings), Nunito (body), Maple Mono (terminal/code; `assets/fonts`, OFL-1.1). CJK text without a glyph in Nunito / Maple Mono falls back to the system font, so CJK inside terminal box drawings is not perfectly column-aligned.
