/**
 * Running a database dump.
 *
 * ## Why the vendor's own tool
 *
 * A logical dump is a format the database defines, not one this package
 * invents. `mysqldump` and `pg_dump` are the tools that write it, they know
 * their own server's quirks, and they are what an operator would run by hand.
 * Talking to the servers over the wire from here would mean reimplementing
 * two wire protocols and their authentication — a dependency and a bug
 * surface this package does not want.
 *
 * So the dump is a child process, and the cost of that is that the tool has to
 * be on the machine. The page says so plainly when it is not, rather than
 * failing with a stack trace.
 *
 * ## Where the password goes
 *
 * Never on the command line: another process on the machine can read that. MySQL
 * and MariaDB read a `--defaults-extra-file`, PostgreSQL reads a `PGPASSFILE`,
 * and both files are written with owner-only permissions and deleted as soon as
 * the dump is over. The test's copy also gets a directory of its own: a name in
 * a shared temporary directory is a name someone else can put a file at first.
 *
 * @module dsh-token-ledger/dbdump
 */

import { spawn as nodeSpawn } from 'node:child_process'
import {
  accessSync,
  constants,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

/** How long a dump may run before it is given up on. */
export const DUMP_TIMEOUT_MS = 15 * 60 * 1000

/** How long the tool is given to stop on its own after being asked to. */
const KILL_GRACE_MS = 5 * 1000

/** How long the exit is waited for after the tool has been killed outright. */
const CLOSE_GRACE_MS = 1000

/** How much of the tool's error output is kept. */
const STDERR_LIMIT = 8 * 1024

/** The extensions Windows appends to a program name when it looks one up. */
const PATHEXT_DEFAULT = '.COM;.EXE;.BAT;.CMD'

/**
 * The tools that can dump each engine, in the order they are tried.
 *
 * MySQL and MariaDB share a wire protocol and a dump format, and the two
 * client tools are interchangeable in practice, so each engine falls back to
 * the other's tool rather than refusing because of a name.
 *
 * @param {string} type - the engine.
 * @returns {string[]} the tool names.
 */
export function dumpToolsFor(type) {
  if (type === 'postgres') return ['pg_dump']
  if (type === 'mariadb') return ['mariadb-dump', 'mysqldump']
  return ['mysqldump', 'mariadb-dump']
}

/**
 * The client that can open a connection to each engine, for the test.
 *
 * @param {string} type - the engine.
 * @returns {string[]} the client names.
 */
export function clientToolsFor(type) {
  if (type === 'postgres') return ['psql']
  if (type === 'mariadb') return ['mariadb', 'mysql']
  return ['mysql', 'mariadb']
}

/**
 * Whether a file is executable.
 *
 * @param {string} path - the path to check.
 * @param {(path: string, mode: number) => void} access - the check.
 * @returns {boolean} whether it is.
 */
function isExecutable(path, access) {
  try {
    access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Find an executable by name, the way a shell would.
 *
 * Windows does not run the file it is handed, it runs the file the name finds
 * with one of the extensions in `PATHEXT`: a `mysqldump` on that machine is
 * `mysqldump.exe` on disk, and looking only for the bare name would report an
 * installed tool as missing.
 *
 * @param {string} name - the program, or a path to one.
 * @param {object} options - the lookup's inputs.
 * @param {NodeJS.ProcessEnv} [options.env] - the environment to read `PATH` and `PATHEXT` from.
 * @param {(path: string, mode: number) => void} [options.access] - the check.
 * @returns {string|null} the path, or null when there is none.
 */
export function findExecutable(name, { env = process.env, access = accessSync } = {}) {
  const target = String(name ?? '').trim()
  if (target === '') return null
  // A path is used as it is: it was written by whoever set it, and looking for
  // it on the PATH would find something else entirely.
  if (target.includes('/') || target.includes('\\')) {
    return isExecutable(target, access) ? target : null
  }
  const entries = String(env.PATH ?? '').split(delimiter).filter((entry) => entry !== '')
  // The bare name is tried first: on a system that appends an extension, a file
  // that is really called `mysqldump` is still the one that was meant.
  const suffixes = ['']
  const pathext = env.PATHEXT === undefined
    ? (process.platform === 'win32' ? PATHEXT_DEFAULT : '')
    : String(env.PATHEXT)
  for (const extension of pathext.split(';')) {
    const suffix = extension.trim()
    if (suffix !== '' && suffix !== '.') suffixes.push(suffix)
  }
  for (const entry of entries) {
    for (const suffix of suffixes) {
      const candidate = join(entry, `${target}${suffix}`)
      if (isExecutable(candidate, access)) return candidate
    }
  }
  return null
}

/**
 * Quote a value for a MySQL option file.
 *
 * The option file is read by the client itself, one line at a time, so a value
 * that holds a quote, a backslash or a line break has to be written with the
 * escapes the client understands — otherwise the value ends early and what is
 * left of the line becomes an option of its own.
 *
 * @param {string} value - the value.
 * @returns {string} the quoted value.
 */
function quoteOption(value) {
  const escaped = String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\0/g, '\\0')
  return `"${escaped}"`
}

/**
 * Escape one field of a PostgreSQL password file.
 *
 * The passfile is five fields separated by colons — host, port, database, user,
 * password — and a field holds a colon or a backslash only when that character
 * is escaped. An IPv6 host is literally `::1`, and a password may hold a colon
 * of its own, so both have to be written as they mean.
 *
 * @param {string|number} value - the field's value.
 * @returns {string} the escaped value.
 */
function escapePassField(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
}

/**
 * Write the file the tool reads the password from.
 *
 * @param {object} connection - the connection.
 * @param {string} path - where to write it.
 * @returns {void}
 */
function writeCredentialFile(connection, path) {
  if (connection.type === 'postgres') {
    // The passfile format is one line: host, port, database, user, password.
    const fields = [connection.host, connection.port, connection.database, connection.user, connection.password]
    const line = fields.map(escapePassField).join(':')
    writeFileSync(path, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
    return
  }
  const body = [
    '[client]',
    `user=${quoteOption(connection.user)}`,
    `password=${quoteOption(connection.password)}`,
    `host=${quoteOption(connection.host)}`,
    `port=${connection.port}`,
    '',
  ].join('\n')
  writeFileSync(path, body, { encoding: 'utf8', mode: 0o600 })
}

/**
 * The command that dumps the database.
 *
 * @param {object} connection - the connection.
 * @param {object} input - the command's inputs.
 * @param {string} input.binary - the tool to run.
 * @param {string} input.credentialFile - the file the password is in.
 * @returns {{ command: string, args: string[], env: object }} the command.
 */
export function dumpCommand(connection, { binary, credentialFile }) {
  if (connection.type === 'postgres') {
    return {
      command: binary,
      args: [
        `--host=${connection.host}`,
        `--port=${connection.port}`,
        `--username=${connection.user}`,
        `--dbname=${connection.database}`,
        '--format=plain',
        '--no-password',
      ],
      env: { PGPASSFILE: credentialFile },
    }
  }
  return {
    command: binary,
    // `--defaults-extra-file` has to come first: the client reads its option
    // files in order and refuses to let a later file override an earlier one.
    args: [
      `--defaults-extra-file=${credentialFile}`,
      '--single-transaction',
      '--quick',
      '--routines',
      '--triggers',
      '--events',
      '--databases',
      connection.database,
    ],
    env: {},
  }
}

/**
 * The command that opens a connection and asks it something.
 *
 * @param {object} connection - the connection.
 * @param {object} input - the command's inputs.
 * @param {string} input.binary - the client to run.
 * @param {string} input.credentialFile - the file the password is in.
 * @returns {{ command: string, args: string[], env: object }} the command.
 */
export function testCommand(connection, { binary, credentialFile }) {
  if (connection.type === 'postgres') {
    return {
      command: binary,
      args: [
        `--host=${connection.host}`,
        `--port=${connection.port}`,
        `--username=${connection.user}`,
        `--dbname=${connection.database}`,
        '--command=SELECT 1',
        '--no-password',
        '--tuples-only',
      ],
      env: { PGPASSFILE: credentialFile },
    }
  }
  return {
    command: binary,
    args: [
      `--defaults-extra-file=${credentialFile}`,
      `--database=${connection.database}`,
      '--execute=SELECT 1',
      '--skip-column-names',
    ],
    env: {},
  }
}

/**
 * Take the password out of a piece of text.
 *
 * A tool should never print a password, but its error output is shown to the
 * reader, and a tool that does print one must not put it on the page.
 *
 * @param {string} text - the text.
 * @param {string} password - the password to remove.
 * @returns {string} the text, without the password.
 */
export function redact(text, password) {
  const value = String(text ?? '')
  if (typeof password !== 'string' || password === '') return value
  return value.split(password).join('***')
}

/**
 * Run a command and collect what it said.
 *
 * @param {object} input - the run's inputs.
 * @param {string} input.command - the program.
 * @param {string[]} input.args - its arguments.
 * @param {object} input.env - the environment to add to.
 * @param {string} [input.outFile] - where the standard output goes.
 * @param {NodeJS.ProcessEnv} [input.baseEnv] - the environment to start from.
 * @param {Function} [input.spawn] - the spawn function.
 * @param {number} [input.timeoutMs] - how long it may run.
 * @param {number} [input.killGraceMs] - how long it is given to stop on its own.
 * @param {number} [input.closeGraceMs] - how long the exit is waited for after a kill.
 * @returns {Promise<{ code: number, stderr: string, timedOut: boolean }>} the outcome.
 */
export function runCommand({
  command,
  args,
  env = {},
  outFile,
  baseEnv = process.env,
  spawn = nodeSpawn,
  timeoutMs = DUMP_TIMEOUT_MS,
  killGraceMs = KILL_GRACE_MS,
  closeGraceMs = CLOSE_GRACE_MS,
}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, {
        env: { ...baseEnv, ...env },
        stdio: ['ignore', outFile === undefined ? 'pipe' : 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ code: -1, stderr: String(error?.message ?? error), timedOut: false })
      return
    }

    let stderr = ''
    let settled = false
    let childClosed = false
    let childCode = -1
    let timedOut = false
    let sinkFinished = outFile === undefined
    let timer = null
    let killTimer = null
    let closeTimer = null
    const timeoutText = 'the dump took too long and was stopped'
    const timedOutResult = () => ({ code: -1, stderr: `${stderr}\n${timeoutText}`, timedOut: true })
    const exitResult = () => (timedOut ? timedOutResult() : { code: childCode, stderr, timedOut: false })
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      clearTimeout(closeTimer)
      resolve(result)
    }
    // The tool is asked to stop, given a moment to act on that, and killed
    // outright when it does not; the answer waits for its exit either way, so a
    // dump that was cut short is never passed off as a finished one. These
    // timers are what settle the promise the caller is awaiting, so they are
    // deliberately not unref'd: an unref'd timer does not keep the event loop
    // alive, and a caller with no other handle would then never be answered.
    // A real tool holds the loop itself, and `finish` clears these timers, so
    // a finished run is not kept alive by them either.
    const stop = () => {
      timedOut = true
      try {
        child.kill()
      } catch {
        // The process is already gone; the signal is not what matters.
      }
      killTimer = setTimeout(() => {
        if (child.exitCode === null) {
          try {
            child.kill('SIGKILL')
          } catch {
            // Already gone.
          }
        }
        closeTimer = setTimeout(() => finish(timedOutResult()), closeGraceMs)
      }, killGraceMs)
    }
    timer = setTimeout(stop, timeoutMs)

    child.stderr?.on('data', (chunk) => {
      if (stderr.length < STDERR_LIMIT) stderr += String(chunk)
    })
    if (outFile === undefined) {
      // Nothing is wanted from the standard output, but the pipe still has to be
      // drained: a child that fills it blocks until someone reads.
      child.stdout?.on('data', () => {})
    } else {
      const sink = createWriteStream(outFile)
      // A full disk must be an answer, not an unhandled error.
      sink.on('error', (error) => {
        finish({ code: -1, stderr: `${stderr}${String(error?.message ?? error)}`, timedOut: false })
      })
      // The dump is only written when the file is written: the tool closing is
      // not the same thing as the last byte being on the disk.
      sink.on('finish', () => {
        sinkFinished = true
        if (childClosed) finish(exitResult())
      })
      child.stdout?.pipe(sink)
    }
    child.on('error', (error) => {
      finish({ code: -1, stderr: `${stderr}${String(error?.message ?? error)}`, timedOut: false })
    })
    child.on('close', (code) => {
      childClosed = true
      childCode = typeof code === 'number' ? code : -1
      if (sinkFinished) finish(exitResult())
    })
  })
}

/**
 * Write the backup file's name.
 *
 * @param {object} connection - the connection being dumped.
 * @param {number} at - when the dump started.
 * @returns {string} the file name.
 */
export function dumpFileName(connection, at) {
  const stamp = new Date(at).toISOString().replace(/[:.]/g, '-')
  return `${connection.id}-${stamp}.sql`
}

/**
 * Dump a database to a file.
 *
 * @param {object} connection - the connection to dump.
 * @param {object} input - the run's inputs.
 * @param {string} input.dir - where the dump is written.
 * @param {number} [input.now] - the clock.
 * @param {Function} [input.spawn] - the spawn function.
 * @param {Function} [input.access] - the executable check.
 * @param {NodeJS.ProcessEnv} [input.env] - the environment.
 * @param {number} [input.timeoutMs] - how long the dump may run.
 * @returns {Promise<{ ok: boolean, file?: string, bytes?: number, error?: string }>} the outcome.
 */
export async function runDump(connection, { dir, now = Date.now, spawn = nodeSpawn, access = accessSync, env = process.env, timeoutMs = DUMP_TIMEOUT_MS } = {}) {
  const tools = connection.dumpPath !== undefined && connection.dumpPath !== '' ? [connection.dumpPath] : dumpToolsFor(connection.type)
  let binary = null
  for (const tool of tools) {
    binary = findExecutable(tool, { env, access })
    if (binary !== null) break
  }
  if (binary === null) {
    return { ok: false, error: `this machine has no ${tools.join(' or ')}` }
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const credentialFile = join(dir, `.credentials-${process.pid}-${now()}.tmp`)
  const file = join(dir, dumpFileName(connection, now()))
  const partial = `${file}.part`

  writeCredentialFile(connection, credentialFile)
  const { command, args, env: extra } = dumpCommand(connection, { binary, credentialFile })

  let outcome
  try {
    outcome = await runCommand({ command, args, env: extra, outFile: partial, baseEnv: env, spawn, timeoutMs })
  } finally {
    try {
      unlinkSync(credentialFile)
    } catch {
      // The credential file is gone on the next sweep either way; failing to
      // remove it must not turn a good dump into a failed one.
    }
  }

  if (outcome.code !== 0) {
    try {
      unlinkSync(partial)
    } catch {
      // Nothing to remove.
    }
    const reason = redact(outcome.stderr, connection.password).trim()
    return { ok: false, error: reason === '' ? `the dump failed with code ${outcome.code}` : reason }
  }

  try {
    renameSync(partial, file)
  } catch (error) {
    return { ok: false, error: `could not write the dump: ${String(error?.message ?? error)}` }
  }
  let bytes = 0
  try {
    bytes = statSync(file).size
  } catch {
    // The size is a nicety; the file is there.
  }
  return { ok: true, file, bytes }
}

/**
 * Open a connection and ask the server something.
 *
 * @param {object} connection - the connection to test.
 * @param {object} input - the run's inputs.
 * @returns {Promise<{ ok: boolean, error?: string }>} the outcome.
 */
export async function runTest(connection, { spawn = nodeSpawn, access = accessSync, env = process.env, timeoutMs = 60_000 } = {}) {
  const tools = clientToolsFor(connection.type)
  let binary = null
  for (const tool of tools) {
    binary = findExecutable(tool, { env, access })
    if (binary !== null) break
  }
  if (binary === null) {
    return { ok: false, error: `this machine has no ${tools.join(' or ')}` }
  }

  // The password goes into a directory of its own: the directory is owner-only
  // and freshly named, so a file that is already at the name cannot be the one
  // the password is written into.
  const credentialDir = mkdtempSync(join(tmpdir(), 'token-ledger-'))
  const credentialFile = join(credentialDir, '.credentials.tmp')
  try {
    writeCredentialFile(connection, credentialFile)
    const { command, args, env: extra } = testCommand(connection, { binary, credentialFile })

    let outcome
    try {
      outcome = await runCommand({ command, args, env: extra, baseEnv: env, spawn, timeoutMs })
    } finally {
      try {
        unlinkSync(credentialFile)
      } catch {
        // The directory below goes away with it either way.
      }
    }

    if (outcome.code !== 0) {
      const reason = redact(outcome.stderr, connection.password).trim()
      return { ok: false, error: reason === '' ? `the connection failed with code ${outcome.code}` : reason }
    }
    return { ok: true }
  } finally {
    try {
      rmSync(credentialDir, { recursive: true, force: true })
    } catch {
      // A directory that will not go is one the next sweep will take.
    }
  }
}

/**
 * The dumps that are on disk.
 *
 * @param {string} dir - the directory they are in.
 * @returns {object[]} the files, newest first.
 */
export function listBackups(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const files = []
  for (const name of names) {
    if (!name.endsWith('.sql')) continue
    try {
      const info = statSync(join(dir, name))
      files.push({ name, bytes: info.size, at: info.mtimeMs })
    } catch {
      // A file that vanished between the listing and the stat is not there.
    }
  }
  return files.sort((left, right) => right.at - left.at)
}
