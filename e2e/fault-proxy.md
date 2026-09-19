# Fault-injection proxy

`fault-proxy.mjs` is a local reverse proxy in front of the Telegram Bot API. With
it you can break the channel between the bot and Telegram on purpose, in a known
way and at a known moment, and see what the bot does. It forwards every call
unchanged until a rule says otherwise. It is plain Node with no dependencies.

## Launch

```powershell
.\e2e\run-test-bot.ps1 -FaultProxy    # Windows
```

```bash
./e2e/run-test-bot.sh --fault-proxy   # macOS / Linux
```

The flag starts the proxy in the background on `http://127.0.0.1:8765` and points
the bot at it for this launch only. `e2e/.env` is not touched. Without the flag the
bot talks to Telegram directly, as before. The proxy starts with no fault active,
and a proxy left from a previous launch is replaced. `stop-test-bot` stops it
along with the rest.

- Upstream: `https://api.telegram.org`. If `e2e/.env` sets its own
  `TELEGRAM_API_ROOT`, that root is used as the upstream instead, giving the chain
  bot → fault proxy → your root.
- Not supported: `TELEGRAM_PROXY_URL` (SOCKS/HTTP). The launch refuses when
  `e2e/.env` sets it.

To run the proxy by hand:
`node e2e/fault-proxy.mjs [--port 8765] [--upstream URL] [--state-dir DIR]`.

## Control API

All control routes are under `http://127.0.0.1:8765/__fault`. They answer JSON, and
a new rule applies from the next call on.

| Request | What it does |
| --- | --- |
| `GET /__fault/state` | Upstream, current call-log file, active rules, scenario names |
| `POST /__fault/rules` | Add a rule (body below); `400` with a reason on bad input |
| `GET /__fault/rules` | List active rules with their matched / fired counts |
| `DELETE /__fault/rules` | Remove all rules |
| `DELETE /__fault/rules/<id>` | Remove one rule |
| `POST /__fault/scenarios/<name>` | Apply a named scenario; optional body `{"durationSeconds": N}` |
| `GET /__fault/stats` | Per-method counters: `calls`, `injected`, `reachedUpstream` |
| `DELETE /__fault/stats` | Reset the counters |

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8765/__fault/scenarios/drop-send
Invoke-RestMethod -Method Post http://127.0.0.1:8765/__fault/rules -ContentType application/json `
  -Body '{"methods":"editMessageText","action":{"type":"error","status":429,"retryAfter":5}}'
Invoke-RestMethod -Method Delete http://127.0.0.1:8765/__fault/rules
```

## Rules

```json
{
  "methods": ["sendMessage", "sendRichMessage"],
  "when": "always",
  "payloadContains": "some text",
  "durationSeconds": 60,
  "action": { "type": "drop" }
}
```

- `methods`: a Bot API method name, a list of them, or `"*"` (the default).
  File downloads (`/file/bot<token>/...`) are the method `file`.
- `when`: which of the matching calls to break.
  - `"always"` (the default);
  - `"once"`: the first one only;
  - `{"every": K}`: every K-th;
  - `{"from": N}`: the N-th and every one after it.

  Counting starts when the rule is added.
- `payloadContains`: only calls whose JSON body or query string contains this
  text. Multipart uploads stream through unread and never match it.
- `durationSeconds`: the rule removes itself after this long.
- `action.type`:
  - `drop`: close the connection without an answer. The call never reaches
    Telegram, and the bot sees a network error.
  - `hang` + `seconds`: accept the call, stay silent that long, then drop. The call
    never reaches Telegram.
  - `error` + `status` (400–599), optional `description` and `retryAfter`: answer
    with a Bot API error body, `{"ok":false,"error_code":…,"description":…,"parameters":{"retry_after":…}}`.
  - `latency` + `ms`: wait, then forward normally.
  - `deliver-then-drop`: forward to Telegram, wait for its answer, then close the
    connection to the bot without passing the answer on. Telegram did the work,
    but the bot does not know it. Use it to prove a retry does not send a
    duplicate.

When several rules match a call, every one of them counts it, and the first one
added that fires acts on it.

## Scenarios

| Name | Rules |
| --- | --- |
| `drop-send` | `drop` on `sendMessage` and `sendRichMessage`, always; `getUpdates` passes |
| `blackout` | `drop` on every method, `getUpdates` and file downloads included, for 90 s (override with `durationSeconds`) |
| `no-duplicate` | `deliver-then-drop` on the first `sendMessage` / `sendRichMessage` |

## Call log

Each proxy launch writes `.tmp/e2e/fault-proxy/calls-YYYY-MM-DD_HH-MM-SS.jsonl`,
one JSON line per call:

- `time`, `method`;
- `path`, with the token replaced by `<token>`;
- `request`: the JSON payload, or `{"streamed":true,"bytes":N}` for uploads;
- `status`, and `response`: the JSON body, or `{"bytes":N}` for files;
- `durationMs`;
- `injected`: `{"rule":"r1","action":"drop"}`, or `null`;
- `reachedUpstream`;
- `error`, when the call broke.

The bot token never appears in the log or in the control answers.
