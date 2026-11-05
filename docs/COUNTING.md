# How the numbers are counted

English | [中文](COUNTING.zh.md)

[← Back to the README](../README.md)

## Counting rules

The numbers are only useful if you know exactly what they count.

| Rule | Behaviour |
| --- | --- |
| **Successful anchors only** | Usage is taken from `assistant/message` (a completed step) and `compaction/summary` (one compaction call). A failed or cancelled attempt never appends either, so it is never counted. |
| **Streaming samples are replaced, not added** | When a step emits a `usage` chunk and then its final message, the final value replaces the earlier sample — one call either way. |
| **`totalTokens` is derived** | It is the sum of the four buckets, never the provider's own total field. Across 15,778 real usage reports the two agreed every single time, and deriving it keeps the buckets and the total consistent by construction. |
| **Reasoning tokens are a subset** | Reported separately, never added into the total, because they are already inside `outputTokens`. |
| **Local calendar days** | Days are your days, not UTC days. |
| **Forks are cut, delegated subagents and resumes are not** | See below. |
| **A call is billed to the model that served it** | The route is read from the session's own header, even when that header sits in the prefix the fold skips. |
| **A session is folded by one source, and that source is followed** | The log fold and the live fold never advance the same session. Whichever took it keeps reading it. |

### Forks versus delegated subagents versus resumes

A stored log can begin with a prefix of history that was already recorded.
Three different situations produce one, and getting them confused is the most
common way a usage plugin silently gets the wrong answer:

- **Fork** (`parentSession` set, `isSeeded` true): the prefix is the *parent's*
  history, counted in the parent's own log. Counting it again here would double
  count. It is cut.
- **Delegated subagent** (`parentSession` set, `isSeeded` false): the log is the
  subagent's own, from its first event — the parent is provenance, not history.
  Cutting it would throw away the subagent's own calls. Nothing is cut.
- **Resume** (no parent): the prefix is *this session's own* earlier history,
  stored once. Cutting it would lose tokens. Nothing is cut.

`isSeeded` is the harness's own answer to "does this session contain a
fork-inherited prefix", so it is what decides the cut. Reading the cut off
`parentSession` alone conflated forks with delegation: on one real home all 93
delegated sessions carried a parent, and cutting them removed **892 calls worth
119,393,450 tokens** from the recomputed ledger — calls that were all made
*after* the subagent was created, so no other session accounted for them.

### A call is billed to the model that served it

The provider and model of a call come from the session's `request/header`. A
live session's first header sits in the prefix the live fold skips — the seed
the session was created with — so reading the route only from the events that
follow left the earliest calls billed to `unknown/unknown` even though the
model was known: 72 calls worth 10,059,207 tokens on the same real home. The
route is now read out of the skipped prefix, the way the disk fold reads it, so
a call is billed to the model that answered it.

The route is also read out of the events a *continued* fold has already passed.
A cursor survives a restart and the routes that go with it do not, so the first
call folded in a new process would otherwise be billed to `unknown/unknown` while
the events behind the cursor name the model.

### A running session is folded from its log, and the log is followed

Which source folds a session is decided once, and the choice is what keeps the
count exact: a session folded from the log on disk holds a cursor in the log's
*compact row* space, and the live event list numbers the same session in another
space, so the live fold refuses to advance it. That leaves the log as the only
thing that can — and for a session resumed after the mount, the log is exactly
what grows.

The log is therefore followed while the host runs: re-read once per activity
window for a session the host is running, once a minute for every log the ledger
owns, and once on the way out. A re-read continues from the cursor, so it counts
only the rows added since the last one, and it decodes only the bytes appended
since the last one — a 2.3 MB log measured at 130 ms to decode whole against about
a millisecond for its tail, so following a session costs the host nothing worth
noticing. Without that, a resumed session's calls were counted at the next start
and not before — **557 calls worth 213,106,082 tokens** on one real home, with two
of the models those calls used missing from the model table until then.

### A call billed to no model is re-derived, not kept

`unknown/unknown` is a real row: the tokens exist, and a bill has to mention them.
But a row of that key means the fold never learned the route, and a route the
events do name is worth reading again. A stored ledger's cursor says the session
is fully consumed, so the row would otherwise be permanent — a corrected fold
never looks behind a cursor.

On load, every live-folded session owning such a row is handed back to the fold: its
rows are subtracted from every aggregate (they are exact sums of the usage cross
table, so nothing is approximated), its cursor is dropped, and the fold re-reads it
from its log — or from session storage when the log is gone. The calls then name the
model that served them. Where no record survives, the tokens leave the ledger with
the row: a row billed to no model cannot be priced, and keeping it keeps the question
"which model was this?" unanswerable forever.

A row the **log fold itself** produced is left alone. Re-reading that log derives the
same key — the log names no route anywhere — so repairing it would decode the file
whole on every start and never converge; the row is the truth about that log, not a
stale attribution to undo.


## The audit distinguishes two kinds of difference

A running host writes its ledger on a debounce, so a live session is routinely a
little ahead of the stored file. Reporting that as corruption would make the
audit useless. The ledger's own `updatedAt` settles it:

- a differing session whose newest event is **newer than the ledger** has simply
  kept running → *match*, with the unflushed amount reported;
- a differing session whose newest event **predates the ledger**, or a day/model
  row that contradicts the fold it should sum to → *mismatch*, exit 1.

```
  audit: match — 1 session(s) advanced after the ledger was written
         (1 calls, 5100 tokens not yet flushed)
```


---

## More documents

- [How the numbers are counted](COUNTING.md) — the counting rules, forks versus resumes, and the audit
- [The settings page](SETTINGS-PAGE.md) — the four views in full
- [Configuration](CONFIGURATION.md) — every key the plugin reads
- [Compatibility](COMPATIBILITY.md) — which DSH it needs, and what it touches
- [Development and releasing](DEVELOPMENT.md) — working on the plugin, and publishing it
- [Verification](VERIFICATION.md) — what was actually checked, and what was not
- [All documents](README.md) — the index
