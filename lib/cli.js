/**
 * `dsh-token-ledger` command line.
 *
 * The CLI is the audit half of the plugin. Because the ledger is a pure fold
 * over session logs, the CLI can recompute the exact same numbers from the raw
 * files on disk and diff them against whatever the running host persisted —
 * without starting DSH, and without trusting the ledger file.
 *
 * @module dsh-token-ledger/cli
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { UsageLedger } from './ledger.js'
import { findSessionLogs, foldSessionLogs } from './session-logs.js'
import { ledgerPaths, loadLedger, saveLedger, writeFileAtomic } from './store.js'

/**
 * Re-exported where it has always been reachable, `./cli`. The walk lives in
 * `session-logs.js` now, because the host half needs the same one.
 */
export { findSessionLogs }

const USAGE = `dsh-token-ledger — token accounting for DeepSeek Harness

Usage
  dsh-token-ledger [summary] [options]     print the stored ledger (default)
  dsh-token-ledger audit   [options]       recompute from raw logs and diff
  dsh-token-ledger rebuild [options]       recompute from raw logs
  dsh-token-ledger export  [options]       write CSV and JSON exports

Options
  --home <path>      DSH home to read (default: the DSH_HOME variable, else ~/.dsh)
  --ledger <path>    ledger file to read or write
  --out <path>       export destination directory
  --days <n>         days to show in the summary (default 7)
  --models <n>       models to show in the summary (default 5)
  --write            with rebuild: replace the stored ledger
  --json             machine-readable output
  --quiet            suppress the human summary, keep the exit code
  -h, --help         show this help
  -v, --version      show the version

Exit codes
  0  success, or the audit matched
  1  the audit found a difference
  2  bad usage or an unreadable input
`

/**
 * Read this package's version.
 *
 * @returns {string} the version, or `'unknown'`.
 */
function packageVersion() {
  try {
    const path = fileURLToPath(new URL('../package.json', import.meta.url))
    return JSON.parse(readFileSync(path, 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Parse `argv` into a command and options.
 *
 * An option that takes a path must not eat the next argument: `--home --quiet`
 * would otherwise resolve a home called `--quiet` (and write a ledger into it),
 * and a trailing `--home` would silently fall back to the default home. Both are
 * recorded in `missing`, which `run` reports as the usage error they are.
 *
 * @param {string[]} argv - arguments after the executable.
 * @returns {{ command: string, home?: string, ledger?: string, out?: string, days: number, models: number, write: boolean, json: boolean, quiet: boolean, help: boolean, version: boolean, unknown: string[], missing: string[] }} the parsed invocation.
 */
export function parseArgs(argv) {
  const options = {
    command: 'summary',
    days: 7,
    models: 5,
    write: false,
    json: false,
    quiet: false,
    help: false,
    version: false,
    unknown: [],
    /** Options given without a usable value; a usage error, never a silent default. */
    missing: [],
  }
  const commands = new Set(['summary', 'audit', 'rebuild', 'export', 'help'])
  let sawCommand = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = () => {
      index += 1
      return argv[index]
    }
    /** The value of an option that names a path, or a record that it had none. */
    const path = (option) => {
      index += 1
      const value = argv[index]
      if (value === undefined || value === '' || value.startsWith('-')) {
        // The next argument is not this option's value — it is the next option, or
        // nothing at all. Leave it for the loop to read.
        if (value !== undefined && value !== '' && value.startsWith('-')) index -= 1
        options.missing.push(option)
        return undefined
      }
      return value
    }
    /** The value of an inline `--option=value`; an empty one is the same usage error. */
    const inline = (option, value) => {
      if (value === '') {
        options.missing.push(option)
        return undefined
      }
      return value
    }
    switch (argument) {
      case '-h':
      case '--help':
        options.help = true
        break
      case '-v':
      case '--version':
        options.version = true
        break
      case '--write':
        options.write = true
        break
      case '--json':
        options.json = true
        break
      case '--quiet':
        options.quiet = true
        break
      case '--home':
        options.home = path('--home')
        break
      case '--ledger':
        options.ledger = path('--ledger')
        break
      case '--out':
        options.out = path('--out')
        break
      case '--days':
        options.days = Number.parseInt(next() ?? '', 10)
        break
      case '--models':
        options.models = Number.parseInt(next() ?? '', 10)
        break
      default: {
        if (argument.startsWith('--home=')) options.home = inline('--home', argument.slice(7))
        else if (argument.startsWith('--ledger=')) options.ledger = inline('--ledger', argument.slice(9))
        else if (argument.startsWith('--out=')) options.out = inline('--out', argument.slice(6))
        else if (!sawCommand && commands.has(argument)) {
          options.command = argument
          sawCommand = true
        } else options.unknown.push(argument)
      }
    }
  }
  if (options.command === 'help') options.help = true
  return options
}

/**
 * Rebuild a ledger by folding every raw session log on disk.
 *
 * The fold itself — the walk, the compact row decode, the fork boundary and the
 * `'log'` origin every cursor carries — lives in `session-logs.js`, because the
 * host half folds the same files at mount. This wrapper only adds what the
 * audit needs beyond the numbers: the newest event time per session, which is
 * how a stale ledger is told apart from one that is merely behind a session
 * still being written.
 *
 * @param {string} sessionsDir - the directory holding session logs.
 * @param {{ onWarning?: (message: string) => void }} [options] - diagnostics sink.
 * @returns {{ ledger: UsageLedger, scanned: number, skipped: number, forks: number, events: number, lastTimes: Map<string, number> }} the rebuild.
 */
export function rebuildFromLogs(sessionsDir, { onWarning = () => {} } = {}) {
  const ledger = new UsageLedger()
  const lastTimes = new Map()
  const tally = foldSessionLogs(ledger, sessionsDir, {
    onWarning,
    onSession: ({ sessionId, records }) => {
      for (const record of records) {
        if (typeof record?.time !== 'number' || !Number.isFinite(record.time)) continue
        const seen = lastTimes.get(sessionId)
        if (seen === undefined || record.time > seen) lastTimes.set(sessionId, record.time)
      }
    },
  })
  // Every log on disk has now been accounted for as of this moment. The host records
  // the same watermark after its own fold: it is what tells a later fold which files
  // have grown since, and what the audit uses to know how much of a log a ledger has
  // seen — without it a rebuilt ledger would claim nothing on disk was folded.
  ledger.markLogsFolded()
  return {
    ledger,
    scanned: tally.scanned,
    skipped: tally.skipped,
    forks: tally.forks,
    events: tally.events,
    lastTimes,
  }
}

/**
 * The counter fields a ledger aggregate carries, in the order a diff reports them.
 *
 * `totalTokens` is derived from the other four, so comparing only the total would
 * call a row equal when its buckets had been rearranged — and a cache-read token
 * counted as an uncached input token is a different bill at the same token count.
 */
const COUNTER_FIELDS = ['totalTokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']

/** The four buckets a usage row splits by side of the vendor's window. */
const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']

/** Largest difference first, which is the order a reader wants to see them in. */
const byDelta = (left, right) => Math.abs(right.delta) - Math.abs(left.delta)

/**
 * One aggregate's counters, with a missing record read as zeroes.
 *
 * @param {object|undefined} record - a ledger aggregate (`{ counters }`).
 * @returns {Record<string, number>} the five counter fields.
 */
function countersOf(record) {
  const counters = record?.counters ?? {}
  const out = {}
  for (const field of COUNTER_FIELDS) {
    out[field] = typeof counters[field] === 'number' && Number.isFinite(counters[field]) ? counters[field] : 0
  }
  return out
}

/**
 * The days, models or sessions two ledgers disagree on.
 *
 * A row is reported when any of its counters differs, not only its total, because a
 * rearrangement of the buckets changes what the row costs without changing its size.
 *
 * @param {Map<string, object>} left - the stored aggregates.
 * @param {Map<string, object>} right - the recomputed aggregates.
 * @returns {object[]} the differing rows, each carrying its total and any differing buckets.
 */
function aggregateRows(left, right) {
  const keys = new Set([...left.keys(), ...right.keys()])
  const out = []
  for (const key of keys) {
    const a = countersOf(left.get(key))
    const b = countersOf(right.get(key))
    const differing = COUNTER_FIELDS.filter((field) => a[field] !== b[field])
    if (differing.length === 0) continue
    const row = { key, stored: a.totalTokens, recomputed: b.totalTokens, delta: b.totalTokens - a.totalTokens }
    const buckets = differing.filter((field) => field !== 'totalTokens')
    if (buckets.length > 0) {
      row.buckets = Object.fromEntries(buckets.map((field) => [field, { stored: a[field], recomputed: b[field] }]))
    }
    out.push(row)
  }
  return out.sort(byDelta)
}

/**
 * The usage rows two ledgers disagree on, period by period.
 *
 * The bill multiplies each bucket of each side of the vendor's window by a price, so
 * these rows are where its money comes from. A diff that compared only the grand
 * total would pass a ledger whose peak tokens had been moved off-peak — the same
 * tokens, half the price — which is exactly the change worth catching.
 *
 * @param {Map<string, object>} left - the stored usage rows, keyed date/session/model.
 * @param {Map<string, object>} right - the recomputed ones.
 * @returns {object[]} the differing rows, largest first.
 */
function usageRows(left, right) {
  const keys = new Set([...left.keys(), ...right.keys()])
  const out = []
  for (const key of keys) {
    const a = left.get(key)
    const b = right.get(key)
    const fields = []
    for (const period of ['peak', 'offPeak']) {
      for (const bucket of USAGE_FIELDS) {
        const x = a?.[period]?.[bucket] ?? 0
        const y = b?.[period]?.[bucket] ?? 0
        if (x !== y) fields.push(`${period}.${bucket}`)
      }
    }
    if ((a?.calls ?? 0) !== (b?.calls ?? 0)) fields.push('calls')
    if (fields.length === 0) continue
    const tokensIn = (record) => {
      const side = (counters) =>
        typeof counters?.totalTokens === 'number'
          ? counters.totalTokens
          : USAGE_FIELDS.reduce((sum, bucket) => sum + (counters?.[bucket] ?? 0), 0)
      return side(record?.peak) + side(record?.offPeak)
    }
    const stored = tokensIn(a)
    const recomputed = tokensIn(b)
    out.push({
      key: `${a?.date ?? b?.date ?? ''} ${a?.sessionId ?? b?.sessionId ?? ''} ${a?.model ?? b?.model ?? ''}`,
      stored,
      recomputed,
      delta: recomputed - stored,
      fields,
    })
  }
  return out.sort(byDelta)
}

/**
 * Compare two ledgers, reporting where they disagree and why.
 *
 * A running host writes its ledger on a debounce, so a live session is
 * routinely a little ahead of the stored file. That is expected and must not
 * read as corruption, and which evidence settles it depends on how the session
 * was counted:
 *
 * - a session the live path owns is current as of `updatedAt`, so a newest event
 *   after it has simply kept running;
 * - a session the log fold owns is current only as far as that fold ran, so the
 *   evidence is `logsFoldedAt`: a log written after the fold has not been read yet,
 *   however recently the ledger itself was saved.
 *
 * A differing session whose newest event predates its own watermark is a real
 * disagreement between the file and the logs.
 *
 * @param {UsageLedger} stored - the ledger read from disk.
 * @param {UsageLedger} recomputed - the ledger folded from raw logs.
 * @param {{ updatedAt?: number, lastTimes?: Map<string, number>, logsFoldedAt?: number, origins?: Map<string, string>|Record<string, string> }} [context] - evidence for classification.
 * @returns {{ equal: boolean, matches: boolean, totals: object, days: object[], models: object[], sessions: object[], usage: object[], stale: object[], pending: object[] }} the diff.
 */
export function diffLedgers(stored, recomputed, { updatedAt = 0, lastTimes = new Map(), logsFoldedAt = 0, origins = new Map() } = {}) {
  const days = aggregateRows(stored.daily, recomputed.daily)
  const models = aggregateRows(stored.models, recomputed.models)
  const sessions = aggregateRows(stored.sessions, recomputed.sessions)
  const usage = usageRows(stored.usage instanceof Map ? stored.usage : new Map(), recomputed.usage instanceof Map ? recomputed.usage : new Map())

  const originOf = (key) => (typeof origins?.get === 'function' ? origins.get(key) : origins?.[key])
  const pending = []
  const stale = []
  for (const row of sessions) {
    const newest = lastTimes.get(row.key) ?? 0
    // A log-owned session is current only as far as the log fold ran: the host folds
    // the logs when it mounts, so what was written afterwards has not been read yet —
    // `updatedAt` moves on every save whether or not a log was read, and so cannot
    // tell "not folded yet" apart from "the file contradicts the logs".
    const watermark = originOf(row.key) === 'log' ? (logsFoldedAt > 0 ? logsFoldedAt : updatedAt) : updatedAt
    if (watermark > 0 && newest > watermark) pending.push(row)
    else stale.push(row)
  }

  const totalsOf = (ledger) => {
    const out = { calls: ledger?.calls ?? 0 }
    for (const field of COUNTER_FIELDS) {
      const value = ledger?.totals?.[field]
      out[field] = typeof value === 'number' && Number.isFinite(value) ? value : 0
    }
    return out
  }
  const storedTotals = totalsOf(stored)
  const recomputedTotals = totalsOf(recomputed)
  const totalsEqual = storedTotals.calls === recomputedTotals.calls && COUNTER_FIELDS.every((field) => storedTotals[field] === recomputedTotals[field])

  // Any disagreement anywhere: the grand totals (or their buckets), a per-session
  // figure, a day/model row contradicting the fold it should sum to, or a usage row
  // whose split by the vendor's window no longer matches.
  const differences = !totalsEqual || sessions.length > 0 || days.length > 0 || models.length > 0 || usage.length > 0
  // A difference is excused only when every differing session has kept running
  // since its watermark. With no such session, a difference in the day, model or
  // usage tables is an internal contradiction being caught, not live traffic.
  const explainedByLiveActivity = pending.length > 0 && stale.length === 0

  return {
    // Nothing differs anywhere.
    equal: !differences,
    // Nothing differs except activity that happened after the ledger was written —
    // or, for a session the log fold owns, after the logs were last folded.
    matches: !differences || explainedByLiveActivity,
    totals: {
      stored: storedTotals,
      recomputed: recomputedTotals,
      deltaTokens: recomputedTotals.totalTokens - storedTotals.totalTokens,
      deltaCalls: recomputedTotals.calls - storedTotals.calls,
    },
    days,
    models,
    sessions,
    usage,
    stale,
    pending,
  }
}

/**
 * Run the CLI.
 *
 * @param {string[]} argv - arguments after the executable.
 * @param {{ stdout?: (text: string) => void, stderr?: (text: string) => void, env?: NodeJS.ProcessEnv }} [io] - output sinks.
 * @returns {number} the process exit code.
 */
export function run(argv, io = {}) {
  const out = io.stdout ?? ((text) => process.stdout.write(`${text}\n`))
  const err = io.stderr ?? ((text) => process.stderr.write(`${text}\n`))
  const env = io.env ?? process.env
  const options = parseArgs(argv)

  if (options.help) {
    out(USAGE)
    return 0
  }
  if (options.version) {
    out(packageVersion())
    return 0
  }
  if (options.unknown.length > 0) {
    err(`unknown argument(s): ${options.unknown.join(' ')}\n`)
    err(USAGE)
    return 2
  }
  if (options.missing.length > 0) {
    err(`missing value for ${options.missing.join(', ')}\n`)
    err(USAGE)
    return 2
  }
  if (!Number.isFinite(options.days) || options.days <= 0 || !Number.isFinite(options.models) || options.models <= 0) {
    err('--days and --models must be positive integers\n')
    return 2
  }

  const paths = ledgerPaths(options.home, env)
  const ledgerPath = options.ledger ?? paths.ledger

  if (options.command === 'audit' || options.command === 'rebuild' || options.command === 'export') {
    const warnings = []
    const { ledger: recomputed, scanned, skipped, forks, events, lastTimes } = rebuildFromLogs(paths.sessionsDir, {
      onWarning: (message) => warnings.push(message),
    })
    // Emit diagnostics before any branch returns.
    for (const warning of warnings) err(`warning: ${warning}\n`)

    if (options.command === 'export') {
      const destination = options.out ?? paths.exportsDir
      const stamp = new Date().toISOString().slice(0, 10)
      let written
      try {
        written = [
          writeFileAtomic(join(destination, `daily-${stamp}.csv`), recomputed.toCsv('daily')),
          writeFileAtomic(join(destination, `sessions-${stamp}.csv`), recomputed.toCsv('sessions')),
          writeFileAtomic(join(destination, `models-${stamp}.csv`), recomputed.toCsv('models')),
          saveLedger(join(destination, `ledger-${stamp}.json`), recomputed.snapshot()),
        ]
      } catch (error) {
        err(`export failed: ${error instanceof Error ? error.message : String(error)}\n`)
        return 2
      }
      if (options.json) out(JSON.stringify({ scanned, events, forks, skipped, written }, null, 2))
      else {
        out(`scanned ${scanned} session log(s), ${events} events, ${forks} forked session(s), ${skipped} unreadable`)
        for (const path of written) out(`  ${path}`)
      }
      return 0
    }

    if (options.command === 'rebuild') {
      if (options.write) {
        try {
          saveLedger(ledgerPath, recomputed.snapshot())
        } catch (error) {
          err(`could not write ${ledgerPath}: ${error instanceof Error ? error.message : String(error)}\n`)
          return 2
        }
      }
      if (options.json) out(JSON.stringify({ scanned, events, forks, skipped, write: options.write, totals: recomputed.snapshot().totals }, null, 2))
      else {
        out(`scanned ${scanned} session log(s), ${events} events, ${forks} forked session(s), ${skipped} unreadable`)
        if (options.write) out(`wrote ${ledgerPath}`)
        if (!options.quiet) out(`\n${recomputed.format({ days: options.days, models: options.models })}`)
      }
      return 0
    }

    // audit
    const storedSnapshot = loadLedger(ledgerPath)
    if (storedSnapshot === undefined) {
      err(`no ledger at ${ledgerPath}; run "dsh-token-ledger rebuild --write" to create one\n`)
      return 2
    }
    const stored = new UsageLedger()
    if (!stored.restore(storedSnapshot)) {
      err(`ledger at ${ledgerPath} has an unsupported version; rerun with rebuild --write\n`)
      return 2
    }
    const diff = diffLedgers(stored, recomputed, {
      updatedAt: typeof storedSnapshot.updatedAt === 'number' ? storedSnapshot.updatedAt : 0,
      lastTimes,
      // How far the host's log fold had run when the ledger was written, and which
      // source owns each cursor: a log-owned session is only current as of the fold.
      logsFoldedAt: typeof stored.logsFoldedAt === 'number' ? stored.logsFoldedAt : 0,
      origins: stored.origins,
    })

    if (options.json) {
      out(JSON.stringify({ scanned, events, forks, skipped, warnings, ...diff }, null, 2))
    } else {
      out(`scanned ${scanned} session log(s), ${events} events, ${forks} forked session(s), ${skipped} unreadable`)
      out('')
      out(`  stored      ${stored.calls} calls  ${stored.totals.totalTokens} tokens`)
      out(`  recomputed  ${recomputed.calls} calls  ${recomputed.totals.totalTokens} tokens`)
      out('')
      if (diff.equal) {
        out('  audit: match — the stored ledger equals a fresh fold of the raw logs')
      } else if (diff.matches) {
        out(
          `  audit: match — ${diff.pending.length} session(s) advanced after the ledger was written`,
        )
        out(`         (${diff.totals.deltaCalls} calls, ${diff.totals.deltaTokens} tokens not yet flushed)`)
      } else {
        out(`  audit: MISMATCH — ${diff.totals.deltaCalls} calls, ${diff.totals.deltaTokens} tokens`)
        if (diff.pending.length > 0) {
          out(`         ${diff.pending.length} differing session(s) merely ran after the ledger was written`)
        }
        const section = (label, rows) => {
          if (rows.length === 0) return
          out('')
          out(`  ${label}`)
          for (const row of rows.slice(0, 10)) {
            // A row whose buckets were rearranged keeps its total, so name the column
            // that moved: otherwise the line reads "delta=0" beside a real difference.
            const moved = row.buckets === undefined ? '' : `  (${Object.keys(row.buckets).join(' ')})`
            out(`    ${row.key}  stored=${row.stored}  recomputed=${row.recomputed}  delta=${row.delta}${moved}`)
          }
          if (rows.length > 10) out(`    … and ${rows.length - 10} more`)
        }
        section('days', diff.days)
        section('models', diff.models)
        section('sessions (stale)', diff.stale)
        if (diff.usage.length > 0) {
          out('')
          out('  usage rows (peak/offPeak split)')
          for (const row of diff.usage.slice(0, 10)) {
            out(`    ${row.key}  stored=${row.stored}  recomputed=${row.recomputed}  delta=${row.delta}  [${row.fields.join(' ')}]`)
          }
          if (diff.usage.length > 10) out(`    … and ${diff.usage.length - 10} more`)
        }
      }
    }
    return diff.matches ? 0 : 1
  }

  // summary
  const snapshot = loadLedger(ledgerPath)
  if (snapshot === undefined) {
    err(`no ledger at ${ledgerPath}\n`)
    err('the plugin writes one while DSH runs; "dsh-token-ledger rebuild --write" can build it from raw logs\n')
    return 2
  }
  const ledger = new UsageLedger()
  if (!ledger.restore(snapshot)) {
    err(`ledger at ${ledgerPath} has an unsupported version\n`)
    return 2
  }
  if (options.json) out(JSON.stringify(ledger.snapshot(), null, 2))
  else if (!options.quiet) out(ledger.format({ days: options.days, models: options.models }))
  return 0
}
