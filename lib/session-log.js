/**
 * Offline reader for DSH session logs.
 *
 * A DSH session log is a concatenation of independent Zstandard frames, each
 * frame holding a chunk of newline-delimited JSON. Node's zstd entry points
 * stop after the first frame, so the frames must be delimited explicitly
 * before decompression.
 *
 * This module walks the frame structure described by RFC 8878 (magic number,
 * frame header, block headers, optional content checksum) instead of scanning
 * for the magic byte sequence, because a magic scan can match bytes inside
 * compressed block payloads and silently split a frame in half.
 *
 * The walk is strict about structure and tolerant about the tail: a file whose
 * last frame was never finished is still read up to that frame, because an
 * unfinished last frame is exactly what a killed writer leaves behind.
 *
 * Every function here is synchronous, dependency-free, and read-only.
 *
 * @module dsh-token-ledger/session-log
 */

import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

/** Zstandard frame magic number, stored little-endian: 0xFD2FB528. */
const ZSTD_MAGIC = 0xfd2fb528

/** A Zstandard frame can be at most 128 KiB of header plus blocks; this bounds a walk. */
const MAX_DICTIONARY_ID_BYTES = [0, 1, 2, 4]

/**
 * Read the length of the frame starting at `start`.
 *
 * @param {Buffer} buffer - the whole file.
 * @param {number} start - offset of the frame's magic number.
 * @returns {number} the frame length in bytes.
 * @throws {Error} when the frame is truncated or structurally invalid.
 */
export function frameLengthAt(buffer, start) {
  if (start + 4 > buffer.length) throw new Error(`truncated frame magic at offset ${start}`)
  if (buffer.readUInt32LE(start) !== ZSTD_MAGIC) {
    throw new Error(`no zstd magic at offset ${start}`)
  }

  let cursor = start + 4
  if (cursor + 1 > buffer.length) throw new Error(`truncated frame header at offset ${start}`)
  const descriptor = buffer.readUInt8(cursor)
  cursor += 1

  const contentSizeFlag = (descriptor >> 6) & 0x3
  const singleSegment = (descriptor >> 5) & 0x1
  const checksumFlag = (descriptor >> 2) & 0x1
  const dictionaryIdFlag = descriptor & 0x3

  // Window_Descriptor is present only when Single_Segment_flag is clear.
  if (singleSegment === 0) cursor += 1
  cursor += MAX_DICTIONARY_ID_BYTES[dictionaryIdFlag]

  // 0 bytes when the flag is 0 and a single segment is declared is not allowed;
  // the spec maps flag 0 to 1 byte in that case.
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment === 1 ? 1 : 0) : 1 << contentSizeFlag
  cursor += contentSizeBytes

  if (cursor > buffer.length) throw new Error(`truncated frame header at offset ${start}`)

  // Walk the block sequence to find where this frame ends.
  for (;;) {
    if (cursor + 3 > buffer.length) throw new Error(`truncated block header at offset ${cursor}`)
    const header = buffer.readUInt8(cursor) | (buffer.readUInt8(cursor + 1) << 8) | (buffer.readUInt8(cursor + 2) << 16)
    const lastBlock = (header & 0x1) === 1
    const blockType = (header >> 1) & 0x3
    const blockSize = header >> 3
    cursor += 3
    if (blockType === 3) throw new Error(`reserved block type at offset ${cursor - 3}`)
    cursor += blockType === 1 ? 1 : blockSize
    if (cursor > buffer.length) throw new Error(`truncated block payload at offset ${start}`)
    if (lastBlock) break
  }

  if (checksumFlag === 1) cursor += 4
  if (cursor > buffer.length) throw new Error(`truncated content checksum at offset ${start}`)
  return cursor - start
}

/**
 * Walk the frame sequence, reporting where an unfinished final frame starts.
 *
 * A frame that runs off the end of the buffer is the normal debris of a writer
 * that was killed mid-append, and the frames completed before it are still the
 * session's durable record. A structural fault — a wrong magic number, a
 * reserved block type — is still an error, because that means the bytes are not
 * this log at all rather than that the log is unfinished.
 *
 * @param {Buffer} buffer - a DSH session log's raw bytes.
 * @returns {{ frames: { offset: number, length: number }[], tornStart: number|undefined, tornError: Error|undefined }} the complete frames, and when the last one is unfinished where it starts and why the walk stopped.
 */
function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    let length
    try {
      length = frameLengthAt(buffer, offset)
    } catch (error) {
      const truncated = error instanceof Error && error.message.startsWith('truncated ')
      if (!truncated) throw error
      return { frames, tornStart: offset, tornError: error }
    }
    frames.push({ offset, length })
    offset += length
  }
  return { frames, tornStart: undefined, tornError: undefined }
}

/**
 * Delimit every Zstandard frame in a buffer.
 *
 * This view is strict: a caller that asked for the frame list asked for the
 * whole file, so an unfinished final frame is reported as an error here.
 * {@link decodeSessionLogBuffer} is the tolerant reader built on the same walk.
 *
 * @param {Buffer} buffer - a DSH session log's raw bytes.
 * @returns {{ offset: number, length: number }[]} frames in file order.
 * @throws {Error} when the buffer does not end on a frame boundary, or a frame is structurally invalid.
 */
export function splitZstdFrames(buffer) {
  const { frames, tornStart, tornError } = scanFrames(buffer)
  if (tornStart !== undefined) throw tornError
  return frames
}

/**
 * Decode a buffer, and say how many of its bytes the decode actually consumed.
 *
 * The size is a **frame boundary**: the end of the last frame that was decoded.
 * An unfinished final frame is left unconsumed — Zstandard yields no rows for a
 * frame that was not written whole, so there is nothing in it to count, and the
 * next read should see the frame whole rather than a half-guessed version of it.
 * Should a Zstandard able to decode such a frame appear, its rows are counted and
 * its bytes are consumed instead, because starting the next read at its magic
 * number would count them a second time. That distinction is what a caller
 * records as "where this read stopped".
 *
 * @param {Buffer} buffer - a DSH session log's raw bytes.
 * @returns {{ records: object[], size: number }} every parseable record, and the byte count they came from.
 */
function decodeBuffer(buffer) {
  const { frames, tornStart } = scanFrames(buffer)
  const parts = frames.map((frame) => zstdDecompressSync(buffer.subarray(frame.offset, frame.offset + frame.length)))
  let size = tornStart ?? buffer.length
  if (tornStart !== undefined) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(tornStart)))
      size = buffer.length
    } catch {
      // Nothing decodable in the unfinished frame; the complete prefix stands, and
      // the frame is read whole next time rather than being decoded twice.
    }
  }
  return { records: parseJsonLines(Buffer.concat(parts).toString('utf8')), size }
}

/**
 * Decode a buffer of concatenated Zstandard frames into its raw text and then
 * into JSON events.
 *
 * A log whose writer was killed mid-frame still holds every event committed
 * before that frame, so the complete frames are decoded and the unfinished tail
 * is kept only when Zstandard can still decode it. Either way the log is read,
 * and a torn trailing line — the one a killed writer leaves — is dropped by
 * {@link parseJsonLines}, exactly as a torn line inside a whole frame is.
 *
 * @param {Buffer} buffer - a DSH session log's raw bytes.
 * @returns {object[]} every parseable JSON record, in order. Unparseable lines
 *   are skipped rather than failing the whole log.
 */
export function decodeSessionLogBuffer(buffer) {
  return decodeBuffer(buffer).records
}

/**
 * Split newline-delimited JSON into records, skipping lines that do not parse.
 *
 * @param {string} text - the decompressed log text.
 * @returns {object[]} the parsed records.
 */
export function parseJsonLines(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A torn trailing line is normal for a log whose writer was killed.
    }
  }
  return events
}

/**
 * Read and decode one DSH session log file.
 *
 * @param {string} path - path to a `session.jsonl.zstd` file.
 * @returns {object[]} every JSON event in the log, in order.
 */
export function readSessionLog(path) {
  return readSessionLogState(path).records
}

/**
 * Read a log and say how many bytes that read covered.
 *
 * The size is what a later {@link readSessionLogTail} continues from, and it is
 * the end of the last frame that was decoded rather than a `stat` taken before the
 * read: a row that landed between the `stat` and the read has been decoded, and
 * starting the next read behind it would decode it twice — while starting it
 * inside an unfinished frame would make every later read refuse the offset and
 * decode the whole file again.
 *
 * @param {string} path - path to a `session.jsonl.zstd` file.
 * @returns {{ records: object[], size: number }} the events, and the byte count they came from.
 */
export function readSessionLogState(path) {
  return decodeBuffer(readFileSync(path))
}

/**
 * Split text into the lines that are complete, keeping the unfinished remainder.
 *
 * A frame carries whole rows for the writer this plugin reads, but nothing in the
 * format promises that, and a row split across two frames would be lost if the
 * halves were parsed separately — the first half does not parse and the second
 * one does not either. So the remainder is handed to the next read.
 *
 * @param {string} text - decompressed log text.
 * @returns {{ records: object[], rest: string }} the complete records, and the tail.
 */
function splitCompleteLines(text) {
  const lastBreak = text.lastIndexOf('\n')
  if (lastBreak < 0) return { records: [], rest: text }
  return { records: parseJsonLines(text.slice(0, lastBreak + 1)), rest: text.slice(lastBreak + 1) }
}

/**
 * Read only what a log has gained since a previous read.
 *
 * A running session appends to its log as each event commits, and re-decoding the
 * whole file every couple of seconds costs real time on the host's thread — a
 * 2.3 MB log measured at 130 ms, which is a stall the model loop would feel. This
 * reader starts at the first byte not yet decoded, so the work is proportional to
 * what was appended.
 *
 * Three things make that safe rather than merely quick:
 *
 * - the previous read **reports where it stopped** — the end of the last frame it
 *   decoded, and not a guess — and only that boundary is taken on trust. A log
 *   that ended on an unfinished frame it could still read reports its whole length,
 *   because those rows were counted and decoding them again would count them twice.
 * - the unfinished line of the previous read travels with it, because a row split
 *   across frames must be parsed as one line rather than as two broken halves.
 * - bytes that are not a frame boundary are **refused**, not guessed at: a log
 *   that was rewritten, or one whose incompletely written frame was completed after
 *   this plugin had already taken its readable part for whole, answers `undefined`
 *   and the caller folds the file from the start instead — the one read that cannot
 *   double count, whatever the file became.
 *
 * @param {string} path - a `session.jsonl.zstd` path.
 * @param {{ offset?: number, tail?: string }} [from] - where the previous read stopped, and the line it left unfinished.
 * @returns {{ records: object[], offset: number, tail: string, size: number }|undefined} the new records, the boundary the next read starts at, the unfinished line, and the file size. `undefined` when the bytes at `offset` are not a frame boundary.
 */
export function readSessionLogTail(path, { offset = 0, tail = '' } = {}) {
  const fd = openSync(path, 'r')
  let available
  try {
    const size = fstatSync(fd).size
    // A file that shrank was replaced rather than appended to, and an offset past
    // its end says nothing about where a row starts.
    if (offset > size) return undefined
    const buffer = Buffer.alloc(size - offset)
    // A short read means the file shrank while it was being read, which is the
    // rewritten case again: the bytes are judged below, and the size reported is
    // the one that was actually read.
    const read = buffer.length === 0 ? 0 : readSync(fd, buffer, 0, buffer.length, offset)
    available = buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }

  let frames
  let tornStart
  try {
    ;({ frames, tornStart } = scanFrames(available))
  } catch {
    // Structurally invalid bytes here mean this is not the boundary we thought it
    // was, not that the log is unreadable: the caller can always start over.
    return undefined
  }
  const parts = frames.map((frame) => zstdDecompressSync(available.subarray(frame.offset, frame.offset + frame.length)))
  const { records, rest } = splitCompleteLines(tail + Buffer.concat(parts).toString('utf8'))
  // A frame that was never finished is left for the next read rather than decoded
  // from its beginning: it may become a whole row, and half of one is not a row.
  const consumed = tornStart === undefined ? available.length : tornStart
  return { records, offset: offset + consumed, tail: rest, size: offset + available.length }
}
