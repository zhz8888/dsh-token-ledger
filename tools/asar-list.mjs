#!/usr/bin/env node
/**
 * List (or search) files inside an Electron `.asar` archive without unpacking it.
 *
 * The archive begins with a pickle holding one number, then the header pickle:
 * 4 bytes (the size pickle's payload size, always 4), 4 bytes (the header
 * pickle's size — the value read below as `headerSize`), then the header pickle
 * itself. That pickle starts with its own 4-byte payload size, carries the JSON
 * length at offset 12 and the JSON at offset 16, so the header pickle is the
 * block running from offset 8 to `8 + headerSize`. File contents therefore begin
 * at `8 + headerSize`, and every entry's `offset` is relative to that point —
 * not to the end of the JSON string, which is 8 bytes earlier.
 *
 * An entry with `unpacked: true` carries no offset: its bytes live beside the
 * archive in `<archive>.unpacked/<path>`, so it is marked instead of being given
 * an offset that would point into another file's bytes.
 *
 * @param {string} archive - the `.asar` path.
 * @param {string} [pattern] - a substring the path must contain.
 * @param {string} [showOffset] - `offset` to print the content offset and size.
 * @returns {void}
 */
import { openSync, readSync, closeSync } from 'node:fs'

const [archive, pattern = '', showOffset = ''] = process.argv.slice(2)

const fd = openSync(archive, 'r')
const prefix = Buffer.alloc(16)
readSync(fd, prefix, 0, 16, 0)
const headerSize = prefix.readUInt32LE(4)
const headerLength = prefix.readUInt32LE(12)
const header = Buffer.alloc(headerLength)
readSync(fd, header, 0, headerLength, 16)
const tree = JSON.parse(header.toString('utf8'))
// The header pickle starts at offset 8, so the contents start 8 + headerSize in;
// its size prefix (the u32 at offset 4) already counts the pickle's own 4 bytes.
const base = 8 + headerSize

/** @type {{ path: string, offset: number|null, size: number, unpacked: boolean }[]} */
const out = []
/**
 * Walk one directory node.
 *
 * @param {object} node - an asar header node.
 * @param {string} prefixPath - the path built so far.
 * @returns {void}
 */
function walk(node, prefixPath) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const path = prefixPath ? `${prefixPath}/${name}` : name
    if (child.files) walk(child, path)
    else
      out.push({
        path,
        // An unpacked entry has no offset; null keeps a fake one out of the output.
        offset: child.unpacked === true ? null : base + Number(child.offset ?? 0),
        size: Number(child.size ?? 0),
        unpacked: child.unpacked === true,
      })
  }
}
walk(tree, '')

for (const entry of out) {
  if (pattern && !entry.path.toLowerCase().includes(pattern.toLowerCase())) continue
  if (showOffset === 'offset') {
    console.log(`${entry.unpacked ? 'unpacked' : entry.offset}\t${entry.size}\t${entry.path}`)
  } else {
    console.log(entry.unpacked ? `${entry.path}\tunpacked` : entry.path)
  }
}
closeSync(fd)
