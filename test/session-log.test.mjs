/**
 * Session log decoding tests.
 *
 * The frame walker is the one piece of this package that parses a binary
 * format, so it gets structural tests: exact round trips, several frames per
 * file, and a killed writer's torn final frame — which the frame walker refuses
 * while the reader keeps the committed prefix before it.
 *
 * @module dsh-token-ledger/test/session-log.test
 */

import assert from 'node:assert/strict'
import { mkdtempSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { test } from 'node:test'

import { decodeSessionLogBuffer, frameLengthAt, parseJsonLines, readSessionLogState, readSessionLogTail, splitZstdFrames } from '../lib/session-log.js'
import { ALPHA_EVENTS, encodeSessionLog, withSeq } from './fixtures.mjs'

/**
 * Write a log to a temporary file and hand back its path.
 *
 * @param {Buffer} buffer - the encoded log.
 * @returns {{ path: string, cleanup: () => void }} the file, and how to remove it.
 */
function temporaryLog(buffer) {
  const directory = mkdtempSync(join(tmpdir(), 'token-ledger-tail-'))
  const path = join(directory, 'session.jsonl.zstd')
  writeFileSync(path, buffer)
  return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

test('splits concatenated frames and covers every byte', () => {
  const events = withSeq(ALPHA_EVENTS)
  for (const eventsPerFrame of [1, 2, 3, 7, events.length]) {
    const buffer = encodeSessionLog(events, { eventsPerFrame })
    const frames = splitZstdFrames(buffer)
    assert.equal(frames.length, Math.ceil(events.length / eventsPerFrame), `eventsPerFrame=${eventsPerFrame}`)
    const covered = frames.reduce((sum, frame) => sum + frame.length, 0)
    assert.equal(covered, buffer.length)
    assert.deepEqual(decodeSessionLogBuffer(buffer), events)
  }
})

test('reads a single frame carrying many lines', () => {
  const events = withSeq(ALPHA_EVENTS)
  const buffer = encodeSessionLog(events, { eventsPerFrame: events.length })
  assert.equal(splitZstdFrames(buffer).length, 1)
  assert.equal(decodeSessionLogBuffer(buffer).length, events.length)
})

test('frameLengthAt reports the exact length of the frame at an offset', () => {
  const events = withSeq(ALPHA_EVENTS)
  const first = encodeSessionLog(events.slice(0, 2), { eventsPerFrame: 2 })
  const rest = encodeSessionLog(events.slice(2), { eventsPerFrame: 2 })
  const buffer = Buffer.concat([first, rest])

  const frames = splitZstdFrames(buffer)
  // Two events in the first frame, the remaining sixteen in frames of two.
  assert.equal(frames.length, 1 + Math.ceil((events.length - 2) / 2))
  assert.equal(frames[0].length, first.length)
  // Walking to any frame's offset must report that frame's length exactly.
  for (const frame of frames) {
    assert.equal(frameLengthAt(buffer, frame.offset), frame.length, `offset ${frame.offset}`)
  }
  assert.equal(frames.reduce((sum, frame) => sum + frame.length, 0), buffer.length)
})

test('rejects a buffer that does not start with a frame', () => {
  assert.throws(() => frameLengthAt(Buffer.from('not zstd at all'), 0), /no zstd magic/)
  assert.throws(() => splitZstdFrames(Buffer.from([1, 2, 3, 4, 5])), /no zstd magic/)
})

/**
 * A killed writer leaves a file whose last frame was never finished. The file
 * walker stays strict about its own contract, but the reader keeps the frames
 * that were completed: those events are committed and counted, and dropping the
 * whole session over the tail is the loss this tolerance exists to prevent.
 */
test('a torn final frame is dropped and the frames before it still decode', () => {
  const events = withSeq(ALPHA_EVENTS)
  const buffer = encodeSessionLog(events, { eventsPerFrame: 2 })
  const frames = splitZstdFrames(buffer)
  const last = frames[frames.length - 1]
  const torn = buffer.subarray(0, buffer.length - 5)

  // `frameLengthAt` and `splitZstdFrames` keep their strict semantics: a caller
  // that asked for the frames is told the file does not end on a boundary.
  assert.throws(() => frameLengthAt(torn, last.offset), /truncated/)
  assert.throws(() => splitZstdFrames(torn), /truncated/)

  // The reader keeps the complete prefix: only the torn frame's two events are
  // missing, rather than the whole log failing.
  assert.deepEqual(decodeSessionLogBuffer(torn), events.slice(0, events.length - 2))

  // A buffer that holds no complete frame decodes to nothing — the writer never
  // finished anything — instead of failing the session.
  assert.deepEqual(decodeSessionLogBuffer(buffer.subarray(0, 4)), [])
})

test('structurally invalid bytes are still refused, not read as a short log', () => {
  assert.throws(() => decodeSessionLogBuffer(Buffer.from('not zstd at all')), /no zstd magic/)
  // Garbage after complete frames is not a torn tail: a torn tail is unfinished,
  // and a frame that never starts is a different file.
  const good = encodeSessionLog(withSeq(ALPHA_EVENTS.slice(0, 2)), { eventsPerFrame: 2 })
  assert.throws(() => decodeSessionLogBuffer(Buffer.concat([good, Buffer.from([1, 2, 3, 4, 5])])), /no zstd magic/)
})

test('parseJsonLines skips the torn trailing line a killed writer leaves', () => {
  const text = '{"a":1}\n{"b":2}\n{"c":'
  assert.deepEqual(parseJsonLines(text), [{ a: 1 }, { b: 2 }])
  assert.deepEqual(parseJsonLines(''), [])
  assert.deepEqual(parseJsonLines('\n\n'), [])
})

test('an empty log decodes to no events', () => {
  const empty = zstdCompressSync(Buffer.from(''))
  assert.deepEqual(decodeSessionLogBuffer(empty), [])
})

test('what a whole read consumed is where the next read starts', () => {
  // A whole read reports the bytes it consumed, which is what a tail read continues
  // from. A log that ends on an unfinished frame is the awkward case: Zstandard
  // cannot decode a frame that was not written whole — it yields no rows at all
  // rather than the part that was written — so the frame is left for the next read
  // and the boundary reported is the one in front of it. Nothing of that frame was
  // counted, so when the writer finishes it the tail read takes it whole, and none
  // of its rows are handed over twice.
  const events = withSeq(ALPHA_EVENTS)
  const buffer = encodeSessionLog(events, { eventsPerFrame: 2 })
  const frames = splitZstdFrames(buffer)
  const last = frames[frames.length - 1]
  const file = temporaryLog(buffer)
  try {
    const whole = readSessionLogState(file.path)
    assert.equal(whole.size, buffer.length)
    assert.deepEqual(whole.records, events)

    // Killed mid-write: the completed frames, and the unfinished one left alone.
    writeFileSync(file.path, buffer.subarray(0, buffer.length - 5))
    const torn = readSessionLogState(file.path)
    assert.equal(torn.size, last.offset, 'the unfinished frame is left whole')
    assert.deepEqual(torn.records, events.slice(0, events.length - 2))

    // Completing the frame lets the next read take it whole, from the boundary the
    // previous read reported.
    writeFileSync(file.path, buffer)
    const completed = readSessionLogTail(file.path, { offset: torn.size, tail: '' })
    assert.deepEqual(completed.records, events.slice(-2))
    assert.equal(completed.offset, buffer.length)

    // A boundary that is not one is refused rather than guessed at: the bytes
    // inside a frame cannot start a read.
    assert.equal(readSessionLogTail(file.path, { offset: buffer.length - 5, tail: '' }), undefined)
  } finally {
    file.cleanup()
  }
})

test('a tail read returns only the frames after its offset', () => {
  // The point of the tail reader: a running session's log is re-read every couple
  // of seconds, and decoding a 2.3 MB file was measured at 130 ms. What it may not
  // do is count a row twice or miss one, so the offset is a frame boundary the
  // previous read reported.
  const events = withSeq(ALPHA_EVENTS)
  const head = encodeSessionLog(events.slice(0, 6), { eventsPerFrame: 2 })
  const rest = encodeSessionLog(events.slice(6), { eventsPerFrame: 2 })
  const file = temporaryLog(Buffer.concat([head, rest]))
  try {
    const first = readSessionLogTail(file.path, { offset: 0, tail: '' })
    assert.deepEqual(first.records, events)
    assert.equal(first.offset, head.length + rest.length)
    assert.equal(first.size, head.length + rest.length)
    assert.equal(first.tail, '')

    // Appending a frame: the next read starts where the last one stopped.
    const more = encodeSessionLog([...events.slice(-1), { type: 'step/end', seq: 99, time: 0, data: { turn: 9, step: 1 } }], {
      eventsPerFrame: 2,
    })
    writeFileSync(file.path, Buffer.concat([head, rest, more]))
    const next = readSessionLogTail(file.path, { offset: first.offset, tail: first.tail })
    assert.equal(next.records.length, 2)
    assert.equal(next.offset, head.length + rest.length + more.length)
    // And a read with nothing new costs an empty answer, not a re-decode.
    const idle = readSessionLogTail(file.path, { offset: next.offset, tail: next.tail })
    assert.deepEqual(idle.records, [])
    assert.equal(idle.offset, next.offset)
  } finally {
    file.cleanup()
  }
})

test('a torn frame is left for the next read rather than half-read', () => {
  const events = withSeq(ALPHA_EVENTS)
  const head = encodeSessionLog(events.slice(0, 4), { eventsPerFrame: 2 })
  const rest = encodeSessionLog(events.slice(4), { eventsPerFrame: 2 })
  const file = temporaryLog(Buffer.concat([head, rest]))
  try {
    const first = readSessionLogTail(file.path, { offset: 0, tail: '' })
    assert.deepEqual(first.records, events)

    // The writer started another frame and has not finished it. Its bytes are not
    // consumed, so the next read starts at its magic number and sees it whole.
    const tailFrame = zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'step/end', seq: 99 })}\n`))
    writeFileSync(file.path, Buffer.concat([head, rest, tailFrame.subarray(0, tailFrame.length - 5)]))
    const torn = readSessionLogTail(file.path, { offset: first.offset, tail: first.tail })
    assert.deepEqual(torn.records, [])
    assert.equal(torn.offset, first.offset, 'the unfinished frame stays unread')

    writeFileSync(file.path, Buffer.concat([head, rest, tailFrame]))
    const completed = readSessionLogTail(file.path, { offset: torn.offset, tail: torn.tail })
    assert.equal(completed.records.length, 1)
    assert.equal(completed.offset, head.length + rest.length + tailFrame.length)
  } finally {
    file.cleanup()
  }
})

test('a line split across two frames is parsed as one line', () => {
  // Nothing in the format promises a frame ends on a line boundary, and two halves
  // of one row parse as neither. The unfinished line travels with the read.
  const first = zstdCompressSync(Buffer.from('{"type":"a"}\n{"type":"b'))
  const second = zstdCompressSync(Buffer.from('"}\n{"type":"c"}\n'))
  const file = temporaryLog(Buffer.concat([first, second]))
  try {
    const read = readSessionLogTail(file.path, { offset: 0, tail: '' })
    // The row split between the two frames is one row, not a broken row and a
    // fragment of another.
    assert.deepEqual(read.records, [{ type: 'a' }, { type: 'b' }, { type: 'c' }])
    assert.equal(read.tail, '', 'the last line is complete, so nothing is carried')

    const onlyHead = temporaryLog(first)
    try {
      const partial = readSessionLogTail(onlyHead.path, { offset: 0, tail: '' })
      assert.deepEqual(partial.records, [{ type: 'a' }])
      assert.equal(partial.tail, '{"type":"b')
    } finally {
      onlyHead.cleanup()
    }
  } finally {
    file.cleanup()
  }
})

test('bytes that are not a frame boundary are refused, not guessed at', () => {
  const events = withSeq(ALPHA_EVENTS)
  const buffer = encodeSessionLog(events, { eventsPerFrame: 2 })
  const frames = splitZstdFrames(buffer)
  const file = temporaryLog(buffer)
  try {
    // An offset inside a frame is what a rewritten or relocated log looks like.
    assert.equal(readSessionLogTail(file.path, { offset: frames[0].offset + 3, tail: '' }), undefined)
    // An offset past the end says the file was replaced by a shorter one.
    assert.equal(readSessionLogTail(file.path, { offset: buffer.length + 10, tail: '' }), undefined)
    // A structural fault at the boundary is the same answer, because the caller can
    // always fold the file from the start: a truncated frame is the one case that is
    // not refused, and it is handled above.
    const replaced = temporaryLog(Buffer.from('this is not a log at all'))
    try {
      assert.equal(readSessionLogTail(replaced.path, { offset: 0, tail: '' }), undefined)
    } finally {
      replaced.cleanup()
    }
  } finally {
    file.cleanup()
  }
})

test('a log replaced by a shorter one is refused rather than read from a stale offset', () => {
  const events = withSeq(ALPHA_EVENTS)
  const file = temporaryLog(encodeSessionLog(events, { eventsPerFrame: 2 }))
  try {
    const first = readSessionLogTail(file.path, { offset: 0, tail: '' })
    // A generation migration rewrites the file; a read that begins at the old end
    // would start in the middle of the new file's bytes.
    const shorter = encodeSessionLog(events.slice(0, 2), { eventsPerFrame: 2 })
    const other = join(tmpdir(), 'token-ledger-rewritten.jsonl.zstd')
    writeFileSync(other, shorter)
    renameSync(other, file.path)
    assert.equal(readSessionLogTail(file.path, { offset: first.offset, tail: first.tail }), undefined)
  } finally {
    file.cleanup()
  }
})
