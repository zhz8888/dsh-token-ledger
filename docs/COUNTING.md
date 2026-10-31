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
