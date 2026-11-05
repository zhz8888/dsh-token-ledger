/**
 * Finding and folding the session logs on disk.
 *
 * A DSH session is durably recorded at
 * `<sessionsDir>/<project>/<session id>/session.jsonl.zstd`: independent
 * Zstandard frames carrying newline-delimited JSON in the harness's *compact
 * row* form. A session that has outlived a storage format keeps its predecessors
 * beside that file as immutable generation names (`session.v4.jsonl.zstd`), and
 * only the newest one is its record. Both halves of this plugin need that
 * record, and neither may own the reader:
 *
 * - the host half folds it at mount, so a fresh install shows the user's history
 *   without asking `sessionPersistence` for anything;
 * - the CLI folds it for `rebuild`, `audit` and `export`, where no host is
 *   running at all.
 *
 * ## Why every fold here declares an origin
 *
 * A log's rows are **not** the logical event list a live `Session` or
 * `sessionPersistence` hands back: several logical events share one row, so an
 * index into one list means something else in the other. `adoptHistory` keeps a
 * per-session cursor in whichever list first folded it, so every fold in this
 * module passes `origin: 'log'`. A session folded from disk is then never
 * advanced by the other source, and vice versa — see `LEDGER_VERSION`.
 *
 * @module dsh-token-ledger/session-logs
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { inheritedCut, hasInheritedPrefix, isForkSession } from './ledger.js'
import { readSessionLogState, readSessionLogTail } from './session-log.js'

/**
 * The format generation one log file name stands for.
 *
 * The harness writes each session as immutable generation files: the first
 * format is `session.jsonl.zstd` (generation 0) and every later one carries its
 * number, `session.v4.jsonl.zstd`. A session directory keeps its predecessors
 * when a newer generation is published and the harness itself selects the
 * numerically highest name as the canonical record.
 *
 * @param {string} name - a file name from a session directory.
 * @returns {number|undefined} the generation, or `undefined` when the name is not a canonical generation.
 */
export function logGenerationOf(name) {
  const match = /^session(?:\.v([1-9][0-9]*))?\.jsonl\.zstd$/.exec(String(name))
  if (match === null) return undefined
  return match[1] === undefined ? 0 : Number(match[1])
}

/**
 * Find every session log under a directory, one per session.
 *
 * The walk is recursive because a session lives in its own directory under a
 * directory named for its working directory, and the layout is the harness's,
 * not this plugin's. Missing or unreadable directories are treated as empty: a
 * host with no sessions stored yet is normal, not an error.
 *
 * **One entry per session directory.** A session that outlived a storage format
 * keeps its predecessors, so a directory can hold `session.jsonl.zstd` beside
 * `session.v4.jsonl.zstd`; only the highest generation is the durable record, and
 * folding both would advance one cursor through two different arrays. A file that
 * is not a canonical generation name is only used when its directory has no
 * canonical one, so a hand-stored log still reaches the fold.
 *
 * @param {string} directory - the DSH `sessions` directory.
 * @returns {string[]} absolute paths to the newest log of each session, in walk order.
 */
export function findSessionLogs(directory) {
  const found = []
  const visit = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    const generations = []
    const others = []
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl.zstd')) continue
      const generation = logGenerationOf(entry.name)
      if (generation === undefined) others.push(path)
      else generations.push({ path, generation })
    }
    if (generations.length === 0) {
      found.push(...others)
      return
    }
    generations.sort((left, right) => right.generation - left.generation)
    found.push(generations[0].path)
  }
  visit(directory)
  return found
}

/**
 * The log a session directory's newest generation is.
 *
 * A running harness can publish a newer generation of a session's log while this
 * plugin is watching it, and the older file is left in place: a path that still
 * exists is not necessarily the record. Reading one directory is what tells the
 * two apart, and it is cheap enough to do before every re-read of a log this
 * ledger is following.
 *
 * The rule is `findSessionLogs`' rule applied to one directory: the highest
 * canonical generation wins, and a file named outside the generation scheme is
 * used only when the directory has no canonical one.
 *
 * @param {string} directory - one session's directory.
 * @returns {string|undefined} the path, or `undefined` when the directory is unreadable or holds no log.
 */
export function newestLogIn(directory) {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return undefined
  }
  let newest
  let fallback
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl.zstd')) continue
    const path = join(directory, entry.name)
    const generation = logGenerationOf(entry.name)
    if (generation === undefined) {
      fallback ??= path
      continue
    }
    if (newest === undefined || generation > newest.generation) newest = { path, generation }
  }
  return newest?.path ?? fallback
}

/**
 * The session id a log path implies.
 *
 * A log is `<sessionsDir>/<project>/<session id>/session.jsonl.zstd` (or a
 * newer generation file beside it), so the id is the directory above the file.
 * Reading it off the path costs nothing, which is what lets the host skip a
 * session it has already folded without opening the file.
 *
 * @param {string} path - a session log path.
 * @returns {string} the implied session id, or `''` when the path is too short.
 */
export function sessionIdOfLogPath(path) {
  return String(path).replace(/\\/g, '/').split('/').slice(-2)[0] ?? ''
}

/**
 * Every session log on disk, with what a `stat` says about it.
 *
 * The modification time is what the host compares against a session's last
 * folded activity to decide whether a log it already owns has grown, so that
 * keeping up with history costs one `stat` per session rather than one read.
 *
 * @param {string} directory - the DSH `sessions` directory.
 * @returns {{ path: string, sessionId: string, mtimeMs: number, size: number }[]} the logs. A
 *   file whose `stat` fails is still listed, with zeroes, so that a caller's
 *   count of what it scanned does not silently drop it.
 */
export function listLogSessions(directory) {
  return findSessionLogs(directory).map((path) => {
    let mtimeMs = 0
    let size = 0
    try {
      const stat = statSync(path)
      mtimeMs = stat.mtimeMs
      size = stat.size
    } catch {
      // Reported as zeroes: the fold will fail on the read and be counted there.
    }
    return { path, sessionId: sessionIdOfLogPath(path), mtimeMs, size }
  })
}

/**
 * Decode one log into the events a fold needs, with its boundary decided.
 *
 * The boundary is located structurally by `inheritedCut` rather than by the
 * header's declared seed length, because the log is the compact row form where
 * that count indexes a different array. See `inheritedCut`.
 *
 * @param {string} path - a `session.jsonl.zstd` path.
 * @returns {{ records: object[], header: object|undefined, sessionId: string, isFork: boolean, cut: number, size: number }} the log's content, and how many bytes the read covered.
 * @throws {Error} when the file cannot be read or decoded.
 */
export function readLogSession(path) {
  const { records, size } = readSessionLogState(path)
  const header = records[0]?.type === 'session' ? records[0] : undefined
  const sessionId = String(header?.id ?? sessionIdOfLogPath(path))
  const isFork = isForkSession(header)
  const cut = inheritedCut({ header, events: records, inheritedEventCount: header?.seedLength })
  return { records, header, sessionId, isFork, cut, size }
}

/**
 * Fold one session log into a ledger.
 *
 * @param {import('./ledger.js').UsageLedger} ledger - the ledger to fold into.
 * @param {{ path: string, sessionId: string }} entry - a `listLogSessions` entry.
 * @param {{ onWarning?: (message: string) => void }} [options] - diagnostics sink.
 * @returns {{ sessionId: string, records: object[], isFork: boolean, folded: boolean, size: number }} what
 *   happened, and how many bytes were read — the boundary a later tail read continues from.
 *   `folded: false` means an empty log, an unreadable one, or a session the other
 *   source owns — never a partial fold.
 */
export function foldLogEntry(ledger, entry, { onWarning = () => {} } = {}) {
  let decoded
  try {
    decoded = readLogSession(entry.path)
  } catch (error) {
    onWarning(`could not decode ${entry.path}: ${error instanceof Error ? error.message : String(error)}`)
    return { sessionId: entry.sessionId, records: [], isFork: false, folded: false, size: 0 }
  }
  const { records, header, sessionId, isFork, cut, size } = decoded
  if (records.length === 0) return { sessionId, records, isFork, folded: false, size }
  if (hasInheritedPrefix(header) && cut === 0) {
    onWarning(
      `forked session ${sessionId} has no usable inheritance boundary; folding it whole, so its totals may include the parent prefix`,
    )
  }
  const folded = ledger.adoptHistory({
    sessionId,
    events: records,
    inheritedEventCount: cut,
    // The compact row form is a different coordinate space from a live
    // Session's event list, and the cursor has to say so.
    origin: 'log',
    // The header line carries the working directory; a log whose header lacks it
    // still gets one from its own events, which `adoptHistory` falls back to.
    cwd: typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : null,
  })
  return { sessionId, records, isFork, folded, size }
}

/**
 * Fold the rows a log has gained since a previous read.
 *
 * The cheap half of {@link foldLogEntry}: same session, same cursor space, but
 * only the bytes after the last boundary are decoded. The route is not recovered
 * here — that needs the rows behind the cursor — so a caller whose process has not
 * yet seen a route for the session folds the whole log first.
 *
 * @param {import('./ledger.js').UsageLedger} ledger - the ledger to fold into.
 * @param {{ path: string, sessionId: string }} entry - the log to continue reading.
 * @param {{ offset?: number, tail?: string }} [from] - where the previous read stopped.
 * @param {{ onWarning?: (message: string) => void }} [options] - diagnostics sink.
 * @returns {{ sessionId: string, records: object[], folded: boolean, offset: number, tail: string, size: number }|undefined}
 *   what was folded and where the next read starts, or `undefined` when the bytes
 *   at `offset` are not a frame boundary — the caller then folds the file whole.
 */
export function foldLogTail(ledger, entry, from, { onWarning = () => {} } = {}) {
  let read
  try {
    read = readSessionLogTail(entry.path, from)
  } catch (error) {
    onWarning(`could not decode ${entry.path}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  if (read === undefined) return undefined
  const folded = ledger.adoptLogTail(entry.sessionId, read.records)
  return { sessionId: entry.sessionId, records: read.records, folded, offset: read.offset, tail: read.tail, size: read.size }
}

/**
 * Fold every session log under a directory into a ledger.
 *
 * @param {import('./ledger.js').UsageLedger} ledger - the ledger to fold into.
 * @param {string} directory - the DSH `sessions` directory.
 * @param {{ onWarning?: (message: string) => void, onSession?: (result: object) => void }} [options] - diagnostics sink and per-log hook.
 * @returns {{ scanned: number, folded: number, skipped: number, forks: number, events: number }} the tally.
 */
export function foldSessionLogs(ledger, directory, { onWarning = () => {}, onSession = () => {} } = {}) {
  const entries = listLogSessions(directory)
  let folded = 0
  let skipped = 0
  let forks = 0
  let events = 0
  for (const entry of entries) {
    const result = foldLogEntry(ledger, entry, { onWarning })
    if (!result.folded) {
      skipped += 1
      continue
    }
    folded += 1
    if (result.isFork) forks += 1
    events += result.records.length
    onSession(result)
  }
  return { scanned: entries.length, folded, skipped, forks, events }
}
