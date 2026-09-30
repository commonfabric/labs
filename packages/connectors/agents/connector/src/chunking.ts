import { newDefaultJsonCodecEngine } from "@commonfabric/data-model/codecs";
import { stableFabricValue } from "./stable-fabric-value.ts";

export const DEFAULT_CHUNK_BYTES = 512 * 1024;

export interface EventChunk<T> {
  part: number;
  events: T[];
  byteLength: number;
}

const fabricJsonCodec = newDefaultJsonCodecEngine();
const textEncoder = new TextEncoder();

/**
 * The size a value takes on the wire, which is what a chunk budget is spent
 * on: the UTF-8 length of this format's serialized form.
 */
export function encodedJsonBytes(value: unknown): number {
  return textEncoder.encode(
    fabricJsonCodec.encode(stableFabricValue(value)),
  ).byteLength;
}

const EMPTY_ARRAY_BYTES = encodedJsonBytes([]);

function encodedJsonArrayElementBytes(value: unknown): number {
  return encodedJsonBytes([value]) - EMPTY_ARRAY_BYTES;
}

export function chunkEvents<T>(
  events: readonly T[],
  targetBytes = DEFAULT_CHUNK_BYTES,
): EventChunk<T>[] {
  return [...iterateEventChunks(events, targetBytes)];
}

function* iterateChunks<T, U>(
  events: readonly T[],
  targetBytes: number,
  capture: (event: T) => U,
): Generator<EventChunk<U>> {
  if (!Number.isSafeInteger(targetBytes) || targetBytes <= 0) {
    throw new Error("targetBytes must be a positive safe integer");
  }
  if (events.length === 0) {
    yield { part: 0, events: [], byteLength: EMPTY_ARRAY_BYTES };
    return;
  }

  let part = 0;
  let current: U[] = [];
  let currentBytes = EMPTY_ARRAY_BYTES;
  for (const sourceEvent of events) {
    const event = capture(sourceEvent);
    const eventBytes = encodedJsonArrayElementBytes(event);
    const candidateBytes = currentBytes +
      (current.length === 0 ? 0 : 1) +
      eventBytes;
    if (current.length > 0 && candidateBytes > targetBytes) {
      yield {
        part,
        events: current,
        byteLength: currentBytes,
      };
      part++;
      current = [event];
      currentBytes = EMPTY_ARRAY_BYTES + eventBytes;
    } else {
      current.push(event);
      currentBytes = candidateBytes;
    }
  }
  yield {
    part,
    events: current,
    byteLength: currentBytes,
  };
}

/** Yield each chunk as soon as its byte boundary is known. */
export function* iterateEventChunks<T>(
  events: readonly T[],
  targetBytes = DEFAULT_CHUNK_BYTES,
): Generator<EventChunk<T>> {
  yield* iterateChunks(events, targetBytes, (event) => event);
}
