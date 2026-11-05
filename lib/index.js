/**
 * `dsh-token-ledger` host half.
 *
 * A transparent, restart-safe token ledger for DeepSeek Harness. It folds the
 * durable session event stream into per-session, per-day and per-model token
 * totals, keeps the result in `<DSH_HOME>/token-ledger/ledger.json`, and
 * answers `/tokens` in the conversation input.
 *
 * Design constraints, in order of importance:
 *
 * 1. **Installable anywhere.** The module imports nothing but Node builtins and
 *    its own files, so it cannot fail on a missing or drifting peer dependency.
 *    It also declares no install scripts, so `dsh plugin add` from a git URL
 *    works without pre-authorizing a pnpm build.
 * 2. **Never in the model's way.** It registers no prompt section, no message
 *    and no model-facing tool, so it cannot change a request prefix and cannot
 *    affect KV-cache reuse. The ledger is read by a command and by the CLI.
 * 3. **Never the reason a session fails.** Every hook is wrapped so a ledger
 *    fault degrades to a warning; folding is pure and cannot mutate session
 *    state.
 *
 * @module dsh-token-ledger
 */

import { UsageLedger, cwdFrom, hasInheritedPrefix, inheritedCut } from './ledger.js'
import { BILL_PATH, DATABASES_PATH, I18N_PATH, RATES_PATH, createBillRoute, createDatabasesRoute, createI18nRoute, createOverviewRoute, createRatesRoute, OVERVIEW_PATH } from './route.js'
import { SMALL_SESSION } from './bill.js'
import { createRatesService } from './rates-service.js'
import { createProviderNames } from './providers.js'
import { createDatabaseStore, databasePaths } from './databases.js'
import { listBackups, runDump, runTest } from './dbdump.js'
import { foldLogEntry, foldLogTail, listLogSessions, newestLogIn } from './session-logs.js'
import { ledgerPaths, loadLedger, saveLedger, writeFileAtomic } from './store.js'
import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Plugin name, as it appears in the Cordis tree. */
export const name = 'token-ledger'

/** Milliseconds to coalesce ledger writes after activity. */
const PERSIST_DEBOUNCE_MS = 2000

/**
 * Milliseconds to coalesce re-reads of a running session's log.
 *
 * A session the log fold owns is advanced by its log, and the harness writes that
 * log as each event commits. Re-reading it at most once per window is what turns
 * that into "the page shows the call a moment after it lands" without reading a
 * multi-megabyte file once per streamed token.
 */
const LOG_REFRESH_MS = 2000

/**
 * Milliseconds between stats of every log this ledger is following.
 *
 * The debounced re-read above only covers a session this process is being told
 * about. A session can also be advanced by another process on the same home, and
 * a log that goes quiet between two of its own writes is never marked dirty
 * again — one stat per log per minute is what closes both gaps.
 */
const LOG_SWEEP_MS = 60_000

/**
 * Mount the ledger.
 *
 * @param {object} ctx - the Cordis context for this plugin's fiber.
 * @param {{ ledgerPath?: string, backfill?: boolean, backfillLogs?: boolean, rates?: boolean|object }} [config] - composition config. `rates: false` disables the pricing feature's networking entirely, leaving hand-entered values as the only source, which is the setting a strictly offline host wants. `rates.source` picks the price source (`modelsdev`, the default, for each vendor's own list price; or `openrouter` for a gateway's quotes and the widest model coverage). `rates.vendors` caps how many vendors are published (`0` for all of them).
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const paths = ledgerPaths()
  const ledgerPath = typeof config.ledgerPath === 'string' && config.ledgerPath !== '' ? config.ledgerPath : paths.ledger
  const shouldBackfill = config.backfill !== false
  // Reading the session logs on disk is what a fresh install shows its history
  // from, and the only history source that asks the host for nothing. It is
  // switchable on its own because it is the one that touches the disk.
  const shouldBackfillLogs = shouldBackfill && config.backfillLogs !== false
  const ratesConfig = typeof config.rates === 'object' && config.rates !== null ? config.rates : {}
  const ratesEnabled = config.rates !== false
  // Monthly plans, for the bill's subscription view. A plan is a fixed fee for a
  // period rather than a price per token, so it is declared here and amortized over
  // the days a bill covers.
  const subscriptionsConfig = Array.isArray(config.subscriptions) ? config.subscriptions : []
  // How the session list is shortened on the page — and only on the page: an export is
  // read for its detail, so it always carries every session. `smallSessionCost` is in
  // the bill's own currency, and `bill.foldSmallSessions: false` turns it off entirely.
  const billConfig = typeof config.bill === 'object' && config.bill !== null ? config.bill : {}
  const smallSession = {
    cost: typeof billConfig.smallSessionCost === 'number' && Number.isFinite(billConfig.smallSessionCost) ? billConfig.smallSessionCost : SMALL_SESSION.cost,
    calls: typeof billConfig.smallSessionCalls === 'number' && Number.isFinite(billConfig.smallSessionCalls) ? billConfig.smallSessionCalls : SMALL_SESSION.calls,
  }
  const foldSmallSessions = billConfig.foldSmallSessions !== false

  const ledger = new UsageLedger()
  const restored = ledger.restore(loadLedger(ledgerPath))

  const log = {
    /** @param {string} message @param {...unknown} rest */
    info: (message, ...rest) => ctx.logger?.info?.(message, ...rest),
    warn: (message, ...rest) => ctx.logger?.warn?.(message, ...rest),
  }

  // A stored ledger can carry calls billed to no model at all. `unknown/unknown`
  // is what a fold writes when it never learned the route, and a bug that has
  // since been fixed wrote some; a cursor cannot repair its own past, so those
  // sessions are handed back to the fold. The log pass below re-reads them and
  // attributes the calls to the model that actually served them, which is also
  // what removes the row from the model table.
  try {
    const repaired = ledger.repairUnattributedSessions()
    if (repaired.length > 0) {
      log.info(
        '[token-ledger] re-deriving %d session(s) billed to an unknown route (%d calls, %d tokens)',
        repaired.length,
        repaired.reduce((sum, session) => sum + session.calls, 0),
        repaired.reduce((sum, session) => sum + session.totalTokens, 0),
      )
    }
  } catch (error) {
    log.warn('[token-ledger] could not repair sessions with no model: %o', error)
  }

  // The name the model settings page shows a provider under, so the bill can say
  // `BOS-API` where the request route says `bos`. Read from the harness settings —
  // never written — and empty when that file is absent or shaped differently.
  const providerNames = createProviderNames({ home: paths.home, options: { log } })

  // Prices and the USD rate live beside the ledger, so the two travel together
  // and one backup covers both.
  const rates = createRatesService({
    path: paths.rates,
    options: {
      source: ratesConfig.source,
      modelsUrl: ratesConfig.modelsUrl,
      fxUrl: ratesConfig.fxUrl,
      perVendor: ratesConfig.perVendor,
      vendorLimit: ratesConfig.vendors,
      intervalMs: ratesConfig.refreshIntervalMs,
      log,
    },
  })

  let timer
  let writing = Promise.resolve()
  /** Set once dispose has begun: no new fold, timer or write is accepted. */
  let disposed = false
  /** Boot work still in flight: the log fold, the backfill and the first price refresh. */
  const pendingWork = new Set()

  /**
   * Track a fire-and-forget promise so dispose can wait for it.
   *
   * @param {Promise<unknown>} work - the work to wait for.
   * @returns {Promise<unknown>} the same promise, for chaining.
   */
  const track = (work) => {
    pendingWork.add(work)
    work.then(
      () => pendingWork.delete(work),
      () => pendingWork.delete(work),
    )
    return work
  }

  /**
   * Write the ledger, serializing writes so two flushes cannot interleave.
   *
   * @returns {Promise<void>} settles when the file is on disk.
   */
  const persist = () => {
    writing = writing
      .then(() => {
        saveLedger(ledgerPath, ledger.snapshot())
      })
      .catch((error) => {
        log.warn('[token-ledger] could not write %s: %o', ledgerPath, error)
      })
    return writing
  }

  /**
   * Persist now, unless dispose has already begun and taken over the last write.
   *
   * @returns {Promise<void>} settles when the file is on disk.
   */
  const flush = () => (disposed ? Promise.resolve() : persist())

  /** @param {number} [delay] - coalescing delay in milliseconds. */
  const schedule = (delay = PERSIST_DEBOUNCE_MS) => {
    if (disposed) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, delay)
    // Do not hold the host process open just to write a ledger.
    timer.unref?.()
  }

  /**
   * The log path and the stat each session's log was last read at.
   *
   * A session the log fold took is advanced only by its own log. Keeping the file
   * and the stat that was current when it was read is what lets a running host
   * ask "has this log grown?" for one `stat` instead of one directory walk, and it
   * is what the sweep below iterates over.
   *
   * @type {Map<string, { path: string, sessionId: string, mtimeMs: number, size: number }>}
   */
  const logFiles = new Map()
  /** @type {Map<string, { mtimeMs: number, size: number }>} */
  const logWatermarks = new Map()
  /**
   * Where each session's log has been decoded up to: the first byte not yet read,
   * and the line that read left unfinished.
   *
   * A running session appends rows as they commit, and re-decoding the whole file
   * every window is time the host does not get back — 2.3 MB measured at 130 ms,
   * which is a stall the model loop feels. The boundary is a frame offset the
   * reader reported rather than a guess, so the read is proportional to what was
   * appended.
   *
   * @type {Map<string, { offset: number, tail: string }>}
   */
  const logReads = new Map()
  /** Sessions the host is running whose events live in a log this fold owns. @type {Set<string>} */
  const dirtyLogs = new Set()
  let refreshTimer
  let sweepTimer
  /** Set while a sweep is walking, so a second one cannot start on top of it. */
  let sweeping = false

  /**
   * Fold one session's log again, if it has grown since it was last read.
   *
   * The cursor is what keeps this from double counting: the fold continues from
   * the row it stopped at, so a re-read counts only the rows added since. A log
   * that has not changed is left alone by its size and modification time, which is
   * why the sweep can afford to ask about every session once a minute.
   *
   * The first read of a log in this process is the whole file, because it is also
   * what recovers the route from the events behind the cursor; after that only the
   * appended bytes are decoded. A log the harness rolled to a newer generation is
   * read whole, because the older file stays on disk and a boundary in one file
   * says nothing about the other.
   *
   * @param {string} sessionId - the session to catch up.
   * @returns {boolean} whether new rows were folded.
   */
  const refreshLog = (sessionId) => {
    if (ledger.ownerOf(sessionId) !== 'log') return false
    const known = logFiles.get(sessionId)
    if (known === undefined) return false
    const path = newestLogIn(dirname(known.path)) ?? known.path
    let stat
    try {
      stat = statSync(path)
    } catch {
      return false
    }
    const seen = logWatermarks.get(sessionId)
    if (seen !== undefined && stat.size === seen.size && stat.mtimeMs <= seen.mtimeMs) return false
    const entry = { path, sessionId, mtimeMs: stat.mtimeMs, size: stat.size }
    const warning = (message) => log.warn('[token-ledger] %s', message)
    const from = logReads.get(sessionId)
    let folded = false
    try {
      if (from === undefined || path !== known.path) {
        const result = foldLogEntry(ledger, entry, { onWarning: warning })
        folded = result.folded
        logReads.set(sessionId, { offset: result.size, tail: '' })
      } else {
        const result = foldLogTail(ledger, entry, from, { onWarning: warning })
        if (result === undefined) {
          // The bytes at the boundary are not a frame boundary after all: the log
          // was rewritten, or a frame that was still being written when its bytes
          // were taken for whole has been completed. Start the file over.
          const whole = foldLogEntry(ledger, entry, { onWarning: warning })
          folded = whole.folded
          logReads.set(sessionId, { offset: whole.size, tail: '' })
        } else {
          folded = result.folded
          logReads.set(sessionId, { offset: result.offset, tail: result.tail })
        }
      }
    } catch (error) {
      log.warn('[token-ledger] could not re-read the log of %s: %o', sessionId, error)
      return false
    }
    // Recorded from the stat taken before the read: if the writer appended again
    // while the file was being decoded, the next refresh asks once more, and the
    // byte boundary — not this stat — is what keeps that read from overlapping.
    logFiles.set(sessionId, entry)
    logWatermarks.set(sessionId, { mtimeMs: stat.mtimeMs, size: stat.size })
    return folded
  }

  /**
   * Fold every marked session's log that has grown.
   *
   * At most one whole-file decode per window, unless the caller says otherwise.
   * That is the expensive read — a host that resumes several sessions at once would
   * otherwise do all of their first reads in one turn of the event loop — and the
   * rest keep their mark and are taken by the next window, which is a couple of
   * seconds away. Shutdown is the exception: there is no next window, so it takes
   * them all.
   *
   * @param {{ wholeBudget?: number }} [options] - how many whole-file decodes to allow.
   * @returns {boolean} whether anything new was counted.
   */
  const refreshDirtyLogs = ({ wholeBudget = 1 } = {}) => {
    if (dirtyLogs.size === 0) return false
    const ids = [...dirtyLogs]
    dirtyLogs.clear()
    let changed = false
    let whole = 0
    for (const sessionId of ids) {
      if (!logReads.has(sessionId)) {
        if (whole >= wholeBudget) {
          dirtyLogs.add(sessionId)
          continue
        }
        whole += 1
      }
      try {
        if (refreshLog(sessionId)) changed = true
      } catch (error) {
        log.warn('[token-ledger] could not fold the log of %s: %o', sessionId, error)
      }
    }
    if (dirtyLogs.size > 0) scheduleRefresh()
    return changed
  }

  /**
   * Re-read the marked logs once per window, then write what was found.
   *
   * One timer, armed by the first activity and left alone by what follows it: the
   * write timer is a debounce and a session that emits an event per millisecond
   * would keep pushing it back, so a long turn would show nothing until it ended.
   */
  const scheduleRefresh = () => {
    if (disposed || refreshTimer !== undefined) return
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      let changed = false
      try {
        changed = refreshDirtyLogs()
      } catch (error) {
        log.warn('[token-ledger] could not fold the session logs: %o', error)
      }
      // The settings page reads the file, so a fold here has to be written rather
      // than waiting for the session to go quiet.
      if (changed) schedule(0)
    }, LOG_REFRESH_MS)
    refreshTimer.unref?.()
  }

  /**
   * Ask every log this ledger follows whether it grew, once a minute.
   *
   * The debounced refresh only sees a session the host tells this process about.
   * A session can also be advanced by another process on the same home, and a log
   * that goes quiet between two stores of itself is never marked dirty again —
   * neither produces an event here. One `stat` per log per minute is what closes
   * that gap, and it is the difference between a ledger that converges and one
   * that waits for the next start.
   *
   * The walk is one log per turn of the event loop, because the ones that grew are
   * read — and a sweep that found several logs to read must not do all of them in
   * one blocking pass. A sweep already in flight is not started again.
   *
   * @returns {boolean} whether a sweep is running.
   */
  const sweepLogs = () => {
    if (sweeping) return false
    sweeping = true
    const ids = [...logFiles.keys()]
    let index = 0
    let changed = false
    const step = () => {
      if (disposed) {
        sweeping = false
        return
      }
      while (index < ids.length) {
        const sessionId = ids[index]
        index += 1
        try {
          if (refreshLog(sessionId)) changed = true
        } catch (error) {
          log.warn('[token-ledger] could not fold the log of %s: %o', sessionId, error)
        }
        if (index < ids.length) {
          setImmediate(step)
          return
        }
      }
      sweeping = false
      if (changed) schedule(0)
    }
    step()
    return true
  }

  /** Arm the sweep, and re-arm it after each pass. */
  const startSweep = () => {
    if (disposed) return
    sweepTimer = setTimeout(() => {
      sweepTimer = undefined
      sweepLogs()
      startSweep()
    }, LOG_SWEEP_MS)
    sweepTimer.unref?.()
  }

  /**
   * Fold a live session's unconsumed events.
   *
   * A session the log fold owns is not folded here. Its cursor indexes the log's
   * compact rows, and the live event list numbers the same session in another
   * coordinate space — advancing one with the other would count some events twice
   * and skip others. What the live path does own is the *knowledge that the
   * session is running*, and that is what marks the log for a re-read: without it
   * a session resumed in this host runs to the end of its log with every call it
   * makes missing from the ledger until the next start.
   *
   * @param {object} session - a live Session.
   * @returns {boolean} whether the session is advanced by its log instead.
   */
  const adopt = (session) => {
    try {
      const id = String(session?.id ?? session?.sessionId ?? '')
      if (id !== '' && ledger.ownerOf(id) === 'log') {
        dirtyLogs.add(id)
        return true
      }
      ledger.adoptSession(session)
    } catch (error) {
      log.warn('[token-ledger] could not fold session: %o', error)
    }
    return false
  }

  // Sessions already live when this plugin mounts (a profile reload, or a
  // ledger installed into a running host). One the restored ledger folded from
  // its log is caught up by a re-read, because a session resumed in this run is
  // exactly the case the log fold cannot advance on its own.
  try {
    const sessions = ctx.get?.('sessions')
    if (sessions !== undefined && typeof sessions.list === 'function') {
      for (const session of sessions.list()) {
        if (adopt(session)) scheduleRefresh()
      }
    }
  } catch (error) {
    log.warn('[token-ledger] could not enumerate live sessions: %o', error)
  }

  /**
   * Fold the session logs on disk: the durable record, and the only history
   * source that asks the host for nothing.
   *
   * A log holds the *compact row* form, whose indices mean something else than
   * the live event list's do, so `foldLogEntry` marks every session it folds as
   * `'log'`-owned and the live and persistence paths then leave those sessions
   * alone. A session already owned live is skipped from its path alone, so for a
   * host that has run before the cost is one `stat` per log, not one read.
   *
   * The work is spread one file per turn of the event loop: a first run has a
   * whole history to fold, and a host that stalls for it would be felt.
   *
   * @returns {Promise<void>} settles once the fold is done, or immediately when it is off.
   */
  const foldLogs = () => {
    if (!shouldBackfillLogs) return Promise.resolve()

    // The moment this pass began. Every stat below is taken after it, so a log
    // written later is newer than the watermark recorded here and is read by the
    // next pass — which is what keeps a restart to one `stat` per session instead
    // of one read, because there *is* always a next pass to raise it.
    const passAt = Date.now()
    let entries
    try {
      entries = listLogSessions(paths.sessionsDir)
    } catch (error) {
      log.warn('[token-ledger] could not list %s: %o', paths.sessionsDir, error)
      return Promise.resolve()
    }

    // What this pass has accounted for, per session: the file, and the stat it
    // was accounted at. The running host keeps both up to date, so a log that
    // grows between two passes is found by one `stat` rather than a directory walk.
    for (const entry of entries) {
      logFiles.set(entry.sessionId, entry)
      logWatermarks.set(entry.sessionId, { mtimeMs: entry.mtimeMs, size: entry.size })
    }

    const pending = entries.filter((entry) => {
      const owner = ledger.ownerOf(entry.sessionId)
      // Never folded by anything: either source may take it, and this one has
      // the file. This is the fresh-install case the fold exists for.
      if (owner === undefined) return true
      // Already folded from disk: fold it again only once the log has grown,
      // which its modification time answers without reading it — a log is
      // written after its newest event, so it is the moment the last pass began
      // that dates what that pass saw, and a file landing in that same millisecond
      // counts as grown. Reading one log again costs a moment; passing over one
      // costs its tokens.
      if (owner === 'log') return entry.mtimeMs >= (ledger.logsFoldedAt ?? 0)
      // Folded from the logical event list: not this source's to advance.
      return false
    })

    if (pending.length === 0) {
      // Nothing has grown, but every log on disk has still been accounted for as
      // of this moment — and saying so is the whole reason the next start costs
      // one `stat` per session. A pass that returned here without recording it
      // left the previous run's watermark in place, so every log written since
      // then was read again on the next start, which is the opposite of cheap.
      ledger.markLogsFolded(passAt)
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      let index = 0
      let folded = 0
      let skipped = 0
      const step = () => {
        while (index < pending.length) {
          const entry = pending[index]
          index += 1
          // Re-checked per file, because a session can be adopted live between
          // two turns of this loop.
          if (ledger.ownerOf(entry.sessionId) === 'session') {
            skipped += 1
            continue
          }
          const result = foldLogEntry(ledger, entry, {
            onWarning: (message) => log.warn('[token-ledger] %s', message),
          })
          if (result.folded) {
            folded += 1
            // Keyed by the id the fold used — the header's, when the log carries
            // one — because that is the id the host reports a live session under.
            // Following a log under the directory's name when the two disagree
            // would never match, and the session would silently never be followed.
            logFiles.set(result.sessionId, { ...entry, sessionId: result.sessionId })
            logWatermarks.set(result.sessionId, { mtimeMs: entry.mtimeMs, size: entry.size })
            // Where this read stopped, so the next one decodes only what is added.
            logReads.set(result.sessionId, { offset: result.size, tail: '' })
          } else skipped += 1
          if (index < pending.length) {
            // Yield between files: on a first run this is a whole history, and
            // the host has a UI to keep answering.
            setImmediate(step)
            return
          }
        }
        if (folded > 0) {
          log.info(
            '[token-ledger] folded %d session log(s) from disk, %d skipped; total %d tokens over %d calls',
            folded,
            skipped,
            ledger.totals.totalTokens,
            ledger.calls,
          )
          schedule(0)
        }
        // Every log on disk has now been accounted for as of the moment this pass
        // began, which is what lets the next start skip the unchanged ones on a
        // `stat`.
        ledger.markLogsFolded(passAt)
        resolve()
      }
      step()
    })
  }

  /**
   * Fold every session storage knows about, including ones from previous runs.
   *
   * This is what makes a fresh install immediately show real history instead of
   * starting from zero. It is safe to repeat: a session already consumed is
   * skipped by its cursor.
   *
   * @param {object} persistence - the `sessionPersistence` service.
   * @returns {Promise<{ sessions: number, errors: number }>} the backfill tally.
   */
  const backfill = async (persistence) => {
    let sessions = 0
    let errors = 0
    const headers = await persistence.list()
    for (const header of headers) {
      const id = String(header?.id ?? '')
      if (id === '') continue
      // A session folded from its log owns that cursor, and this pass numbers the
      // same session's events differently. Leave it to the log fold.
      if (ledger.ownerOf(id) === 'log') continue
      try {
        const read = typeof persistence.inspect === 'function' ? persistence.inspect : persistence.load
        const stored = await read.call(persistence, id)
        const events = stored?.events
        if (!Array.isArray(events)) continue
        const meta = stored?.meta ?? header
        // A fork's prefix belongs to its parent, which is counted separately.
        // The boundary is located by the `session/end-seed` marker rather than
        // by a raw count, because a count can be expressed in a different
        // coordinate space than the array we were handed. See inheritedCut.
        const inheritedEventCount = inheritedCut({
          header: meta,
          events,
          inheritedEventCount: stored?.inheritedEventCount ?? meta?.seedLength,
        })
        if (hasInheritedPrefix(meta) && inheritedEventCount === 0) {
          log.warn(
            '[token-ledger] forked session %s has no usable inheritance boundary; folding it whole, so its totals may include the parent prefix',
            id,
          )
        }
        // The working directory is on the session's header line, which
        // `sessionPersistence` hands back separately from the sequenced events: the
        // events alone carry no `cwd`, so a backfill that read only them recorded
        // every session without a workspace. It is passed in explicitly here, with
        // the event scan as a fallback for the shapes that do carry it inline.
        const cwd = cwdFrom([stored?.meta, header, stored?.session, stored])
        ledger.adoptHistory({ sessionId: id, events, inheritedEventCount, cwd })
        sessions += 1
      } catch (error) {
        errors += 1
        log.warn('[token-ledger] could not read stored session %s: %o', id, error)
      }
    }
    return { sessions, errors }
  }

  // The logs go first and the persistence pass waits for them. Both fold history
  // into one ledger, and which source owns a session has to be settled before the
  // other one reads it — otherwise a session could be claimed twice, in two
  // coordinate spaces, and counted twice.
  const logsFolded = track(foldLogs())

  // Following the logs is what makes a session this ledger took from disk keep
  // counting while the host runs: without it, a session resumed in this run is
  // `'log'`-owned, so the live path may not advance it and its calls are missing
  // from the ledger — and from the models the page lists — until the next start.
  if (shouldBackfillLogs) startSweep()

  if (shouldBackfill) {
    const onPersistence = (persistenceCtx) => {
      // Tracked as one chain: dispose has to wait for the whole backfill, not only
      // for the log fold it is waiting behind.
      track(
        logsFolded
          .then(() => backfill(persistenceCtx.sessionPersistence))
          .then((tally) => {
            log.info(
              '[token-ledger] backfilled %d stored session(s), %d unreadable; total %d tokens over %d calls',
              tally.sessions,
              tally.errors,
              ledger.totals.totalTokens,
              ledger.calls,
            )
            schedule(0)
          })
          .catch((error) => {
            log.warn('[token-ledger] backfill failed: %o', error)
          }),
      )
    }
    if (typeof ctx.inject === 'function') ctx.inject(['sessionPersistence'], onPersistence)
  }

  if (typeof ctx.on === 'function') {
    ctx.on('session/created', (session) => {
      if (adopt(session)) scheduleRefresh()
      schedule()
    })
    ctx.on('session/event', (session) => {
      if (adopt(session)) scheduleRefresh()
      schedule()
    })
    ctx.on('session/disposed', (session) => {
      // A session this ledger took from disk is not advanced by `adopt`, so its
      // log is the only place its last events can come from — and the session
      // being over is the moment its log can be read at once, instead of on the
      // next window.
      if (adopt(session)) {
        try {
          refreshLog(String(session?.id ?? session?.sessionId ?? ''))
        } catch (error) {
          log.warn('[token-ledger] could not fold the log of a disposed session: %o', error)
        }
      }
      schedule(0)
    })
    ctx.on('session/end-seed', () => schedule())
  }

  if (!restored) log.info('[token-ledger] started a new ledger at %s', ledgerPath)

  /**
   * Handle `/tokens [summary|export|json|path]`.
   *
   * @param {{ rawInput?: string }} input - the command invocation.
   * @returns {{ kind: 'success'|'error', text: string }} the command result.
   */
  const runCommand = ({ rawInput = '' } = {}) => {
    const argument = String(rawInput).trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    switch (argument) {
      case '':
      case 'summary': {
        return { kind: 'success', text: ledger.format() }
      }
      case 'path': {
        return { kind: 'success', text: ledgerPath }
      }
      case 'json': {
        return { kind: 'success', text: JSON.stringify(ledger.snapshot(), null, 2) }
      }
      case 'export': {
        const stamp = new Date().toISOString().slice(0, 10)
        const written = []
        try {
          written.push(writeFileAtomic(join(paths.exportsDir, `daily-${stamp}.csv`), ledger.toCsv('daily')))
          written.push(writeFileAtomic(join(paths.exportsDir, `sessions-${stamp}.csv`), ledger.toCsv('sessions')))
          written.push(writeFileAtomic(join(paths.exportsDir, `models-${stamp}.csv`), ledger.toCsv('models')))
          written.push(saveLedger(join(paths.exportsDir, `ledger-${stamp}.json`), ledger.snapshot()))
        } catch (error) {
          return { kind: 'error', text: `export failed: ${error instanceof Error ? error.message : String(error)}` }
        }
        return { kind: 'success', text: `exported:\n${written.map((path) => `  ${path}`).join('\n')}` }
      }
      default: {
        return {
          kind: 'error',
          text: 'usage: /tokens [summary|export|json|path]',
        }
      }
    }
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: 'tokens',
        description: 'Show the cumulative token ledger (per day and per model)',
        // `input` must be an object carrying a non-empty `hint` string; a bare
        // string is rejected by the command registry with a TypeError.
        input: { hint: 'summary | export | json | path' },
        handler: runCommand,
      })
    })
  }

  // The browser half reads this route, which is a read-only view of the live
  // ledger. Without a web server the plugin is still fully usable through
  // /tokens and the CLI, so the service is optional rather than injected.
  //
  // Registration is logged because the settings page can only report that it
  // could not read the route. The log is what distinguishes "this profile has no
  // web server" from "the route failed to register"; from the browser the two
  // look identical.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      ctx.effect(() => {
        const dispose = webCtx.webServer.register(
          createOverviewRoute({
            ledger,
            // The overview shows what a period cost, which needs the same prices the
            // bill uses; the catalogue carries every provider's whole list, so a
            // call to a model that is not the vendor's newest is priced too.
            catalogue: () => rates.readCatalogue(),
            subscriptions: subscriptionsConfig,
            options: { onError: (error) => log.warn('[token-ledger] overview route failed: %o', error) },
          }),
        )
        const disposeRates = webCtx.webServer.register(
          createRatesRoute({
            rates,
            options: { onError: (error) => log.warn('[token-ledger] rates route failed: %o', error) },
          }),
        )
        const disposeBill = webCtx.webServer.register(
          createBillRoute({
            snapshot: () => ledger.snapshot(),
            // The bill prices usage by model, so it needs every priced model the
            // catalogue carries — not only the few the price table shows.
            catalogue: () => rates.readCatalogue(),
            subscriptions: subscriptionsConfig,
            providerNames,
            foldSmallSessions,
            smallSession,
            options: { onError: (error) => log.warn('[token-ledger] bill route failed: %o', error) },
          }),
        )
        // The translations are data in `locale/*.json`, read per request and
        // served to the browser half, which is one classic script and cannot
        // carry them as files of its own.
        const disposeI18n = webCtx.webServer.register(
          createI18nRoute({
            options: { onError: (error) => log.warn('[token-ledger] i18n route failed: %o', error) },
          }),
        )
        // The database connections live beside the ledger, in a file only the
        // user can read, and the dumps are written next to it. The route runs
        // the vendor's own dump tool, so the tool has to be on this machine —
        // the page says so when it is not.
        const databaseLayout = databasePaths(paths.dir)
        const databaseStore = createDatabaseStore({
          path: databaseLayout.path,
          dir: databaseLayout.dir,
          options: { log },
        })
        const disposeDatabases = webCtx.webServer.register(
          createDatabasesRoute({
            store: { ...databaseStore, backups: () => listBackups(databaseLayout.dir) },
            dump: (connection) => runDump(connection, { dir: databaseLayout.dir }),
            test: (connection) => runTest(connection),
            options: { onError: (error) => log.warn('[token-ledger] databases route failed: %o', error) },
          }),
        )
        log.info('[token-ledger] settings page routes ready at %s, %s, %s, %s and %s', OVERVIEW_PATH, RATES_PATH, BILL_PATH, I18N_PATH, DATABASES_PATH)
        return () => {
          disposeDatabases?.()
          disposeI18n?.()
          disposeBill?.()
          disposeRates?.()
          dispose?.()
        }
      }, 'token-ledger: settings page routes')
    })
  }

  // Prices are enriched from the network but never depend on it. These two files
  // are the same directory, so they travel together in a backup.
  if (ratesEnabled) {
    // Tracked, because a shutdown in the middle of the first refresh would
    // otherwise leave the fetch racing the process exit.
    track(rates.refresh({ reason: 'startup' }))
    rates.start()
  } else {
    log.info('[token-ledger] pricing refresh is disabled; only hand-entered prices will be used')
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(
      () => async () => {
        disposed = true
        rates.stop()
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        if (refreshTimer !== undefined) {
          clearTimeout(refreshTimer)
          refreshTimer = undefined
        }
        if (sweepTimer !== undefined) {
          clearTimeout(sweepTimer)
          sweepTimer = undefined
        }
        // A refresh still in flight is cancelled when the service can do it; the
        // optional call keeps an older or stubbed service working.
        rates.cancelRefresh?.()
        // The boot work folds history this ledger does not have yet. Waiting for it
        // is what makes the write below a complete ledger rather than a snapshot of
        // whatever the process happened to have folded when it was asked to stop.
        await Promise.allSettled([...pendingWork])
        // What the running sessions produced since the last window belongs in the
        // durable record too, and a session being closed is exactly the moment its
        // log is final. The same one-whole-read-per-turn budget applies: a quit
        // that resumed several sessions must not turn into a second of blocked
        // event loop, and whatever is left is read again at the next mount, whose
        // watermark this run's logs are newer than.
        try {
          refreshDirtyLogs()
        } catch (error) {
          log.warn('[token-ledger] could not fold a session log on the way out: %o', error)
        }
        await persist()
      },
      'token-ledger: flush on dispose',
    )
  }
}

export default { name, apply }
