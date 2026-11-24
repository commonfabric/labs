/**
 * The DAG-CBOR subset a UCAN delegation envelope is written in, encoded and
 * decoded in house.
 *
 * DAG-CBOR is CBOR with one encoding per value: definite lengths, integers in
 * their shortest form, map keys sorted by length and then bytewise, and no
 * indefinite forms, tags, or floats. A delegation uses five kinds of value:
 * `null`, a non-negative integer, a text string, a byte string, an array, and
 * a map with text keys. That is the whole of what this module handles, and it
 * refuses everything else on decode, so a value that decodes here is one this
 * repository's own encoder could have produced. The encoding is held to the
 * reference vectors in the delegation tests rather than to an external codec.
 */

/** A value this subset encodes: what a delegation envelope is made of. */
export type DagCborValue =
  | null
  | number
  | string
  | Uint8Array
  | readonly DagCborValue[]
  | { readonly [key: string]: DagCborValue };

/** Thrown when bytes are not the canonical encoding of a subset value. */
export class DagCborError extends Error {
  override name = "DagCborError" as const;
}

const textEncoder = new TextEncoder();
// `ignoreBOM` keeps a leading U+FEFF as the character it is: a decoder that
// dropped it would read two different byte strings as one text.
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const MAJOR_UINT = 0;
const MAJOR_BYTES = 2;
const MAJOR_TEXT = 3;
const MAJOR_ARRAY = 4;
const MAJOR_MAP = 5;
const MAJOR_SIMPLE = 7;
const SIMPLE_NULL = 0xf6;

/** How deep a value may nest; a delegation envelope nests three levels. */
const MAX_DEPTH = 8;

/** Compares two keys as DAG-CBOR orders them: by length, then bytewise. */
const compareKeys = (
  a: Uint8Array,
  b: Uint8Array,
): number => {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
};

/** The shortest head for `major` and the count or value `n`. */
const head = (major: number, n: number): number[] => {
  const type = major << 5;
  if (n < 24) return [type | n];
  if (n < 0x100) return [type | 24, n];
  if (n < 0x10000) return [type | 25, n >>> 8, n & 0xff];
  if (n < 0x1_0000_0000) {
    return [
      type | 26,
      (n >>> 24) & 0xff,
      (n >>> 16) & 0xff,
      (n >>> 8) & 0xff,
      n & 0xff,
    ];
  }
  const high = Math.floor(n / 0x1_0000_0000);
  const low = n % 0x1_0000_0000;
  return [
    type | 27,
    (high >>> 24) & 0xff,
    (high >>> 16) & 0xff,
    (high >>> 8) & 0xff,
    high & 0xff,
    (low >>> 24) & 0xff,
    (low >>> 16) & 0xff,
    (low >>> 8) & 0xff,
    low & 0xff,
  ];
};

const encodeInto = (
  value: DagCborValue,
  out: number[],
  depth: number,
): void => {
  if (depth > MAX_DEPTH) {
    throw new DagCborError(`value nests deeper than ${MAX_DEPTH}`);
  }
  if (value === null) {
    out.push(SIMPLE_NULL);
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DagCborError(
        `${value} is not a non-negative integer within safe range`,
      );
    }
    append(out, head(MAJOR_UINT, value));
  } else if (typeof value === "string") {
    const bytes = textEncoder.encode(value);
    append(out, head(MAJOR_TEXT, bytes.length));
    append(out, bytes);
  } else if (value instanceof Uint8Array) {
    append(out, head(MAJOR_BYTES, value.length));
    append(out, value);
  } else if (Array.isArray(value)) {
    append(out, head(MAJOR_ARRAY, value.length));
    for (const item of value) encodeInto(item, out, depth + 1);
  } else {
    // A map is a plain object and nothing else: an instance of a class, a
    // Map, or a Date carries state its enumerable properties do not show,
    // and encoding those would silently drop it.
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DagCborError(
        "a map must be a plain object with Object.prototype or null as its prototype",
      );
    }
    const entries = Object.entries(value as { [key: string]: DagCborValue })
      .map(([key, item]) => ({ key: textEncoder.encode(key), item }))
      .sort((a, b) => compareKeys(a.key, b.key));
    append(out, head(MAJOR_MAP, entries.length));
    for (const { key, item } of entries) {
      append(out, head(MAJOR_TEXT, key.length));
      append(out, key);
      encodeInto(item, out, depth + 1);
    }
  }
};

/** Appends every element of `items` to `out`. */
const append = (out: number[], items: ArrayLike<number>): void => {
  for (let i = 0; i < items.length; i++) out.push(items[i]);
};

/** Encodes `value` as DAG-CBOR. Throws a {@link DagCborError} for a number
 * that is not a non-negative safe integer, or a value nested too deep. */
export function encodeDagCbor(value: DagCborValue): Uint8Array {
  const out: number[] = [];
  encodeInto(value, out, 0);
  return new Uint8Array(out);
}

/** A cursor over the bytes being decoded. */
class Reader {
  #bytes: Uint8Array;
  #offset = 0;

  /** Constructs a reader positioned at the start of `bytes`. */
  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  //
  // Instance members
  //

  /** Whether every byte has been consumed. */
  get done(): boolean {
    return this.#offset === this.#bytes.length;
  }

  /** The next byte. */
  byte(): number {
    if (this.#offset >= this.#bytes.length) {
      throw new DagCborError("unexpected end of input");
    }
    return this.#bytes[this.#offset++];
  }

  /** The next `length` bytes, as a copy. */
  take(length: number): Uint8Array {
    if (this.#offset + length > this.#bytes.length) {
      throw new DagCborError("unexpected end of input");
    }
    const out = this.#bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return out;
  }

  /**
   * Reads a head, returning its major type and its argument, and refusing a
   * head whose argument is not in its shortest form or is indefinite.
   */
  head(): { major: number; argument: number } {
    const initial = this.byte();
    const major = initial >>> 5;
    const info = initial & 0x1f;
    if (info < 24) return { major, argument: info };
    if (info === 31) {
      throw new DagCborError("indefinite-length items are not canonical");
    }
    if (info > 27) {
      throw new DagCborError(`reserved additional information ${info}`);
    }
    const width = 1 << (info - 24);
    let argument = 0;
    for (let i = 0; i < width; i++) {
      argument = argument * 0x100 + this.byte();
    }
    if (!Number.isSafeInteger(argument)) {
      throw new DagCborError("integer argument exceeds safe range");
    }
    const shortest = width === 1
      ? 24
      : width === 2
      ? 0x100
      : width === 4
      ? 0x10000
      : 0x1_0000_0000;
    if (argument < shortest) {
      throw new DagCborError("integer argument is not in its shortest form");
    }
    return { major, argument };
  }
}

const decodeValue = (reader: Reader, depth: number): DagCborValue => {
  if (depth > MAX_DEPTH) {
    throw new DagCborError(`value nests deeper than ${MAX_DEPTH}`);
  }
  const { major, argument } = reader.head();
  switch (major) {
    case MAJOR_UINT:
      return argument;
    case MAJOR_BYTES:
      return reader.take(argument);
    case MAJOR_TEXT:
      return decodeText(reader.take(argument));
    case MAJOR_ARRAY: {
      const items: DagCborValue[] = [];
      for (let i = 0; i < argument; i++) {
        items.push(decodeValue(reader, depth + 1));
      }
      return items;
    }
    case MAJOR_MAP: {
      const map: { [key: string]: DagCborValue } = {};
      let previous: Uint8Array | undefined;
      for (let i = 0; i < argument; i++) {
        const keyHead = reader.head();
        if (keyHead.major !== MAJOR_TEXT) {
          throw new DagCborError("map keys must be text strings");
        }
        const keyBytes = reader.take(keyHead.argument);
        if (previous !== undefined && compareKeys(previous, keyBytes) >= 0) {
          throw new DagCborError("map keys are not in canonical order");
        }
        previous = keyBytes;
        // Defined rather than assigned, so a key such as `__proto__` becomes
        // an own property and never reaches a setter on the prototype.
        Object.defineProperty(map, decodeText(keyBytes), {
          value: decodeValue(reader, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return map;
    }
    case MAJOR_SIMPLE:
      if (argument === (SIMPLE_NULL & 0x1f)) return null;
      throw new DagCborError(`simple value ${argument} is not in the subset`);
    default:
      throw new DagCborError(`major type ${major} is not in the subset`);
  }
};

const decodeText = (bytes: Uint8Array): string => {
  try {
    return textDecoder.decode(bytes);
  } catch {
    throw new DagCborError("text string is not valid UTF-8");
  }
};

/**
 * Decodes `bytes` as DAG-CBOR. Throws a {@link DagCborError} for anything
 * outside the subset, a non-canonical encoding, or trailing bytes.
 */
export function decodeDagCbor(bytes: Uint8Array): DagCborValue {
  const reader = new Reader(bytes);
  const value = decodeValue(reader, 0);
  if (!reader.done) {
    throw new DagCborError("trailing bytes after the value");
  }
  return value;
}

/** Whether `value` decoded as a map rather than another kind of value. */
export function isDagCborMap(
  value: DagCborValue,
): value is { readonly [key: string]: DagCborValue } {
  return typeof value === "object" && value !== null &&
    !(value instanceof Uint8Array) && !Array.isArray(value);
}

/** The multicodec code of DAG-CBOR, as a CID and a varsig header name it. */
export const DAG_CBOR_CODE = 0x71;
