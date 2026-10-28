# dsh-token-ledger

Transparent, auditable token accounting for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

[![CI](https://github.com/zhz8888/dsh-token-ledger/actions/workflows/ci.yml/badge.svg)](https://github.com/zhz8888/dsh-token-ledger/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@zhz8888/dsh-token-ledger.svg)](https://www.npmjs.com/package/@zhz8888/dsh-token-ledger)
[![license](https://img.shields.io/npm/l/@zhz8888/dsh-token-ledger.svg)](./LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%5E0.2.0--rc.1-4c1a97)](https://github.com/deepseek-ai/deepseek-harness)
[![last commit](https://img.shields.io/github/last-commit/zhz8888/dsh-token-ledger)](https://github.com/zhz8888/dsh-token-ledger/commits/main)

English | [中文](README.zh.md)

---

A ledger, not a dashboard. It folds the durable DSH session log into token totals,
keeps them restart-safe, and — the part that matters — lets you **recompute the
exact same numbers from the raw logs and diff them** against what the running host
recorded.

```
$ dsh-token-ledger audit
scanned 139 session log(s), 344203 events, 29 forked session(s), 0 unreadable

  stored      6901 calls  1205685663 tokens
  recomputed  6901 calls  1205685663 tokens

  audit: match — the stored ledger equals a fresh fold of the raw logs
```

If you only want a pretty chart, there are a dozen plugins for that. This one is
for when you need to *defend* the number.

The settings page has three tabs — **Overview** (the ledger, with what each period
cost), **Rates** (a price list for each vendor's newest models, with the live
USD/CNY rate) and **Bill** (the same usage turned into money — four groupings
stacked over five periods each, exportable as CSV or JSON in one file) — and a CLI
that works with no host running at all.

## Contents

- [Quick start](#quick-start)
- [Requirements](#requirements)
- [Screenshots](#screenshots)
- [Why it installs where others do not](#why-it-installs-where-others-do-not)
- [Install](#install)
- [CLI](#cli)
- [The settings page](#the-settings-page)
- [How the numbers are counted](#how-the-numbers-are-counted)
- [Configuration](#configuration)
- [What it deliberately does not do](#what-it-deliberately-does-not-do)
- [Permissions](#permissions)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Security](#security)
- [Support](#support)
- [Acknowledgements](#acknowledgements)
- [License](#license)

## Quick start

```bash
# 1. add the plugin to a profile
dsh plugin --profile web add @zhz8888/dsh-token-ledger

# 2. restart DSH, then check the row landed
dsh --profile web --dump-config | grep token-ledger

# 3. in a conversation, ask for the ledger
/tokens
```

Or, with no host running at all — the CLI reads the raw session logs itself:

```bash
dsh-token-ledger summary   # the stored ledger
dsh-token-ledger audit     # recompute from the raw logs and diff the two
```

The ledger is written to `<DSH_HOME>/token-ledger/ledger.json`, and a fresh install
folds the history already on disk rather than starting from today. It needs DSH
`^0.2.0-rc.1` (verified against `0.2.1-rc.3`) and Node ≥ 22.15.0; everything else is
optional.

## Requirements

| | Requirement | Notes |
| --- | --- | --- |
| **DSH** | `^0.2.0-rc.1` | Verified against `0.2.1-rc.3`. Load-bearing: DSH skips a plugin whose range excludes the running harness. See [Compatibility](docs/COMPATIBILITY.md). |
| **Node** | ≥ 22.15.0 | The CLI decodes Zstandard frames. The host half needs nothing version-specific. |
| **Profile** | Any | The settings page needs a profile with a web server (`web` or `desktop`); `/tokens` and the CLI work everywhere. |
| **Network** | Optional | Only the price list and the USD/CNY rate are fetched. `rates: false` removes every request. |
| **Disk** | A writable `<DSH_HOME>/token-ledger/` | The only directory it writes to, besides the exports you ask for. |

## Screenshots

The settings page's tabs, captured on a real ledger:

**Overview**, with the month's totals, today's usage and a year of activity:

![Overview tab: month totals, today's usage, and the year's activity heatmap](assets/screenshots/01-overview.jpg)

**The calendar**, where a month's shape lives — busiest day, lightest day, the day
that ran latest — above the same usage broken down by model:

![Calendar view: month heatmap with the busiest, lightest and latest day, and usage by model](assets/screenshots/02-calendar.jpg)

**The last seven days** as bars, with the same by-model breakdown:

![Seven-day token totals as bars, with usage by model](assets/screenshots/03-weekly.jpg)

**Rates**: the live USD/CNY rate and each vendor's published price list:

![Rates tab: USD/CNY rate and per-vendor model prices](assets/screenshots/04-rates.jpg)

## Why it installs where others do not

| Property | Why it matters |
| --- | --- |
| **Nothing is installed for you** | No runtime dependencies, and every declared peer is an optional host package — so a version drift in a DSH package cannot pull a second copy of the harness into your profile. |
| **Zero install scripts** | `dsh plugin add` from a git URL works immediately — pnpm has no build to block and no `allowBuilds` entry to add. |
| **Only `node:` imports** | The host half loads from any profile (web, desktop, headless, TUI) without resolving a single package. |
| **No model-facing surface** | It registers no prompt section, no message and no tool, so it cannot change a request prefix or hurt KV-cache reuse. |
| **Fails soft** | Every hook is guarded. A ledger fault logs a warning; it never fails a session. |

## Install

```bash
# from npm
dsh plugin --profile web add @zhz8888/dsh-token-ledger

# from a git URL (no build step is involved)
dsh plugin --profile web add github:zhz8888/dsh-token-ledger

# from a local checkout
dsh plugin --profile web add /absolute/path/to/dsh-token-ledger
```

The npm package is scoped because npm rejects the unscoped name
`dsh-token-ledger` as too similar to an existing package once separators are
normalized away. The CLI command is still `dsh-token-ledger`.

Restart DSH, then check the row landed:

```bash
dsh --profile web --dump-config | grep token-ledger
```

In the conversation, `/tokens` prints the ledger:

```
/tokens
/tokens export     # write CSV + JSON under <DSH_HOME>/token-ledger/exports/
/tokens json       # the raw snapshot
/tokens path       # where the ledger file is
```

The ledger is written to `<DSH_HOME>/token-ledger/ledger.json`.

## CLI

Works without DSH running — it reads the raw logs directly.

```
dsh-token-ledger [summary] [options]     print the stored ledger (default)
dsh-token-ledger audit   [options]       recompute from raw logs and diff
dsh-token-ledger rebuild [options]       recompute from raw logs
dsh-token-ledger export  [options]       write CSV and JSON exports
dsh-token-ledger help    [options]       print the usage text

--home <path>    DSH home to read (default: the DSH_HOME variable, else ~/.dsh)
--ledger <path>  ledger file to read or write
--out <path>     export destination directory
--days <n>       days in the summary (default 7)
--models <n>     models in the summary (default 5)
--write          with rebuild: replace the stored ledger
--json           machine-readable output
--quiet          suppress the human summary, keep the exit code
-h, --help       print the usage text
-v, --version    print the version
```

Exit codes: `0` success or audit match, `1` audit found a real difference,
`2` bad usage or an unreadable input. That makes it usable as a scheduled check.

## The settings page

The browser half adds a **Token ledger** section to the settings sidebar, with
three tabs. Its own labels are registered with the host's locale service, so they
follow the host's language.

- **Overview** — the month's totals, today live, a usage calendar, and a per-model
  breakdown, with what each period cost.
- **Rates** — the live USD/CNY rate and each vendor's published prices, every one
  of them editable by hand for the times the network is not there.
- **Bill** — the same usage as money: workspace, session, model and vendor
  stacked, each with its own period, one CSV or JSON export for all of it.

[The settings page in full](docs/SETTINGS-PAGE.md) — what each view shows, and
where every price on it came from.

## How the numbers are counted

| Rule | Behaviour |
| --- | --- |
| **Successful anchors only** | Usage is taken from a completed step and from a compaction call. A failed or cancelled attempt never appends either, so it is never counted. |
| **Streaming samples are replaced, not added** | When a step emits a `usage` chunk and then its final message, the final value replaces the earlier sample — one call either way. |
| **`totalTokens` is derived** | It is the sum of the four buckets, never the provider's own total field. |
| **Reasoning tokens are a subset** | Reported separately, never added into the total, because they are already inside `outputTokens`. |
| **Local calendar days** | Days are your days, not UTC days. |
| **Forks are cut, resumes are not** | A fork's prefix belongs to the parent session; a resume's prefix is this session's own. |

[How the numbers are counted](docs/COUNTING.md) — the rules, how a fork is told
from a resume, and what the audit's two kinds of difference mean.

## Configuration

Override the composition entry by its `id`:

```yaml
- id: token-ledger
  config:
    ledgerPath: 'D:/dsh/ledger.json'   # default: <DSH_HOME>/token-ledger/ledger.json
    backfill: false                     # default: true — fold stored history on startup
    backfillLogs: false                 # default: true — read the session logs on disk too
    rates: false                        # default: true — false makes no network request at all
```

[Configuration](docs/CONFIGURATION.md) — every key, what it changes, and where the
history comes from.

## What it deliberately does not do

- **The overview states an estimate with its basis; the bill itemizes it.** Both name
  the price source, the rate they converted at, every price joined by name and every
  model that could not be priced, so the number can be checked rather than believed.
  Neither is a provider invoice and neither claims to be.
- **No bundled price list.** Prices are fetched from a source you can choose — the
  default is each vendor's own list price — or typed by you. A price list shipped
  inside the package would be wrong within weeks and would have to be updated by a
  release.
- **No model-facing tool.** A tool schema costs prompt tokens on every request and
  shifts the cache prefix — a strange thing for a token-accounting plugin to do.
  `/tokens` and the CLI cover the human cases.

## Permissions

What the plugin does with the machine it runs on, stated so it can be checked rather
than inferred:

| Capability | What it actually does |
| --- | --- |
| **Files** | Reads the session logs under `<DSH_HOME>/sessions/`, read-only, and reads `<DSH_HOME>/settings.yaml` for the provider display names a bill shows. Writes two files in its own directory — `<DSH_HOME>/token-ledger/ledger.json` and `rates.json` — plus exports where you ask for them. Nothing outside that directory is written or removed. |
| **Network** | Plain HTTPS `GET`s, and only while the rates feature is on: the price catalogue, the USD/CNY rate, and at most three vendor pricing pages. `rates: false` removes every one of them. The browser half makes no external request at all. |
| **Commands** | No shell, no child process, no spawn — neither at install time nor at run time. What it exposes is the `/tokens` slash command and the `dsh-token-ledger` binary you run yourself. |
| **Credentials** | None are read. `process.env` is consulted only to resolve `DSH_HOME`; no provider API key, no keychain, no OAuth. |

Every claim above can be checked against the source — the imports, the URLs and the
state directory are all in `lib/`, and `pnpm run verify` asserts the packaging
invariants that keep the install side true. The long form is in
[Compatibility](docs/COMPATIBILITY.md).

## Troubleshooting

**The plugin did not mount at all.**
DSH skips a plugin whose declared DSH range excludes the running harness, and it
says so in the host's own log. This one is `^0.2.0-rc.1`, so a `0.1.x` harness will
not load it — see [Compatibility](docs/COMPATIBILITY.md).

**The ledger is empty.**
A fresh install shows the history already on disk, so an empty ledger usually means
the disk fold is off or the logs are not where the plugin looks. Check both sides
from the CLI, which reads the same files the host does:

```bash
dsh-token-ledger rebuild --home ~/.dsh --write
dsh-token-ledger audit --home ~/.dsh
```

`backfillLogs: false` turns the disk fold off, and `backfill: false` turns off both
folds, leaving the ledger to start empty.

**The audit says "mismatch".**
It distinguishes a live session that has not been flushed yet from a real
disagreement, and only the second is a failure — see
[How the numbers are counted](docs/COUNTING.md).

**The cost shows a dash, or the page says "no prices yet".**
No price list is bundled — it would be wrong within weeks. Prices are fetched from
a source you choose, or typed by you on the rates page, and a host with no prices
yet says so instead of printing a confident `¥0.00`. Offline, the last fetched
result is still served from disk, with its age visible.

**`/tokens` is not registered.**
The command is registered through the host's own `commands` service, which this
plugin declares as an optional peer. A profile without that service has no slash
commands at all; the CLI is unaffected and still reads the ledger.

**The number does not match the provider's dashboard.**
The bill is an estimate computed from the tokens the session log recorded and the
published list price of the model the route named. It is not an invoice, and it
does not know about a provider's discounts, credits, plan quotas or failed and
retried requests.

**Starting over.**
Delete `<DSH_HOME>/token-ledger/` and restart; the next start folds the history on
disk again.

## Uninstall

```bash
dsh plugin --profile web remove @zhz8888/dsh-token-ledger
```

The ledger file is left alone on purpose — delete
`<DSH_HOME>/token-ledger/` yourself to reset the history.

## Documentation

The READMEs carry what you need to use the plugin. The rest lives in
[`docs/`](docs/README.md):

| Document | What it holds |
| --- | --- |
| [How the numbers are counted](docs/COUNTING.md) | The counting rules, forks versus resumes, and the audit. |
| [The settings page](docs/SETTINGS-PAGE.md) | The three views in full. |
| [Configuration](docs/CONFIGURATION.md) | Every key the plugin reads. |
| [Compatibility](docs/COMPATIBILITY.md) | Which DSH it needs, and what it touches. |
| [Development and releasing](docs/DEVELOPMENT.md) | Working on the plugin, and publishing it. |
| [Verification](docs/VERIFICATION.md) | What was actually checked, and what was not. |

Every document exists in both languages; the switcher is at the top of each one.
The Chinese index is in [README.zh.md](README.zh.md#文档).

## Contributing

Issues and pull requests are welcome.

```bash
git clone https://github.com/zhz8888/dsh-token-ledger
cd dsh-token-ledger
pnpm install
pnpm test          # 297 tests in 14 files
pnpm run verify    # packaging invariants
```

A change is ready when both gates pass and the diff carries nothing unrelated. Two
conventions this repository keeps: the README is part of the package's contract,
and a new claim goes into [`docs/VERIFICATION.md`](docs/VERIFICATION.md) with its
evidence or it does not go in. The rest —
[Development and releasing](docs/DEVELOPMENT.md).

## Security

This plugin reads the session logs, reads `settings.yaml` for the provider display
names a bill shows, and writes only inside `<DSH_HOME>/token-ledger/`. It reads no
credentials of any kind. The full list of what it touches is in
[Permissions](#permissions), item by item, so it can be checked against the source
rather than taken on trust.

**To report a vulnerability, please do not open a public issue.** Use GitHub's
private reporting on this repository's **Security** tab (*Report a vulnerability*),
which reaches the maintainer without disclosing anything; if that option is not
available to you, contact the maintainer directly at the address in
`package.json`.

## Support

- **Bugs and feature requests** — [GitHub issues](https://github.com/zhz8888/dsh-token-ledger/issues).
- **What changed in each version** — [CHANGELOG.md](CHANGELOG.md).
- **What was actually verified, and what was not** — [docs/VERIFICATION.md](docs/VERIFICATION.md).

An issue that carries the DSH version, the profile type, and the output of
`dsh-token-ledger audit` — it prints what it scanned — is usually one round trip
from a diagnosis.

## Acknowledgements

- The slot registry, the locale service and the settings shell this plugin binds to
  come from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
- The vendor marks are the official ones, taken from the vendors' own sites and from
  [Simple Icons](https://simpleicons.org), and they remain the trademarks of their
  respective owners.
- The price catalogue for the vendors that publish no machine-readable price comes
  from [models.dev](https://models.dev); the DeepSeek, Z.ai and Tencent prices are
  read from those vendors' own pricing pages.

## License

MIT — see [LICENSE](LICENSE).

The code is MIT licensed. The vendor marks bundled with the package (OpenAI,
Anthropic, Google, DeepSeek, Qwen, xAI, Z.ai, Kimi, MiniMax, Tencent, Xiaomi and
ByteDance) are the trademarks of their respective owners, used to identify whose
price a row shows; they are not covered by this license.
