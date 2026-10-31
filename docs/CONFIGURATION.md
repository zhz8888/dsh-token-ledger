# Configuration

English | [中文](CONFIGURATION.zh.md)

[← Back to the README](../README.md)

## Configuration

Override the composition entry by its `id`:

```yaml
- id: token-ledger
  config:
    ledgerPath: 'D:/dsh/ledger.json'   # default: <DSH_HOME>/token-ledger/ledger.json
    backfill: false                     # default: true — fold stored history on startup
    backfillLogs: false                 # default: true — read the session logs on disk too
    rates: false                        # default: true — false makes no network request at all
    # rates also takes an object:
    # rates:
    #   source: modelsdev                # default: the per-vendor dataset; 'openrouter' for gateway quotes
    #   refreshIntervalMs: 1800000       # default: 30 minutes
    #   perVendor: 3                     # default: 3 newest models per vendor
    #   vendors: 15                      # default: cap on how many vendors to publish; 0 for all
    #   modelsUrl: 'https://…'           # default: per source — https://models.dev/api.json
    #   fxUrl: 'https://…/latest/USD'    # default: open.er-api.com
    # Monthly plans, for the bill's plan grouping. Each is amortized over the days
    # a bill covers, so a partial month is billed partially.
    subscriptions:
      - vendor: deepseek                 # which vendor's usage this plan covers
        plan: 'DeepSeek 包月'            # the name shown on the bill
        amount: 199                      # the fee per month
        currency: CNY                    # the currency the fee is quoted in
        startedAt: '2026-09-01'          # optional: not billed before this day
        endedAt: null                    # optional: not billed after this day
        note: null                       # optional: free text, shown with the plan
    # How the page shortens the session list. The export is never shortened, so these
    # only change what is on screen.
    # bill:
    #   foldSmallSessions: true          # default: true — false lists every session on the page too
    #   smallSessionCost: 1              # default: 1, in the bill's currency
    #   smallSessionCalls: 10            # default: 10
```

`rates: false` disables the pricing feature's networking entirely and leaves
hand-entered values as the only source. That is the setting a strictly offline host
wants; the rates page still works.

### The database connections

The database backups are **not** a configuration key. A connection carries a
password, and a setting is persisted, rewritten on every debounce and readable
in `settings.yaml` — a password belongs in none of those. So the connections
live in their own file, beside the ledger:

```
<DSH_HOME>/token-ledger/databases.json
```

It is written with owner-only permissions (`0600`) and its directory with
`0700`. The page manages it, so a password is never typed into a JSON file by
hand and never ends up in a shell history. The shape is one entry per
connection:

```json
{
  "connections": [
    {
      "id": "gitea",
      "name": "Gitea",
      "type": "mariadb",
      "host": "127.0.0.1",
      "port": 3306,
      "database": "gitea",
      "user": "gitea",
      "password": "…",
      "dumpPath": ""
    }
  ]
}
```

`type` is `mysql`, `mariadb` or `postgres`; `port` defaults to the one the engine
listens on; `dumpPath` is where that engine's dump tool is, and an empty one
means the tool on the `PATH`. The file is read by the host only — the browser
half never sees a password, and a connection is redacted on the way out.

### Where the history comes from

A fresh install shows the ledger you already have rather than one that starts today. Two
sources are folded at startup, and each session is owned — permanently — by whichever of
them folded it first.

- **The session logs on disk**,
  `<DSH_HOME>/sessions/<project>/<session>/session.jsonl.zstd`. This is the durable record,
  it is complete, and it needs nothing from the host: they are the same files `rebuild` and
  `audit` read. Every session nobody has folded yet comes from here, which is what makes a
  first install show its history instead of an empty page.
- **`sessionPersistence`**, the host service. It covers what a log cannot — a session whose
  file has not been written yet — and it is the incremental path for the sessions the live
  event stream folded.

They hand over different arrays: a log is the harness's compact row form, whose indices mean
something else than the logical event list's. A cursor is therefore only ever advanced by the
source that set it, and the other one refuses rather than re-counting a session. `backfillLogs:
false` keeps the startup fold off the disk; `backfill: false` turns both off and starts empty.

The disk fold reads one session per turn of the event loop, so a first run cannot stall the
host, and it skips every log that has not been written since the previous pass from a single
`stat`. A host that has run before pays nothing for history it already folded — only the first
run, or the one after a session was resumed outside this host, opens a file.


---

## More documents

- [How the numbers are counted](COUNTING.md) — the counting rules, forks versus resumes, and the audit
- [The settings page](SETTINGS-PAGE.md) — the four views in full
- [Configuration](CONFIGURATION.md) — every key the plugin reads
- [Compatibility](COMPATIBILITY.md) — which DSH it needs, and what it touches
- [Development and releasing](DEVELOPMENT.md) — working on the plugin, and publishing it
- [Verification](VERIFICATION.md) — what was actually checked, and what was not
- [All documents](README.md) — the index
