# dsh-wechat-plugin

[![CI](https://github.com/xcisxc29/dsh-wechat/actions/workflows/ci.yml/badge.svg)](https://github.com/xcisxc29/dsh-wechat/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-wechat-plugin.svg)](https://www.npmjs.com/package/dsh-wechat-plugin)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

Turn WeChat into a remote control for [DeepSeek Harness](https://github.com/deepseek-ai): chat from
your phone, and the DSH agent on your computer does the work.

**No OpenClaw required.** This plugin speaks the Tencent iLink Bot API directly — the same HTTP/JSON
interface behind WeChat's official ClawBot plugin.

[中文说明](README.zh.md)

---

## Why it works

WeChat's ClawBot plugin **dials out** to Tencent's servers and long-polls. No public IP, no port
forwarding, no tunnel. As long as the machine is on and the process is running, your phone works from
any network.

The protocol was read from Tencent's own channel implementation
([`@tencent-weixin/openclaw-weixin`](https://unpkg.com/@tencent-weixin/openclaw-weixin@2.4.6/src/api/types.ts),
MIT) and verified against the live service:

| Check | Result |
|---|---|
| Does the server require OpenClaw? | No — it does not check client identity |
| QR login | Issues a real `ilink_bot_id` (`xxx@im.bot`) |
| Bearer auth | Works |
| Long-poll inbound | Real messages, all fields present |
| Send text | Arrives on the phone |
| Proactive message without `context_token` | Accepted by the server |
| Reuse the token across restarts | Works — no rescan after a reboot |

---

## What it does

| | |
|---|---|
| **Text both ways** | Your message becomes a DSH prompt; the reply comes back to WeChat |
| **Photos, files, voice, video** | Downloaded, decrypted, saved into the session workspace, and handed to the agent. Outbound too, through a `send_to_wechat` tool the agent can call |
| **One WeChat chat, many DSH sessions** | `/new`, `/list`, `/switch`, `/current`, `/cancel` — or just say "switch to the other one" in plain language |
| **Answer prompts from your phone** | Permission requests and multiple-choice questions are sent to WeChat and answered with a number. Without this, anyone away from the desk is stuck forever, because the default answerer fails closed |
| **Settings page** | In DSH under **Settings → WeChat**, styled with DSH's own design tokens |

---

## Install

Requires DSH with a workspace and tool service — the standard desktop composition.

### From the app

Open the **plugin** entry in the sidebar, choose **添加插件** (add plugin), and enter:

```
dsh-wechat-plugin
```

The field accepts a package name with an optional version, a Git URL, a tarball, or a local absolute
path — it is the same spec `dsh plugin add` takes. When the install finishes, use **立即启用** to turn
the bundle on, then restart DSH.

That is the whole install. The dialog also remembers which registry answered, and can fall back to
npmmirror when GitHub or npm is unreachable.

### From a terminal

The app drives `pnpm` underneath, so the same thing headlessly:

```bash
dsh plugin --profile desktop add dsh-wechat-plugin
```

Then make sure the bundle is enabled — this is what **立即启用** does for you:

```json
// ~/.dsh/profiles/desktop/package.json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-wechat-plugin"
      ]
    }
  }
}
```

### From source

```bash
pnpm install && pnpm build && pnpm run pack
# → dsh-wechat-plugin-<version>.tgz
```

Then paste the absolute path to that `.tgz` into **添加插件**, or:

```bash
dsh plugin --profile desktop add /absolute/path/to/dsh-wechat-plugin-<version>.tgz
```

### After installing

**Restart DSH.** Open **Settings → WeChat**, click **重新扫码** (rescan), and scan the QR code with your
phone. Send `你好` from WeChat and you should get a reply.

### Optional

Voice messages arrive as WeChat's SILK format. To transcribe them to WAV locally, install the codec
into the profile:

```bash
dsh plugin --profile desktop add silk-wasm
```

Without it, voice still works: the raw SILK file is saved and handed to the agent along with the
service's own transcription. Image thumbnails use `sharp`, which ships with the application; if it is
absent, images are sent without one.

Set `DSH_WECHAT_NO_CODECS=1` to force both codecs off — useful for checking what a stripped
deployment will do.

---

## Use

```
你好                          → starts a conversation
/new 修复登录                  → a new conversation, titled
/list                         → what conversations exist
/list all                     → including other workspaces
/switch 3                     → move to number 3
/current                      → where am I
/cancel                       → stop the current task
/help                         → the list above
```

Spaces are optional: `/switch3`, `/switch 3` and `/switch:3` all work, because phone keyboards drop
spaces. A bare `/news` is left alone — a command name followed by an ASCII letter is not split.

**You do not have to remember any of this.** Plain language works: "switch to the other one", "what
conversations do I have", "stop". The agent judges the intent and calls a tool; `/list` and the spoken
path render the same list from the same code, so the same question gives the same answer.

**Conversation titles come from your first message.** DSH names a session from its first prompt, so
the channel sends that first message with *only* your words — the standing channel note goes as a
separate message immediately after. Otherwise every conversation would be named after the note.

See [SETTINGS.md](SETTINGS.md) for every setting, in Chinese.

---

## Security — read this

**Anyone who can message this bot can drive the computer it runs on.** The agent can execute commands
and read and write files, and messages from WeChat are the only credential involved.

That means: the bot's WeChat account, and the friend list that can reach it, are the security
boundary. There is no allowlist in this version. If that is not a boundary you want, do not run it, or
run it where a stranger with your WeChat account would not matter.

Related, and deliberate: **there is no password on the settings page.** One was built and then
removed as over-complicated. It also protects less than it appears to — it cannot stop anyone who can
send the bot a WeChat message, which is the actual threat.

---

## How it works

```
phone WeChat ──► Tencent iLink ──► your machine
                                     │
                               dsh-wechat-plugin
                                     │
                   ┌─────────────────┴─────────────────┐
                   │  @dsh-wechat/core                 │  protocol, zero DSH dependencies
                   │  login / long-poll / send / state │
                   └─────────────────┬─────────────────┘
                                     │
                   ┌─────────────────┴─────────────────┐
                   │  dsh-wechat-plugin (bundle)       │  host glue
                   │  routing / settings / replies     │
                   └───────────────────────────────────┘
```

Two halves. `@dsh-wechat/core` is a plain client for the iLink API and knows nothing about DSH, so it
is testable and reusable on its own. The bundle wires it to DSH: session routing, the settings page,
media, and the return path for replies.

### Examples

Both run from the repository root after `pnpm build`, and use `@dsh-wechat/core` directly — no DSH, no
agent.

```bash
# The whole protocol in about forty lines: log in, echo every message back.
node --experimental-transform-types examples/echo-bot.ts

# Send a file to a WeChat user *without* being asked — no `context_token` needed.
node --experimental-transform-types examples/send-file.ts ./report.md
```

`echo-bot` prints the QR login URL and then echoes whatever you send it. `send-file` reuses the
credentials already in `$DSH_HOME/wechat/state.json` rather than logging in again, because a second
client scanning would rebind the bot and unbind the phone.

The examples are type-checked with the rest of the repository (`pnpm typecheck`), which is not
decoration: the first version of `send-file` passed a file path to `sendFile`, whose real signature
wants an uploaded CDN reference. Only the compiler caught it.

| Document | Contents |
|---|---|
| [README.zh.md](README.zh.md) | Full notes, protocol evidence, progress (Chinese) |
| [SETTINGS.md](SETTINGS.md) | Every setting explained (Chinese) |
| [docs/POSTMORTEM.md](docs/POSTMORTEM.md) | Every real failure met while building this, and its cause |
| [docs/RELEASING.md](docs/RELEASING.md) | How a version gets published (Chinese) |
| [examples/](examples) | A working echo bot and a proactive file send, on `core` alone |

---

## Development

```bash
pnpm install
pnpm build        # compiles core to lib/ — the bundle imports the built form
pnpm typecheck    # includes examples/
pnpm test         # 173 tests
pnpm check        # build + typecheck + test
pnpm run pack     # not `pnpm pack`: that is pnpm's own command and fails here
pnpm run verify-pack  # extract, check the manifest's files exist, and mount it as DSH would
```

**Rebuild `core` after changing it.** Tests resolve `@dsh-wechat/core` through `node_modules` to
`lib/`, so source edits without a rebuild test the *old* code — and pass.

`scripts/` holds the long-lived tools: `pack`, `verify-pack`, `smoke`, `probe-silk`,
`probe-installed`, `preview`, `asar-extract`. One-off debugging probes were deleted once their
findings became regression tests.

---

## Licence

MIT — see [LICENSE](LICENSE).
