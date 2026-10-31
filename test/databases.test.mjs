/**
 * The database connection store.
 *
 * The store holds passwords, so what is tested here is that it keeps them out
 * of the page, writes the file owner-only, and refuses a connection that could
 * not be dumped.
 *
 * @module dsh-token-ledger/test/databases
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  DB_TYPES,
  DEFAULT_PORTS,
  createDatabaseStore,
  databasePaths,
  readConnections,
  redactConnection,
  redactConnections,
  slugify,
  validateConnection,
  writeConnections,
} from '../lib/databases.js'

/**
 * A directory that goes away with the process.
 *
 * @returns {string} the directory.
 */
function scratch() {
  return mkdtempSync(join(tmpdir(), 'token-ledger-db-'))
}

/**
 * A connection that passes.
 *
 * @param {object} [overrides] - what to change.
 * @returns {object} the connection.
 */
function connection(overrides = {}) {
  return {
    type: 'mysql',
    name: 'Gitea',
    host: '127.0.0.1',
    database: 'gitea',
    user: 'gitea',
    password: 'secret',
    ...overrides,
  }
}

test('the three engines are the ones this plugin can dump', () => {
  assert.deepEqual(DB_TYPES, ['mysql', 'mariadb', 'postgres'])
  assert.equal(DEFAULT_PORTS.mysql, 3306)
  assert.equal(DEFAULT_PORTS.mariadb, 3306)
  assert.equal(DEFAULT_PORTS.postgres, 5432)
})

test('a connection is checked as a whole, not in parts', () => {
  assert.equal(validateConnection(connection()).ok, true)
  assert.equal(validateConnection(connection({ type: 'sqlite' })).ok, false)
  assert.equal(validateConnection(connection({ name: '' })).ok, false)
  assert.equal(validateConnection(connection({ host: '' })).ok, false)
  assert.equal(validateConnection(connection({ database: '' })).ok, false)
  assert.equal(validateConnection(connection({ user: '' })).ok, false)
  assert.equal(validateConnection(connection({ port: 0 })).ok, false)
  assert.equal(validateConnection(connection({ port: 70000 })).ok, false)
  assert.equal(validateConnection(connection({ port: 'abc' })).ok, false)
  // A name with a newline in it is not a name, and a host with one is not a
  // host: both end up somewhere a file name or a command line reads.
  assert.equal(validateConnection(connection({ host: 'a\nb' })).ok, false)
  assert.equal(validateConnection(connection({ database: 'a\nb' })).ok, false)
  assert.equal(validateConnection(connection({ user: 'a\nb' })).ok, false)
})

test('the port defaults to the one the engine listens on', () => {
  assert.equal(validateConnection(connection()).connection.port, 3306)
  assert.equal(validateConnection(connection({ type: 'postgres' })).connection.port, 5432)
  assert.equal(validateConnection(connection({ port: '' })).connection.port, 3306)
})

test('the identifier comes from the name and never from a path', () => {
  assert.equal(slugify('Gitea'), 'gitea')
  assert.equal(slugify('Gitea (prod)'), 'gitea-prod')
  assert.equal(slugify('../../etc/passwd'), 'etc-passwd')
  assert.equal(slugify(''), 'db')
  const result = validateConnection(connection({ name: '../escape' }))
  assert.equal(result.ok, true)
  assert.equal(result.connection.id, 'escape')
  assert.ok(!result.connection.id.includes('/'))
})

test('two connections with the same name do not collide', () => {
  const first = validateConnection(connection())
  assert.equal(first.connection.id, 'gitea')
  const second = validateConnection(connection(), { existing: [first.connection] })
  assert.equal(second.connection.id, 'gitea-2')
  const third = validateConnection(connection(), { existing: [first.connection, second.connection] })
  assert.equal(third.connection.id, 'gitea-3')
})

test('the page never sees a password', () => {
  const redacted = redactConnection(connection({ id: 'gitea', password: 'secret' }))
  assert.equal(redacted.password, undefined)
  assert.equal(redacted.hasPassword, true)
  assert.equal(redacted.user, 'gitea')
  const empty = redactConnection({ id: 'x', password: '' })
  assert.equal(empty.hasPassword, false)
  assert.deepEqual(redactConnections([{ id: 'a', password: 'p' }]), [{ id: 'a', hasPassword: true }])
})

test(
  'the file of connections is written owner-only',
  // Windows has no POSIX permissions: the mode it reports is synthesised, so
  // there is nothing there to assert on.
  { skip: process.platform === 'win32' ? 'Windows does not carry POSIX permissions' : false },
  () => {
    const dir = scratch()
    const path = join(dir, 'databases.json')
    writeConnections(path, [connection({ id: 'gitea' })])
    const info = statSync(path)
    // The mode says who may read it: a password that another account on the
    // machine can read is a password that is not a secret.
    assert.equal(info.mode & 0o077, 0, 'no one but the owner may read it')
    assert.equal(readConnections(path).length, 1)
  },
)

test('a file of connections that cannot be read is empty rather than an error', () => {
  const dir = scratch()
  assert.deepEqual(readConnections(join(dir, 'missing.json')), [])
  const broken = join(dir, 'broken.json')
  writeFileSync(broken, 'not json at all')
  assert.deepEqual(readConnections(broken), [])
  const shapeless = join(dir, 'shapeless.json')
  writeFileSync(shapeless, '{"connections": "not a list"}')
  assert.deepEqual(readConnections(shapeless), [])
})

test('the store keeps the password out of what it hands back', () => {
  const dir = scratch()
  const store = createDatabaseStore({ path: join(dir, 'databases.json'), dir: join(dir, 'backups') })
  const saved = store.save(connection())
  assert.equal(saved.ok, true)
  assert.equal(saved.connection.password, undefined)
  assert.equal(store.read().connections[0].password, undefined)
  assert.equal(store.read().connections[0].hasPassword, true)
  // The host still has it: the dump needs it.
  assert.equal(store.secret('gitea').password, 'secret')
})

test('changing a connection without a password keeps the one it had', () => {
  const dir = scratch()
  const store = createDatabaseStore({ path: join(dir, 'databases.json'), dir: join(dir, 'backups') })
  store.save(connection())
  // The page redacts the password, so it cannot send it back unless it is
  // being changed.
  const again = store.save({ ...connection(), id: 'gitea', name: 'Gitea renamed', password: '' })
  assert.equal(again.ok, true)
  assert.equal(store.secret('gitea').password, 'secret')
  assert.equal(store.secret('gitea').name, 'Gitea renamed')
  // A password that is being changed is taken.
  const changed = store.save({ ...connection(), id: 'gitea', password: 'other' })
  assert.equal(changed.ok, true)
  assert.equal(store.secret('gitea').password, 'other')
})

test('a connection that is removed is gone', () => {
  const dir = scratch()
  const store = createDatabaseStore({ path: join(dir, 'databases.json'), dir: join(dir, 'backups') })
  store.save(connection())
  assert.equal(store.remove('gitea').ok, true)
  assert.equal(store.read().connections.length, 0)
  assert.equal(store.remove('gitea').ok, false)
})

test('a dump is served by name, and only a name this page wrote', () => {
  const dir = scratch()
  const store = createDatabaseStore({ path: join(dir, 'databases.json'), dir: join(dir, 'backups') })
  assert.equal(store.readBackup('../databases.json').ok, false)
  assert.equal(store.readBackup('anything.sql').ok, false)
  assert.equal(store.readBackup('/etc/passwd').ok, false)
  assert.equal(store.readBackup('gitea-2026.sql').ok, false, 'the file is not there')
})

test('the store lives beside the ledger', () => {
  const paths = databasePaths('/home/someone/.dsh/token-ledger')
  assert.equal(paths.path, join('/home/someone/.dsh/token-ledger', 'databases.json'))
  assert.equal(paths.dir, join('/home/someone/.dsh/token-ledger', 'backups'))
})
