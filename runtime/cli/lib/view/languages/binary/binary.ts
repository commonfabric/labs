import { glyphFor } from "../../display.ts";
import type { RenderInputExtent } from "../language.ts";
import type { Line, TokenClass } from "../../model.ts";

const BYTES_PER_LINE = 16;
export const MAX_BINARY_VIEW_BYTES = 256 * 1024;

/** Describe a bounded preview after refreshing the source's byte count. */
export function binaryPreviewExtent(
  shownByteLength: number,
  totalBytesRead: number,
  reachedEof: boolean,
  reportedByteLength: number | undefined,
): RenderInputExtent {
  if (reachedEof) {
    return { byteLength: totalBytesRead, complete: true };
  }
  if (
    reportedByteLength !== undefined && reportedByteLength >= totalBytesRead
  ) {
    return { byteLength: reportedByteLength, complete: true };
  }
  return { byteLength: shownByteLength, complete: false };
}

/** Format a bounded raw-byte string as canonical `hexdump -C` style rows. */
export function renderBinaryLines(
  raw: string,
  extent: RenderInputExtent = { byteLength: raw.length, complete: true },
): Line[] {
  const shown = raw.slice(0, MAX_BINARY_VIEW_BYTES);
  const byteLength = extent.complete
    ? Math.max(extent.byteLength, raw.length)
    : shown.length;
  return [...binaryLines(shown, byteLength, extent.complete)];
}

/** Produce dump rows without retaining the expanded document. */
function* binaryLines(
  raw: string,
  byteLength: number = raw.length,
  complete = true,
): Generator<Line> {
  for (let offset = 0; offset < raw.length; offset += BYTES_PER_LINE) {
    const length = Math.min(BYTES_PER_LINE, raw.length - offset);
    yield dumpRawLine(raw, offset, length);
  }
  if (!complete) {
    yield singleSpanLine(
      `${hexOffset(raw.length)}  … preview stopped; ` +
        "total byte count unavailable …",
      "plain",
    );
    return;
  }
  if (byteLength > raw.length) {
    yield singleSpanLine(
      `${hexOffset(raw.length)}  … ${byteLength - raw.length} bytes omitted; ` +
        "use --plain for the complete dump …",
      "plain",
    );
  }
  yield singleSpanLine(hexOffset(byteLength), "number");
}

/** Produce complete dump rows from chunks of any size. */
export async function* binaryLinesFrom(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<Line> {
  const pending = new Uint8Array(BYTES_PER_LINE);
  let pendingLength = 0;
  let offset = 0;
  for await (const chunk of chunks) {
    let cursor = 0;
    if (pendingLength > 0) {
      const take = Math.min(BYTES_PER_LINE - pendingLength, chunk.length);
      pending.set(chunk.subarray(0, take), pendingLength);
      pendingLength += take;
      cursor += take;
      if (pendingLength === BYTES_PER_LINE) {
        yield dumpByteLine(pending, 0, BYTES_PER_LINE, offset);
        offset += BYTES_PER_LINE;
        pendingLength = 0;
      }
    }
    while (cursor + BYTES_PER_LINE <= chunk.length) {
      yield dumpByteLine(chunk, cursor, BYTES_PER_LINE, offset);
      cursor += BYTES_PER_LINE;
      offset += BYTES_PER_LINE;
    }
    if (cursor < chunk.length) {
      pendingLength = chunk.length - cursor;
      pending.set(chunk.subarray(cursor), 0);
    }
  }
  if (pendingLength > 0) {
    yield dumpByteLine(pending, 0, pendingLength, offset);
    offset += pendingLength;
  }
  yield singleSpanLine(hexOffset(offset), "number");
}

/** Number of dump rows, including the final byte count. */
export function binaryLineCount(byteLength: number): number {
  return Math.ceil(byteLength / BYTES_PER_LINE) + 1;
}

function dumpRawLine(raw: string, offset: number, length: number): Line {
  return dumpLine(
    (index) => byteAt(raw, index),
    offset,
    length,
    offset,
  );
}

function dumpByteLine(
  bytes: Uint8Array,
  start: number,
  length: number,
  offset: number,
): Line {
  return dumpLine((index) => bytes[index], start, length, offset);
}

function dumpLine(
  byte: (index: number) => number,
  start: number,
  length: number,
  offset: number,
): Line {
  let hex = "";
  for (let index = 0; index < BYTES_PER_LINE; index++) {
    if (index === 8) hex += " ";
    hex += index < length
      ? byte(start + index).toString(16).padStart(2, "0")
      : "  ";
    if (index < BYTES_PER_LINE - 1) hex += " ";
  }

  let characters = "";
  for (let index = 0; index < length; index++) {
    characters += byteGlyph(byte(start + index));
  }
  return singleSpanLine(
    `${hexOffset(offset)}  ${hex}  |${characters}|`,
    "plain",
  );
}

function byteAt(raw: string, offset: number): number {
  const value = raw.charCodeAt(offset);
  if (value > 0xff) {
    throw new TypeError(
      `Binary source contains a non-byte code unit at offset ${offset}.`,
    );
  }
  return value;
}

function byteGlyph(byte: number): string {
  if (byte >= 0x20 && byte <= 0x7e) return String.fromCharCode(byte);
  if (byte <= 0x7f) return glyphFor(String.fromCharCode(byte));
  return glyphFor("\u0080");
}

function hexOffset(offset: number): string {
  return offset.toString(16).padStart(8, "0");
}

function singleSpanLine(text: string, cls: TokenClass): Line {
  return { text, spans: [{ col: 0, text, cls }] };
}
