/**
 * The plugin's translations, read from the files that hold them.
 *
 * ## Why the texts are files
 *
 * A dictionary is data: two languages' worth of it is a few hundred strings, and
 * it changes for reasons that have nothing to do with code — a wording fix, a
 * new label, a translator's pass. Keeping it inside the browser half meant it
 * was edited as code, in a file three thousand lines long, and its key set
 * could only be compared with the other language's by parsing that file.
 *
 * So the texts live in `locale/zh.json` and `locale/en.json` beside the
 * package, and this module reads them. The host half serves them to the
 * browser half, which registers them with the locale service.
 *
 * ## What happens when a file is missing
 *
 * The dictionaries are cosmetic: without them the page still works and its
 * labels fall back to the keys themselves. A missing, unreadable or malformed
 * file therefore yields an empty dictionary for that language rather than an
 * error — the plugin must not refuse to mount over a word.
 *
 * @module dsh-token-ledger/locale
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The languages the plugin ships. */
export const LOCALES = ['zh', 'en']

/** Where the dictionaries live, relative to this module's package. */
export const LOCALE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'locale')

/**
 * Read one dictionary file.
 *
 * @param {string} locale - the language id.
 * @param {{ dir?: string, readFile?: (path: string) => string }} [options] - where to read from, and how.
 * @returns {Record<string, string>} the entries, empty when the file cannot be read.
 */
function readDictionary(locale, { dir, readFile }) {
  try {
    const parsed = JSON.parse(readFile(join(dir, `${locale}.json`)))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // Only strings are entries: a number or a nested object in a dictionary is
    // a mistake in the file, and rendering one as text would be a lie.
    const entries = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') entries[key] = value
    }
    return entries
  } catch {
    // A missing file, an unreadable one, or one that is not JSON: the language
    // is simply not there, and the page falls back to the keys.
    return {}
  }
}

/**
 * Read every dictionary the plugin ships.
 *
 * @param {{ dir?: string, readFile?: (path: string) => string }} [options] - where to read from, and how.
 * @returns {{ zh: Record<string, string>, en: Record<string, string> }} the dictionaries.
 */
export function readDictionaries({ dir = LOCALE_DIR, readFile = (path) => readFileSync(path, 'utf8') } = {}) {
  const dictionaries = {}
  for (const locale of LOCALES) dictionaries[locale] = readDictionary(locale, { dir, readFile })
  return dictionaries
}

/**
 * The keys two dictionaries do not share.
 *
 * A key that exists in one language and not in the other is a gap: the reader
 * gets the key itself in one language and a word in the other, which reads as
 * a mistake even when it is only a missing line in a file.
 *
 * @param {Record<string, string>} left - the first dictionary.
 * @param {Record<string, string>} right - the second dictionary.
 * @returns {{ onlyInLeft: string[], onlyInRight: string[] }} the gaps, in each direction.
 */
export function dictionaryGaps(left, right) {
  const leftKeys = new Set(Object.keys(left ?? {}))
  const rightKeys = new Set(Object.keys(right ?? {}))
  return {
    onlyInLeft: [...leftKeys].filter((key) => !rightKeys.has(key)).sort(),
    onlyInRight: [...rightKeys].filter((key) => !leftKeys.has(key)).sort(),
  }
}
