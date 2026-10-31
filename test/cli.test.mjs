/**
 * CLI end-to-end tests over a synthetic DSH home.
 *
 * These cover the trust story of the package: a ledger built from raw logs must
 * audit clean, activity after the ledger was written must not read as
 * corruption, and a tampered ledger must be caught.
 *
 * @module dsh-token-ledger/test/cli.test
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ledgerPaths, loadLedger } from '../lib/store.js'
import { rebuildFromLogs, run } from '../lib/cli.js'
import {
  ALPHA_EVENTS,
  BETA_EVENTS,
  BETA_INHERITED,
  DAY1,
  assistantMessage,
  encodeSessionLog,
  headerEvent,
  stepEnd,
  usageChunk,
  userMessage,
  withSeq,
} from './fixtures.mjs'

/**
 * Create a throwaway DSH home containing the given session logs.
 *
 * @param {Record<string, object[]>} sessions - map of session id to events.
 * @returns {{ home: string, cleanup: () => void }} the home and its disposer.
 */
function makeHome(sessions) {
  const home = mkdtempSync(join(tmpdir(), 'token-ledger-test-'))
  for (const [sessionId, events] of Object.entries(sessions)) {
    const directory = join(home, 'sessions', '--workspace--', sessionId)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'session.jsonl.zstd'), encodeSessionLog(withSeq(events), { eventsPerFrame: 3 }))
  }
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

/**
 * Build a session log wrapper whose first record is a `session` header.
 *
 * @param {object} header - header fields beyond `type`.
 * @param {object[]} events - the body events.
 * @returns {object[]} header followed by body.
 */
function withHeader(header, events) {
  return [{ type: 'session', version: 0, createdAt: DAY1, cwd: 'C:\\workspace', ...header }, ...events]
}

/**
 * Run the CLI capturing its output.
 *
 * @param {string[]} argv - CLI arguments.
 * @returns {{ code: number, stdout: string, stderr: string }} the result.
 */
function invoke(argv) {
  let stdout = ''
  let stderr = ''
  const code = run(argv, {
    stdout: (text) => {
      stdout += `${text}\n`
    },
    stderr: (text) => {
      stderr += `${text}\n`
    },
    // An empty env keeps the tests independent of the developer's real DSH_HOME.
    env: {},
  })
  return { code, stdout, stderr }
}

/** A fork: the prefix before `session/end-seed` belongs to the parent. */
const FORK_EVENTS = withHeader({ id: 'sess-fork', parentSession: 'sess-parent', isSeeded: true, seedLength: 4 }, [
  userMessage('parent work', DAY1),
  headerEvent({ time: DAY1 }),
  // Inherited usage: must NOT be counted.
  assistantMessage({ turn: 1, step: 1, usage: { inputTokens: 999999, outputTokens: 1, totalTokens: 1000000 }, time: DAY1 }),
  { type: 'session/end-seed', seq: 3, time: DAY1, data: {} },
  // The fork's own work: counted.
  assistantMessage({ turn: 1, step: 1, usage: { inputTokens: 40, outputTokens: 2 }, time: DAY1 }),
  stepEnd(1, 1, DAY1),
])

/** A resume: `session/end-seed` with no parent means the prefix is its own history. */
const RESUME_EVENTS = withHeader({ id: 'sess-resume' }, [
  headerEvent({ time: DAY1 }),
  assistantMessage({ turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10 }, time: DAY1 }),
  { type: 'session/end-seed', seq: 2, time: DAY1, data: {} },
  assistantMessage({ turn: 1, step: 2, usage: { inputTokens: 20, outputTokens: 5 }, time: DAY1 }),
])

test('rebuild folds forks at their seed marker and resumes in full', () => {
  const { home, cleanup } = makeHome({ 'sess-fork': FORK_EVENTS, 'sess-resume': RESUME_EVENTS })
  try {
    const { ledger, forks, scanned } = rebuildFromLogs(join(home, 'sessions'))
    assert.equal(scanned, 2)
    assert.equal(forks, 1)
    // fork: 42 own tokens; resume: 110 + 25.
    assert.equal(ledger.totals.totalTokens, 42 + 110 + 25)
    assert.equal(ledger.sessions.get('sess-fork').counters.totalTokens, 42)
    assert.equal(ledger.sessions.get('sess-resume').counters.totalTokens, 135)
  } finally {
    cleanup()
  }
})

test('a ledger built from logs audits clean', () => {
  const { home, cleanup } = makeHome({ 'sess-alpha': ALPHA_EVENTS, 'sess-fork': FORK_EVENTS })
  try {
    const written = invoke(['rebuild', '--home', home, '--write', '--quiet'])
    assert.equal(written.code, 0, written.stderr)

    const audited = invoke(['audit', '--home', home])
    assert.equal(audited.code, 0, audited.stdout + audited.stderr)
    assert.match(audited.stdout, /audit: match/)
  } finally {
    cleanup()
  }
})

test('activity after the ledger was written is reported, not treated as corruption', () => {
  const { home, cleanup } = makeHome({ 'sess-alpha': ALPHA_EVENTS })
  try {
    assert.equal(invoke(['rebuild', '--home', home, '--write', '--quiet']).code, 0)

    // Append a call whose timestamp is newer than the ledger we just wrote.
    const live = [
      ...ALPHA_EVENTS,
      assistantMessage({
        turn: 3,
        step: 1,
        usage: { inputTokens: 5000, outputTokens: 100 },
        time: Date.now() + 5000,
      }),
    ]
    const directory = join(home, 'sessions', '--workspace--', 'sess-alpha')
    writeFileSync(join(directory, 'session.jsonl.zstd'), encodeSessionLog(withSeq(live), { eventsPerFrame: 3 }))

    const audited = invoke(['audit', '--home', home])
    assert.equal(audited.code, 0, audited.stdout + audited.stderr)
    assert.match(audited.stdout, /advanced after the ledger was written/)
    assert.match(audited.stdout, /5100 tokens not yet flushed/)
  } finally {
    cleanup()
  }
})

test('a tampered ledger is caught', () => {
  const { home, cleanup } = makeHome({ 'sess-alpha': ALPHA_EVENTS })
  try {
    assert.equal(invoke(['rebuild', '--home', home, '--write', '--quiet']).code, 0)

    const path = ledgerPaths(home, {}).ledger
    const snapshot = loadLedger(path)
    // Inflate a past day and push the ledger's timestamp past the fixture times,
    // so the difference cannot be excused as unflushed live activity.
    snapshot.updatedAt = Date.now() + 60000
    snapshot.totals.inputTokens += 12345
    snapshot.daily[0].inputTokens += 12345
    writeFileSync(path, JSON.stringify(snapshot))

    const audited = invoke(['audit', '--home', home, '--json'])
    assert.equal(audited.code, 1, audited.stdout + audited.stderr)
    const parsed = JSON.parse(audited.stdout)
    assert.equal(parsed.matches, false)
    assert.equal(parsed.pending.length, 0)
    assert.equal(parsed.totals.deltaTokens, -12345)
    // The day table contradicts the fold, so the audit must flag it even though
    // no per-session row differs.
    assert.ok(parsed.days.length >= 1, JSON.stringify(parsed.days))

    const human = invoke(['audit', '--home', home])
    assert.match(human.stdout, /MISMATCH/)
    assert.match(human.stdout, /12345/)
  } finally {
    cleanup()
  }
})

test('a difference the totals hide is caught bucket by bucket', () => {
  const { home, cleanup } = makeHome({ 'sess-alpha': ALPHA_EVENTS })
  try {
    assert.equal(invoke(['rebuild', '--home', home, '--write', '--quiet']).code, 0)
    const path = ledgerPaths(home, {}).ledger
    const snapshot = loadLedger(path)
    snapshot.updatedAt = Date.now() + 60000
    // Move the input tokens of one usage row into the cache-read bucket, adjusting
    // only the derived total of that period so every total in the file stays equal.
    // Cache reads are the cheap bucket, so the row now costs a fraction of what it did
    // with exactly the same number of tokens.
    const row = snapshot.usage.find((entry) => entry.peak.inputTokens > 0 || entry.offPeak.inputTokens > 0)
    const period = row.peak.inputTokens > 0 ? 'peak' : 'offPeak'
    const moved = row[period].inputTokens
    const move = (counters) => {
      counters.inputTokens -= moved
      counters.cacheReadTokens += moved
    }
    move(row[period])
    row[period].totalTokens = row[period].inputTokens + row[period].outputTokens + row[period].cacheReadTokens + row[period].cacheWriteTokens
    // The same swap in the day and model tables, whose totals are derived from these
    // buckets: their totals stay equal, so only a bucket comparison can see it.
    move(snapshot.daily.find((entry) => entry.date === row.date))
    move(snapshot.models.find((entry) => entry.model === row.model))
    writeFileSync(path, JSON.stringify(snapshot))

    const audited = invoke(['audit', '--home', home, '--json'])
    const parsed = JSON.parse(audited.stdout)
    assert.equal(audited.code, 1, audited.stdout + audited.stderr)
    assert.equal(parsed.matches, false)
    assert.equal(parsed.totals.deltaTokens, 0, 'the swap changes no total at all')
    // The day and model rows keep their totals and name the buckets that moved instead.
    for (const table of [parsed.days, parsed.models]) {
      assert.equal(table.length, 1)
      assert.equal(table[0].delta, 0)
      assert.deepEqual(Object.keys(table[0].buckets).sort(), ['cacheReadTokens', 'inputTokens'])
    }
    // The usage table says which side of the vendor's window moved, which is what the
    // bill multiplies by a price.
    assert.equal(parsed.usage.length, 1)
    assert.deepEqual(parsed.usage[0].fields.sort(), [`${period}.cacheReadTokens`, `${period}.inputTokens`])

    const human = invoke(['audit', '--home', home])
    assert.match(human.stdout, /usage rows \(peak\/offPeak split\)/)
  } finally {
    cleanup()
  }
})

test('a session whose log grew after the fold is behind, not corrupt', () => {
  const { home, cleanup } = makeHome({ 'sess-alpha': ALPHA_EVENTS })
  try {
    assert.equal(invoke(['rebuild', '--home', home, '--write', '--quiet']).code, 0)
    const path = ledgerPaths(home, {}).ledger
    const snapshot = loadLedger(path)
    // A ledger built from the logs says so: the watermark is what the audit uses to
    // know how much of each log the file has seen.
    assert.equal(typeof snapshot.logsFoldedAt, 'number', 'a rebuild records that every log was folded')
    // The host folded the logs at mount and has not folded again since. Its ledger
    // file, saved on every live change, is newer than the session's last event; the
    // fold's watermark is older. Only the watermark can tell "not read yet" from "the
    // file contradicts the logs", so the audit must use it for a log-owned session.
    const newest = Math.max(...ALPHA_EVENTS.filter((event) => typeof event.time === 'number').map((event) => event.time))
    snapshot.logsFoldedAt = newest - 1000
    snapshot.updatedAt = Date.now() + 60000
    // Drop the tokens of the alpha fixture's last call, the way a fold that stopped
    // before it would have.
    const session = snapshot.sessions.find((row) => row.sessionId === 'sess-alpha')
    session.inputTokens -= 100
    session.outputTokens -= 30
    session.totalTokens -= 130
    writeFileSync(path, JSON.stringify(snapshot))

    const audited = invoke(['audit', '--home', home, '--json'])
    const parsed = JSON.parse(audited.stdout)
    assert.equal(audited.code, 0, audited.stdout + audited.stderr)
    assert.equal(parsed.equal, false, 'the file really is behind')
    assert.equal(parsed.matches, true, 'behind the fold is not corruption')
    assert.ok(parsed.pending.some((row) => row.key === 'sess-alpha'))
    assert.equal(parsed.stale.length, 0)

    // The same difference for a session the live path owns is a real one: that source
    // is current as of when the ledger was written, and the ledger is newer.
    snapshot.origins['sess-alpha'] = 'session'
    writeFileSync(path, JSON.stringify(snapshot))
    const live = invoke(['audit', '--home', home, '--json'])
    assert.equal(live.code, 1, live.stdout + live.stderr)
    assert.equal(JSON.parse(live.stdout).matches, false)
  } finally {
    cleanup()
  }
})

test('a path option with no value is a usage error, not a silent default', () => {
  const { home, cleanup } = makeHome({})
  try {
    for (const argv of [['summary', '--home'], ['rebuild', '--write', '--home'], ['audit', '--ledger'], ['export', '--out'], ['summary', '--home=']]) {
      const result = invoke(argv)
      assert.equal(result.code, 2, argv.join(' '))
      assert.match(result.stderr, /missing value for --(home|ledger|out)/, argv.join(' '))
    }
    // The next option must not be eaten as a value: `--home --quiet` is how a ledger
    // used to land in a directory called `--quiet`, with `--quiet` itself lost.
    const swallowed = invoke(['rebuild', '--write', '--home', '--quiet'])
    assert.equal(swallowed.code, 2)
    assert.match(swallowed.stderr, /missing value for --home/)
    // A real value still parses, in both spellings.
    assert.match(invoke(['summary', '--home', home]).stderr, /no ledger at/)
    assert.match(invoke(['summary', `--home=${home}`]).stderr, /no ledger at/)
  } finally {
    cleanup()
  }
})

test('JSON output is machine readable', () => {
  const { home, cleanup } = makeHome({ 'sess-alpha': ALPHA_EVENTS })
  try {
    assert.equal(invoke(['rebuild', '--home', home, '--write', '--quiet']).code, 0)
    const audited = invoke(['audit', '--home', home, '--json'])
    assert.equal(audited.code, 0)
    const parsed = JSON.parse(audited.stdout)
    assert.equal(parsed.matches, true)
    assert.equal(parsed.totals.stored.totalTokens, 6220)
    assert.equal(parsed.scanned, 1)

    const summary = invoke(['summary', '--home', home, '--json'])
    assert.equal(JSON.parse(summary.stdout).totals.totalTokens, 6220)
  } finally {
    cleanup()
  }
})

test('summary prints the stored ledger without touching the logs', () => {
  const { home, cleanup } = makeHome({ 'sess-alpha': ALPHA_EVENTS })
  try {
    assert.equal(invoke(['rebuild', '--home', home, '--write', '--quiet']).code, 0)
    // Remove the logs entirely: a summary must still work from the ledger.
    rmSync(join(home, 'sessions'), { recursive: true, force: true })
    const summary = invoke(['summary', '--home', home, '--days', '2', '--models', '1'])
    assert.equal(summary.code, 0, summary.stderr)
    assert.match(summary.stdout, /6,220/)
    assert.match(summary.stdout, /deepseek-official\/deepseek-v4-flash/)
  } finally {
    cleanup()
  }
})

test('export writes three CSV tables and a JSON ledger', () => {
  const { home, cleanup } = makeHome({ 'sess-alpha': ALPHA_EVENTS, 'sess-fork': FORK_EVENTS })
  try {
    const destination = join(home, 'out')
    const exported = invoke(['export', '--home', home, '--out', destination])
    assert.equal(exported.code, 0, exported.stderr)

    const daily = readFileSync(join(destination, `daily-${new Date().toISOString().slice(0, 10)}.csv`), 'utf8')
    const rows = daily.trim().split('\r\n')
    assert.equal(rows[0].split(',').length, 8)
    assert.equal(rows.length, 4) // header + 3 fixture days
    // 2026-01-15 holds alpha's three calls plus the fork's single call:
    // input 1800 + 40, output 110 + 2, cache read 2600, total 4552.
    assert.ok(
      rows.includes('2026-01-15,4,1840,112,2600,0,4552,0'),
      `unexpected daily rows:\n${rows.join('\n')}`,
    )

    const sessions = readFileSync(join(destination, `sessions-${new Date().toISOString().slice(0, 10)}.csv`), 'utf8')
    assert.match(sessions, /sess-alpha/)
    assert.match(sessions, /sess-fork/)
  } finally {
    cleanup()
  }
})

test('usage errors exit 2 and explain themselves', () => {
  const { home, cleanup } = makeHome({})
  try {
    assert.equal(invoke(['--help']).code, 0)
    assert.match(invoke(['--help']).stdout, /dsh-token-ledger — token accounting/)
    assert.equal(invoke(['--version']).code, 0)
    assert.equal(invoke(['nonsense', '--home', home]).code, 2)
    assert.match(invoke(['nonsense']).stderr, /unknown argument/)
    assert.equal(invoke(['--days', '0', '--home', home]).code, 2)
    // No ledger and nothing to audit from.
    assert.equal(invoke(['summary', '--home', home]).code, 2)
    assert.equal(invoke(['audit', '--home', home]).code, 2)
  } finally {
    cleanup()
  }
})

test('a corrupt ledger is treated as an error, not silently as zero', () => {
  const { home, cleanup } = makeHome({ 'sess-alpha': ALPHA_EVENTS })
  try {
    const path = ledgerPaths(home, {}).ledger
    mkdirSync(join(home, 'token-ledger'), { recursive: true })
    writeFileSync(path, '{ this is not json')
    const summary = invoke(['summary', '--home', home])
    assert.equal(summary.code, 2)
    assert.match(summary.stderr, /no ledger at/)

    writeFileSync(path, JSON.stringify({ version: 999, totals: {} }))
    const versioned = invoke(['summary', '--home', home])
    assert.equal(versioned.code, 2)
    assert.match(versioned.stderr, /unsupported version/)
  } finally {
    cleanup()
  }
})

test('a torn final frame is read up to the frames before it, and an unreadable log warns', () => {
  // The session-log reader keeps the frames a killed writer finished: those events
  // are the session's durable record, and dropping the whole session over a torn
  // tail would lose usage that was really recorded. A file that is not a log at all
  // is still skipped with a warning rather than folded as if it were empty.
  const { home, cleanup } = makeHome({ 'sess-alpha': ALPHA_EVENTS })
  try {
    const torn = join(home, 'sessions', '--workspace--', 'sess-torn')
    mkdirSync(torn, { recursive: true })
    const encoded = encodeSessionLog(withSeq(ALPHA_EVENTS), { eventsPerFrame: 2 })
    writeFileSync(join(torn, 'session.jsonl.zstd'), encoded.subarray(0, encoded.length - 7))
    const broken = join(home, 'sessions', '--workspace--', 'sess-broken')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, 'session.jsonl.zstd'), 'not a zstd log')

    const rebuilt = invoke(['rebuild', '--home', home])
    assert.equal(rebuilt.code, 0, rebuilt.stderr)
    // Three logs walked, one of them unreadable; the torn log still contributes the
    // events its completed frames hold.
    assert.match(rebuilt.stdout, /3 session log\(s\)/)
    assert.match(rebuilt.stdout, /34 events/)
    assert.match(rebuilt.stdout, /1 unreadable/)
    assert.match(rebuilt.stderr, /warning: could not decode/)
    // The healthy session is counted in full (6,220) and the torn log contributes the
    // events its completed frames hold (6,090) — the two calls in its lost frame are
    // the only thing missing.
    assert.match(rebuilt.stdout, /12,310/)
  } finally {
    cleanup()
  }
})

test('forked logs without a marker are folded whole and warned about', () => {
  const { home, cleanup } = makeHome({
    'sess-nomarker': withHeader({ id: 'sess-nomarker', parentSession: 'gone', isSeeded: true }, [
      headerEvent({ time: DAY1 }),
      assistantMessage({ turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1 }, time: DAY1 }),
    ]),
  })
  try {
    const rebuilt = invoke(['rebuild', '--home', home])
    assert.equal(rebuilt.code, 0)
    assert.match(rebuilt.stderr, /has no usable inheritance boundary/)
    assert.match(rebuilt.stdout, /11/)
  } finally {
    cleanup()
  }
})

test('a streaming sample replaced by its message stays one call in the CLI fold', () => {
  const { home, cleanup } = makeHome({
    'sess-replace': withHeader({ id: 'sess-replace' }, [
      headerEvent({ time: DAY1 }),
      usageChunk({ turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1 }, time: DAY1 }),
      assistantMessage({ turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1 }, time: DAY1 }),
    ]),
  })
  try {
    const { ledger } = rebuildFromLogs(join(home, 'sessions'))
    assert.equal(ledger.calls, 1)
    assert.equal(ledger.totals.totalTokens, 11)
  } finally {
    cleanup()
  }
})

test('BETA fixture semantics hold through the CLI path too', () => {
  const { home, cleanup } = makeHome({
    'sess-beta': withHeader({ id: 'sess-beta', parentSession: 'sess-parent', isSeeded: true, seedLength: BETA_INHERITED }, [
      ...BETA_EVENTS.slice(0, BETA_INHERITED),
      { type: 'session/end-seed', seq: BETA_INHERITED - 1, time: DAY1, data: {} },
      ...BETA_EVENTS.slice(BETA_INHERITED),
    ]),
  })
  try {
    const { ledger } = rebuildFromLogs(join(home, 'sessions'))
    assert.equal(ledger.totals.totalTokens, 15)
  } finally {
    cleanup()
  }
})
