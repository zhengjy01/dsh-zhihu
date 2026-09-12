# @zhengjy01/dsh-zhihu

A [Zhihu](https://www.zhihu.com) (知乎) plugin for [DeepSeek Harness](https://github.com/deepseek-ai/dsh): it wraps the local **zhihu CLI** — [pyzhihu-cli](https://github.com/BAIGUANGMEI/zhihu-cli), command name `zhihu` — as `zhihu_*` agent tools. Search questions, read the hot list, inspect questions / answers / comments, look up users, browse the recommended feed, topics and notifications. Publishing, voting, following and deleting are **off by default** and gated behind an explicit `readOnly` switch.

- **Read tools** call `zhihu <command> --json` and normalize the raw Zhihu API payload into compact items (id, type, title, URL, author, upvotes, answer count).
- **Login** rides Zhihu's official QR-code API: the CLI writes the QR image to a PNG and the plugin hands the path to the agent, which can show it to the user. Pasting a cookie string is also supported — the plugin writes the CLI's cookie file directly, so the token never lands in the process list.
- **Write tools** are not registered at all by default, so nothing can be published or deleted by accident.

## Prerequisites

```bash
# Install the Zhihu CLI (Python 3.10+; uv keeps it in its own venv)
uv tool install pyzhihu-cli      # or: pipx install pyzhihu-cli
zhihu --version                  # zhihu-cli, version 0.2.4
```

The plugin resolves `zhihu` from `$PATH`, `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`; point `cliPath` at an absolute path if it lives elsewhere.

> **Important**: *every* pyzhihu-cli command requires a login — even the hot list fails with `Not authenticated`. The first run must therefore be a `zhihu_login`.

## Tools

### Management and auth

| Tool | Purpose |
|---|---|
| `zhihu_status` | CLI availability and version, login state (cookie has `z_c0`/`_xsrf`/`d_c0`), read-only mode, paths, timeout. Never echoes cookie contents |
| `zhihu_config` | Configure `readOnly` / `cliPath` / `timeoutMs` / `loginWaitMs` / `proxy` / `cliHome`; `reset: true` restores defaults. Call with no arguments to read |
| `zhihu_login` | Log in. `mode: qrcode` (default) returns the QR PNG path (`~/.zhihu-cli/login_qrcode.png`) to show the user and can be called again to keep waiting (it never spawns a second QR code); `mode: cookie` accepts pasted `z_c0/_xsrf/d_c0` and verifies online |
| `zhihu_logout` | Remove the CLI's cookie file |
| `zhihu_whoami` | Current account profile |

### Read

| Tool | Purpose |
|---|---|
| `zhihu_search` | Search content (`type: general\|people\|topic`) |
| `zhihu_hot` | Zhihu hot list |
| `zhihu_question` | Question detail; `answers: true` adds the answer list (`limit` / `sort`) |
| `zhihu_answer` | Answer body; `comments: true` adds comments |
| `zhihu_user` | User profile, or their answers / articles / followers / following (`include`) |
| `zhihu_feed` | Recommended feed; `withComments: true` uses the CLI's text-mode "feed + comments" |
| `zhihu_topic` | Topic detail; `hotQuestions: true` adds the topic's hot questions |
| `zhihu_notifications` | Notifications (with `offset` paging) |
| `zhihu_collections` | Your collections |

### Write (registered only when `readOnly: false`)

| Tool | Purpose |
|---|---|
| `zhihu_publish` | Publish a question / pin / article (`kind: ask\|pin\|article`, optional topics and local images; `dryRun: true` only echoes the command) |
| `zhihu_vote` | Upvote / cancel an upvote |
| `zhihu_follow_question` | Follow / unfollow a question |
| `zhihu_delete` | Delete your own question / pin / article (requires explicit `confirm: true`) |

## Web panel

Two entries, one component:

1. **A bottom-right floating ball** (blue 「知」 button) — reachable from any page, opening a 380px popover.
2. **A 「知乎」 card in the settings page** (`settings.section`).

The panel covers: login state with an **inline QR code** (one click, auto-detects the scan), the account summary, the read-only switch, proxy / timeout settings, and quick hot-list / search lookups with clickable links.

It talks to the loopback-only `/api/dsh-zhihu/*` route family (`status`, `config`, `login`, `qrcode`, `logout`, `whoami`, `hot`, `search`); non-loopback peers, foreign Host headers and cross-site Origins get 403. The QR is returned as a PNG data URL — no new files on disk.

> Client changes need a browser hard refresh; host changes or `dsh.client` manifest changes need a `dsh web` restart.

## Read-only switch

The plugin is **read-only by default**: write tools are never registered, so the model cannot even see them.

Two ways to open them up:

```jsonc
// 1) At install time, seed it in cordis.patch.yml
- insert:
    - id: zhihu
      name: dsh-zhihu
      config:
        readOnly: false
```

```
2) At runtime via the tool (stored in ~/.dsh/dsh-zhihu.json, remounts immediately):
   zhihu_config({ readOnly: false })     # enable write tools
   zhihu_config({ readOnly: true })      # revoke them
```

The store value wins over the install-time seed; with neither set, read-only applies.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `readOnly` | `true` | Only read tools when true; write tools are registered when false |
| `cliPath` | `zhihu` | CLI command name or absolute path |
| `timeoutMs` | `90000` | Per-invocation timeout |
| `loginWaitMs` | `15000` | How long `zhihu_login` waits for a scan before returning; call it again to keep waiting |
| `proxy` | empty | Empty = inherit the environment; `none` = force no proxy (Zhihu is a domestic site, a system proxy can actually break it); or `http://host:port` |
| `cliHome` | `~/.zhihu-cli` | CLI config directory. The CLI hardcodes `Path.home()/".zhihu-cli"`, so the plugin overrides the child process's `HOME` |

Stored in `~/.dsh/dsh-zhihu.json` (mode 0600). Credentials are **not** stored here — the CLI keeps cookies in `<cliHome>/cookies.json` (the CLI chmods it 0600 itself).

## Logging in

**Option 1 — QR code (recommended)**

```
zhihu_login()                     → returns qrcodePath (~/.zhihu-cli/login_qrcode.png)
   ↓ the agent shows it with read_image / present
the user scans it in the Zhihu app
zhihu_login()                     → keeps waiting; returns authenticated: true
```

**Option 2 — paste a cookie**

```
zhihu_login({ mode: "cookie", cookie: "z_c0=...; _xsrf=...; d_c0=..." })
```

The plugin writes the cookie straight into the CLI's `cookies.json` (byte-compatible with the CLI's own `save_cookies`) and then verifies it online via `zhihu whoami`; a failed check removes the file and reports why. Unlike `zhihu login --cookie`, this path never exposes the token in the process list.

## Compatibility

Requires **DeepSeek Harness ≥ 0.1.5-rc.1** (declared in `dsh.engines.dsh`, which the plugin market reads) and is tested on **0.1.5-rc.1**. This build follows the DSH 0.1.5 strict tool-result contract (lossless-JSON snapshots, `additionalProperties: false` schema validation, `output.render` returning `ContentBlock[]`) and resolves the executable independently of the host `PATH` (a launchd-managed host only has `/usr/bin:/bin`).

## Known limitations

- The CLI's `--json` mode does **not** cover comments, the "feed + comments" command, or a topic's hot questions. Those three fall back to text mode and land in the result's `text` field (ANSI colour codes stripped).
- `zhihu_search` / `zhihu_hot` accept `-a/--answers` only in the CLI's human-readable mode; it is ignored under `--json`, so the plugin does not expose it.
- Zhihu applies risk control. This plugin is a thin wrapper — request volume and compliance are the caller's responsibility; do not crawl aggressively.
- Zhihu's public API can change; the real command surface is whatever `zhihu <cmd> --help` reports locally.

## Development

```bash
pnpm install
pnpm typecheck         # tsc --noEmit (host + client)
pnpm build             # tsc for .d.ts + tsdown for lib/index.js (host) and lib/client.js (browser)
pnpm test              # smoke tests (real CLI calls; all writes land in a temp dir)
pnpm test:e2e          # drive the plugin's own tools against the real CLI (no host restart)
node tests/routes.mjs  # hit /api/dsh-zhihu/* with synthetic req/res
node tests/client.mjs  # execute lib/client.js under a synthetic __ModuleLoader__
```

Artifacts: `lib/index.js` (host, ESM) + `lib/client.js` (browser closure-factory) + `lib/types/` (.d.ts).

## Install into a profile

```bash
dsh plugin --profile web add @zhengjy01/dsh-zhihu
dsh plugin --profile web add link:/path/to/dsh-zhihu
# or, once published
dsh plugin --profile web add github:zhengjy01/dsh-zhihu
```

A DSH web restart is required afterwards (there is no hot reload).

## License

MIT. The Zhihu CLI itself (pyzhihu-cli) is Apache-2.0; this project only invokes it as a subprocess and contains none of its code.
