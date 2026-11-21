/**
 * The documents of one executed instance, held in memory.
 *
 * A document is a JSON value. A position of a document can hold a link to
 * a position of another document, and a read of a path continues at the
 * target of each link it meets, as `execution-and-storage.md` §2.2 says of
 * a slot's path ("A slot's path is resolved through links").
 */

import { spliceAll } from "@commonfabric/collections/splice";
import {
  debugStr,
  type FabricHash,
  type FabricValue,
  hashOf,
  isValidFabricValue,
  taggedHashStringOf,
} from "@commonfabric/data-model";
import {
  fabricFromJsonValue,
  jsonFromFabricValue,
} from "@commonfabric/data-model/codecs";

import { PartedDocuments, type PartsOptions } from "./parts.ts";

/** The members of a JSON schema the executor reads. */
export type Schema = boolean | {
  type?: string | string[];
  default?: unknown;
  properties?: Record<string, Schema>;
  items?: Schema;
  asCell?: unknown;

  /** The variants of a union. */
  anyOf?: Schema[];

  /**
   * In the schema of an array, beside `items`: the key fields that the
   * array type declares with `ArrayByKey`, in the order of their names
   * (`plan-and-label-templates.md` §1.3, "A declared key field").
   */
  keyFields?: string[];

  /**
   * In a schema document: the schemas that the document holds at more
   * than one position, each written once, and at a position the name of
   * one of them (`plan-and-label-templates.md` §1.5, provisional
   * decision P7). `linkedSchema` puts the schema in the place of each
   * name.
   */
  $defs?: Record<string, Schema>;
  $ref?: string;
};

/**
 * `array.splice(start, count, ...members)`, with the members passed as
 * arguments of the call only where they are few: a call takes about a
 * hundred thousand arguments and no more.
 */
export const spliceIn = <T>(
  array: T[],
  start: number,
  count: number,
  members: readonly T[],
): T[] =>
  members.length > 1_024
    ? spliceAll(array, start, count, members)
    : Array.prototype.splice.apply(
      array,
      ([start, count] as unknown[]).concat(members) as [number, number],
    ) as T[];

const linked = new WeakSet<object>();

/**
 * A schema document with each `$ref` replaced by the schema under `$defs`
 * that it names: the same object at every position that names it, so the
 * document is no larger for it. The document is changed in place, once.
 */
export const linkedSchema = <S>(document: S): S => {
  if (typeof document !== "object" || document === null) return document;
  if (linked.has(document)) return document;
  linked.add(document);
  const defs = (document as { $defs?: Record<string, unknown> }).$defs ?? {};
  const seen = new WeakSet<object>();
  const named = (value: unknown): unknown => {
    const name = typeof value === "object" && value !== null &&
        typeof (value as { $ref?: unknown }).$ref === "string"
      ? (value as { $ref: string }).$ref.match(/^#\/\$defs\/(.+)$/)?.[1]
      : undefined;
    return name !== undefined && name in defs ? defs[name] : value;
  };
  const walk = (value: unknown): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((member, index) => {
        value[index] = named(member);
        walk(value[index]);
      });
      return;
    }
    const record = value as Record<string, unknown>;
    for (const name of Object.keys(record)) {
      if (name === "default") continue;
      record[name] = named(record[name]);
      walk(record[name]);
    }
  };
  walk(defs);
  walk(document);
  return document;
};

/** The schema of a member of what a schema describes. */
export const schemaBelow = (
  schema: Schema | undefined,
  segment: string,
): Schema | undefined => {
  if (typeof schema !== "object") return undefined;
  return /^\d+$/.test(segment) || segment === "*"
    ? schema.items
    : schema.properties?.[segment];
};

/**
 * A value with the defaults its schema declares for what it lacks. A
 * container no default is filled in below is returned as it is. Where
 * one is, the container is copied, and `copied` is told of the copy.
 */
export const withDefaults = (
  value: unknown,
  schema: Schema | undefined,
  copied?: (from: object, to: object) => void,
): unknown => {
  if (typeof schema !== "object") return value;
  if (value === undefined) {
    return schema.default === undefined
      ? undefined
      : structuredClone(schema.default);
  }
  if (isRecord(value) && schema.properties !== undefined) {
    let filled: Record<string, unknown> | undefined;
    for (const [name, member] of Object.entries(schema.properties)) {
      const given = withDefaults(value[name], member, copied);
      if (given === value[name]) continue;
      filled ??= { ...value };
      filled[name] = given;
    }
    if (filled === undefined) return value;
    copied?.(value, filled);
    return filled;
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    const filled = value.map((member) =>
      withDefaults(member, schema.items, copied)
    );
    if (filled.every((member, index) => member === value[index])) return value;
    copied?.(value, filled);
    return filled;
  }
  return value;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

/** A value as a string, with the members of each record in one order. */
export const canonical = (value: unknown): string =>
  JSON.stringify(
    value,
    (_, member) =>
      isPlainRecord(member)
        ? Object.fromEntries(
          Object.entries(member).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
        )
        : member,
  ) ?? "undefined";

/** Whether a value can be the value of a key field: a string or a number. */
const isKeyValue = (value: unknown): value is string | number =>
  typeof value === "string" || typeof value === "number";

/** Compares two strings by their code points, as the compiler orders names. */
const byCodePoint = (a: string, b: string): number => {
  const [left, right] = [Array.from(a), Array.from(b)];
  for (let index = 0; index < left.length && index < right.length; index++) {
    const difference = left[index].codePointAt(0)! -
      right[index].codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
};

/** Names in the order a key holds them: by code point, each once. */
const ordered = (names: readonly string[]): string[] =>
  [...new Set(names)].sort(byCodePoint);

/**
 * The element part of a key (`plan-and-label-templates.md` §1.3, "The
 * structure of a key"; `execution-and-storage.md` §5.3): what a key
 * holds beside its occurrence count. It is a fabric value, one of the
 * following by what the position holds.
 *
 * - A plain value of an array with no declared key: the salted hash of
 *   the value.
 * - A plain value of an array that declares key fields:
 *   `{ fields, hash }`, the names of the key fields in the order of the
 *   names and the salted hash of the array of the values that the
 *   element holds at them, in that order (rulings Z47 and Z48).
 * - A link to a cell: the record of the address that the link resolves
 *   to, `{ space, document, path }`, without `space` in a store that was
 *   given none.
 * - A link to an element by key: the record of that reference,
 *   `{ collection, key, path }`.
 * - An element that holds a reference by key into its own array, while
 *   the keys of that array are formed: `{ position }`.
 */
export type ElementPart = FabricValue;

/** Whether a fabric value is a record of fabric values. */
const isValueRecord = (
  value: FabricValue,
): value is Record<string, FabricValue> => isPlainRecord(value);

/**
 * The written form of a fabric value where a string is needed: the text
 * of the JSON codec of fabric values (`jsonFromFabricValue()` in
 * `base/data-model/src/codecs.ts`), which writes a hash as the codec
 * does and needs no separator between the parts (ruling Z51).
 */
export const textOf = (value: FabricValue): string =>
  jsonFromFabricValue(value);

/**
 * The identifier of a thing, from the cause of its creation and what
 * tells it from the other things of that cause: the hash of the record
 * `{ ...source, causal: cause }`, as `createRef()` of
 * `runtime/runner/src/create-ref.ts` forms one
 * (`execution-and-storage.md` §5.1), written as `taggedHashStringOf()`
 * of `base/data-model/src/value-hash/impl.ts` writes a hash that stands
 * alone. A key in the cause enters the hash as the record it is, so no
 * identifier holds the text of a key.
 */
export const identifierOf = (
  cause: FabricValue,
  source: Record<string, FabricValue> = {},
): string => taggedHashStringOf({ ...source, causal: cause });

/**
 * The identifier of the argument document of an instance, from that of
 * its result document (`execution-and-storage.md` §5.1).
 */
export const argumentOf = (result: string): string =>
  identifierOf({ type: "argument", parent: result });

/**
 * The name of a record of a plan (`plan-and-label-templates.md` §1.1,
 * `Name`): a string for a name of one part, and the record of its parts
 * for a name of several.
 */
export type Name = FabricValue;

/**
 * A name where a string is needed, as in a report or as the member of a
 * record: a name of one part as it is, and a name of several parts as
 * the text that the codec writes for its record.
 */
export const nameText = (name: Name): string =>
  typeof name === "string" ? name : textOf(name);

/**
 * The record that a key is the text of. Throws for a text that is not
 * the serialization of a record.
 */
export const recordOfKey = (key: string): Record<string, FabricValue> => {
  const parts = fabricFromJsonValue(key);
  if (!isValueRecord(parts)) {
    throw new Error(debugStr`Not an element key: $quote${key}`);
  }
  return parts;
};

/**
 * The keys of the positions of one array, from the element part of
 * each: a key is the record of the element part, `element`, and the
 * occurrence count, `occurrence`, the number of earlier positions with
 * the same part, so no two positions have one key
 * (`execution-and-storage.md` §5.3).
 */
export const keysOfParts = (parts: readonly ElementPart[]): string[] => {
  const seen = new Map<string, number>();
  return parts.map((element) => {
    const text = textOf(element);
    const occurrence = seen.get(text) ?? 0;
    seen.set(text, occurrence + 1);
    return textOf({ element, occurrence });
  });
};

/**
 * The key of a member of the segment that a `flatMap` gave an element:
 * the record of the key of the upstream element, `source`, and the key
 * of the member among the members of the segment, `member`
 * (`plan-and-label-templates.md` §1.3, "The key of an element that a
 * `flatMap` contributes").
 */
export const memberKey = (upstream: string, member: string): string =>
  textOf({ source: recordOfKey(upstream), member: recordOfKey(member) });

/**
 * A key with the upstream key `from` in it replaced by `to`: the key
 * itself, and the key of a member of a segment of the element at any
 * depth. Any other key is returned as it is.
 */
export const rekeyed = (key: string, from: string, to: string): string => {
  if (key === from) return to;
  const { source, member } = recordOfKey(key);
  if (!isValueRecord(source) || !isValueRecord(member)) return key;
  const upstream = textOf(source);
  const moved = rekeyed(upstream, from, to);
  return moved === upstream ? key : memberKey(moved, textOf(member));
};

/**
 * The key fields that a key names, and none for a key that was formed
 * from a whole value or from a cell: a key is resolved from these alone,
 * with no schema (ruling Z44).
 */
export const fieldsOfKey = (key: string): string[] => {
  const { element } = recordOfKey(key);
  if (!isValueRecord(element) || !Array.isArray(element.fields)) return [];
  return element.fields.filter((field) => typeof field === "string");
};

/**
 * The segment of a path that names an element of an array by its key and
 * not by its position (`plan-and-label-templates.md` §1.3, "A plain value
 * in place has an identity"): the text of the key, as the codec writes
 * the record (its §1.2, "Written forms"). A reference whose path holds
 * one is a reference by key: the path up to the segment is the address
 * of the collection, the segment holds the key, and the rest is the path
 * below the element. A read or a write through it finds the position
 * that holds the key at that time.
 */
export const keySegment = (key: string): string => key;

/** What the text of the codec for a fabric value begins with. */
const CODEC_TEXT = "fvj1:";

/**
 * The key that a segment of a path holds, as its record, and nothing
 * for a segment that is a property name or a position. A segment is a
 * key where it decodes to the record of a key: one with `element` and
 * `occurrence`, or one with `source` and `member`. So a property whose
 * name is the text of such a record cannot be named by a path.
 */
export const keyOfSegment = (
  segment: string,
): Record<string, FabricValue> | undefined => {
  if (!segment.startsWith(CODEC_TEXT)) return undefined;
  let decoded: FabricValue;
  try {
    decoded = fabricFromJsonValue(segment);
  } catch {
    // A text that the codec does not read is a property name.
    return undefined;
  }
  if (!isValueRecord(decoded)) return undefined;
  const isKey = ("element" in decoded && "occurrence" in decoded) ||
    ("source" in decoded && "member" in decoded);
  return isKey ? decoded : undefined;
};

/** Whether a segment of a path names an element by its key. */
export const isKeySegment = (segment: string): boolean =>
  keyOfSegment(segment) !== undefined;

/** Whether two paths have the same segments. */
const samePath = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((segment, index) => segment === b[index]);

/**
 * The key fields that the schema of an array declares, beside `items`
 * (ruling Z49).
 */
export const keyFieldsOf = (schema: Schema | undefined): string[] =>
  typeof schema === "object" ? schema.keyFields ?? [] : [];

/** A reference to a position of a document. */
export class Ref {
  constructor(
    readonly doc: string,
    readonly path: readonly string[],
    /**
     * The schema a read through the reference is made under: its defaults
     * are what the read gives where nothing is stored
     * (`execution-and-storage.md` §2.2).
     */
    readonly schema?: Schema,
  ) {}

  key(...segments: string[]): Ref {
    return segments.reduce(
      (ref: Ref, segment) =>
        new Ref(
          ref.doc,
          [...ref.path, segment],
          schemaBelow(ref.schema, segment),
        ),
      this,
    );
  }

  withSchema(schema: Schema | undefined): Ref {
    return schema === undefined || this.schema !== undefined
      ? this
      : new Ref(this.doc, this.path, schema);
  }

  /**
   * The reference with a default for where nothing is stored, unless its
   * schema declares one already: the default of the place it names comes
   * before one a callee declares for a path bound to it
   * (`plan-and-label-templates.md` §1.1, ruling Z16).
   */
  withDefault(fallback: unknown): Ref {
    if (typeof this.schema === "object" && this.schema.default !== undefined) {
      return this;
    }
    return new Ref(this.doc, this.path, {
      ...(typeof this.schema === "object" ? this.schema : {}),
      default: fallback,
    });
  }
}

/**
 * A reference to the stream of a binding, for one key of each element.
 * `instance` names the instance the binding is of, where that is one a
 * function body made, by the prefix of its documents. A binding that a
 * function body made has the index -1, and its one key names it.
 */
export class StreamRef {
  constructor(
    readonly binding: number,
    readonly keys: readonly string[],
    readonly instance = "",
  ) {}
}

/**
 * What `ConeHost.stream` gives value code for the stream of a binding
 * (`execution-and-storage.md` §2.2, "Value code places a stream"): an
 * object with no member. Value code can put it into a value and can do
 * nothing else with it. Which stream it stands for is held here, where
 * value code does not reach, and the runtime reads it when it stores the
 * value.
 */
export class StreamMarker {
  constructor() {
    Object.freeze(this);
  }
}

const markers = new WeakMap<StreamMarker, StreamRef>();

/** A marker for a stream: the binding, and the keys of the instance. */
export const markerOf = (stream: StreamRef): StreamMarker => {
  const marker = new StreamMarker();
  markers.set(marker, stream);
  return marker;
};

/** The stream a marker stands for. */
export const streamOf = (marker: StreamMarker): StreamRef => {
  const stream = markers.get(marker);
  if (stream === undefined) throw new Error("a marker of no stream");
  return stream;
};

/** Whether a schema declares the position it describes as a stream. */
export const isStreamSchema = (schema: Schema | undefined): boolean =>
  typeof schema === "object" && Array.isArray(schema.asCell) &&
  schema.asCell.includes("stream");

/**
 * A position that a read observed: the document and the path. A read
 * through a reference by key observed no position: it has `keyed`, the
 * reference from the key on and the value it read there, and it is stale
 * when a read through the reference gives another value. A move of the
 * element changes neither, so nothing that read through the reference is
 * evaluated for it.
 */
export type Position = {
  doc: string;
  path: readonly string[];
  keyed?: {
    ref: Ref;
    seen: string;
    /** The key, and the array that the read found it in. */
    key: string;
    array?: object;
    /** The positions outside the array that the read went through. */
    others: Position[];
  };
};

/** What `Store.locate` found. */
export type Located = {
  /** The position, with a key resolved to the position that holds it. */
  ref: Ref;
  value: unknown;
  /**
   * The address in the form that names it: as `ref`, with each key the
   * path crossed in the last document left as the key. Two references
   * name one thing where their `named` are the same.
   */
  named: Ref;
  /** A key of the path is held by no position. */
  missing: boolean;
  /**
   * The position is an element of an array of its document, or below
   * one: a plain value in place.
   */
  inPlace: boolean;
  /**
   * Each key the path crossed in the last document, outermost first: the
   * path of the array in the form that names it, the key the position
   * holds, and the path of the position.
   */
  crossed: { array: string[]; key: string; position: string[] }[];
  /**
   * The schema that the link nearest the position holds for it, where a
   * link the read resolved through holds one. A link whose schema
   * declares no key fields for the position does not replace one that
   * declares some. A reader whose own schema declares no key fields
   * for an array forms keys with those this schema declares (ruling
   * Z52).
   */
  given: Schema | undefined;
  /**
   * The default declared nearest the end of the chain of links the read
   * resolved through: that of the last link whose schema declares one,
   * and that of the reference's own schema where no link does.
   */
  fallback: unknown;
};

type StoredLink = { $link: { doc: string; path: string[]; schema?: Schema } };
type StoredStream = {
  $stream: { binding: number; keys: string[]; instance?: string };
};

/** A position of a document that holds the link to a stream. */
export type StreamPosition = {
  path: string[];
  stream: StoredStream["$stream"];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isLink = (value: unknown): value is StoredLink =>
  isRecord(value) && isRecord(value.$link) &&
  typeof value.$link.doc === "string";

export const isStream = (value: unknown): value is StoredStream =>
  isRecord(value) && isRecord(value.$stream) &&
  typeof value.$stream.binding === "number";

const isPrefix = (prefix: readonly string[], path: readonly string[]) =>
  prefix.length <= path.length &&
  prefix.every((segment, index) => segment === path[index]);

const child = (value: unknown, segment: string): unknown => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    return segment === "length" ? value.length : undefined;
  }
  if (typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    if (segment === "length") return value.length;
    return /^\d+$/.test(segment) ? value[Number(segment)] : undefined;
  }
  return Object.hasOwn(value, segment)
    ? (value as Record<string, unknown>)[segment]
    : undefined;
};

/**
 * An error state as a value (`plan-and-label-templates.md` §5.2, "An
 * error is a value with a label"): the record that stands for the
 * failure of the cone instance that computes the position. The
 * documents give an error state no form, and this one is the
 * executor's.
 */
export type ErrorState = { $error: { message: string } };

export const errorState = (message: string): ErrorState => ({
  $error: { message },
});

export const isErrorState = (value: unknown): value is ErrorState =>
  isRecord(value) && isRecord(value.$error) &&
  Object.keys(value).length === 1;

/** A write through a reference by key whose key no position holds. */
export class MissingKey extends Error {
  constructor() {
    super("a write through a reference by key that no position holds");
  }
}

/** A write to the document of a computed output, which refuses writes. */
export class ComputedOutput extends Error {
  constructor() {
    super("a write to a computed output");
  }
}

/** The kind of the document that holds what a computed output returned. */
export const OUTPUT = "output";

/**
 * What one change of a document replaced: the whole document, what a
 * path held, or the members that a splice of an array removed and how
 * many it put in their place. A value in it is the one the document
 * held, and no copy: a change replaces a value and mutates none.
 */
export type Undo =
  | {
    doc: string;
    whole: true;
    old: { kind: string; value: unknown } | undefined;
  }
  | { doc: string; path: readonly string[]; old: unknown }
  | {
    doc: string;
    path: readonly string[];
    splice: { start: number; inserted: number; removed: unknown[] };
  };

/**
 * A change of the keys of a stored array: the positions from `start`
 * on that held the keys `removed` hold the keys `inserted`.
 */
export type KeyOp = { start: number; removed: string[]; inserted: string[] };

/** The keys of one stored array, formed with one list of key fields. */
type KeyState = {
  /** The reference that the keys were formed through. */
  at: Ref;
  fields: readonly string[];
  held: readonly unknown[];
  keys: string[];
  /** The element part of each position, and its text. */
  parts: ElementPart[];
  texts: string[];
  /** How many positions have each part, by its text. */
  counts: Map<string, number>;
  /** The clock when the keys were last known to stand. */
  clock: number;
  /** The other documents that forming the keys read, each whole. */
  others: Position[];
  /** How many times the keys were formed whole. */
  formed: number;
  /** The changes since the keys were last formed whole. */
  ops: KeyOp[];
  /** How many of those changes the store no longer holds. */
  dropped: number;
};

/** The longest chain of links a read follows before it gives up. */
const MAX_LINKS = 64;

export class Store {
  /**
   * The secret of the space, which the hash of the element part of a
   * plain value is salted with (`execution-and-storage.md` §5.3).
   */
  readonly #secret: string;

  /** The space that the documents are in, where the store was given one. */
  readonly #space: string | undefined;

  /**
   * Constructs an instance with no document. `secret` is the secret of
   * the space; without it the store mints one, and its keys of plain
   * values then differ from those of every other store. `space` is the
   * space that the documents are in, which the element part of a
   * position that holds a link names.
   */
  constructor(
    options: {
      secret?: string;
      space?: string;
      keys?: "kept" | "formed";
      /** How the documents are laid out in parts; `false` for no parts. */
      parts?: PartsOptions | false;
    } = {},
  ) {
    this.#secret = options.secret ?? crypto.randomUUID();
    this.#space = options.space;
    this.#kept = (options.keys ?? "kept") === "kept";
    this.parts = options.parts === false ? undefined : new PartedDocuments({
      keyAt: (doc, path, index) => this.#rowKey(doc, path, index),
      ...options.parts,
    });
  }

  /**
   * The documents that each document of `docs` is stored in, by the
   * layout of provisional decision P20: every change of a document is
   * applied to them as it is made.
   */
  readonly parts: PartedDocuments | undefined;

  /**
   * The keys of the rows of a stored array that no key state holds, by
   * the text of the document and the path: whoever stores the rows of a
   * collection under their element keys names them here.
   */
  readonly rowKeys = new Map<string, () => readonly string[]>();

  /** The key of the row at a position of a stored array, where known. */
  #rowKey(
    doc: string,
    path: readonly string[],
    index: number,
  ): string | undefined {
    const named = this.rowKeys.get(JSON.stringify([doc, path]));
    if (named !== undefined) return named()[index];
    const held = this.peek(doc, path);
    if (typeof held !== "object" || held === null) return undefined;
    // An array has a list of keys for each set of key fields that a
    // reader formed keys with: the one with the most fields is taken.
    let found: KeyState | undefined;
    for (const state of this.#states.get(held)?.values() ?? []) {
      if (found === undefined || state.fields.length > found.fields.length) {
        found = state;
      }
    }
    return found?.keys[index];
  }

  /**
   * Whether the key of a position that a write did not touch is kept
   * across the write (`keys: "kept"`, the default), or the key of every
   * position is formed again after each write to the array
   * (`keys: "formed"`, as `execution-and-storage.md` §2.5, step 2, words
   * it: "Compute the key of every position"). The keys are the same
   * either way: a key is a function of what its position holds.
   */
  readonly #kept: boolean;

  readonly docs = new Map<string, { kind: string; value: unknown }>();
  /**
   * The places that hold nothing until a write: a state cell has no
   * document when it is created, and a read of it reads the default of
   * its schema (`plan-and-label-templates.md` §1.3, "The first value of
   * a state cell").
   */
  readonly declared = new Map<string, { kind: string; default: unknown }>();
  /** Counts the writes and the evaluations whose value changed. */
  clock = 0;
  /** Every write: where, and the clock after it. */
  readonly log: { doc: string; path: readonly string[]; at: number }[] = [];
  /**
   * The address each container a read gave was read from. A value read
   * from a stored address carries the address, invisibly to the code it
   * is handed to (`execution-and-storage.md` §2.4).
   */
  readonly addresses = new WeakMap<object, Ref>();
  /**
   * The containers that are a copy of a plain value in place, which a
   * function body read through a handle (ruling Z25). A copy carries no
   * address: what writes it elsewhere stores the value.
   */
  readonly copies = new WeakSet<object>();
  /**
   * The link to a stream at each position of a document that holds one
   * (ruling Z43), found by a walk of what the document holds now. The
   * entries of a document are in the order of the stored value.
   */
  readonly streams = {
    get: (doc: string): StreamPosition[] | undefined => {
      const found: StreamPosition[] = [];
      const walk = (held: unknown, at: string[]) => {
        if (isStream(held)) {
          found.push({ path: at, stream: structuredClone(held.$stream) });
        } else if (Array.isArray(held)) {
          held.forEach((member, index) => walk(member, [...at, `${index}`]));
        } else if (isRecord(held)) {
          for (const [name, member] of Object.entries(held)) {
            walk(member, [...at, name]);
          }
        }
      };
      walk(this.docs.get(doc)?.value, []);
      return found.length === 0 ? undefined : found;
    },
    has: (doc: string): boolean => this.streams.get(doc) !== undefined,
  };

  /**
   * For the document of a computed output: what brings the output up to
   * date and stores it, which a read that reaches the document runs
   * first. A reference by key to an element of the output that is
   * stored elsewhere then reads what the computation returns now
   * (ruling Z53).
   */
  readonly sources = new Map<string, () => void>();

  /** The documents whose source is being run. */
  readonly #refreshing = new Set<string>();

  /** Brings the document of a computed output up to date. */
  #refresh(id: string): void {
    const source = this.sources.get(id);
    if (source === undefined || this.#refreshing.has(id)) return;
    this.#refreshing.add(id);
    try {
      source();
    } finally {
      this.#refreshing.delete(id);
    }
  }

  /**
   * Called before each change of a document, with the document and the
   * path that changes: a transaction notes which documents it wrote, and
   * which evaluation wrote them.
   */
  onWrite: ((doc: string, path: readonly string[]) => void) | undefined;

  /**
   * Called after each change of a document, with what changed: whoever
   * keeps an index from a position to its readers marks them
   * (`scheduler-and-serving-loop.md` §3.1). `keyed` is absent where the
   * change is in no array, and otherwise says, for each array on the way
   * to the path and for an array at it, which keys changed what they
   * hold or whether a position holds them: `keys` is absent where every
   * key may have, and `now` is the array that replaced `array`.
   */
  onChange:
    | ((
      change: {
        doc: string;
        path: readonly string[];
        /** What the path held, or the members that a splice removed. */
        old: unknown;
        splice?: { start: number; removed: number; inserted: number };
        keyed: { array: object; keys?: readonly string[]; now?: object }[];
      },
    ) => void)
    | undefined;

  /**
   * What each change of a transaction in progress replaced, in order,
   * while a transaction keeps one: enough to put back what a path held
   * before the transaction, without a copy of its document.
   */
  journal: Undo[] | undefined;

  /** A change was made: the clock, the log, the keys, and the readers. */
  #changed(
    doc: string,
    path: readonly string[],
    old: unknown,
    splice?: { start: number; removed: number; inserted: number },
  ): void {
    this.clock += 1;
    this.log.push({ doc, path, at: this.clock });
    const keyed = this.#touch(doc, path, splice, old);
    this.parts?.changed(doc, path, this.docs.get(doc)?.value, old, splice);
    this.onChange?.({
      doc,
      path,
      old,
      ...(splice === undefined ? {} : { splice }),
      keyed,
    });
  }

  /**
   * What a path of a document held before the changes of `journal`: the
   * value there now with those changes undone, as a copy.
   */
  before(doc: string, path: readonly string[], journal: readonly Undo[]) {
    // The changes at, above or below the path, and the shortest path
    // among them: the changes below that one are undone on a copy.
    let top = path;
    for (const undo of journal) {
      if (undo.doc !== doc) continue;
      if ("whole" in undo) {
        top = [];
      } else if (isPrefix(undo.path, top)) {
        top = undo.path;
      }
    }
    let copy: { value: unknown } | undefined = {
      value: structuredClone(
        top.reduce(
          (value: unknown, segment) => child(value, segment),
          this.docs.get(doc)?.value,
        ),
      ),
    };
    for (let index = journal.length - 1; index >= 0; index--) {
      const undo = journal[index];
      if (undo.doc !== doc) continue;
      if ("whole" in undo) {
        copy = undo.old === undefined
          ? undefined
          : { value: structuredClone(undo.old.value) };
        continue;
      }
      if (copy === undefined || !isPrefix(top, undo.path)) continue;
      const rest = undo.path.slice(top.length);
      if (rest.length === 0 && !("splice" in undo)) {
        copy.value = structuredClone(undo.old);
        continue;
      }
      let holder = copy as unknown as Record<string, unknown>;
      let name = "value";
      for (const segment of rest) {
        const next = holder?.[name];
        if (typeof next !== "object" || next === null) break;
        holder = next as Record<string, unknown>;
        name = segment;
      }
      if ("splice" in undo) {
        const array = holder[name];
        if (Array.isArray(array)) {
          spliceIn(
            array,
            undo.splice.start,
            undo.splice.inserted,
            structuredClone(undo.splice.removed),
          );
        }
      } else if (undo.old === undefined && !Array.isArray(holder)) {
        delete holder[name];
      } else {
        holder[name] = structuredClone(undo.old);
      }
    }
    if (copy === undefined) return { existed: false, value: undefined };
    return {
      existed: true,
      value: path.slice(top.length).reduce(
        (value: unknown, segment) => child(value, segment),
        copy.value,
      ),
    };
  }

  /**
   * Puts back what a path of a document held before the changes of
   * `journal`. A document that did not exist then is deleted, and a read
   * of its place reads what the place was declared with.
   */
  revert(doc: string, path: readonly string[], journal: readonly Undo[]) {
    const { existed, value } = this.before(doc, path, journal);
    const held = this.docs.get(doc);
    const old = path.reduce(
      (below: unknown, segment) => child(below, segment),
      held?.value,
    );
    if (!existed) {
      if (held === undefined) return;
      this.docs.delete(doc);
    } else if (held === undefined || path.length === 0) {
      let kind = held?.kind ?? "";
      for (const undo of journal) {
        if (undo.doc === doc && "whole" in undo && undo.old !== undefined) {
          kind = held?.kind ?? undo.old.kind;
          break;
        }
      }
      this.docs.set(doc, { kind, value });
    } else {
      let holder = held.value as Record<string, unknown>;
      for (const segment of path.slice(0, -1)) {
        const next = holder?.[segment];
        if (typeof next !== "object" || next === null) return;
        holder = next as Record<string, unknown>;
      }
      const last = path[path.length - 1];
      if (typeof holder !== "object" || holder === null) return;
      if (value === undefined && !Array.isArray(holder)) delete holder[last];
      else holder[last] = value;
    }
    this.#changed(doc, [...path], old);
  }

  /** Undoes every change of `journal`, the last one first. */
  undo(journal: readonly Undo[]): void {
    for (let index = journal.length - 1; index >= 0; index--) {
      const undo = journal[index];
      if ("whole" in undo) {
        const now = this.docs.get(undo.doc)?.value;
        if (undo.old === undefined) this.docs.delete(undo.doc);
        else this.docs.set(undo.doc, undo.old);
        this.#changed(undo.doc, [], now);
        continue;
      }
      const held = this.docs.get(undo.doc);
      if (held === undefined) continue;
      if (undo.path.length === 0 && !("splice" in undo)) {
        const now = held.value;
        held.value = undo.old;
        this.#changed(undo.doc, [], now);
        continue;
      }
      let holder = held as unknown as Record<string, unknown>;
      let name = "value";
      for (const segment of undo.path) {
        const next = holder?.[name];
        if (typeof next !== "object" || next === null) break;
        holder = next as Record<string, unknown>;
        name = segment;
      }
      if ("splice" in undo) {
        const array = holder[name];
        if (Array.isArray(array)) {
          const taken = spliceIn(
            array,
            undo.splice.start,
            undo.splice.inserted,
            undo.splice.removed,
          );
          this.#changed(undo.doc, undo.path, taken, {
            start: undo.splice.start,
            removed: taken.length,
            inserted: undo.splice.removed.length,
          });
        }
        continue;
      }
      const now = holder[name];
      if (undo.old === undefined && !Array.isArray(holder)) {
        delete holder[name];
      } else {
        holder[name] = undo.old;
      }
      this.#changed(undo.doc, undo.path, now);
    }
  }

  create(id: string, kind: string, value: unknown): void {
    this.onWrite?.(id, []);
    const old = this.docs.get(id);
    this.journal?.push({ doc: id, whole: true, old });
    this.docs.set(id, { kind, value });
    this.#changed(id, [], old?.value);
  }

  /** Names a place that gets its document with the first write. */
  declare(id: string, kind: string, fallback: unknown): void {
    this.declared.set(id, { kind, default: fallback });
  }

  /** What a place holds: its document, or its default where it has none. */
  #held(id: string): unknown {
    const document = this.docs.get(id);
    return document === undefined
      ? this.declared.get(id)?.default
      : document.value;
  }

  /** The position of each key of a list of keys that `keysOf` formed. */
  readonly #positions = new WeakMap<readonly string[], Map<string, number>>();

  /**
   * The position that holds `key` among `keys`, or -1: a lookup in an
   * index that is built once for each list of keys, so that resolving a
   * reference by key does not scan the keys of its array. The index of
   * a list that a splice changed is built again.
   */
  #positionOf(keys: readonly string[], key: string): number {
    let positions = this.#positions.get(keys);
    if (positions === undefined) {
      positions = new Map();
      for (let index = keys.length - 1; index >= 0; index--) {
        positions.set(keys[index], index);
      }
      this.#positions.set(keys, positions);
    }
    return positions.get(key) ?? -1;
  }

  /** The arrays whose keys are being formed. */
  readonly #keying = new Set<string>();

  /** How many times the keys of an array were formed whole. */
  keyings = 0;

  /**
   * The keys of each stored array whose keys were formed, by the array
   * and the key fields. An array is changed in place by a write below
   * it and by a splice, and its keys are then brought up to date for
   * the positions that the change touched (`#touch`).
   */
  readonly #states = new WeakMap<object, Map<string, KeyState>>();

  /**
   * The keys of a stored array as the store holds them, where it holds
   * them: the list, which changes in place, the count of the times it
   * was formed whole, and the changes since. A reader that kept the
   * count and the number of changes it has seen brings what it derived
   * from the keys up to date from the changes after that number, and
   * derives it whole where the count moved.
   */
  keyState(
    held: readonly unknown[],
    fields: readonly string[] = [],
  ): {
    keys: readonly string[];
    formed: number;
    /** How many changes there were since the keys were formed whole. */
    count: number;
    /** The changes after the first `seen`, or nothing where the store
     * no longer holds them. */
    since: (seen: number) => KeyOp[] | undefined;
  } | undefined {
    const state = this.#states.get(held)?.get(JSON.stringify(fields));
    if (state === undefined) return undefined;
    return {
      keys: state.keys,
      formed: state.formed,
      count: state.dropped + state.ops.length,
      since: (seen) =>
        seen < state.dropped
          ? undefined
          : state.ops.slice(seen - state.dropped),
    };
  }

  /** The element part of a position of an array whose keys are held. */
  #partAt(state: KeyState, index: number, reads: Position[]): ElementPart {
    const member = state.held[index];
    if (isLink(member)) {
      const { named } = this.locate(
        new Ref(member.$link.doc, member.$link.path),
        true,
        reads,
        true,
      );
      return this.addressOf(named);
    }
    return this.partOf(
      this.read(state.at.key(`${index}`), reads),
      state.fields,
    );
  }

  /**
   * Whether the reference that the keys of an array were formed through
   * still names the array, so that a position can be read through it.
   */
  #stands(state: KeyState): boolean {
    return this.#kept && this.locate(state.at, true).value === state.held;
  }

  /** Notes what forming a part read of other documents. */
  #others(state: KeyState, reads: readonly Position[]): void {
    const array = this.locate(state.at, true).ref;
    for (const { doc, path } of reads) {
      if (doc === array.doc && isPrefix(array.path, path)) continue;
      if (!state.others.some((known) => known.doc === doc)) {
        state.others.push({ doc, path: [] });
      }
    }
  }

  /**
   * The keys of the held arrays after a splice of `array`, or after a
   * write of a member: the positions from `start` on that held
   * `removed` members hold `inserted` now. A key of another position
   * stays as it is, unless a part that left or entered is one that
   * another position has: the occurrence counts are then formed again
   * from the parts, with no hash. Returns the keys that changed what
   * they hold or whether a position holds them, or nothing where every
   * key may have.
   */
  #respliced(
    array: readonly unknown[],
    start: number,
    removed: number,
    inserted: number,
  ): string[] | undefined {
    const states = this.#states.get(array);
    if (states === undefined) return undefined;
    const affected: string[] = [];
    let all = false;
    for (const [fields, state] of [...states]) {
      if (!this.#stands(state)) {
        states.delete(fields);
        all = true;
        continue;
      }
      const id = this.addressText(state.at);
      const reads: Position[] = [];
      let parts: ElementPart[];
      this.#keying.add(id);
      try {
        parts = Array.from(
          { length: inserted },
          (_, offset) => this.#partAt(state, start + offset, reads),
        );
      } finally {
        this.#keying.delete(id);
      }
      this.#others(state, reads);
      state.clock = this.clock;
      const texts = parts.map(textOf);
      const left = state.texts.slice(start, start + removed);
      const before = state.keys.slice(start, start + removed);
      // Whether another position has a part that left or entered.
      const counts = new Map<string, number>();
      for (const text of left) counts.set(text, (counts.get(text) ?? 0) - 1);
      for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
      let shared = false;
      for (const text of new Set([...left, ...texts])) {
        const others = (state.counts.get(text) ?? 0) -
          left.filter((one) => one === text).length;
        const here = texts.filter((one) => one === text).length;
        if (others > 0 || here > 1) shared = true;
      }
      spliceIn(state.parts, start, removed, parts);
      spliceIn(state.texts, start, removed, texts);
      for (const [text, change] of counts) {
        const now = (state.counts.get(text) ?? 0) + change;
        if (now === 0) state.counts.delete(text);
        else state.counts.set(text, now);
      }
      if (shared) {
        // The occurrence counts of the positions with those parts are
        // formed again, and every reader of the keys starts over.
        spliceIn(state.keys, 0, state.keys.length, keysOfParts(state.parts));
        this.#positions.delete(state.keys);
        state.formed += 1;
        state.ops.length = 0;
        state.dropped = 0;
        all = true;
        continue;
      }
      const keys = parts.map((element) => textOf({ element, occurrence: 0 }));
      const index = this.#positions.get(state.keys);
      if (index !== undefined) {
        if (removed === inserted) {
          before.forEach((key) => index.delete(key));
          keys.forEach((key, offset) => index.set(key, start + offset));
        } else if (start + removed === state.keys.length) {
          before.forEach((key) => index.delete(key));
          keys.forEach((key, offset) => index.set(key, start + offset));
        } else {
          this.#positions.delete(state.keys);
        }
      }
      spliceIn(state.keys, start, removed, keys);
      state.ops.push({ start, removed: before, inserted: keys });
      // A reader that is further behind than this forms what it
      // derived from the keys whole.
      if (state.ops.length > 512) {
        state.dropped += 256;
        state.ops.splice(0, 256);
      }
      for (const key of before) affected.push(key);
      for (const key of keys) affected.push(key);
    }
    return all ? undefined : affected;
  }

  /**
   * Brings the held keys up to date with a change of a document, and
   * says which keys of which arrays changed: of each array on the way
   * to the path, the keys of the position the path goes through, and
   * of an array at the path, those of the members that the change
   * replaced. `old` is what the path held, where the change replaced
   * it whole.
   */
  #touch(
    doc: string,
    path: readonly string[],
    splice: { start: number; removed: number; inserted: number } | undefined,
    old: unknown,
  ): { array: object; keys?: readonly string[]; now?: object }[] {
    const keyed: { array: object; keys?: readonly string[]; now?: object }[] =
      [];
    let value = this.docs.get(doc)?.value;
    for (const segment of path) {
      if (Array.isArray(value)) {
        keyed.push({
          array: value,
          keys: /^\d+$/.test(segment)
            ? this.#memberSet(value, Number(segment))
            : this.#dropped(value),
        });
      }
      value = child(value, segment);
    }
    if (splice !== undefined) {
      if (Array.isArray(value)) {
        keyed.push({
          array: value,
          keys: this.#respliced(
            value,
            splice.start,
            splice.removed,
            splice.inserted,
          ),
        });
      }
      return keyed;
    }
    if (!Array.isArray(old) || old === value) return keyed;
    // An array that was replaced whole: the members that both hold at
    // the start and at the end keep their keys.
    const states = this.#states.get(old);
    if (states === undefined || !Array.isArray(value) || !this.#kept) {
      keyed.push({
        array: old,
        ...(Array.isArray(value) ? { now: value } : {}),
      });
      return keyed;
    }
    const same = (a: unknown, b: unknown) =>
      a === b || JSON.stringify(a) === JSON.stringify(b);
    let head = 0;
    while (
      head < old.length && head < value.length && same(old[head], value[head])
    ) head += 1;
    let tail = 0;
    while (
      tail < old.length - head && tail < value.length - head &&
      same(old[old.length - 1 - tail], value[value.length - 1 - tail])
    ) tail += 1;
    this.#states.delete(old);
    this.#states.set(value, states);
    for (const state of states.values()) state.held = value;
    keyed.push({
      array: old,
      now: value,
      keys: this.#respliced(
        value,
        head,
        old.length - head - tail,
        value.length - head - tail,
      ),
    });
    return keyed;
  }

  /** The keys of an array after a write of the member at `index`. */
  #memberSet(array: readonly unknown[], index: number): string[] | undefined {
    for (const state of this.#states.get(array)?.values() ?? []) {
      if (state.keys.length !== array.length) return this.#dropped(array);
    }
    return this.#respliced(array, index, 1, 1);
  }

  /** Forgets the keys of an array: every key may have changed. */
  #dropped(array: readonly unknown[]): undefined {
    this.#states.delete(array);
    return undefined;
  }

  /**
   * The element part of the key of a plain value
   * (`plan-and-label-templates.md` §1.3). With `fields`, the key fields
   * the array declares, and a value that is a record that holds a
   * string or a number at each of them, the part names the fields in
   * the order of their names and holds one salted hash of the array of
   * their values in that order (rulings Z47 and Z48). Any other value
   * is keyed whole: the part is the salted hash of the value and names
   * no field. So a key formed from a field `id` that holds 7 is not the
   * key of a whole value 7.
   */
  partOf(value: unknown, fields: readonly string[] = []): ElementPart {
    if (fields.length > 0 && isPlainRecord(value)) {
      const names = ordered(fields);
      const values = names.map((name) =>
        Object.hasOwn(value, name) ? value[name] : undefined
      );
      if (values.every(isKeyValue)) {
        return { fields: names, hash: this.#salted(values) };
      }
    }
    return this.#salted(value);
  }

  /** The key of a plain value at an occurrence count. */
  keyOf(value: unknown, fields: readonly string[] = [], count = 0): string {
    return textOf({ element: this.partOf(value, fields), occurrence: count });
  }

  /**
   * The salted hash of a value (ruling Z57): what the value hasher
   * (`hashOf()` in `base/data-model/src/value-hash/impl.ts`) returns for
   * the record of `salt`, the secret of the space, and `value`, the
   * value as the fabric value it is. Throws for a value that is no
   * fabric value.
   */
  #salted(value: unknown): FabricHash {
    if (!isValidFabricValue(value)) {
      throw new Error(debugStr`Not a fabric value: $quote${value}`);
    }
    this.hashes += 1;
    return hashOf({ salt: this.#secret, value });
  }

  /**
   * The salted hash of a value that is no element part of a key, as
   * the name of a key in the identifier of a part document is
   * (`execution-and-storage.md` §4.10): it is not counted with the
   * hashes of the keys.
   */
  salted(value: FabricValue): FabricHash {
    return hashOf({ salt: this.#secret, value });
  }

  /** How many salted hashes of a plain value were formed for a key. */
  hashes = 0;

  /**
   * The address that a reference names, as a fabric value: the record of
   * the space, the document and the path, and for a reference to an
   * element by key the record of that reference, with the address of the
   * collection, the key, and the path below the element. It is the
   * element part of a position that holds a link
   * (`plan-and-label-templates.md` §1.3, "The structure of a key").
   */
  addressOf(named: Ref): ElementPart {
    const at = named.path.findLastIndex(isKeySegment);
    if (at < 0) {
      return {
        ...(this.#space === undefined ? {} : { space: this.#space }),
        document: named.doc,
        path: [...named.path],
      };
    }
    return {
      collection: this.addressOf(
        new Ref(named.doc, named.path.slice(0, at)),
      ),
      key: recordOfKey(named.path[at]),
      path: named.path.slice(at + 1),
    };
  }

  /**
   * The key of each position of a stored array
   * (`plan-and-label-templates.md` §1.3, "Element keys"): the address of
   * the cell where the position holds a link, the salted hash of the
   * value where it holds one, and the count of the earlier positions
   * with the same element part. `copies` gives the values of the
   * positions where the caller has read them. With `fields`, the key
   * fields that the collection or the read declares, or that a key to
   * resolve names, a plain value that holds the fields is keyed by them
   * and not by its whole value: a change of another member changes no
   * key (rulings Z44, Z45 and Z49). A position that holds a link is
   * keyed by its cell with or without declared fields.
   */
  keysOf(
    held: readonly unknown[],
    at: Ref,
    copies?: readonly unknown[],
    fields: readonly string[] = [],
  ): string[] {
    return [...this.#keysOf(held, at, copies, fields)];
  }

  /**
   * The keys of `keysOf`, as the list that the store holds and changes
   * in place with the array.
   */
  #keysOf(
    held: readonly unknown[],
    at: Ref,
    copies?: readonly unknown[],
    fields: readonly string[] = [],
  ): string[] {
    const id = this.addressText(at);
    // An element that holds a reference by key into its own array is
    // keyed by its position while the keys of that array are formed.
    const reentered = this.#keying.has(id);
    // The keys of a stored array are a function of what is stored. The
    // store brings them up to date with each change of the array, so
    // they stand until another document that forming them read is
    // written.
    const clock = this.clock;
    const named = JSON.stringify(fields);
    const known = this.#states.get(held)?.get(named);
    if (
      !reentered && known !== undefined &&
      (known.clock === clock || !this.changedSince(known.clock, known.others))
    ) {
      known.clock = clock;
      return known.keys;
    }
    this.#keying.add(id);
    this.keyings += 1;
    const reads: Position[] = [];
    try {
      const parts = held.map((member, index): ElementPart => {
        if (isLink(member)) {
          // What the link names, with no key resolved: a link to an
          // element by key is keyed by that reference.
          const { named } = this.locate(
            new Ref(member.$link.doc, member.$link.path),
            true,
            reads,
            true,
          );
          return this.addressOf(named);
        }
        if (reentered) return { position: index };
        return this.partOf(
          copies === undefined
            ? this.read(at.key(`${index}`), reads)
            : copies[index],
          fields,
        );
      });
      const keys = keysOfParts(parts);
      if (!reentered && copies === undefined && this.clock === clock) {
        // What was read beside the array: each other document whole. A
        // write to one of them forms the keys again.
        const texts = parts.map(textOf);
        const counts = new Map<string, number>();
        for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
        const state: KeyState = {
          at,
          fields: [...fields],
          held,
          keys,
          parts,
          texts,
          counts,
          clock,
          others: [],
          formed: (known?.formed ?? 0) + 1,
          ops: [],
          dropped: 0,
        };
        this.#others(state, reads);
        const states = this.#states.get(held) ?? new Map<string, KeyState>();
        states.set(named, state);
        this.#states.set(held, states);
      }
      return keys;
    } finally {
      if (!reentered) this.#keying.delete(id);
    }
  }

  /**
   * The position a reference resolves to, with the value stored there.
   * A link at a segment on the way is followed. With `through`, a link at
   * the last segment is followed as well. A segment that holds a key is
   * resolved to the position of the array that holds the key now, and
   * with `names` the walk ends there and resolves no key: two references
   * by key are one where they name the same collection, key and path
   * (`plan-and-label-templates.md` §1.3). Each
   * position where a link was crossed, and the last one, is added to
   * `reads`; from a key on, the one read by key stands for them. A key
   * is resolved from the key alone (ruling Z44): the element is the one
   * whose key, formed with the fields that the key names, is the key.
   */
  locate(
    ref: Ref,
    through: boolean,
    reads?: Position[],
    /** Stop at a key: the reference is named and no key is resolved. */
    names = false,
  ): Located {
    let doc = ref.doc;
    this.#refresh(doc);
    let value = this.#held(doc);
    let at: string[] = [];
    let named_: string[] = [];
    let schema = ref.schema;
    let fallback = typeof ref.schema === "object"
      ? ref.schema.default
      : undefined;
    let given: Schema | undefined;
    let rest = [...ref.path];
    let links = 0;
    let missing = false;
    let inPlace = false;
    let crossed: Located["crossed"] = [];
    for (;;) {
      while (isLink(value) && (rest.length > 0 || through)) {
        links += 1;
        if (links > MAX_LINKS) {
          return {
            ref: new Ref(doc, at),
            value: undefined,
            named: new Ref(doc, named_),
            missing,
            inPlace,
            crossed,
            given: undefined,
            fallback: undefined,
          };
        }
        reads?.push({ doc, path: at });
        const below = rest.reduce(schemaBelow, value.$link.schema);
        // The schema of the first link crossed, where the reference has
        // none of its own, and the default of the last link that
        // declares one (ruling Z8).
        schema ??= below;
        if (typeof below === "object" && below.default !== undefined) {
          fallback = below.default;
        }
        if (
          below !== undefined &&
          (keyFieldsOf(below).length > 0 || keyFieldsOf(given).length === 0)
        ) {
          given = below;
        }
        doc = value.$link.doc;
        rest = [...value.$link.path, ...rest];
        at = [];
        named_ = [];
        inPlace = false;
        crossed = [];
        this.#refresh(doc);
        value = this.#held(doc);
      }
      const segment = rest.shift();
      if (segment === undefined) break;
      if (isKeySegment(segment)) {
        if (names) {
          const named = new Ref(doc, [...named_, segment, ...rest], schema);
          return {
            ref: named,
            value: undefined,
            named,
            missing,
            inPlace: true,
            crossed,
            given,
            fallback,
          };
        }
        if (reads !== undefined && !this.#plain.has(reads)) {
          const keyed = new Ref(doc, [...named_, segment, ...rest]);
          const inner: Position[] = [];
          this.#plain.add(inner);
          const seen = canonical(this.read(keyed, inner));
          reads.push({
            doc,
            path: at,
            keyed: {
              ref: keyed,
              seen,
              key: segment,
              ...(Array.isArray(value) ? { array: value } : {}),
              others: inner.filter((read) =>
                read.doc !== doc || !isPrefix(at, read.path)
              ),
            },
          });
          reads = undefined;
        }
        // A key that a write of the transaction in progress changed is
        // found under the key the element has now (ruling Z24).
        let key = segment;
        const held = value;
        const here = new Ref(doc, at);
        const indexOf = (key: string) =>
          Array.isArray(held)
            ? this.#positionOf(
              this.#keysOf(held, here, undefined, fieldsOfKey(key)),
              key,
            )
            : -1;
        let index = indexOf(key);
        for (let hops = 0; index < 0 && hops < MAX_LINKS; hops++) {
          const next = this.#rekeyed(doc, named_, key);
          if (next === undefined) break;
          key = next;
          index = indexOf(key);
        }
        if (index < 0) {
          missing = true;
          value = undefined;
          at = [...at, segment];
        } else {
          value = (value as unknown[])[index];
          at = [...at, `${index}`];
          crossed = [...crossed, { array: named_, key, position: at }];
        }
        named_ = [...named_, segment];
        inPlace = true;
        continue;
      }
      if (Array.isArray(value) && /^\d+$/.test(segment)) inPlace = true;
      value = child(value, segment);
      at = [...at, segment];
      named_ = [...named_, segment];
    }
    reads?.push({ doc, path: at });
    return {
      ref: new Ref(doc, at, schema),
      value,
      named: new Ref(doc, named_, schema),
      missing,
      inPlace,
      crossed,
      given,
      fallback,
    };
  }

  /**
   * The lists of reads that take each position a read went through, a
   * position inside an array that a key named included, and no read by
   * key in their place.
   */
  readonly #plain = new WeakSet<Position[]>();

  /** What a document holds at a path, with no link followed. */
  peek(doc: string, path: readonly string[]): unknown {
    return path.reduce(
      (value: unknown, segment) => child(value, segment),
      this.docs.get(doc)?.value,
    );
  }

  /**
   * The elements that a write of the transaction in progress re-keyed
   * (`plan-and-label-templates.md` §1.3; ruling Z24): the document, the
   * path of the array in the form that names it, and the key before and
   * after. A write through a reference by key that changes the value
   * leaves the position with another key. Until the transaction ends, a
   * reference that holds the old key resolves to the position, so the
   * writer's later writes succeed, and the runtime moves what the old
   * key holds to the new key. Whoever runs the transaction empties the
   * list when it ends: a reference stored elsewhere under the old key
   * then names no position.
   */
  readonly rekeys: {
    doc: string;
    array: readonly string[];
    from: string;
    to: string;
  }[] = [];

  #rekeyed(
    doc: string,
    array: readonly string[],
    key: string,
  ): string | undefined {
    return this.rekeys.findLast((rekey) =>
      rekey.doc === doc && rekey.from === key && samePath(rekey.array, array)
    )?.to;
  }

  /**
   * A reference with each key that the transaction in progress changed
   * replaced by the key the element has now: the reference the writer
   * holds, as it is stored (ruling Z24).
   */
  current(ref: Ref): Ref {
    if (this.rekeys.length === 0 || !ref.path.some(isKeySegment)) return ref;
    const held: string[] = [];
    const path = ref.path.map((segment) => {
      let now = segment;
      if (isKeySegment(segment)) {
        let key = segment;
        for (let hops = 0; hops < MAX_LINKS; hops++) {
          const next = this.#rekeyed(ref.doc, held, key);
          if (next === undefined) break;
          key = next;
        }
        now = keySegment(key);
      }
      held.push(segment);
      return now;
    });
    return new Ref(ref.doc, path, ref.schema);
  }

  /** How many documents were given another identifier. */
  moves = 0;

  /** Gives a document another identifier, with what it was declared as. */
  move(from: string, to: string): void {
    this.moves += 1;
    this.onWrite?.(from, []);
    this.onWrite?.(to, []);
    const document = this.docs.get(from);
    const declared = this.declared.get(from);
    this.journal?.push({ doc: from, whole: true, old: document });
    this.journal?.push({ doc: to, whole: true, old: this.docs.get(to) });
    const replaced = this.docs.get(to)?.value;
    this.docs.delete(to);
    this.declared.delete(to);
    if (document !== undefined) {
      this.docs.delete(from);
      this.docs.set(to, document);
    }
    if (declared !== undefined) {
      this.declared.delete(from);
      this.declared.set(to, declared);
    }
    this.#changed(from, [], undefined);
    // The two changes are one step of the clock.
    this.clock -= 1;
    this.#changed(to, [], replaced);
  }

  /**
   * Removes a document, with what the place was declared as. A link to
   * it reads as nothing.
   */
  remove(id: string): void {
    this.onWrite?.(id, []);
    const old = this.docs.get(id);
    this.journal?.push({ doc: id, whole: true, old });
    this.docs.delete(id);
    this.declared.delete(id);
    this.#changed(id, [], old?.value);
  }

  /**
   * The value at a reference, with every link in it replaced by the value
   * at its target. A link whose target is being read already gives
   * `undefined`. The stream of a binding reads as `{ $stream: true }`,
   * and so does a position that holds nothing and that the schema of the
   * reference declares as a stream: a stream the instance was given.
   *
   * With `copies`, the read is that of a function body through a handle
   * (ruling Z25): a plain value in place, an element of an array or a
   * value below one, is a copy. It carries no address, so what writes
   * it elsewhere stores the value. A member that is a link is the value
   * of its cell and carries that cell's address, as without `copies`.
   */
  read(ref: Ref, reads?: Position[], copies = false): unknown {
    return this.#deep(ref, reads, new Set(), copies);
  }

  #deep(
    ref: Ref,
    reads: Position[] | undefined,
    open: Set<string>,
    copies: boolean,
  ): unknown {
    const located = this.locate(ref, true, reads);
    const id = this.addressText(located.ref);
    if (open.has(id)) return undefined;
    if (located.value === undefined && isStreamSchema(located.ref.schema)) {
      return { $stream: true };
    }
    open.add(id);
    const copied = copies && located.inPlace;
    // A container that is copied to fill in a default keeps the address
    // it was read from.
    const value = withDefaults(
      located.value === undefined && located.fallback !== undefined
        ? structuredClone(located.fallback)
        : this.#copy(
          located.value,
          reads,
          open,
          located.named,
          copies,
          copied,
          located.ref.schema,
          located.given,
        ),
      located.ref.schema,
      (from, to) => {
        const address = this.addresses.get(from);
        if (address !== undefined) this.addresses.set(to, address);
        if (this.copies.has(from)) this.copies.add(to);
      },
    );
    open.delete(id);
    if (typeof value === "object" && value !== null) {
      if (copied) this.copies.add(value);
      else this.addresses.set(value, located.named);
    }
    return value;
  }

  /**
   * `copied`: the value is a plain value in place that a function body
   * reads, or below one, and carries no address.
   */
  #copy(
    value: unknown,
    reads: Position[] | undefined,
    open: Set<string>,
    at: Ref,
    copies: boolean,
    copied: boolean,
    /**
     * The schema the read is made under at the position: the keys of an
     * array are formed with the key fields it declares (ruling Z44).
     */
    shape?: Schema,
    /**
     * The schema that a link the read resolved through holds for the
     * position: where `shape` declares no key fields for an array, its
     * keys are formed with those this schema declares (ruling Z52).
     */
    given?: Schema,
  ): unknown {
    if (isLink(value)) {
      const { doc, path, schema } = value.$link;
      return this.#deep(new Ref(doc, path, schema), reads, open, copies);
    }
    if (isStream(value)) return { $stream: true };
    const here = new Ref(at.doc, at.path);
    if (Array.isArray(value)) {
      // A member that is a container in place carries a reference by
      // key, so what passes it on unchanged stores that reference. A
      // function body reads it as a copy.
      const containers = !copies &&
        value.some((member) =>
          typeof member === "object" && member !== null && !isLink(member) &&
          !isStream(member)
        );
      const items = typeof shape === "object" ? shape.items : undefined;
      const copy = value.map((member, index) =>
        this.#copy(
          member,
          reads,
          open,
          here.key(`${index}`),
          copies,
          copies,
          items,
          typeof given === "object" ? given.items : undefined,
        )
      );
      if (containers) {
        const declared = keyFieldsOf(shape);
        const keys = this.keysOf(
          value,
          here,
          copy,
          declared.length > 0 ? declared : keyFieldsOf(given),
        );
        copy.forEach((member, index) => {
          if (isLink(value[index])) return;
          this.#readdress(
            member,
            here.key(`${index}`),
            here.key(keySegment(keys[index])),
          );
        });
      }
      if (copied) this.copies.add(copy);
      else this.addresses.set(copy, here);
      return copy;
    }
    if (isRecord(value)) {
      const copy = Object.fromEntries(
        Object.entries(value).map((
          [name, member],
        ) => [
          name,
          this.#copy(
            member,
            reads,
            open,
            here.key(name),
            copies,
            copied,
            schemaBelow(shape, name),
            schemaBelow(given, name),
          ),
        ]),
      );
      if (copied) this.copies.add(copy);
      else this.addresses.set(copy, here);
      return copy;
    }
    return value;
  }

  /** Gives what was read at or below `from` the address `to` in its place. */
  #readdress(value: unknown, from: Ref, to: Ref): void {
    if (typeof value !== "object" || value === null) return;
    const address = this.addresses.get(value);
    if (
      address === undefined || address.doc !== from.doc ||
      !isPrefix(from.path, address.path)
    ) {
      return;
    }
    this.addresses.set(
      value,
      new Ref(
        to.doc,
        [...to.path, ...address.path.slice(from.path.length)],
        address.schema,
      ),
    );
    for (const member of Object.values(value)) {
      this.#readdress(member, from, to);
    }
  }

  /**
   * Stores a value at a reference. The value is in stored form: a
   * reference in it is a link already. A link at a segment on the way is
   * followed, and so is a link at the last segment unless the value
   * written is itself a link.
   */
  write(ref: Ref, value: unknown): void {
    const located = this.locate(ref, !isLink(value) && !isStream(value));
    // A write through a reference by key whose key no position holds is
    // refused (`plan-and-label-templates.md` §1.3, assumed there under
    // question 112).
    if (located.missing) throw new MissingKey();
    const { doc, path } = located.ref;
    let document = this.docs.get(doc);
    if (document?.kind === OUTPUT) throw new ComputedOutput();
    if (document === undefined) {
      // The first write of a declared place makes its document. A write
      // below the root starts from the default the place read as.
      const declared = this.declared.get(doc);
      if (declared === undefined) return;
      this.onWrite?.(doc, path);
      this.journal?.push({ doc, whole: true, old: undefined });
      document = {
        kind: declared.kind,
        value: path.length === 0
          ? undefined
          : structuredClone(declared.default),
      };
      this.docs.set(doc, document);
    } else if (JSON.stringify(located.value) === JSON.stringify(value)) {
      return;
    } else {
      this.onWrite?.(doc, path);
    }
    let old: unknown;
    if (path.length === 0) {
      old = document.value;
      this.journal?.push({ doc, path, old });
      document.value = value;
    } else {
      if (!isRecord(document.value) && !Array.isArray(document.value)) {
        this.journal?.push({ doc, path: [], old: document.value });
        document.value = {};
      }
      let holder = document.value as Record<string, unknown>;
      for (let index = 0; index < path.length - 1; index++) {
        const next = (holder as Record<string, unknown>)[path[index]];
        if (typeof next !== "object" || next === null) {
          this.journal?.push({
            doc,
            path: path.slice(0, index + 1),
            old: next,
          });
          holder[path[index]] = /^\d+$/.test(path[index + 1]) ? [] : {};
        }
        holder = holder[path[index]] as Record<string, unknown>;
      }
      const last = path[path.length - 1];
      if (Array.isArray(holder) && last === "length") {
        // The array is stored without the positions past the length.
        const length = value as number;
        this.journal?.push({
          doc,
          path: path.slice(0, -1),
          splice: {
            start: length,
            inserted: 0,
            removed: (holder as unknown[]).slice(length),
          },
        });
        const taken = (holder as unknown[]).splice(length);
        this.#changed(doc, path.slice(0, -1), taken, {
          start: length,
          removed: taken.length,
          inserted: 0,
        });
      } else {
        old = holder[last];
        this.journal?.push({ doc, path, old });
        holder[last] = value;
        this.#changed(doc, path, old);
      }
    }
    if (path.length === 0) this.#changed(doc, path, old);
    // A position the write went through by key that holds another key
    // now is re-keyed (ruling Z24).
    for (const { array, key, position } of located.crossed) {
      const index = Number(position[position.length - 1]);
      const holder = this.locate(new Ref(doc, position.slice(0, -1)), false);
      if (!Array.isArray(holder.value)) continue;
      const now = this.keysOf(
        holder.value,
        holder.ref,
        undefined,
        fieldsOfKey(key),
      )[index];
      if (now !== undefined && now !== key) {
        this.rekeys.push({ doc, array, from: key, to: now });
      }
    }
  }

  /**
   * Changes the members of a stored array in place: removes `removed`
   * members from `start` on and puts `members`, in stored form, in
   * their place, as one change of the array (`PatchOp` in
   * `runtime/memory/v2.ts`; `execution-and-storage.md` §4.2). Where the
   * reference names no stored array, the whole value is written.
   */
  splice(
    ref: Ref,
    start: number,
    removed: number,
    members: readonly unknown[],
  ): void {
    const located = this.locate(ref, true);
    if (located.missing) throw new MissingKey();
    const { doc, path } = located.ref;
    const document = this.docs.get(doc);
    if (document?.kind === OUTPUT) throw new ComputedOutput();
    const held = located.value;
    if (document === undefined || !Array.isArray(held)) {
      const before = Array.isArray(held) ? held : [];
      this.write(ref, [
        ...before.slice(0, start),
        ...members,
        ...before.slice(start + removed),
      ]);
      return;
    }
    if (removed === 0 && members.length === 0) return;
    this.onWrite?.(doc, path);
    const taken = spliceIn(held, start, removed, members);
    this.journal?.push({
      doc,
      path,
      splice: { start, inserted: members.length, removed: taken },
    });
    this.#changed(doc, path, taken, {
      start,
      removed: taken.length,
      inserted: members.length,
    });
  }

  /**
   * Stores a value at a path of a document, with no link followed: the
   * write of the runtime to a document that it lays out itself, as the
   * result document is. A value that the path holds already is not
   * written.
   */
  put(doc: string, path: readonly string[], value: unknown): void {
    const document = this.docs.get(doc);
    if (document === undefined) return;
    const old = this.peek(doc, path);
    if (old === value || JSON.stringify(old) === JSON.stringify(value)) return;
    this.onWrite?.(doc, path);
    if (path.length === 0) {
      this.journal?.push({ doc, path, old });
      document.value = value;
    } else {
      let holder = document.value as Record<string, unknown>;
      for (const segment of path.slice(0, -1)) {
        holder = holder?.[segment] as Record<string, unknown>;
      }
      if (typeof holder !== "object" || holder === null) return;
      this.journal?.push({ doc, path, old });
      holder[path[path.length - 1]] = value;
    }
    this.#changed(doc, path, old);
  }

  /** The splice of `splice`, at a path of a document, with no link followed. */
  spliceAt(
    doc: string,
    path: readonly string[],
    start: number,
    removed: number,
    members: readonly unknown[],
  ): void {
    const held = this.peek(doc, path);
    if (!Array.isArray(held)) return;
    if (removed === 0 && members.length === 0) return;
    this.onWrite?.(doc, path);
    const taken = spliceIn(held, start, removed, members);
    this.journal?.push({
      doc,
      path,
      splice: { start, inserted: members.length, removed: taken },
    });
    this.#changed(doc, path, taken, {
      start,
      removed: taken.length,
      inserted: members.length,
    });
  }

  /**
   * The address that a reference names as a string: the text of the
   * codec for `addressOf()`. Two references name one thing where their
   * texts are the same.
   */
  addressText(named: Ref): string {
    return textOf(this.addressOf(named));
  }

  /** Whether a write after `since` is at, above, or below a position. */
  changedSince(since: number, positions: readonly Position[]): boolean {
    const last = this.log[this.log.length - 1];
    if (last === undefined || last.at <= since) return false;
    for (const { keyed } of positions) {
      if (
        keyed !== undefined && canonical(this.read(keyed.ref)) !== keyed.seen
      ) {
        return true;
      }
    }
    for (let index = this.log.length - 1; index >= 0; index--) {
      const entry = this.log[index];
      if (entry.at <= since) return false;
      for (const position of positions) {
        if (
          position.keyed === undefined && position.doc === entry.doc &&
          (isPrefix(position.path, entry.path) ||
            isPrefix(entry.path, position.path))
        ) {
          return true;
        }
      }
    }
    return false;
  }
}
