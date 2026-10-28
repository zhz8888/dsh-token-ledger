# Compatibility

English | [中文](COMPATIBILITY.zh.md)

[← Back to the README](../README.md)

## What DSH it needs

**DSH `^0.2.0-rc.1`** — 0.2.1-rc.3 is the version this is currently verified against, and
the floor is written as `0.2.0-rc.1` because that is how this ecosystem spells a
prerelease range. The `^` puts the ceiling at `0.3.0`.

This range is load-bearing rather than decorative: DSH compares it against the running
harness at startup and **skips a plugin whose range excludes it**. `^0.1.2-rc.1` — the
range 1.0.0 shipped with — does not accept `0.2.0-rc.2`, so 1.0.0 was silently skipped
by every 0.2 harness and 1.0.1 exists to fix exactly that. A `0.1.x` harness is now
outside the declared range.

The same range is also declared as `engines.dsh`, which is the field a plugin market's
compatibility preflight reads and displays — `dshmarket` derives its verdict from that field
together with the host peers, and shows the conjunction of everything declared. Both carry
the identical string, so the market shows one requirement rather than a conjunction of two
spellings of it, and the two cannot drift apart without someone editing both.

The requirement is declared the way the ecosystem actually reads it — as
`peerDependencies` on the five host packages the two halves bind to:

| Peer | Why this plugin names it |
| --- | --- |
| `@deepseek-ai/dsh-session-persistence` | It provides `sessionPersistence`, which is where the ledger's usage comes from. |
| `@deepseek-ai/dsh-commands` | It provides `commands`, which registers `/tokens`. |
| `@deepseek-ai/dsh-host-webserver` | It provides `webServer`, which serves the three settings routes. |
| `@deepseek-ai/dsh-client-locale` | The browser half injects it for the translated labels. |
| `@deepseek-ai/dsh-client-ui-settings-general` | The browser half injects it to add its section to the settings sidebar. |

Every one is **optional**, and that is deliberate rather than a hedge. DSH does not
hoist host packages into a profile's `node_modules`, so a required peer would report
an unmet dependency on every install and mean nothing. Optional is also what keeps the
declaration honest about this plugin's own behaviour: a profile with no web server
skips the settings page and keeps `/tokens` and the CLI, and a headless or TUI profile
never has the client packages at all.

What makes the declaration useful is that DSH resolves it against the install that is
actually running. Its profile checker reads a peer from the plugin's own `node_modules`
first, then the profile tree, then **the DSH installation itself**
(`node_modules/dshmarket/lib/check.js`), and compares the result to the range above —
so an unsupported harness is reported instead of silently mounting. Earlier versions of
this package declared `dsh.compatibility.dsh` instead, which nothing in DSH reads; 1.0
removed it rather than leave a field that looks like a promise and is not one. The
`dsh.compatibility.dshReleases` map that replaced it is a declaration for a store to
read — it names the releases this has actually been checked against — and it is not
what DSH evaluates at mount. The gate is the peer range above.

The declarations cost a consumer nothing: optional peers are not installed, and the
package still ships with no runtime dependencies and no install scripts.


## Compatibility

- **Node:** ≥ 22.15.0 (the CLI decodes Zstandard frames). The host half itself
  needs nothing version-specific.
- **DSH:** `^0.2.0-rc.1`, declared as optional peers on the five host packages it
  binds to — see [What DSH it needs](#what-dsh-it-needs). Held against `0.2.1-rc.3`:
  DSH's own compatibility evaluator accepts this manifest, and every interface the two
  halves use — `ctx.on`, `ctx.inject`, `ctx.get`, `ctx.effect`, `commands.register`,
  `sessionPersistence.list()/inspect()`, and the `settings.section` slot with
  `ctx.slots.inject`/`ctx.slots.register` — is unchanged in the `0.2` line.
  [`docs/VERIFICATION.md`](VERIFICATION.md) records the last full in-app run, which
  was on `0.1.2-rc.1`, and separately the `0.2.1-rc.3` mount this is held against.
- **Profiles:** any. There is no profile-specific code.
- **Network:** the rates tab fetches prices and the USD rate over HTTPS. This is
  entirely optional: with no route to the internet the last fetched result is
  still served from disk, hand-entered values still work, and `rates: false`
  removes the requests altogether.


---

## More documents

- [How the numbers are counted](COUNTING.md) — the counting rules, forks versus resumes, and the audit
- [The settings page](SETTINGS-PAGE.md) — the three views in full
- [Configuration](CONFIGURATION.md) — every key the plugin reads
- [Compatibility](COMPATIBILITY.md) — which DSH it needs, and what it touches
- [Development and releasing](DEVELOPMENT.md) — working on the plugin, and publishing it
- [Verification](VERIFICATION.md) — what was actually checked, and what was not
- [All documents](README.md) — the index
