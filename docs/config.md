# Relay configuration: text model and voice

The relay has two model-backed parts:

- the **text assistant** (chat in the app, and the tasks a voice call hands over), which can use many providers with an ordered fallback;
- **voice calls**, through MOSS-Live (default and recommended) or a service that speaks the OpenAI Realtime protocol.

Keys stay on the relay. They are never sent to the phone, never shown by `/v1/health` or the admin page, and removed from upstream error messages before those are logged.

Also on this page: [dictation](#dictation-speech-to-text) (speech to text for voice input on computers), and the [settings file of computers and the desktop app](#computers-and-the-desktop-app-configjson) (`config.json`, read by the `herdr-pocket` CLI and the desktop app; nothing in it reaches the relay).

## Where settings come from

1. **Environment variables**, usually from `/etc/herdr-pocket/relay.env` (systemd) or `relay.env` next to the Docker Compose file. Template: [`deploy/relay.env.example`](../deploy/relay.env.example).
2. **An optional JSON file** named by `POCKET_CONFIG`, for the text-model, voice and time-zone settings only (format below). Other relay settings (port, database, admin token, public URL) are environment-only.
3. **The app** (Settings → 模型 / 语音 / 提示词), see [Changing it from the phone](#changing-it-from-the-phone). What a phone sets overrides 1 and 2 until a phone resets it.

Precedence, per setting: a phone's change, then a non-empty environment variable, then the file, then the built-in default. A variable that is set but empty (`POCKET_X=`) counts as unset, so the empty lines of the template never hide a value from the file. A file that cannot be read or parsed stops the relay at startup with the reason.

At startup the relay prints one line per problem it found (a model without a key, an unknown provider, and so on) and a summary such as `[relay] assistant: deepseek, qwen  voice: moss-live`.

JSON values in an env file (`*_EXTRA_BODY`) go in single quotes: `POCKET_OPENAI_EXTRA_BODY='{"reasoning_effort":"low"}'`. systemd and Docker Compose remove the quotes; the relay also accepts them if a loader keeps them.

## Text assistant

### The model list

`POCKET_ASSISTANT_MODELS` is a comma-separated list, tried in order. The relay tries the next model if the request fails, the stream ends without text or a tool call, or no first token arrives within `POCKET_ASSISTANT_FIRST_TOKEN_MS` (default 25 000 ms). Reasoning tokens count as stream activity. Each model request may take up to 120 s.

Each entry is `provider:model`:

```sh
POCKET_ASSISTANT_MODELS=deepseek:deepseek-flash,qwen:qwen3.7-plus,ollama:qwen3:8b
```

The part before the first colon counts as a provider only if it names one (a preset below, `custom`, a provider in the config file, or an id with its own `POCKET_<ID>_BASE_URL`). Otherwise the whole entry is a model name for the default provider (`POCKET_ASSISTANT_PROVIDER`, default `custom`). So `ollama:qwen3:8b` is model `qwen3:8b` at Ollama, and with `POCKET_ASSISTANT_PROVIDER=ollama` a bare `qwen3:8b` means the same.

There is no default model list. Without models, or when no listed model has a usable provider, the assistant answers only that it is not set up.

### Providers

| id | Vendor | Protocol | Default base URL | Notes |
|---|---|---|---|---|
| `anthropic` | Anthropic | Anthropic Messages | `https://api.anthropic.com` | `x-api-key` header, `anthropic-version: 2023-06-01` |
| `openai` | OpenAI | Chat Completions | `https://api.openai.com/v1` | sends `max_completion_tokens` (`max_tokens` is deprecated there) |
| `mimo` | Xiaomi MiMo | Chat Completions | `https://token-plan-cn.xiaomimimo.com/v1` | uses `reasoning_effort: "low"` + `parallel_tool_calls` on tool turns; disables thinking on connectivity pings |
| `deepseek` | DeepSeek | Chat Completions | `https://api.deepseek.com` | Anthropic-compatible: `https://api.deepseek.com/anthropic` |
| `qwen` | Alibaba Cloud Model Studio (DashScope) | Chat Completions | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Singapore: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`. Keys belong to one region. Anthropic-compatible: `https://dashscope.aliyuncs.com/apps/anthropic` |
| `moonshot` | Moonshot Kimi | Chat Completions | `https://api.moonshot.cn/v1` | International: `https://api.moonshot.ai/v1`. Sends `max_completion_tokens` (its docs deprecate `max_tokens`). Anthropic-compatible: `https://api.moonshot.cn/anthropic` |
| `zhipu` | Zhipu GLM (BigModel) | Chat Completions | `https://open.bigmodel.cn/api/paas/v4` | Z.ai: `https://api.z.ai/api/paas/v4`. Tool arguments come in one piece unless `tool_stream` is set; both work. Anthropic-compatible: `https://open.bigmodel.cn/api/anthropic` |
| `siliconflow` | SiliconFlow | Chat Completions | `https://api.siliconflow.cn/v1` | International: `https://api.siliconflow.com/v1` |
| `volcengine` | Volcengine Ark (Doubao) | Chat Completions | `https://ark.cn-beijing.volces.com/api/v3` | |
| `openrouter` | OpenRouter | Chat Completions | `https://openrouter.ai/api/v1` | model names look like `vendor/model` |
| `gemini` | Google Gemini | Chat Completions | `https://generativelanguage.googleapis.com/v1beta/openai` | Gemini's OpenAI-compatible endpoint; streamed tool calls are not confirmed by its docs |
| `ollama` | Ollama (local) | Chat Completions | `http://localhost:11434/v1` | no key. In Docker use `http://host.docker.internal:11434/v1` |
| `custom` | your own gateway | Anthropic Messages unless set | none: set `POCKET_ASSISTANT_URL` or `POCKET_CUSTOM_BASE_URL` | the meaning `POCKET_ASSISTANT_URL` always had |

Chat Completions requests go to `{base}/chat/completions` with `Authorization: Bearer <key>`; Anthropic requests go to `{base}/v1/messages`. Both stream. The assistant's tools are sent as functions and the answers translated back, so any listed provider can call them, provided the model supports tool calling.

Example model ids from the vendors' docs in 2026-11 (check the vendor's current list): DeepSeek `deepseek-flash`, `deepseek-v4-pro`; Qwen `qwen3.7-plus`, `qwen3.8-max`; Kimi `kimi-k3`; GLM `glm-5.3`; Doubao `doubao-seed-2.1-pro`. For a voice-friendly assistant prefer fast models without long thinking: the first token has to arrive within the limit above.

### Per-provider variables

`<ID>` is the provider id in upper case, `-` replaced by `_` (`my-gw` becomes `POCKET_MY_GW_…`).

| Variable | Meaning |
|---|---|
| `POCKET_<ID>_API_KEY` | key for this provider (not needed for `ollama`) |
| `POCKET_<ID>_BASE_URL` | replaces the preset's base URL (international endpoints, proxies). Required for ids that are not presets |
| `POCKET_<ID>_PROTOCOL` | `openai`, `openai-responses`, `anthropic`, `gemini`, or `ollama`. Example: `POCKET_DEEPSEEK_PROTOCOL=anthropic` with `POCKET_DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic` |
| `POCKET_<ID>_AUTH` | `bearer`, `x-api-key`, `x-goog-api-key`, `api-key`, or `none`. Default: `x-api-key` for Anthropic, `x-goog-api-key` for Gemini, `none` for Ollama, `bearer` for OpenAI Chat/Responses |
| `POCKET_<ID>_EXTRA_BODY` | JSON merged into every request body last, e.g. `'{"reasoning_effort":"low"}'`, `'{"enable_thinking":false}'`, or a larger output limit for a reasoning model (`'{"max_completion_tokens":4000}'`) |

Any other id works as a provider once it has a base URL: `POCKET_MYGW_BASE_URL=https://llm.example.com/v1`, `POCKET_MYGW_API_KEY=…`, then `mygw:some-model` in the list. Such providers default to the OpenAI protocol. These ids are reserved: `assistant`, `voice`, `moss`, `admin`, `public`, `trust`, `port`, `host`, `db`, `config`.

### Shorthand for the default provider and the other assistant settings

| Variable | Default | Meaning |
|---|---|---|
| `POCKET_ASSISTANT_PROVIDER` | `custom` | provider for list entries without a prefix |
| `POCKET_ASSISTANT_KEY` | | key of the default provider (a provider's own `POCKET_<ID>_API_KEY` wins) |
| `POCKET_ASSISTANT_URL` | | base URL of the default provider |
| `POCKET_ASSISTANT_PROTOCOL` | provider's | protocol of the default provider |
| `POCKET_ASSISTANT_USER_AGENT` | none | `User-Agent` sent to every text provider, for gateways that filter on it |
| `POCKET_ASSISTANT_NAME` | `小羊` | the assistant's name in chat and on calls |
| `POCKET_ASSISTANT_FIRST_TOKEN_MS` | `25000` | see the model list above |
| `POCKET_ASSISTANT_CONFIRM` | `never` | `never`: the assistant acts at once. `always`: it asks before acting on agents in typed chats. Calls never wait. The app's Settings toggle "小羊动手前先问我" and the /admin dashboard override it; the override is kept in the relay database (`settings` table, key `assistant.confirm`) |

### Examples

```sh
# One vendor
POCKET_DEEPSEEK_API_KEY=sk-...
POCKET_ASSISTANT_MODELS=deepseek:deepseek-flash

# Two vendors, the second when the first fails or is slow
POCKET_QWEN_API_KEY=sk-...
POCKET_MOONSHOT_API_KEY=sk-...
POCKET_ASSISTANT_MODELS=qwen:qwen3.7-plus,moonshot:kimi-k3

# Your own OpenAI-compatible gateway, several models on it
POCKET_ASSISTANT_URL=https://llm.example.com/v1
POCKET_ASSISTANT_PROTOCOL=openai
POCKET_ASSISTANT_KEY=...
POCKET_ASSISTANT_MODELS=model-a,model-b

# An Anthropic-compatible gateway (what POCKET_ASSISTANT_URL meant before providers existed)
POCKET_ASSISTANT_URL=https://gateway.example.com
POCKET_ASSISTANT_KEY=...
POCKET_ASSISTANT_MODELS=model-a,model-b
```

### Upgrading from the single-gateway settings

Earlier versions read only `POCKET_ASSISTANT_KEY`, `POCKET_ASSISTANT_URL`, `POCKET_ASSISTANT_MODELS`, `POCKET_ASSISTANT_NAME` and `POCKET_ASSISTANT_USER_AGENT`, and filled in a built-in gateway, model list and user agent when they were missing. Those variables keep their meaning (an Anthropic-protocol gateway, models tried in order, the same requests), but nothing is filled in any more: set `POCKET_ASSISTANT_URL` and `POCKET_ASSISTANT_MODELS` explicitly, and `POCKET_ASSISTANT_USER_AGENT` if your gateway needs a particular one.

## Time zone

`POCKET_TIMEZONE` (or `"timeZone"` at the top level of the config file) is the IANA zone the assistant tells the time in, both spoken and written, and in which it understands reminder times. Examples: `Asia/Shanghai`, `Europe/Berlin`, `America/New_York`. Default: `Asia/Shanghai`. A name this system's time-zone data does not know is ignored with a warning, and the default stays.

In `Asia/Shanghai` the assistant calls its times 北京时间, as before. In any other zone they are 当地时间, and the model is also told the current UTC offset (daylight saving included), so reminder times it writes carry the right one. On a MOSS-Live call the zone is also passed as the call's `time_zone`.

## Admin token

`POCKET_ADMIN_TOKEN` is optional. A relay with no devices prints a one-time setup code and link for the first one, so pairing works without it. Only the `/admin` dashboard and the admin APIs need it; it must be at least 24 characters (`openssl rand -hex 24`), and a shorter one stops the relay at startup.

## Voice calls

`POCKET_VOICE_PROVIDER` selects the service: `moss-live` (default) or `openai-realtime`. Calls are off while the provider has no key. The phone app is the same for both: the relay converts audio and events, and the app never sees which service is behind a call. One call is open at a time; a new call replaces the old one.

### MOSS-Live (default, recommended)

| Variable | Older name | Default |
|---|---|---|
| `POCKET_VOICE_KEY` | `POCKET_MOSS_KEY` | (required) key from platform.mosi.cn → API Keys |
| `POCKET_VOICE_URL` | `POCKET_MOSS_URL` | `wss://api.mosi.cn/v1/realtime` |
| `POCKET_VOICE_MODEL` | `POCKET_MOSS_MODEL` | `moss-live-1.0` |
| `POCKET_VOICE_VOICE` | `POCKET_MOSS_VOICE` | the model's default voice |
| `POCKET_VOICE_SPEED` | `POCKET_MOSS_SPEED` | `1.1` (0.5–1.5; 1 is normal) |

When both names are set, `POCKET_VOICE_*` wins. Behaviour is unchanged from earlier versions.

### OpenAI Realtime protocol

| Variable | Default | Meaning |
|---|---|---|
| `POCKET_VOICE_KEY` | (required) | the service's key. `POCKET_MOSS_KEY` is not used here |
| `POCKET_VOICE_URL` | `wss://api.openai.com/v1/realtime` | `?model=` is added unless the URL has it |
| `POCKET_VOICE_MODEL` | `gpt-realtime` | realtime model, or the deployment name on Azure |
| `POCKET_VOICE_VOICE` | service default | OpenAI: `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, `cedar` |
| `POCKET_VOICE_SPEED` | service default | 0.25–1.5 |
| `POCKET_VOICE_AUTH` | `bearer` | `api-key` sends an `api-key` header (Azure) |
| `POCKET_VOICE_TRANSCRIBE_MODEL` | `gpt-4o-mini-transcribe` | speech-to-text for captions of what the person says; `none` turns it off |
| `POCKET_VOICE_LANGUAGE` | `zh` | language hint for transcription; `auto` leaves it out |
| `POCKET_VOICE_VAD` | `server_vad` | turn detection: `server_vad` or `semantic_vad` |
| `POCKET_VOICE_DIALECT` | `ga` | `beta`: the older flat session fields and `response.audio.*` events (see the table below) |
| `POCKET_VOICE_INPUT_RATE` / `POCKET_VOICE_OUTPUT_RATE` | `24000` | PCM sample rates the service takes and gives. OpenAI's `audio/pcm` is 24 kHz only |

How a call works on this protocol: the phone's 16 kHz microphone audio is resampled to the service's rate and its speech back to the phone's 48 kHz. The voice gets the same persona and instructions as on MOSS-Live, plus one function tool, `ask_backend`. A call of that tool is a task for the text assistant (the call screen shows it as one); the result goes back as the tool's output, and the voice reads its line aloud. When the person talks over an answer, the phone stops playback at once and the relay truncates the answer upstream to what was actually played, so the model knows what was heard.

Which services speak it, checked against their docs in 2026-11:

| Service | Works | How to set it up |
|---|---|---|
| OpenAI | yes | key and model; defaults above |
| Azure OpenAI | yes (same GA protocol) | `POCKET_VOICE_URL=wss://<resource>.openai.azure.com/openai/v1/realtime`, `POCKET_VOICE_MODEL=<deployment>`, `POCKET_VOICE_AUTH=api-key`. The older `api-version=…-preview` URL form is deprecated |
| Alibaba Qwen-Omni-Realtime | partly; untested | older event names (`POCKET_VOICE_DIALECT=beta`), 16 kHz input (`POCKET_VOICE_INPUT_RATE=16000`), its own transcription model (`qwen3-asr-flash-realtime`), a URL with your workspace id. No truncation of cut-off answers. Its docs do not claim OpenAI compatibility |
| StepFun realtime | partly; untested | older event names (`POCKET_VOICE_DIALECT=beta`); sample rate not stated in its docs; no truncation |
| Zhipu GLM-Realtime | partly; untested | older event names (`POCKET_VOICE_DIALECT=beta`); how the model is selected is not stated in its docs; no truncation |
| Volcengine / Doubao realtime dialogue | no | its own binary protocol |
| xAI Grok voice | unverified | its docs could not be read when this was written |
| MiniMax | no | no documented speech-to-speech realtime API |

"Partly; untested" means the relay has a mode for it, but it was never run against that service. Expect to adjust settings.

### Differences from MOSS-Live on the OpenAI Realtime protocol

- **Notices during a call** are better: when nobody is speaking, the relay asks the voice to say them right away. MOSS-Live can only bring them up on its next turn or inside a running task. While the person talks or an answer plays, a notice waits until that is over, or goes out with a running task's result.
- **A cut-off answer's caption** is estimated: the share of its text equal to the share of its audio that was played. MOSS-Live reports the heard text exactly.
- **Captions of the person's words** need a transcription model. Without one there are none, and tasks get less context. Transcripts can arrive after the answer has started, so a spoken question can land in the chat thread just after its answer.
- **A task cannot be called off.** MOSS-Live cancels a delegated task when the person changes their mind. Here the task runs to the end and the voice then says its result.
- **Silent notes and the spoken line** reach the voice in one tool output, labelled. MOSS-Live has separate channels for them. Keeping the notes silent relies on the model following the instructions.
- **The `beta` dialect** sets no speaking rate and sends no truncation, and services may reject fields this relay sends. If the session setup is refused, the call ends with "语音会话配置失败（<code>）" and the code is logged.

## Config file

`POCKET_CONFIG=/etc/herdr-pocket/relay.json` (keep it `chmod 600` like the env file: it can hold keys). Every key is optional; environment variables win per setting.

```json
{
  "timeZone": "Asia/Shanghai",
  "assistant": {
    "name": "小羊",
    "provider": "deepseek",
    "models": ["deepseek-flash", "qwen:qwen3.7-plus", "mygw:model-a"],
    "firstTokenMs": 25000,
    "userAgent": "my-relay",
    "providers": {
      "deepseek": { "apiKey": "sk-..." },
      "qwen": { "apiKey": "sk-...", "baseUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
      "openai": { "apiKey": "sk-...", "extraBody": { "reasoning_effort": "low" } },
      "mygw": {
        "protocol": "openai",
        "baseUrl": "https://llm.example.com/v1",
        "apiKey": "...",
        "auth": "bearer",
        "headers": { "x-team": "pocket" },
        "maxTokensField": "max_tokens"
      }
    }
  },
  "voice": {
    "provider": "moss-live",
    "apiKey": "...",
    "voice": "",
    "speed": 1.1
  }
}
```

- `timeZone` is the file form of `POCKET_TIMEZONE`.
- `assistant.models` may also be a comma-separated string. `assistant.apiKey`, `assistant.url` and `assistant.protocol` are the file forms of the default-provider shorthand.
- `providers.<id>` takes `protocol`, `baseUrl`, `apiKey`, `auth`, `headers` (file only), `maxTokensField` (`max_tokens` or `max_completion_tokens`, file only) and `extraBody`.
- `voice` takes `provider`, `apiKey`, `url`, `model`, `voice`, `speed`, and for `openai-realtime` also `auth`, `dialect`, `transcribeModel`, `language`, `vad`, `inputRate` and `outputRate`.

## Changing it from the phone

Any paired phone can change the assistant's name, its providers (protocol, address, key), the order models are tried in, the voice service and every prompt; computers cannot. The relay keeps one copy, so every phone sees the same settings, and a change takes effect with the next message or call, without a restart. The other phones are told at once. Two phones saving at the same moment do not overwrite each other: the later one is asked to refresh first.

- **What the server sets is the starting point.** Providers from the environment or the config file show as 服务器上的; a phone can change them but not delete them. Settings → 模型 → 恢复成服务器上的设置 drops every phone change, keys included. Once a phone has changed the model list, `POCKET_ASSISTANT_MODELS` no longer decides it until that reset.
- **Keys go in, never out.** A phone can set or clear a key; it is only ever shown whether one is set and its last four characters. A key is used only at the address (scheme, host and port) it was given for: moving a provider or the voice to another host does not take the key along, it has to be entered again. This also keeps a leaked phone token from redirecting a key to another server.
- **Keys and prompt edits are sealed** with AES-256-GCM. The seal key is a file next to the database, `<database>.key` (`/var/lib/herdr-pocket/relay.db.key`, `/data/relay.db.key` in Docker), created on first start, readable by the relay's user only. Back it up with the database: without it, keys set from a phone cannot be read (the relay says so and falls back to the server's keys) and prompt edits are lost. A copy of the database alone holds neither.
- **测速** on Settings → 模型 sends one short request to a model and shows the time to its first word and to the whole answer, so the fastest can go first.

### Prompts

The shipped prompts are Markdown files in [`apps/relay/src/assistant/prompts/`](../apps/relay/src/assistant/prompts/), one per part: `base` (personality and rules), `act_direct` / `act_ask` (acting at once or after asking), `text`, `cards_direct` / `cards_ask` (typed chats), `call`, `persona`, `voice_rules` (calls) and `woken` (looking at an agent that stopped). Placeholders such as `{{name}}` are filled in by the relay. Wake-up material, tool descriptions and the voice's hand-over line stay in code.

To keep your own wording out of this repository, put files with the same names in a folder of your own and point `POCKET_PROMPTS_DIR` at it: each `<id>.md` there replaces the shipped one (and is what 恢复默认 on the phone goes back to). Edits made on a phone are stored sealed in the database, never in the repository.

## Dictation (speech to text)

`POST /v1/transcribe` turns a recording into text for quick voice input in the desktop app (a global shortcut, then the text is pasted where you type). Any service with an OpenAI-compatible `/audio/transcriptions` endpoint works. Without settings of its own the relay reuses what it already has, read only:

1. `POCKET_TRANSCRIBE_URL` (+ `POCKET_TRANSCRIBE_KEY`): a service of its own;
2. else the OpenAI Realtime voice service (`POCKET_VOICE_PROVIDER=openai-realtime`, the `ga` dialect): its key and host, model `POCKET_VOICE_TRANSCRIBE_MODEL`;
3. else the `openai` text provider's key (model `gpt-4o-mini-transcribe`), or the `siliconflow` one's (`FunAudioLLM/SenseVoiceSmall`).

MOSS-Live alone does not give dictation: it has no separate speech-to-text endpoint that this relay knows of. A key only ever goes to the host it was configured for.

| Variable | Default | Meaning |
|---|---|---|
| `POCKET_TRANSCRIBE_PROVIDER` | `auto` | `auto` (the order above), `off`, `voice` (only the realtime voice service), or a text provider id such as `openai`, `siliconflow` or one of your own |
| `POCKET_TRANSCRIBE_URL` | | base URL of a service of its own; requests go to `<url>/audio/transcriptions` (http or https, e.g. a local Whisper server) |
| `POCKET_TRANSCRIBE_KEY` | | its key; without one nothing is sent as a key |
| `POCKET_TRANSCRIBE_AUTH` | `bearer` | `bearer`, `api-key` (an `api-key` header) or `none` |
| `POCKET_TRANSCRIBE_MODEL` | per service | model name; required for a text provider other than `openai` and `siliconflow` |

Requests: device token of a phone or the desktop app (computers and the admin token are refused); the body is the recording itself with its `Content-Type` (`audio/webm`, `audio/ogg`, `audio/wav`, `audio/mpeg`, `audio/mp4`, `audio/m4a`, `audio/flac`); `?language=zh|en|auto` and `&durationMs=`. Limits: 10 MB and 300 s per recording (a WAV's length is read from its header), 20 requests a minute and 2 at a time per device, 90 s for the service to answer. `GET /v1/transcribe` says whether dictation is available and with which service, or why not.

The relay keeps neither the audio nor the text. Each request is one `transcribe` line in the log (`herdr-pocket logs --kind transcribe`): device, service and model, size, length, time taken and the number of characters, never the words.

## Health

`GET /v1/health` (no auth) now also reports which services are configured, by name only:

```json
{ "ok": true, "assistant": ["deepseek", "qwen"], "voice": "moss-live", "...": "..." }
```

`assistant` is empty and `voice` is `null` when they are off.

## Computers and the desktop app: config.json

One settings file per user, shared by the `herdr-pocket` CLI, its daemon and the desktop app (macOS, Windows, Linux). It sits next to the computer's login file:

| OS | Path |
|---|---|
| macOS, Linux | `~/.config/herdr-pocket/config.json` |
| Windows | `%APPDATA%\herdr-pocket\config.json` |
| any, with `HERDR_POCKET_HOME` set | `$HERDR_POCKET_HOME/config.json` |

`herdr-pocket config path` prints it. The file holds no secrets: the relay address and device token stay in `hostd.json` (written by `herdr-pocket login`, owner-only), the desktop app's own login in its session file. A key name that looks like a secret (`token`, `apiKey`, `password`, …) is reported as an error.

Rules for the file:

- Plain JSON, UTF-8, no comments: `{ "version": 1, "<section>": { "<key>": value } }`.
- Every key is optional. A missing key, or a value that is wrong, means the default; `herdr-pocket config show` lists what is wrong. The file never stops a program from starting.
- Programs write only the key that changed, keep keys they do not know (written by a newer version) and never lower `version`. Writes replace the file in one rename, so a reader never sees half of it, and leave it readable by its owner only (`600` on macOS and Linux). A file that is not valid JSON is never overwritten: fix it or delete it.
- Which program writes what: keys read only by the app (see the table) are the desktop app's; `update.*` and `logging.level` / `logging.upload` are shared, and `herdr-pocket config` can set any key.
- Environment variables win over the file where noted.
- The daemon reads it again before each update check and every minute, and logs what changed (`config` lines in `herdr-pocket logs`).

### Commands

```sh
herdr-pocket config path                   # where it is
herdr-pocket config show [--all] [--json]  # what differs from the defaults, and problems
herdr-pocket config get update.region
herdr-pocket config set update.region cn
herdr-pocket config set update.mirrors https://mirror.example.com/,https://other.example.com/
herdr-pocket config unset update.region    # back to the default
herdr-pocket config edit                   # $VISUAL / $EDITOR, else Notepad (Windows) or vi in a terminal
herdr-pocket config keys                   # every key with its default
```

`set`, `unset` and `edit` also send one line to the relay's log when this computer is logged in (`kind config`, which key, old and new value); a file with mistakes is reported there too. Plain reads are not logged.

### Keys

Who reads it: CLI = `herdr-pocket` commands, daemon = `herdr-pocket run`, app = the desktop app.

| Key | Default | Values | Read by | Meaning |
|---|---|---|---|---|
| `general.language` | `"zh-CN"` | `zh-CN`, `en` | app | language of the desktop app |
| `general.theme` | `"system"` | `system`, `light`, `dark` | app | appearance |
| `general.textScale` | `100` | 80–160 | app | text size of the desktop app, in percent |
| `general.chatDisplayMode` | `"standard"` | `compact`, `standard`, `expanded` | app | conversation detail density (`compact`: merged activity groups; `standard`: separate thinking blocks + grouped tool tab; `expanded`: thinking & tool steps expanded) |
| `general.showShells` | `false` | boolean | app | list plain shells beside the agents |
| `general.useLocalLogin` | `true` | boolean | app | when this computer's `herdr-pocket` is logged in, the app joins the same relay with it (it asks that login for a one-time pairing code and pairs as its own device) |
| `general.launchAtLogin` | `false` | boolean | app | start the app when you log in |
| `general.closeToTray` | `false` | boolean | app | closing the window keeps the app in the menu bar or tray; off, closing the window quits the app |
| `general.notifications` | `true` | boolean | app | system notifications when an agent finishes or waits |
| `update.region` | `"auto"` | `auto`, `cn`, `global` | CLI, daemon, app | where downloads come from first, see [Regions and download sources](#regions-and-download-sources). `HERDR_POCKET_MIRROR=1` / `0` wins |
| `update.preferredSource` | `"auto"` | `"auto"`, `"direct"`, or a mirror prefix | CLI, daemon, app | `"auto"`: recommend by time zone and pick the lowest-latency reachable source. `"direct"`: try GitHub directly first. Or pin a specific mirror prefix (falls back to others if unreachable) |
| `update.autoCheck` | `true` | boolean | CLI, daemon, app | look for a new release now and then. `HERDR_POCKET_UPDATE_CHECK=0` wins |
| `update.checkIntervalHours` | `0.5` | 0.25–168 | daemon, app | hours between automatic checks (supports decimals such as `0.25` for 15 minutes and `0.5` for 30 minutes), ±10% at random |
| `update.mirrors` | `[]` | up to 20 prefixes | CLI, daemon, app | your own GitHub mirrors, e.g. `https://mirror.example.com/`: https, ending in `/`, put in front of a `https://github.com/…` address (plain `http://` only for `localhost` / `127.0.0.1`). Raced first, before the built-in ones |
| `update.checkTools` | `true` | boolean | daemon | once a day, look for newer hc, Herdr app and uniflo releases; report only, see [Updates of hc, the Herdr app and uniflo](#updates-of-hc-the-herdr-app-and-uniflo). Off as well when `update.autoCheck` is off |
| `logging.level` | `"info"` | `debug`, `info`, `warn`, `error` | daemon, app | lowest level kept and uploaded. `debug` adds every file-view request |
| `logging.upload` | `true` | boolean | daemon, app | send this device's log lines to the relay, where `herdr-pocket logs` reads them |
| `logging.keepDays` | `7` | 1–90 | app | days of local log files the desktop app keeps |
| `voiceInput.enabled` | `true` | boolean | app | dictation with a global shortcut (needs [dictation](#dictation-speech-to-text) on the relay) |
| `voiceInput.hotkey` | `"CommandOrControl+Shift+Space"` | a shortcut, or one modifier key | app | Either a shortcut with at least one modifier, or one modifier key alone (`RightOption`, `RightControl`, `RightCommand`, `RightShift`, `Fn`) held to talk. Shortcuts use the Tauri accelerator form (`CommandOrControl`, `Alt`/`Option`, `Shift`, `Super`, then a key such as `Space`, `D`, `F5`). `RightAlt` and `RightCtrl` are taken too and stored as `RightOption` and `RightControl`. See the notes below the table |
| `voiceInput.mode` | `"hold"` | `hold`, `toggle` | app | `hold`: talk while the shortcut is held. `toggle`: press to start, again to stop |
| `voiceInput.language` | `"auto"` | `auto` or a code (`zh`, `en`, …) | app | language hint for recognition |
| `voiceInput.insert` | `"paste"` | `paste`, `type`, `clipboard` | app | where the text goes: pasted into the focused app, typed key by key, or only copied |
| `voiceInput.maxSeconds` | `60` | 5–300 | app | a recording stops after this long |
| `voiceInput.sounds` | `true` | boolean | app | a short sound when recording starts and stops |
| `voiceInput.denoise` | `true` | boolean | nothing (reserved) | reserved for microphone noise suppression; nothing reads it yet, and the desktop app does not show it (its call noise suppression is a setting of its own) |
| `browser.homePage` | `""` | empty or an http(s) address | app | what a new tab of the built-in browser opens |
| `browser.searchEngine` | `"bing"` | `bing`, `google`, `baidu`, `duckduckgo` | app | for words typed into the address bar |
| `browser.cookieImport` | `"ask"` | `ask`, `off` | app | `ask`: offer to import cookies from another installed browser (each import asks first). `off`: never read other browsers' cookies |
| `browser.clearOnExit` | `false` | boolean | app | drop the built-in browser's cookies and cache on quit |
| `files.showHidden` | `false` | boolean | app | list dot files in the file view |
| `files.showIgnored` | `false` | boolean | app | list heavy generated folders (`node_modules`, `.git`, `dist`, `target`, …) |
| `resources.lowPower` | `"auto"` | `auto`, `on`, `off` | app | slower polling and fewer animations: on battery (`auto`), always, or never |
| `resources.memoryWarnMb` | `1024` | 256–16384 | app | warn when the desktop app uses more memory |
| `resources.diskWarnGb` | `5` | 1–1000 | app | warn when free disk space falls below this |
| `terminal.fontFamily` | `""` | font family name | app | monospace font family of the desktop terminal (empty: default stack) |
| `terminal.fontSize` | `13` | 10–28 | app | font size of the desktop terminal in pixels |
| `terminal.lineHeight` | `120` | 100–200 | app | line height of the desktop terminal in percent |
| `terminal.fontWeight` | `400` | 300–700 | app | normal text weight of the desktop terminal (bold stays 700) |
| `terminal.cursorBlink` | `true` | boolean | app | blink the cursor in the desktop terminal |

Notes on `voiceInput.hotkey`:

- `RightCommand` and `Fn` exist on macOS only. The file belongs to one machine, so it takes them on any OS; the desktop app says so when it cannot register the key.
- `Fn` on macOS also needs System Settings → Keyboard → "Press 🌐 key to" set to "Do Nothing"; otherwise macOS opens its own emoji picker or dictation.
- On Windows keyboard layouts where the right Alt key is AltGr, `RightOption` (right Alt) types characters, so `RightControl` is the safer choice on Windows.

Example:

```json
{
  "version": 1,
  "update": { "region": "cn", "mirrors": ["https://mirror.example.com/"] },
  "voiceInput": { "hotkey": "Alt+Space", "mode": "toggle", "language": "zh" },
  "files": { "showHidden": true }
}
```

The schema (types, defaults, checks and the Chinese labels the app shows) is `CLIENT_CONFIG_KEYS` in [`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts).

### Regions and download sources

Release files (update checks, the CLI bundle, installers, the Android APK) come from GitHub or from public mirrors put in front of its addresses. Which goes first depends on the region:

1. `HERDR_POCKET_MIRROR`: `1` (or `cn`) mirrors first, `0` (or `global`) GitHub first;
2. else `update.region` in `config.json`, unless it is `auto`;
3. else the time zone: mainland China (`Asia/Shanghai`, `Asia/Urumqi`, … ; on runtimes that only report `UTC+8`, together with a `zh-CN` locale) means mirrors first, everywhere else GitHub first.

The order is: your own `update.mirrors`, then for mainland China the built-in mirrors (`ghfast.top`, `gh-proxy.com`, `cdn.gh-proxy.com`, `edgeone.gh-proxy.com`) and GitHub last; elsewhere GitHub and then the mirrors.

Sources are not simply tried in turn. An update check asks all of them at once for the small `SHA256SUMS` file of the latest release, 4 s each. Once one answers, the others get 150 ms more; the fastest wins, except that an earlier one in the order wins when it was at most 150 ms slower. The winner is remembered for a day in the state folder (`~/.local/state/herdr-pocket/sources.json`, `%LOCALAPPDATA%\herdr-pocket\sources.json`, or `$HERDR_POCKET_STATE`) and asked first for the next check and for downloads. When no source answers in time, each is tried in turn with a long timeout, and the GitHub API too (first outside mainland China, last inside). Whatever comes through a mirror is checked against `SHA256SUMS`.

Automatic checks run a few minutes after the daemon starts, then every `update.checkIntervalHours`. Each is one `update` line in the log: the latest version, the source that answered, how long it took, how the source was chosen (remembered, race, one after another) and every source's time. `herdr-pocket update --check` asks now and prints the same. `herdr-pocket update --probe` races every source now, prints each one's time, and remembers the winner.

### Updates of hc, the Herdr app and uniflo

The daemon also looks for newer releases of the programs it works with, a few minutes after it starts and then about once a day (both jittered). It only reports; it never installs anything:

- hc (herdr-core): `core/latest.json` on Herdr's release server, offered only when its `generation` is the one the running core speaks, as Herdr's own app does (`hc update` stays within a generation);
- the Herdr app, only where it is installed (`/Applications/Herdr.app` or `~/Applications/Herdr.app` on macOS, `~/.local/share/herdr-app` on Linux, `%LOCALAPPDATA%\Programs\herdr-app` on Windows): `app/latest.json`;
- uniflo: `uniflo update --check --json`, which asks crates.io itself (10 s).

The release server is `HERDR_RELEASES_URL` if set (as for Herdr), else `https://releases.herdr.dev`; each request gets 4 s. Offline, the last answers stay. Each check is one `update` line in the log (`herdr-pocket logs --kind update`), and the answers are kept in the state folder (`upstream.json`). `herdr-pocket status` shows them, e.g. `upstream hc 0.1.21 → 0.1.22 可更新 · uniflo 0.2.8 (最新)`, or `未检查` before the first answer; phones and the desktop app get them in `host.info` (`tools.latest`). `update.checkTools: false`, `update.autoCheck: false` or `HERDR_POCKET_UPDATE_CHECK=0` turns it off.

## Sources

Vendor documentation the presets and the voice table were checked against (2026-11). Where a vendor's own page could not be opened from the build machine, the official SDK or cookbook was used instead; that is noted.

- Anthropic Messages: official Python SDK (`anthropics/anthropic-sdk-python`, `_client.py`, `types/message_create_params.py`, `types/input_json_delta.py`); docs page not reachable.
- OpenAI Chat Completions: official Python SDK (`openai/openai-python`, `types/chat/completion_create_params.py`, `types/chat/chat_completion_chunk.py`); docs pages not reachable.
- DeepSeek: https://api-docs.deepseek.com/, https://api-docs.deepseek.com/guides/tool_calls, https://api-docs.deepseek.com/guides/anthropic_api
- Qwen (DashScope): https://help.aliyun.com/zh/model-studio/base-url, https://help.aliyun.com/zh/model-studio/qwen-function-calling, https://www.alibabacloud.com/help/en/model-studio/anthropic-api-messages
- Moonshot Kimi: https://platform.kimi.com/docs/api/chat, https://platform.kimi.ai/docs/overview
- Zhipu GLM: https://docs.bigmodel.cn/cn/guide/develop/openai/introduction, https://docs.bigmodel.cn/cn/guide/capabilities/stream-tool, https://docs.bigmodel.cn/cn/guide/develop/claude/introduction, https://docs.z.ai/guides/develop/openai/python
- SiliconFlow: https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions, https://docs.siliconflow.com/en/api-reference/chat-completions/chat-completions
- Volcengine Ark: https://docs.volcengine.com/docs/82379/1298454, https://docs.volcengine.com/docs/ark/base-url-and-authentication
- OpenRouter: https://openrouter.ai/docs/api-reference/overview
- Gemini: Google's cookbook `quickstarts/Get_started_OpenAI_Compatibility.ipynb` (`google-gemini/cookbook`); https://ai.google.dev/gemini-api/docs/openai not reachable.
- Ollama: https://docs.ollama.com/api/openai-compatibility
- OpenAI Realtime (GA): official SDK types (`openai/openai-node` `src/resources/realtime/realtime.ts`; `openai/openai-python` `src/openai/types/realtime/`) and Microsoft's migration guide below.
- Azure OpenAI realtime: https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-websockets, https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-preview-api-migration-guide
- Qwen-Omni-Realtime: https://www.alibabacloud.com/help/en/model-studio/realtime, https://www.alibabacloud.com/help/en/model-studio/server-events
- StepFun: https://platform.stepfun.com/docs/zh/api-reference/realtime/chat
- Zhipu GLM-Realtime: https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-realtime
- Volcengine realtime dialogue: https://docs.volcengine.com/docs/6561/1594356
- MOSS-Live: https://platform.mosi.cn/docs/reference/moss-live
