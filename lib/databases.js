/**
 * The database connections the backup page keeps.
 *
 * ## Where the credentials live
 *
 * A connection carries a password, so the file it lives in is written with
 * owner-only permissions inside the DSH home, next to the ledger it belongs
 * to. It is deliberately **not** a settings namespace: those are persisted,
 * rewritten on every debounce and readable in `settings.yaml`, and a password
 * belongs in neither.
 *
 * ## What the page is allowed to see
 *
 * The page lists the connections, so it needs their names, addresses and
 * users — and it does not need their passwords. A read redacts them; a write
 * carries one, once, when the connection is created or its password is
 * changed.
 *
 * @module dsh-token-ledger/databases
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The engines this plugin can dump. */
export const DB_TYPES = ['mysql', 'mariadb', 'postgres']

/** The port each engine listens on by default. */
export const DEFAULT_PORTS = { mysql: 3306, mariadb: 3306, postgres: 5432 }

/** The file the connections live in, inside the plugin's state directory. */
export const DATABASES_FILENAME = 'databases.json'

/** The directory the dumps are written to, inside the plugin's state directory. */
export const BACKUPS_DIRNAME = 'backups'

/**
 * Whether a value can be part of a file name.
 *
 * A name that reaches the file system is a name that can walk out of the
 * directory it belongs in, so the alphabet is a short one and the separators
 * are not in it.
 *
 * @param {string} value - the candidate.
 * @returns {boolean} whether it is safe.
 */
function isSafeName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
}

/**
 * Turn a display name into a safe identifier.
 *
 * The identifier ends up in the name of the dump file, so it is built from a
 * short alphabet and can never be a path.
 *
 * @param {string} name - the display name.
 * @returns {string} the identifier.
 */
export function slugify(name) {
  const slug = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'db' : slug.slice(0, 64)
}

/**
 * Check a connection and fill in what the reader did not say.
 *
 * The check is the whole shape of the thing rather than a spot check: a
 * connection that is missing a host cannot be dumped, and a dump that fails
 * halfway through because of a missing user is a worse answer than one that
 * was refused before it started.
 *
 * @param {object} input - what the page sent.
 * @param {{ existing?: object[] }} [options] - the connections already stored.
 * @returns {{ ok: true, connection: object } | { ok: false, error: string }} the result.
 */
export function validateConnection(input = {}, { existing = [] } = {}) {
  const type = String(input.type ?? '').trim().toLowerCase()
  if (!DB_TYPES.includes(type)) return { ok: false, error: 'unknown database type' }

  const name = String(input.name ?? '').trim()
  if (name === '') return { ok: false, error: 'the connection needs a name' }
  if (name.length > 64) return { ok: false, error: 'the name is too long' }

  const host = String(input.host ?? '').trim()
  if (host === '') return { ok: false, error: 'the connection needs a host' }
  if (/[\r\n\0]/.test(host)) return { ok: false, error: 'the host is not a host' }

  const database = String(input.database ?? '').trim()
  if (database === '') return { ok: false, error: 'the connection needs a database' }
  if (/[\r\n\0]/.test(database)) return { ok: false, error: 'the database name is not a name' }

  const user = String(input.user ?? '').trim()
  if (user === '') return { ok: false, error: 'the connection needs a user' }
  if (/[\r\n\0]/.test(user)) return { ok: false, error: 'the user is not a user' }

  const port = input.port === undefined || input.port === null || input.port === ''
    ? DEFAULT_PORTS[type]
    : Number(input.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'the port is not a port' }

  // An empty dump path means "the one on the PATH"; anything else has to be a
  // plain path, because it is handed to the operating system and not to a shell.
  const dumpPath = String(input.dumpPath ?? '').trim()
  if (dumpPath !== '' && !isSafeName(dumpPath) && !dumpPath.includes('/') && !dumpPath.includes('\\')) {
    return { ok: false, error: 'the dump tool path is not a path' }
  }

  const password = typeof input.password === 'string' ? input.password : ''
  // The password is written into a line of a file the client reads — the
  // passfile, the option file — so a line break in it would end the value early
  // and leave the rest of the password as something else.
  if (/[\r\n\0]/.test(password)) return { ok: false, error: 'the password is not a password' }

  // An update keeps its identifier; a new connection takes one from its name
  // and is given a suffix if that name is already taken.
  const wanted = String(input.id ?? '').trim()
  const taken = new Set(existing.map((entry) => entry.id))
  let id = wanted === '' ? slugify(name) : slugify(wanted)
  if (wanted === '') {
    let suffix = 1
    while (taken.has(id)) {
      suffix += 1
      id = `${slugify(name)}-${suffix}`
    }
  } else if (!existing.some((entry) => entry.id === id)) {
    return { ok: false, error: 'unknown connection' }
  }

  return {
    ok: true,
    connection: {
      id,
      name,
      type,
      host,
      port,
      database,
      user,
      password,
      dumpPath,
    },
  }
}

/**
 * A connection without its password.
 *
 * @param {object} connection - the stored connection.
 * @returns {object} the connection, redacted.
 */
export function redactConnection(connection) {
  if (connection === null || typeof connection !== 'object') return connection
  const { password, ...rest } = connection
  return { ...rest, hasPassword: typeof password === 'string' && password !== '' }
}

/**
 * Every connection without its password.
 *
 * @param {object[]} connections - the stored connections.
 * @returns {object[]} the redacted connections.
 */
export function redactConnections(connections) {
  return Array.isArray(connections) ? connections.map(redactConnection) : []
}

/**
 * Read the stored connections, and say whether the file could be read at all.
 *
 * A file that is not there holds no connections, which is not an error: a fresh
 * install has no connections yet. A file that is there and cannot be read or
 * parsed is a different thing — the connections in it may be perfectly good and
 * merely unreadable for a moment — so it is reported as an error, and the store
 * refuses to write over what it could not read.
 *
 * @param {string} path - the file to read.
 * @returns {{ connections: object[], error?: string }} what is stored.
 */
function readState(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { connections: [] }
    return { connections: [], error: 'the connections file could not be read' }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { connections: [], error: 'the connections file is not valid JSON' }
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.connections
  if (!Array.isArray(list)) return { connections: [], error: 'the connections file does not hold connections' }
  return { connections: list.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string') }
}

/**
 * The stored connections.
 *
 * An unreadable file is reported as an error by `readState`; this is the
 * reading that only wants the connections, so it takes the empty list.
 *
 * @param {string} path - the file to read.
 * @returns {object[]} the connections.
 */
export function readConnections(path) {
  return readState(path).connections
}

/**
 * Write the connections, owner-only.
 *
 * The file holds passwords, so it is written with `0600` and its directory
 * with `0700`. The write is atomic: a half-written file of credentials is
 * worse than no file at all.
 *
 * @param {string} path - the file to write.
 * @param {object[]} connections - the connections to store.
 * @returns {void}
 */
export function writeConnections(path, connections) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    chmodSync(dirname(path), 0o700)
  } catch {
    // The directory already exists with the mode it has; a filesystem that
    // refuses the change is not a reason to refuse the write.
  }
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify({ connections }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The rename failure matters more than the cleanup failure.
    }
    throw error
  }
}

/**
 * Build the store the route reads and writes through.
 *
 * @param {object} input - the store's inputs.
 * @param {string} input.path - where the connections live.
 * @param {string} input.dir - where the dumps are written.
 * @param {{ log?: { warn: Function } }} [input.options] - diagnostics.
 * @returns {object} the store.
 */
export function createDatabaseStore({ path, dir, options = {} }) {
  const log = options.log ?? { warn: () => {} }

  /**
   * The store's reading of the file, which also says whether it was read.
   *
   * @returns {{ connections: object[], error?: string }} what is stored.
   */
  const all = () => readState(path)

  return {
    path,
    dir,
    /**
     * The connections the page is allowed to see.
     *
     * A file that could not be read is an empty list and the reason beside it:
     * the page has to be able to say a list is empty because the file is broken,
     * and not because there is nothing in it.
     */
    read() {
      const state = all()
      if (state.error !== undefined) return { connections: [], error: state.error }
      return { connections: redactConnections(state.connections) }
    },
    /**
     * Add a connection or change one that is already there.
     *
     * A file that could not be read is never written over: the connections in it
     * are still there, and replacing them with the one being saved now is how a
     * password that was only unreadable for a moment is lost for good.
     *
     * @param {object} input - what the page sent.
     * @returns {{ ok: true, connection: object } | { ok: false, error: string }} the result.
     */
    save(input) {
      const state = all()
      if (state.error !== undefined) return { ok: false, error: 'could not read the connections file' }
      const existing = state.connections
      const result = validateConnection(input, { existing })
      if (result.ok !== true) return result
      // An update that carries no password keeps the one it had: the page
      // redacts it, so it cannot send it back unless it is being changed.
      if (result.connection.password === '' && existing.length > 0) {
        const previous = existing.find((entry) => entry.id === result.connection.id)
        if (previous !== undefined) result.connection.password = previous.password ?? ''
      }
      const kept = existing.filter((entry) => entry.id !== result.connection.id)
      try {
        writeConnections(path, [...kept, result.connection])
      } catch (error) {
        log.warn('[token-ledger] could not write the database connections: %o', error)
        return { ok: false, error: 'could not save the connection' }
      }
      return { ok: true, connection: redactConnection(result.connection) }
    },
    /**
     * Forget a connection.
     *
     * @param {string} id - the connection's identifier.
     * @returns {{ ok: true } | { ok: false, error: string }} the result.
     */
    remove(id) {
      const state = all()
      if (state.error !== undefined) return { ok: false, error: 'could not read the connections file' }
      const existing = state.connections
      const kept = existing.filter((entry) => entry.id !== id)
      if (kept.length === existing.length) return { ok: false, error: 'unknown connection' }
      try {
        writeConnections(path, kept)
      } catch (error) {
        log.warn('[token-ledger] could not write the database connections: %o', error)
        return { ok: false, error: 'could not remove the connection' }
      }
      return { ok: true }
    },
    /**
     * The connection with its password, for the dump.
     *
     * Nothing when the file cannot be read: there is no connection that could be
     * named, and a dump of the wrong one is worse than none.
     *
     * @param {string} id - the connection's identifier.
     * @returns {object|undefined} the connection, when it is stored.
     */
    secret(id) {
      const state = all()
      if (state.error !== undefined) return undefined
      return state.connections.find((entry) => entry.id === id)
    },
    /**
     * One of the dumps that is on disk.
     *
     * The name comes from the browser, so it is checked against a short
     * alphabet before it is joined to the directory: a name that could walk out
     * of that directory is not a name, it is a path.
     *
     * A name is not a dump either: a directory called `something.sql` is let
     * through by the alphabet and by `statSync`, and handing its path to the
     * route would ask a stream to read a directory.
     *
     * The file is handed over as a path rather than as its contents: a dump can
     * be gigabytes, and it is streamed rather than read into memory.
     *
     * @param {string} name - the file's name.
     * @returns {{ ok: true, name: string, path: string, size: number } | { ok: false, error: string }} the result.
     */
    readBackup(name) {
      const file = String(name ?? '')
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/.test(file) || file.includes('..')) {
        return { ok: false, error: 'that is not a dump this page wrote' }
      }
      const path = join(dir, file)
      try {
        const info = statSync(path)
        if (!info.isFile()) return { ok: false, error: 'that is not a dump this page wrote' }
        return { ok: true, name: file, path, size: info.size }
      } catch {
        return { ok: false, error: 'that dump is not there any more' }
      }
    },
  }
}

/**
 * Where the store and the dumps live inside a DSH home.
 *
 * @param {string} dir - the plugin's state directory.
 * @returns {{ path: string, dir: string }} the layout.
 */
export function databasePaths(dir) {
  return { path: join(dir, DATABASES_FILENAME), dir: join(dir, BACKUPS_DIRNAME) }
}
