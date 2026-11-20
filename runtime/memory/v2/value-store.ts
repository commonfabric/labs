/**
 * The value store: JSON fragments held as objects in `mem_value_object`, each
 * distinct fragment stored once, and a subtree that recurs under more than one
 * parent stored once and referenced from each body that holds it.
 *
 * A row's value cell (`revision.data`, `snapshot.value`) holds either text, as
 * the codec wrote it, or the vid of an object whose fragment is that text
 * without its `fvj1:` prefix. Every reader reads both, and a value reads back
 * as exactly the text that was stored.
 *
 * A body is a tag byte, the fragment's UTF-8 length as LEB128, and a payload:
 * the fragment's UTF-8 bytes with each descendant object written as `0x01`
 * followed by its vid as LEB128, compressed with zstd when that is smaller.
 * JSON text never holds a raw `0x01` byte, so the marker is unambiguous.
 *
 * Which subtrees become objects is decided online, one value at a time, from
 * what SQLite already holds (an equal fragment is referenced) and from a
 * bounded in-memory table of the parents each subtree was last seen under (a
 * subtree seen under a second parent is stored). Lookups go by the first 16
 * bytes of the SHA-256 of a fragment's text, and every hit is confirmed by
 * comparing the text, so nothing depends on the hash being collision-free.
 */

import type { Database, Statement } from "@db/sqlite";
import { sha256 } from "@commonfabric/content-hash";
import { decodeULEB128, encodeULEB128 } from "@commonfabric/bytes/leb128";
// deno-lint-ignore no-external-import -- The runtime's native zstd compresses value bodies.
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { containsReservedSchemaRefSubstring } from "./sync-schema-ref.ts";

/** UTF-8 bytes of a row text (prefix included) below which the row stays text. */
export const ROW_INLINE_LIMIT = 64;

/** UTF-8 bytes of a subtree's JSON text from which it is a candidate object. */
export const SUBTREE_MIN_BYTES = 64;

/** The value store's tables; idempotent. */
export const VALUE_STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS mem_value_object (
  vid   INTEGER PRIMARY KEY,
  body  BLOB    NOT NULL
);
CREATE TABLE IF NOT EXISTS mem_value_hash (
  hash  BLOB    NOT NULL,
  vid   INTEGER NOT NULL,
  PRIMARY KEY (hash, vid)
) WITHOUT ROWID;
`;

/**
 * What `revision.data` or `snapshot.value` holds: text (the codec's text, or a
 * small value), a vid, or NULL.
 */
export type ValueCell = string | number | null;

/** Stores and reads JSON fragments as objects. `CommitRecords` depends on this alone. */
export interface FragmentStore {
  /**
   * Stores `json` (a fragment, no `fvj1:` prefix) by the online rule, the
   * fragment itself being the root, and returns its vid; an equal fragment
   * already stored returns that vid. Only inside a write transaction. Throws
   * when `json` is not compact JSON text.
   */
  storeFragment(json: string): number;

  /**
   * The fragment object `vid` stands for, references expanded. Throws when
   * there is no such object.
   */
  fragmentText(vid: number): string;
}

/** Options of a {@link ValueStore}. */
export type ValueStoreOptions = {
  /** Slots in the seen table; a power of two. Default 65_536. */
  seenSlots?: number;

  /** Budget of the reassembled-fragment cache, bytes. Default 8 MiB. */
  textCacheBytes?: number;

  /** Tests only: replaces the lookup hash (16 bytes), to force collisions. */
  hashForTesting?: (bytes: Uint8Array) => Uint8Array;
};

/** One object as stored, its payload decompressed. */
export type StoredObject = {
  /** The object's id. */
  vid: number;

  /** Tag bit 1: whether the full fragment holds a reserved schema-ref prefix. */
  mayContainReservedSchemaRef: boolean;

  /** UTF-8 length of the full fragment. */
  fragmentByteLength: number;

  /** rawPayload, decompressed. */
  payload: Uint8Array;

  /** The vids `payload` references, in order of appearance. */
  refs: readonly number[];
};

/** Counters of one {@link ValueStore}. */
export type ValueStoreStats = {
  /** Objects inserted into `mem_value_object`. */
  objectsStored: number;

  /** Candidates replaced by a reference to an equal stored object. */
  hashHits: number;

  /** Stored objects whose hash matched a candidate's and whose text did not. */
  hashCollisions: number;

  /** Seen-table slots overwritten by a different subtree. */
  seenOverwrites: number;

  /** Bodies read from SQLite. */
  objectsFetched: number;

  /** UTF-8 bytes of the fragments the published text cache holds. */
  textCacheBytes: number;

  /** Entries the published text cache holds. */
  textCacheEntries: number;
};

/** Tag bit 0: the payload is a zstd frame. */
const TAG_ZSTD = 0x01;

/** Tag bit 1: the full fragment contains a reserved schema-ref prefix. */
const TAG_RESERVED_REF = 0x02;

/** The byte that starts a reference in a payload. */
const REF_MARKER = 0x01;

/** Smallest raw payload compression is attempted on. */
const COMPRESS_MIN_BYTES = 32;

/** The prefix every row text the codec writes starts with. */
const ROW_PREFIX = "fvj1:";

/** Largest vid a LEB128 reference carries. */
const MAX_VID = 0xFFFF_FFFF;

/** Default slot count of the seen table. */
const DEFAULT_SEEN_SLOTS = 65_536;

/** Default budget of the text cache, bytes. */
const DEFAULT_TEXT_CACHE_BYTES = 8 * 1024 * 1024;

/** Most entries the object-header cache holds; the least recently used goes first. */
const HEADER_CACHE_MAX = 262_144;

/** Longest header: a tag byte and a five-byte LEB128. */
const HEADER_MAX_BYTES = 6;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** The ASCII text of the JSON escape for U+0001, as it appears in JSON text. */
const ESCAPED_REF_MARKER = "\\u0001";

/** Thrown when a fragment is not compact JSON text. */
class NotCompactJsonError extends Error {}

/**
 * UTF-8 byte length of `text`, as `TextEncoder` would encode it (a lone
 * surrogate counts as the three bytes of U+FFFD).
 */
const utf8Length = (text: string): number => {
  let length = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) length += 1;
    else if (unit < 0x800) length += 2;
    else if (
      unit >= 0xD800 && unit <= 0xDBFF && index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xDC00 &&
      text.charCodeAt(index + 1) <= 0xDFFF
    ) {
      length += 4;
      index++;
    } else length += 3;
  }
  return length;
};

/** First 16 bytes of the SHA-256 of `bytes`, in a buffer of their own. */
const lookupHash = (bytes: Uint8Array): Uint8Array =>
  sha256(bytes).slice(0, 16);

/** Little-endian 32-bit word of `hash` at byte `offset`. */
const hashWord = (hash: Uint8Array, offset: number): number =>
  (hash[offset] | (hash[offset + 1] << 8) | (hash[offset + 2] << 16) |
    (hash[offset + 3] << 24)) >>> 0;

/** A body's header fields. */
type BodyHeader = {
  /** The tag byte. */
  tag: number;

  /** UTF-8 length of the full fragment. */
  fragmentByteLength: number;

  /** Index of the payload's first byte in the body. */
  payloadStart: number;
};

/** Reads the header of `body`, throwing on a tag with an unknown bit. */
const readHeader = (body: Uint8Array): BodyHeader => {
  if (body.length === 0) throw new Error("Value object body is empty");
  const tag = body[0];
  if ((tag & ~(TAG_ZSTD | TAG_RESERVED_REF)) !== 0) {
    throw new Error(`Value object tag has unknown bits: \`${tag}\``);
  }
  const { value, nextIndex } = decodeULEB128(body, 1);
  return { tag, fragmentByteLength: value, payloadStart: nextIndex };
};

/** The decompressed payload of `body`, whose header is `header`. */
const payloadOf = (body: Uint8Array, header: BodyHeader): Uint8Array => {
  const stored = body.subarray(header.payloadStart);
  if ((header.tag & TAG_ZSTD) === 0) return stored;
  const raw = zstdDecompressSync(stored);
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
};

/** The vids `payload` references, in order of appearance. */
const refsOf = (payload: Uint8Array): number[] => {
  const refs: number[] = [];
  for (
    let index = payload.indexOf(REF_MARKER);
    index >= 0;
    index = payload.indexOf(REF_MARKER, index)
  ) {
    const { value, nextIndex } = decodeULEB128(payload, index + 1);
    refs.push(value);
    index = nextIndex;
  }
  return refs;
};

/** The vids a body references (for the compaction sweep). */
export function referencedVids(body: Uint8Array): number[] {
  return refsOf(payloadOf(body, readHeader(body)));
}

/**
 * Returns the fragment text `payload` stands for, reading each referenced
 * fragment through `childText`.
 */
const assemble = (
  payload: Uint8Array,
  childText: (vid: number) => string,
): string => {
  let text = "";
  let segmentStart = 0;
  for (
    let index = payload.indexOf(REF_MARKER);
    index >= 0;
    index = payload.indexOf(REF_MARKER, segmentStart)
  ) {
    text += utf8Decoder.decode(payload.subarray(segmentStart, index));
    const { value, nextIndex } = decodeULEB128(payload, index + 1);
    text += childText(value);
    segmentStart = nextIndex;
  }
  return text + utf8Decoder.decode(payload.subarray(segmentStart));
};

/** The candidates of one fragment, in pre-order. */
type Candidates = {
  /** Number of candidates. */
  count: number;

  /** Byte offset where each candidate starts. */
  start: number[];

  /** Byte offset just past each candidate. */
  end: number[];

  /** Index of each candidate's nearest enclosing candidate; -1 for the root. */
  parent: number[];
};

const OPEN_OBJECT = 0x7B;
const CLOSE_OBJECT = 0x7D;
const OPEN_ARRAY = 0x5B;
const CLOSE_ARRAY = 0x5D;
const QUOTE = 0x22;
const BACKSLASH = 0x5C;
const COMMA = 0x2C;
const COLON = 0x3A;

/** Whether `byte` may appear in a number or a literal (`true`, `null`, ...). */
const isScalarByte = (byte: number): boolean =>
  (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x7A) ||
  (byte >= 0x41 && byte <= 0x5A) || byte === 0x2B || byte === 0x2D ||
  byte === 0x2E;

/**
 * Helper for candidate collection, which returns the index just past the JSON
 * string starting at `index`, throwing on a raw control byte or an unclosed
 * string.
 */
const skipString = (bytes: Uint8Array, index: number): number => {
  let at = index + 1;
  while (at < bytes.length) {
    const byte = bytes[at];
    if (byte === QUOTE) return at + 1;
    if (byte < 0x20) throw new NotCompactJsonError("raw control byte");
    at += byte === BACKSLASH ? 2 : 1;
  }
  throw new NotCompactJsonError("unclosed string");
};

/**
 * Finds the candidates of the compact JSON text `bytes`: the root, and every
 * object, array or string in value position whose text is
 * {@link SUBTREE_MIN_BYTES} or more. Iterative, so nesting depth is bounded by
 * memory rather than the call stack.
 *
 * Checks structure, not every token: whitespace, raw control bytes and
 * misplaced punctuation are refused, while a malformed number or literal is
 * not. Exactness does not rest on the check, since the stored bytes are the
 * given bytes; it keeps raw `0x01` out of payloads and keeps spans nested.
 */
const collectCandidates = (bytes: Uint8Array): Candidates => {
  const start: number[] = [];
  const end: number[] = [];
  const parent: number[] = [];
  // Open containers: their kind, and their reserved candidate index.
  const kinds: number[] = [];
  const indices: number[] = [];
  let pos = 0;

  const fail = (what: string): never => {
    throw new NotCompactJsonError(`${what} at byte ${pos}`);
  };

  const closeContainer = (): void => {
    const index = indices.pop()!;
    kinds.pop();
    pos++;
    if (pos - start[index] >= SUBTREE_MIN_BYTES || index === 0) {
      end[index] = pos;
    } else {
      // A container below the threshold holds no candidate either.
      start.length = end.length = parent.length = index;
    }
  };

  // Each turn reads one value at `pos`, then the punctuation after it up to
  // the next value.
  while (true) {
    const enclosing = indices.length === 0 ? -1 : indices[indices.length - 1];
    const byte = bytes[pos];
    if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) {
      const index = start.length;
      start.push(pos);
      end.push(-1);
      parent.push(enclosing);
      kinds.push(byte);
      indices.push(index);
      pos++;
      const close = byte === OPEN_OBJECT ? CLOSE_OBJECT : CLOSE_ARRAY;
      if (bytes[pos] === close) {
        closeContainer();
      } else {
        if (byte === OPEN_OBJECT) {
          if (bytes[pos] !== QUOTE) fail("expected a member name");
          pos = skipString(bytes, pos);
          if (bytes[pos] !== COLON) fail("expected `:`");
          pos++;
        }
        continue;
      }
    } else if (byte === QUOTE) {
      const valueStart = pos;
      pos = skipString(bytes, pos);
      if (pos - valueStart >= SUBTREE_MIN_BYTES || enclosing === -1) {
        start.push(valueStart);
        end.push(pos);
        parent.push(enclosing);
      }
    } else if (byte !== undefined && isScalarByte(byte)) {
      const valueStart = pos;
      while (pos < bytes.length && isScalarByte(bytes[pos])) pos++;
      if (enclosing === -1) {
        start.push(valueStart);
        end.push(pos);
        parent.push(enclosing);
      }
    } else {
      fail("expected a value");
    }

    // After a value: a separator leads to the next value, a closer ends a
    // container, and the end of the text ends the root.
    while (true) {
      if (kinds.length === 0) {
        if (pos !== bytes.length) fail("trailing bytes");
        return { count: start.length, start, end, parent };
      }
      const kind = kinds[kinds.length - 1];
      const next = bytes[pos];
      if (next === COMMA) {
        pos++;
        if (kind === OPEN_OBJECT) {
          if (bytes[pos] !== QUOTE) fail("expected a member name");
          pos = skipString(bytes, pos);
          if (bytes[pos] !== COLON) fail("expected `:`");
          pos++;
        }
        break;
      }
      if (next === (kind === OPEN_OBJECT ? CLOSE_OBJECT : CLOSE_ARRAY)) {
        closeContainer();
        continue;
      }
      fail("expected `,` or a closer");
    }
  }
};

/**
 * A cache keyed by vid that honors the rule for ids a rolled-back transaction
 * may hand to different content: an entry is published only from a read made
 * outside a transaction, or from inside one into a staged layer that
 * `settle(true)` publishes and `settle(false)` drops. Published entries are
 * evicted least recently used first once their weight passes the budget.
 */
class VidCache<Value> {
  /** Published entries, least recently used first. */
  readonly #published = new Map<number, { value: Value; weight: number }>();

  /** Staged layers, innermost last. */
  readonly #staged: Map<number, { value: Value; weight: number }>[] = [];

  /** Total weight of the published entries. */
  #weight = 0;

  /** Constructs an instance whose published entries weigh at most `budget`. */
  constructor(readonly budget: number) {}

  /** Total weight of the published entries. */
  get weight(): number {
    return this.#weight;
  }

  /** Number of published entries. */
  get size(): number {
    return this.#published.size;
  }

  /** The entry for `vid` from the innermost staged layer, or published. */
  get(vid: number): Value | undefined {
    for (let layer = this.#staged.length - 1; layer >= 0; layer--) {
      const entry = this.#staged[layer].get(vid);
      if (entry !== undefined) return entry.value;
    }
    const entry = this.#published.get(vid);
    if (entry === undefined) return undefined;
    this.#published.delete(vid);
    this.#published.set(vid, entry);
    return entry.value;
  }

  /**
   * Remembers `value` for `vid`: published when `inTransaction` is false,
   * staged when a stage is open, and nowhere otherwise.
   */
  put(vid: number, value: Value, weight: number, inTransaction: boolean) {
    if (!inTransaction) this.#publish(vid, { value, weight });
    else if (this.#staged.length > 0) {
      this.#staged[this.#staged.length - 1].set(vid, { value, weight });
    }
  }

  /** Opens a staged layer. */
  stage(): void {
    this.#staged.push(new Map());
  }

  /**
   * Closes the innermost staged layer, moving its entries into the layer
   * below (or publishing them) when `committed`, dropping them otherwise.
   */
  settle(committed: boolean): void {
    const layer = this.#staged.pop();
    if (layer === undefined || !committed) return;
    const below = this.#staged[this.#staged.length - 1];
    for (const [vid, entry] of layer) {
      if (below !== undefined) below.set(vid, entry);
      else this.#publish(vid, entry);
    }
  }

  /** Empties every layer. */
  clear(): void {
    this.#published.clear();
    this.#staged.length = 0;
    this.#weight = 0;
  }

  #publish(vid: number, entry: { value: Value; weight: number }): void {
    if (entry.weight > this.budget) return;
    const previous = this.#published.get(vid);
    if (previous !== undefined) {
      this.#published.delete(vid);
      this.#weight -= previous.weight;
    }
    this.#published.set(vid, entry);
    this.#weight += entry.weight;
    for (const [oldest, old] of this.#published) {
      if (this.#weight <= this.budget) break;
      this.#published.delete(oldest);
      this.#weight -= old.weight;
    }
  }
}

/** A body header as the header cache holds it: `fragmentByteLength * 4 + tag flags`. */
type PackedHeader = number;

/**
 * Stores and reads value objects on one connection. Holds an in-memory seen
 * table (allocated on the first store) and two caches keyed by vid: the
 * reassembled text of a fragment, and an object's header.
 */
export class ValueStore implements FragmentStore {
  readonly #database: Database;
  readonly #hash: (bytes: Uint8Array) => Uint8Array;
  readonly #seenSlots: number;
  #seenHashLow?: Uint32Array;
  #seenHashHigh?: Uint32Array;
  #seenParent?: Uint32Array;
  #seenUsed?: Uint8Array;
  readonly #texts: VidCache<string>;
  readonly #headers = new VidCache<PackedHeader>(HEADER_CACHE_MAX);
  readonly #selectBody: Statement;
  readonly #selectHeader: Statement;
  readonly #selectVidsByHash: Statement;
  readonly #insertObject: Statement;
  readonly #insertHash: Statement;
  readonly #stats = {
    objectsStored: 0,
    hashHits: 0,
    hashCollisions: 0,
    seenOverwrites: 0,
    objectsFetched: 0,
  };

  /**
   * Constructs an instance over `database`, which must already hold
   * {@link VALUE_STORE_SCHEMA}. Throws when `seenSlots` is not a power of two.
   */
  constructor(database: Database, options: ValueStoreOptions = {}) {
    const seenSlots = options.seenSlots ?? DEFAULT_SEEN_SLOTS;
    if (
      !Number.isInteger(seenSlots) || seenSlots < 1 ||
      (seenSlots & (seenSlots - 1)) !== 0 || seenSlots > 0x4000_0000
    ) {
      throw new Error(`\`seenSlots\` is not a power of two: ${seenSlots}`);
    }
    this.#database = database;
    this.#hash = options.hashForTesting ?? lookupHash;
    this.#seenSlots = seenSlots;
    this.#texts = new VidCache(
      options.textCacheBytes ?? DEFAULT_TEXT_CACHE_BYTES,
    );
    this.#selectBody = database.prepare(
      "SELECT body FROM mem_value_object WHERE vid = ?",
    );
    this.#selectHeader = database.prepare(
      `SELECT substr(body, 1, ${HEADER_MAX_BYTES}) FROM mem_value_object WHERE vid = ?`,
    );
    this.#selectVidsByHash = database.prepare(
      "SELECT vid FROM mem_value_hash WHERE hash = ? ORDER BY vid",
    );
    this.#insertObject = database.prepare(
      "INSERT INTO mem_value_object (body) VALUES (?)",
    );
    this.#insertHash = database.prepare(
      "INSERT INTO mem_value_hash (hash, vid) VALUES (?, ?)",
    );
  }

  /**
   * The cell to write for row text `text` (`fvj1:...`): `text` itself under
   * {@link ROW_INLINE_LIMIT}, else the vid of its fragment. A text that does
   * not start with `fvj1:` or whose fragment is not compact JSON is returned
   * as itself, so the row stays in today's form. Only inside a write
   * transaction.
   */
  storeRowText(text: string): string | number {
    this.#requireTransaction();
    if (utf8Length(text) < ROW_INLINE_LIMIT) return text;
    if (!text.startsWith(ROW_PREFIX)) return text;
    const fragment = text.slice(ROW_PREFIX.length);
    let candidates: Candidates;
    const bytes = utf8Encoder.encode(fragment);
    try {
      candidates = collectCandidates(bytes);
    } catch (error) {
      if (error instanceof NotCompactJsonError) return text;
      throw error;
    }
    const vid = this.#store(fragment, bytes, candidates);
    return vid === undefined ? text : vid;
  }

  /** @inheritDoc */
  storeFragment(json: string): number {
    this.#requireTransaction();
    const bytes = utf8Encoder.encode(json);
    const candidates = collectCandidates(bytes);
    const vid = this.#store(json, bytes, candidates);
    if (vid === undefined) {
      throw new RangeError("Value object ids exceed the 32-bit range");
    }
    return vid;
  }

  /** The row text a cell stands for: text as is, `"fvj1:" + fragmentText(vid)`, or null. */
  rowText(cell: ValueCell): string | null {
    if (cell === null || typeof cell === "string") return cell;
    return ROW_PREFIX + this.fragmentText(cell);
  }

  /** @inheritDoc */
  fragmentText(vid: number): string {
    const cached = this.#texts.get(vid);
    if (cached !== undefined) return cached;
    const { header, payload } = this.#readPayload(vid);
    const text = assemble(payload, (child) => this.fragmentText(child));
    this.#texts.put(
      vid,
      text,
      header.fragmentByteLength,
      this.#database.inTransaction,
    );
    return text;
  }

  /**
   * UTF-8 length of `rowText(cell)` without assembling it; 0 for null, as the
   * engine's `storedByteLength` counts it.
   */
  rowByteLength(cell: ValueCell): number {
    if (cell === null) return 0;
    if (typeof cell === "string") return utf8Length(cell);
    return ROW_PREFIX.length + Math.floor(this.#header(cell) / 4);
  }

  /**
   * `containsReservedSchemaRefSubstring(rowText(cell))`, from the tag bit for
   * a vid.
   */
  rowMayContainReservedSchemaRef(cell: ValueCell): boolean {
    if (cell === null) return false;
    if (typeof cell === "string") {
      return containsReservedSchemaRefSubstring(cell);
    }
    return (this.#header(cell) & TAG_RESERVED_REF) !== 0;
  }

  /** Reads object `vid` from SQLite. Throws when there is no such object. */
  readObject(vid: number): StoredObject {
    const { header, payload } = this.#readPayload(vid);
    return {
      vid,
      mayContainReservedSchemaRef: (header.tag & TAG_RESERVED_REF) !== 0,
      fragmentByteLength: header.fragmentByteLength,
      payload,
      refs: refsOf(payload),
    };
  }

  /**
   * Helper for `readObject()` and `fragmentText()`, which reads object `vid`'s
   * header and decompressed payload from SQLite and caches the header.
   * Throws when there is no such object.
   */
  #readPayload(vid: number): { header: BodyHeader; payload: Uint8Array } {
    const row = this.#selectBody.value<[Uint8Array]>(vid);
    if (row === undefined) {
      throw new Error(`No value object with vid ${vid}`);
    }
    this.#stats.objectsFetched++;
    const body = row[0];
    const header = readHeader(body);
    this.#headers.put(
      vid,
      header.fragmentByteLength * 4 + header.tag,
      1,
      this.#database.inTransaction,
    );
    return { header, payload: payloadOf(body, header) };
  }

  /**
   * The tree `JSON.parse(fragmentText(vid))` would build, deep-frozen, except
   * that each reference in the object's own payload is replaced by
   * `childRef(childVid)` (left as returned). Returns undefined when the
   * object's own text contains the JSON escape `\u0001`, which would make the
   * placeholder ambiguous; the caller then parses `fragmentText(vid)`.
   */
  rawTree(vid: number, childRef: (vid: number) => unknown): unknown {
    const { payload, refs } = this.readObject(vid);
    let text = "";
    let segmentStart = 0;
    let index = 0;
    let ref = 0;
    const segment = (to: number): boolean => {
      const part = utf8Decoder.decode(payload.subarray(segmentStart, to));
      text += part;
      return part.includes(ESCAPED_REF_MARKER);
    };
    while (index < payload.length) {
      if (payload[index] === REF_MARKER) {
        if (segment(index)) return undefined;
        text += `"${ESCAPED_REF_MARKER}${ref++}"`;
        index = decodeULEB128(payload, index + 1).nextIndex;
        segmentStart = index;
      } else index++;
    }
    if (segment(payload.length)) return undefined;
    return JSON.parse(text, (_key, value: unknown) => {
      if (typeof value === "string") {
        return value.charCodeAt(0) === REF_MARKER
          ? childRef(refs[Number(value.slice(1))])
          : value;
      }
      if (value !== null && typeof value === "object") Object.freeze(value);
      return value;
    });
  }

  /** Whether this store's connection is inside a transaction. */
  get inTransaction(): boolean {
    return this.#database.inTransaction;
  }

  /** Opens a staging scope for the caches keyed by vid. */
  stage(): void {
    this.#texts.stage();
    this.#headers.stage();
  }

  /** Publishes (true) or drops (false) what the innermost scope cached. */
  settle(committed: boolean): void {
    this.#texts.settle(committed);
    this.#headers.settle(committed);
  }

  /** The counters, and the published text cache's size. */
  stats(): ValueStoreStats {
    return {
      ...this.#stats,
      textCacheBytes: this.#texts.weight,
      textCacheEntries: this.#texts.size,
    };
  }

  /** Finalizes this instance's statements and empties its caches. */
  close(): void {
    this.#selectBody.finalize();
    this.#selectHeader.finalize();
    this.#selectVidsByHash.finalize();
    this.#insertObject.finalize();
    this.#insertHash.finalize();
    this.#texts.clear();
    this.#headers.clear();
  }

  #requireTransaction(): void {
    if (!this.#database.inTransaction) {
      throw new Error("Value objects are stored only inside a transaction");
    }
  }

  /** The header of object `vid`, packed, from the cache or SQLite. */
  #header(vid: number): PackedHeader {
    const cached = this.#headers.get(vid);
    if (cached !== undefined) return cached;
    const row = this.#selectHeader.value<[Uint8Array]>(vid);
    if (row === undefined) {
      throw new Error(`No value object with vid ${vid}`);
    }
    const header = readHeader(row[0]);
    const packed = header.fragmentByteLength * 4 + header.tag;
    this.#headers.put(vid, packed, 1, this.#database.inTransaction);
    return packed;
  }

  /**
   * Stores the fragment `text`, whose UTF-8 bytes are `bytes`, by the online
   * rule, and returns the root's vid; undefined when a vid passes the 32-bit
   * range a reference carries.
   */
  #store(
    text: string,
    bytes: Uint8Array,
    candidates: Candidates,
  ): number | undefined {
    const { count, start, end, parent } = candidates;
    const hashes: Uint8Array[] = new Array(count);
    const mayHoldReservedRef = containsReservedSchemaRefSubstring(text);
    // References emitted inside the open frames: spans and vids, in order.
    const refStart: number[] = [];
    const refEnd: number[] = [];
    const refVid: number[] = [];
    // Candidates being stored as new objects, outermost first, each with the
    // number of references emitted before it opened.
    const frames: number[] = [];
    const frameBase: number[] = [];
    let skipEnd = -1;

    const closeFrame = (): boolean => {
      const index = frames.pop()!;
      const base = frameBase.pop()!;
      const vid = this.#insert(
        hashes[index],
        bytes,
        start[index],
        end[index],
        refStart,
        refEnd,
        refVid,
        base,
        mayHoldReservedRef,
      );
      refStart.length = refEnd.length = refVid.length = base;
      if (vid > MAX_VID) return false;
      refStart.push(start[index]);
      refEnd.push(end[index]);
      refVid.push(vid);
      return true;
    };

    for (let index = 0; index < count; index++) {
      const from = start[index];
      const to = end[index];
      while (frames.length > 0 && end[frames[frames.length - 1]] <= from) {
        if (!closeFrame()) return undefined;
      }
      if (from < skipEnd) continue;
      const hash = this.#hash(bytes.subarray(from, to));
      hashes[index] = hash;
      const hit = this.#lookup(hash, bytes.subarray(from, to));
      if (hit !== undefined) {
        this.#stats.hashHits++;
        if (index === 0) return hit;
        refStart.push(from);
        refEnd.push(to);
        refVid.push(hit);
        skipEnd = to;
        continue;
      }
      if (
        index === 0 || this.#seenUnderOtherParent(hash, hashes[parent[index]])
      ) {
        frames.push(index);
        frameBase.push(refStart.length);
      }
    }
    while (frames.length > 0) {
      if (!closeFrame()) return undefined;
    }
    return refVid[0];
  }

  /**
   * Applies rules 3 and 4 of the online rule to a candidate with hash `hash`
   * under a parent with hash `parentHash`: true when the seen table holds
   * `hash` under a different parent; otherwise records the sighting (unless
   * the slot already holds `hash`) and returns false.
   */
  #seenUnderOtherParent(hash: Uint8Array, parentHash: Uint8Array): boolean {
    if (this.#seenUsed === undefined) {
      this.#seenHashLow = new Uint32Array(this.#seenSlots);
      this.#seenHashHigh = new Uint32Array(this.#seenSlots);
      this.#seenParent = new Uint32Array(this.#seenSlots);
      this.#seenUsed = new Uint8Array(this.#seenSlots);
    }
    const low = hashWord(hash, 0);
    const high = hashWord(hash, 4);
    const parentKey = hashWord(parentHash, 0);
    const slot = low & (this.#seenSlots - 1);
    const used = this.#seenUsed[slot] === 1;
    if (
      used && this.#seenHashLow![slot] === low &&
      this.#seenHashHigh![slot] === high
    ) {
      return this.#seenParent![slot] !== parentKey;
    }
    if (used) this.#stats.seenOverwrites++;
    this.#seenUsed[slot] = 1;
    this.#seenHashLow![slot] = low;
    this.#seenHashHigh![slot] = high;
    this.#seenParent![slot] = parentKey;
    return false;
  }

  /**
   * The vid of a stored object whose fragment bytes equal `candidate` and
   * whose lookup hash is `hash`, or undefined. Asks SQLite every time: no
   * connection caches the absence of a hash, since another may insert it.
   */
  #lookup(hash: Uint8Array, candidate: Uint8Array): number | undefined {
    const rows = this.#selectVidsByHash.values<[number]>(hash);
    if (rows.length === 0) return undefined;
    let candidateText: string | undefined;
    for (const [vid] of rows) {
      if (Math.floor(this.#header(vid) / 4) === candidate.length) {
        candidateText ??= utf8Decoder.decode(candidate);
        if (this.fragmentText(vid) === candidateText) return vid;
      }
      this.#stats.hashCollisions++;
    }
    return undefined;
  }

  /**
   * Inserts the object for the candidate spanning `bytes[from, to)`, whose
   * descendant objects are the references from index `base` on, and returns
   * its vid.
   */
  #insert(
    hash: Uint8Array,
    bytes: Uint8Array,
    from: number,
    to: number,
    refStart: readonly number[],
    refEnd: readonly number[],
    refVid: readonly number[],
    base: number,
    mayHoldReservedRef: boolean,
  ): number {
    const encodedRefs: Uint8Array[] = [];
    let length = to - from;
    for (let ref = base; ref < refVid.length; ref++) {
      const encoded = encodeULEB128(refVid[ref]);
      encodedRefs.push(encoded);
      length += 1 + encoded.length - (refEnd[ref] - refStart[ref]);
    }
    let payload: Uint8Array = new Uint8Array(length);
    let write = 0;
    let read = from;
    for (let ref = base; ref < refVid.length; ref++) {
      payload.set(bytes.subarray(read, refStart[ref]), write);
      write += refStart[ref] - read;
      payload[write++] = REF_MARKER;
      payload.set(encodedRefs[ref - base], write);
      write += encodedRefs[ref - base].length;
      read = refEnd[ref];
    }
    payload.set(bytes.subarray(read, to), write);

    let tag = 0;
    if (
      mayHoldReservedRef &&
      containsReservedSchemaRefSubstring(
        utf8Decoder.decode(bytes.subarray(from, to)),
      )
    ) {
      tag |= TAG_RESERVED_REF;
    }
    if (payload.length >= COMPRESS_MIN_BYTES) {
      const frame = zstdCompressSync(payload, {
        params: { [constants.ZSTD_c_compressionLevel]: 3 },
      });
      if (frame.byteLength < payload.length) {
        payload = new Uint8Array(
          frame.buffer,
          frame.byteOffset,
          frame.byteLength,
        );
        tag |= TAG_ZSTD;
      }
    }
    const fragmentByteLength = to - from;
    const lengthBytes = encodeULEB128(fragmentByteLength);
    const body = new Uint8Array(1 + lengthBytes.length + payload.length);
    body[0] = tag;
    body.set(lengthBytes, 1);
    body.set(payload, 1 + lengthBytes.length);

    this.#insertObject.run(body);
    const vid = this.#database.lastInsertRowId;
    this.#insertHash.run(hash, vid);
    this.#stats.objectsStored++;
    this.#headers.put(vid, fragmentByteLength * 4 + tag, 1, true);
    return vid;
  }
}

/**
 * Stateless `rowText` for tools holding only a Database (acl-heads,
 * compaction, reap, inspector, tests). Reads every object it needs from
 * SQLite and caches nothing.
 */
export function readStoredValueText(
  database: Database,
  cell: ValueCell,
): string | null {
  if (cell === null || typeof cell === "string") return cell;
  const select = database.prepare(
    "SELECT body FROM mem_value_object WHERE vid = ?",
  );
  try {
    const fragment = (vid: number): string => {
      const row = select.value<[Uint8Array]>(vid);
      if (row === undefined) {
        throw new Error(`No value object with vid ${vid}`);
      }
      const body = row[0];
      return assemble(payloadOf(body, readHeader(body)), fragment);
    };
    return ROW_PREFIX + fragment(cell);
  } finally {
    select.finalize();
  }
}
