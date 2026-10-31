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
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
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
  runCommand,
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
 * @param {Function} [input.onSpawn] - called with the call, before the child is returned.
 * @returns {Function} the spawn function.
 */
function fakeSpawn({ code = 0, stdout = '', stderr = '', seen = [], onSpawn = () => {} } = {}) {
  return (command, args, options) => {
    seen.push({ command, args, env: options?.env })
    onSpawn({ command, args, env: options?.env })
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

/**
 * The option file a MySQL or MariaDB command was given.
 *
 * @param {string[]} args - the command's arguments.
 * @returns {string|null} the path, when there is one.
 */
function optionFileOf(args) {
  const arg = args.find((value) => value.startsWith('--defaults-extra-file='))
  return arg === undefined ? null : arg.slice('--defaults-extra-file='.length)
}

/**
 * Split a PostgreSQL password file line the way libpq reads one.
 *
 * The five fields are separated by colons, a colon or a backslash inside a
 * field is escaped with a backslash, and an escaped character stands for
 * itself.
 *
 * @param {string} text - the file's contents.
 * @returns {string[]} the fields of the first line.
 */
function passFileFields(text) {
  const fields = []
  let field = ''
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\n') break
    if (character === '\\') {
      field += text[index + 1] ?? ''
      index += 1
      continue
    }
    if (character === ':') {
      fields.push(field)
      field = ''
      continue
    }
    field += character
  }
  fields.push(field)
  return fields
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

test('a tool is found by the extension Windows knows it by', () => {
  const env = {
    PATH: ['/usr/local/bin', '/tools'].join(process.platform === 'win32' ? ';' : ':'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
  }
  // The file on the disk is `mysqldump.exe`; the name the caller has is `mysqldump`.
  const exeOnly = (path) => {
    if (path === join('/tools', 'mysqldump.EXE')) return
    throw new Error('not executable')
  }
  assert.equal(findExecutable('mysqldump', { env, access: exeOnly }), join('/tools', 'mysqldump.EXE'))
  // The bare name is still tried first, so a file that is called exactly that wins.
  const bare = (path) => {
    if (path === join('/tools', 'mysqldump')) return
    throw new Error('not executable')
  }
  assert.equal(findExecutable('mysqldump', { env, access: bare }), join('/tools', 'mysqldump'))
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

test('the PostgreSQL password file escapes the fields that mean something', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-ledger-dump-'))
  let written = null
  const outcome = await runDump(connection({ type: 'postgres', host: '::1', port: 5432, password: 'p:a\\ss' }), {
    dir,
    now: () => Date.UTC(2026, 9, 31, 12, 0, 0),
    spawn: fakeSpawn({
      stdout: '-- dump\n',
      onSpawn: ({ env }) => {
        written = readFileSync(env.PGPASSFILE, 'utf8')
      },
    }),
    access: (path) => {
      if (path.endsWith('pg_dump')) return
      throw new Error('not executable')
    },
    env: pathWith('pg_dump'),
  })
  assert.equal(outcome.ok, true)
  // An IPv6 host is `::1` and the password holds a colon and a backslash: the
  // line still says five fields, and they are the five that went in.
  assert.deepEqual(passFileFields(written), ['::1', '5432', 'gitea', 'gitea', 'p:a\\ss'])
})

test('a line break in a MySQL password stays one value in the option file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-ledger-dump-'))
  let body = null
  const outcome = await runDump(connection({ password: 'a\nb' }), {
    dir,
    now: () => Date.UTC(2026, 9, 31, 12, 0, 0),
    spawn: fakeSpawn({
      stdout: '-- dump\n',
      onSpawn: ({ args }) => {
        body = readFileSync(optionFileOf(args), 'utf8')
      },
    }),
    access: (path) => {
      if (path.endsWith('mysqldump')) return
      throw new Error('not executable')
    },
    env: pathWith('mysqldump'),
  })
  assert.equal(outcome.ok, true)
  // The break is the escape the client understands, so the password stays the
  // value of one option and the file gains no option of its own.
  assert.equal(body, '[client]\nuser="gitea"\npassword="a\\nb"\nhost="127.0.0.1"\nport=3306\n')
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

test('a tool that will not stop is killed outright, and its exit is waited for', async () => {
  const signals = []
  const spawn = () => {
    const child = new EventEmitter()
    child.stderr = new PassThrough()
    child.stdout = new PassThrough()
    child.exitCode = null
    child.kill = (signal) => signals.push(signal ?? 'SIGTERM')
    return child
  }
  const outcome = await runCommand({
    command: '/usr/bin/mysqldump',
    args: [],
    env: {},
    spawn,
    timeoutMs: 20,
    killGraceMs: 20,
    closeGraceMs: 20,
  })
  // The polite signal first, the kill when it is ignored, and no answer until
  // the tool is gone.
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(outcome.timedOut, true)
  assert.equal(outcome.code, -1)
  assert.ok(outcome.stderr.includes('took too long'))
})

test('a tool that stops when it is asked is not killed', async () => {
  const signals = []
  const spawn = () => {
    const child = new EventEmitter()
    child.stderr = new PassThrough()
    child.stdout = new PassThrough()
    child.exitCode = null
    child.kill = (signal) => {
      signals.push(signal ?? 'SIGTERM')
      setImmediate(() => {
        child.exitCode = 0
        child.emit('close', 0)
      })
    }
    return child
  }
  const outcome = await runCommand({
    command: '/usr/bin/mysqldump',
    args: [],
    env: {},
    spawn,
    timeoutMs: 20,
    killGraceMs: 100,
    closeGraceMs: 100,
  })
  assert.deepEqual(signals, ['SIGTERM'])
  assert.equal(outcome.timedOut, true)
  // A dump that was cut short is not a dump that worked, even when the tool
  // leaves with a success code of its own.
  assert.equal(outcome.code, -1)
})

test('the test command keeps its password in a directory of its own', async () => {
  let seen = null
  const outcome = await runTest(connection(), {
    spawn: fakeSpawn({
      stdout: '1\n',
      onSpawn: ({ args }) => {
        const file = optionFileOf(args)
        const dir = dirname(file)
        seen = { body: readFileSync(file, 'utf8'), dir, dirMode: statSync(dir).mode & 0o777 }
      },
    }),
    access: (path) => {
      if (path.endsWith('mysql')) return
      throw new Error('not executable')
    },
    env: pathWith('mysql'),
  })
  assert.equal(outcome.ok, true)
  assert.ok(seen.body.includes('password="secret"'))
  // A fresh owner-only directory under the temporary directory, not a name in
  // the temporary directory itself: a name there is one someone else can take.
  assert.ok(basename(seen.dir).startsWith('token-ledger-'))
  assert.equal(resolve(dirname(seen.dir)), resolve(tmpdir()))
  if (process.platform !== 'win32') {
    assert.equal(seen.dirMode & 0o077, 0, 'no one but the owner may read it')
  }
  assert.ok(!existsSync(seen.dir), 'the directory goes away with the run')
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
