#!/usr/bin/env node
/**
 * Extract one file out of an Electron `.asar` archive to a local path.
 *
 * The file contents begin at `8 + headerSize`, where `headerSize` is the u32 at
 * offset 4: the header pickle starts at offset 8 and its size prefix already
 * counts the pickle's own 4 bytes, so the contents sit one pickle-header further
 * along than a `16 + headerSize` reading suggests.
 *
 * An entry with `unpacked: true` has no offset in the header: Electron keeps its
 * bytes in `<archive>.unpacked/<entry>` beside the archive, which is where this
 * copies them from.
 *
 * @param {string} archive - the `.asar` path.
 * @param {string} entry - the archive-relative path of the file.
 * @param {string} out - where to write it.
 * @returns {void}
 */
import { copyFileSync, mkdirSync, openSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const [archive, entry, out] = process.argv.slice(2)

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

let node = tree
for (const part of entry.split('/')) {
  node = node?.files?.[part]
  if (!node) throw new Error(`not found: ${entry}`)
}

mkdirSync(dirname(out), { recursive: true })

if (node.unpacked === true) {
  // No offset and no bytes in the archive itself: the side directory holds it.
  const side = `${archive}.unpacked/${entry}`
  closeSync(fd)
  copyFileSync(side, out)
  console.log(`wrote ${out} (${statSync(out).size} bytes, unpacked from ${side})`)
} else {
  const body = Buffer.alloc(Number(node.size))
  readSync(fd, body, 0, Number(node.size), base + Number(node.offset))
  closeSync(fd)
  writeFileSync(out, body)
  console.log(`wrote ${out} (${node.size} bytes)`)
}
