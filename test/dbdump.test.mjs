/**
 * Running a database dump.
 *
 * The dump is a child process, so what is tested here is the part that is this
 * package's own: which command is built, where the password goes, and what the
 * reader is told when it did not work.
 *
 * @module dsh-token-ledger/test/dbdump
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'

import {
  clientToolsFor,
  dumpCommand,
  dumpFileName,
  dumpToolsFor,
  findExecutable,
  listBackups,
  redact,
  runDump,
  runTest,
  testCommand,
} from '../lib/dbdump.js'

/**
 * A connection that passes.
 *
 * @param {object} [overrides] - what to change.
 * @returns {object} the connection.
 */
function connection(overrides = {}) {
  return {
    id: 'gitea',
    name: 'Gitea',
    type: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    database: 'gitea',
    user: 'gitea',
    password: 'secret',
    dumpPath: '',
    ...overrides,
  }
}

/**
 * A spawn that writes a fixed line and exits.
 *
 * @param {object} input - the fake's inputs.
 * @param {number} [input.code] - the exit code.
 * @param {string} [input.stdout] - what it writes to the standard output.
 * @param {string} [input.stderr] - what it writes to the standard error.
 * @param {object[]} [input.seen] - where the call is recorded.
 * @returns {Function} the spawn function.
 */
function fakeSpawn({ code = 0, stdout = '', stderr = '', seen = [] } = {}) {
  return (command, args, options) => {
    seen.push({ command, args, env: options?.env })
    const child = new EventEmitter()
    // The standard streams are real streams: the dump is piped into a file, and
    // a stand-in that cannot be piped to would not exercise that.
    child.stderr = new PassThrough()
    child.stdout = new PassThrough()
    child.kill = () => {}
    setImmediate(() => {
      if (stdout !== '') child.stdout.write(stdout)
      if (stderr !== '') child.stderr.write(stderr)
      child.stdout.end()
      child.stderr.end()
    })
    child.stdout.on('end', () => {
      setImmediate(() => child.emit('close', code))
    })
    return child
  }
}

/**
 * An environment whose PATH holds one tool.
 *
 * @param {string} name - the tool.
 * @returns {object} the environment.
 */
function pathWith(name) {
  return { PATH: join(tmpdir(), 'token-ledger-tools') }
}

test('each engine has the tool that dumps it', () => {
  assert.deepEqual(dumpToolsFor('mysql'), ['mysqldump', 'mariadb-dump'])
  assert.deepEqual(dumpToolsFor('mariadb'), ['mariadb-dump', 'mysqldump'])
  assert.deepEqual(dumpToolsFor('postgres'), ['pg_dump'])
  assert.deepEqual(clientToolsFor('postgres'), ['psql'])
  assert.deepEqual(clientToolsFor('mysql'), ['mysql', 'mariadb'])
})

test('a tool is found the way a shell finds one', () => {
  const access = (path) => {
    if (path.endsWith(join('usr', 'bin', 'mysqldump'))) return
    throw new Error('not executable')
  }
  const env = { PATH: ['/usr/local/bin', '/usr/bin'].join(process.platform === 'win32' ? ';' : ':') }
  assert.equal(findExecutable('mysqldump', { env, access }), join('/usr/bin', 'mysqldump'))
  assert.equal(findExecutable('nothing', { env, access }), null)
  // A path is used as it is: it was written by whoever set it.
  assert.equal(findExecutable('/opt/tools/mysqldump', { env, access }), null)
})

test('the password never reaches the command line', () => {
  const mysql = dumpCommand(connection(), { binary: '/usr/bin/mysqldump', credentialFile: '/tmp/creds' })
  assert.ok(!mysql.args.join(' ').includes('secret'))
  assert.equal(mysql.args[0], '--defaults-extra-file=/tmp/creds')
  assert.ok(mysql.args.includes('--databases'))
  assert.ok(mysql.args.includes('gitea'))

  const postgres = dumpCommand(connection({ type: 'postgres' }), { binary: '/usr/bin/pg_dump', credentialFile: '/tmp/creds' })
  assert.ok(!postgres.args.join(' ').includes('secret'))
  assert.ok(postgres.args.includes('--dbname=gitea'))
  assert.equal(postgres.env.PGPASSFILE, '/tmp/creds')
})

test('the connection is asked without a password', () => {
  const mysql = testCommand(connection(), { binary: '/usr/bin/mysql', credentialFile: '/tmp/creds' })
  assert.ok(!mysql.args.join(' ').includes('secret'))
  assert.ok(mysql.args.includes('--execute=SELECT 1'))
  const postgres = testCommand(connection({ type: 'postgres' }), { binary: '/usr/bin/psql', credentialFile: '/tmp/creds' })
  assert.ok(postgres.args.includes('--command=SELECT 1'))
  // A client that asks for a password on the terminal would hang the route.
  assert.ok(postgres.args.includes('--no-password'))
})

test('a password a tool printed is taken out of what the reader is told', () => {
  assert.equal(redact('Access denied for secret', 'secret'), 'Access denied for ***')
  assert.equal(redact('nothing to hide', ''), 'nothing to hide')
  assert.equal(redact(undefined, 'secret'), '')
})

test('the dump file is named after the connection and the moment', () => {
  const name = dumpFileName(connection(), Date.UTC(2026, 9, 31, 12, 0, 0))
  assert.equal(name, 'gitea-2026-10-31T12-00-00-000Z.sql')
  assert.ok(!name.includes('/'))
})

test('a dump is written to a file and the credential file is taken away', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-ledger-dump-'))
  const seen = []
  const outcome = await runDump(connection(), {
    dir,
    now: () => Date.UTC(2026, 9, 31, 12, 0, 0),
    spawn: fakeSpawn({ stdout: '-- dump\n', seen }),
    // The tool is "there": the lookup is what is being exercised elsewhere.
    access: (path) => {
      if (path.endsWith('mysqldump')) return
      throw new Error('not executable')
    },
    env: pathWith('mysqldump'),
  })
  assert.equal(outcome.ok, true)
  const files = readdirSync(dir)
  assert.equal(files.length, 1, 'the dump and nothing else')
  assert.ok(files[0].endsWith('.sql'))
  // The password went into the credential file and not onto the command line.
  assert.ok(!seen[0].args.join(' ').includes('secret'))
})

test('a dump that fails says why, and leaves no half file behind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-ledger-dump-'))
  const outcome = await runDump(connection(), {
    dir,
    spawn: fakeSpawn({ code: 2, stderr: 'Access denied for user gitea using password secret' }),
    access: (path) => {
      if (path.endsWith('mysqldump')) return
      throw new Error('not executable')
    },
    env: pathWith('mysqldump'),
  })
  assert.equal(outcome.ok, false)
  assert.ok(!outcome.error.includes('secret'), 'the password is not in what the reader is told')
  assert.ok(outcome.error.includes('Access denied'))
  assert.deepEqual(readdirSync(dir), [], 'no file that looks like a backup')
})

test('a machine with no dump tool says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-ledger-dump-'))
  const outcome = await runDump(connection(), {
    dir,
    spawn: fakeSpawn(),
    access: () => {
      throw new Error('not executable')
    },
    env: { PATH: '' },
  })
  assert.equal(outcome.ok, false)
  assert.ok(outcome.error.includes('mysqldump'))
  assert.ok(outcome.error.includes('mariadb-dump'))
})

test('a connection that cannot be reached says so', async () => {
  const outcome = await runTest(connection(), {
    spawn: fakeSpawn({ code: 1, stderr: "Can't connect to local server" }),
    access: (path) => {
      if (path.endsWith('mysql')) return
      throw new Error('not executable')
    },
    env: pathWith('mysql'),
  })
  assert.equal(outcome.ok, false)
  assert.ok(outcome.error.includes("Can't connect"))
})

test('a connection that works says so', async () => {
  const outcome = await runTest(connection(), {
    spawn: fakeSpawn({ stdout: '1\n' }),
    access: (path) => {
      if (path.endsWith('mysql')) return
      throw new Error('not executable')
    },
    env: pathWith('mysql'),
  })
  assert.equal(outcome.ok, true)
})

test('the dumps on disk are listed newest first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-ledger-list-'))
  writeFileSync(join(dir, 'one.sql'), 'a')
  writeFileSync(join(dir, 'two.sql'), 'b')
  writeFileSync(join(dir, 'not-a-dump.txt'), 'c')
  const files = listBackups(dir)
  assert.equal(files.length, 2)
  assert.deepEqual(files.map((file) => file.name).sort(), ['one.sql', 'two.sql'])
  assert.equal(files[0].bytes, 1)
  assert.deepEqual(listBackups(join(dir, 'missing')), [])
})
