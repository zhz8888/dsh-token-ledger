/**
 * Locale tests.
 *
 * The translations are data in `locale/*.json`, and this is where they are
 * checked: that they are read, that a missing file degrades instead of
 * throwing, and — the reason they are files rather than a dictionary written
 * inside the browser half — that the two languages carry the same keys.
 *
 * @module dsh-token-ledger/test/locale
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { LOCALES, dictionaryGaps, readDictionaries } from '../lib/locale.js'

/**
 * Read one of the shipped dictionaries from disk.
 *
 * @param {string} name - the language id.
 * @returns {object} the entries.
 */
const shipped = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`../locale/${name}.json`, import.meta.url)), 'utf8'))

test('the shipped dictionaries are read from the files beside the package', () => {
  const dictionaries = readDictionaries()
  assert.deepEqual(Object.keys(dictionaries).sort(), [...LOCALES].sort())
  for (const locale of LOCALES) {
    assert.ok(Object.keys(dictionaries[locale]).length > 0, `${locale} carries no entries`)
    assert.equal(dictionaries[locale].nav, shipped(locale).nav, `${locale} is the file, read as it is`)
  }
})

test('the two languages carry the same keys', () => {
  // A key that exists in one language and not in the other is a gap: the
  // reader gets a word in one language and the key itself in the other.
  const dictionaries = readDictionaries()
  const gaps = dictionaryGaps(dictionaries.zh, dictionaries.en)
  assert.deepEqual(gaps.onlyInLeft, [], 'zh has no key en lacks')
  assert.deepEqual(gaps.onlyInRight, [], 'en has no key zh lacks')
  assert.ok(Object.keys(dictionaries.zh).length > 100, 'the dictionaries are the page, not a sample')
})

test('a dictionary that cannot be read is empty rather than an error', () => {
  // The texts are cosmetic: without them the page still works and its labels
  // fall back to the keys. A plugin must not refuse to mount over a word.
  const missing = readDictionaries({ dir: '/nonexistent/locale' })
  assert.deepEqual(missing.zh, {})
  assert.deepEqual(missing.en, {})

  const broken = readDictionaries({
    dir: '/nonexistent/locale',
    readFile: () => 'not json at all',
  })
  assert.deepEqual(broken.zh, {})
})

test('only strings are entries', () => {
  // A number or a nested object in a dictionary is a mistake in the file, and
  // rendering one as text would be a lie.
  const dictionaries = readDictionaries({
    dir: '/nonexistent/locale',
    readFile: (path) => {
      if (path.includes('zh')) return JSON.stringify({ good: 'text', bad: 42, worse: { nested: 'x' } })
      return '{}'
    },
  })
  assert.deepEqual(dictionaries.zh, { good: 'text' })
})

test('the gaps are reported in both directions', () => {
  const gaps = dictionaryGaps({ a: '1', b: '2' }, { b: '2', c: '3' })
  assert.deepEqual(gaps.onlyInLeft, ['a'])
  assert.deepEqual(gaps.onlyInRight, ['c'])
})
