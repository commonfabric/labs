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
  FabricPrimitive,
  type FabricValue,
  hashOf,
  isValidFabricValue,
  taggedHashStringOf,
} from "@commonfabric/data-model";
import {
  fabricFromJsonValue,
  jsonFromFabricValue,
} from "@commonfabric/data-model/codecs";

import { utf8Compare, utf8SortedKeysOf } from "@commonfabric/text/utf8";
import { PartedDocuments, type PartsOptions } from "./parts.ts";
import {
  ScopeInstances,
  type ScopeInstancesOptions,
} from "./scope-instances.ts";

/** The members of a JSON schema the executor reads. */
export type Schema = boolean | {
  type?: string | string[];
  default?: unknown;
  properties?: Record<string, Schema>;
  items?: Schema;
  additionalProperties?: Schema;
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

/**
 * A copy of a frozen array that is not frozen. At 10,000 members
 * `Object.values` takes 7 us, in a realm that is locked down and in one
 * that is not; a spread takes 1 us in a realm that is not locked down and
 * 110 us in one that is, and `slice` 160 us in both. `Object.values`
 * leaves out a position that holds nothing, so an array with one is copied
 * by `concat`, which keeps it.
 */
const copyOfArray = <T>(array: readonly T[]): T[] => {
  const copy = Object.values(array);
  return copy.length === array.length ? copy : array.concat();
};

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

/**
 * Whether a schema says nothing of what a position holds, as `unknown`
 * does: a link there is a reference that is not read (LS §7.8).
 */
const unread = (schema: Schema | undefined): boolean =>
  schema === true ||
  (typeof schema === "object" &&
    ["type", "properties", "items", "anyOf", "oneOf", "allOf", "$ref", "enum"]
      .every((keyword) => !(keyword in schema)) &&
    !("const" in schema));

/**
 * The variant of a union that describes a container, for a read under the
 * union: the first that declares members or elements.
 */
const containerOf = (schema: Schema | undefined): Schema | undefined =>
  typeof schema === "object" && schema.anyOf !== undefined
    ? schema.anyOf.find((variant) =>
      typeof variant === "object" &&
      (variant.properties !== undefined || variant.items !== undefined)
    ) ?? schema
    : schema;

/**
 * The members a read under `schema` takes of a record: the properties the
 * schema declares, where it declares some and admits no other. `undefined`
 * where the read takes every member the record holds.
 */
export const declaredMembers = (
  schema: Schema | undefined,
): string[] | undefined => {
  const outer = containerOf(schema);
  return typeof outer === "object" && outer.properties !== undefined &&
      !outer.additionalProperties
    ? Object.keys(outer.properties)
    : undefined;
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
      : copyOfData(schema.default);
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

/**
 * The names of the members of a record in the order every reader of the
 * storage finds them in: the storage keeps a record with its names in the
 * order of their UTF-8 bytes (`JsonEncodeAct.encodePlainObject`), and the
 * process that wrote a record holds the names as they were written until
 * the stored document replaces its own. Value code that reads which names
 * a record holds is handed this order in every process, so that what it
 * derives from the order is the same before and after a restart. A record
 * that is built from the names in this order holds a name that is an array
 * index before every other, as every record of the language does.
 */
export const membersInOrder = (record: object): readonly string[] =>
  utf8SortedKeysOf(record);

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

/**
 * Whether a value is a primitive of the data model, such as a
 * `FabricEpochNsec`: an immutable object that the storage keeps whole. The
 * executor stores one as it is, never copies it, and compares two by the
 * text of the JSON codec of fabric values.
 */
export const isDataPrimitive = (value: unknown): value is FabricPrimitive =>
  value instanceof FabricPrimitive;

/**
 * A copy of stored data: of each array and each plain record in it, with
 * every primitive of the data model in it kept. `structuredClone` makes a
 * plain record of such a primitive, which loses what it holds.
 */
export const copyOfData = <T>(value: T): T => {
  if (typeof value !== "object" || value === null) return value;
  if (isDataPrimitive(value)) return value;
  if (Array.isArray(value)) return value.map(copyOfData) as T;
  if (isPlainRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const name of Object.keys(value)) copy[name] = copyOfData(value[name]);
    return copy as T;
  }
  return structuredClone(value);
};

/**
 * A value as a string, with the members of each record in one order, and a
 * primitive of the data model as the text the JSON codec of fabric values
 * gives it: its text as plain JSON is `{}`, whatever it holds. A `bigint`,
 * which plain JSON refuses, is its digits.
 */
export const canonical = (value: unknown): string =>
  JSON.stringify(
    value,
    (_, member) =>
      isPlainRecord(member)
        ? Object.fromEntries(
          Object.entries(member).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
        )
        : isDataPrimitive(member)
        ? { $primitive: jsonFromFabricValue(member) }
        : typeof member === "bigint"
        ? { $bigint: `${member}` }
        : member,
  ) ?? "undefined";

/**
 * Whether the name of a member is an array index. A record holds such a
 * name before every other, in the order of the numbers.
 */
const isIndexName = (name: string): boolean => {
  const first = name.charCodeAt(0);
  if (first < 48 || first > 57) return false;
  return /^(0|[1-9]\d*)$/.test(name) && Number(name) < 4_294_967_295;
};

/**
 * Whether the names of a record are in the order that a record built from
 * `membersInOrder` holds them in: the names that are no array index in
 * the order of their UTF-8 bytes.
 */
const inStorageOrder = (names: readonly string[]): boolean => {
  for (let at = 1; at < names.length; at++) {
    if (isIndexName(names[at - 1])) continue;
    if (utf8Compare(names[at - 1], names[at]) > 0) return false;
  }
  return true;
};

/**
 * Whether two values in stored form are written as the same JSON text
 * where the members of each record are taken in one order. Two values
 * that are one object are the same without a look at what they hold, so
 * the comparison of a value with a copy that shares most of its
 * containers does the work of the containers that differ. A primitive of
 * the data model is the same as another of the same text of the JSON codec
 * of fabric values (`canonical`) and as nothing else: it has no member
 * that holds what it stands for. A `bigint`, which plain JSON refuses, is
 * the same as an equal `bigint` only.
 */
export const sameStored = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a === "bigint" || typeof b === "bigint") return false;
  const left = typeof a === "object" && a !== null;
  const right = typeof b === "object" && b !== null;
  if (!left || !right) {
    return !left && !right && JSON.stringify(a) === JSON.stringify(b);
  }
  if (isDataPrimitive(a) || isDataPrimitive(b)) {
    return isDataPrimitive(a) && isDataPrimitive(b) &&
      canonical(a) === canonical(b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let index = 0; index < a.length; index++) {
      // A position that holds nothing is written as `null`.
      if (!sameStored(a[index] ?? null, b[index] ?? null)) return false;
    }
    return true;
  }
  const [one, other] = [a, b] as Record<string, unknown>[];
  let members = 0;
  for (const name of Object.keys(one)) {
    // A member that holds nothing is not written.
    if (one[name] === undefined) continue;
    members += 1;
    if (!Object.hasOwn(other, name) || !sameStored(one[name], other[name])) {
      return false;
    }
  }
  for (const name of Object.keys(other)) {
    if (other[name] !== undefined) members -= 1;
  }
  return members === 0;
};

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
  const known = decodedKeys.get(key);
  if (known !== undefined && known !== null) return known;
  const parts = fabricFromJsonValue(key);
  if (!isValueRecord(parts)) {
    throw new Error(debugStr`Not an element key: $quote${key}`);
  }
  noteDecoded(key, parts);
  return parts;
};

/**
 * What the codec read of each text that was asked about as a key: the
 * record of a text that is the serialization of one, which the codec gives
 * frozen, and `null` for any other text. A key is asked about at each read
 * and each write through a reference that holds it, and reading its text
 * costs many times a lookup. What the table holds for a text is a function
 * of the text alone, so the stores of one process share it with no effect
 * on any of them. It is emptied when it holds `DECODED_KEYS` texts, so it
 * holds no more than that many.
 */
const decodedKeys = new Map<string, Record<string, FabricValue> | null>();
const DECODED_KEYS = 100_000;

const noteDecoded = (
  text: string,
  record: Record<string, FabricValue> | null,
): void => {
  if (decodedKeys.size >= DECODED_KEYS) decodedKeys.clear();
  decodedKeys.set(text, record);
};

/** A path of a document in `Store.#changes`. */
type ChangeNode = {
  /** The time of the last change at the path itself. */
  at: number;
  /** The time of the last change at the path or below it. */
  below: number;
  children?: Map<string, ChangeNode>;
};

/**
 * The text `Store.appended` holds a stored array under. The text of a path
 * starts with that of each path above it.
 */
const arrayKey = (doc: string, path: readonly string[]): string =>
  `${doc}\n${path.map((segment) => JSON.stringify(segment)).join("")}`;

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
  let decoded: FabricValue | null | undefined = decodedKeys.get(segment);
  if (decoded === undefined) {
    try {
      decoded = fabricFromJsonValue(segment);
    } catch {
      // A text that the codec does not read is a property name.
      decoded = null;
    }
    noteDecoded(segment, isValueRecord(decoded) ? decoded : null);
  }
  if (decoded === null || !isValueRecord(decoded)) return undefined;
  const isKey = ("element" in decoded && "occurrence" in decoded) ||
    ("source" in decoded && "member" in decoded);
  return isKey ? decoded : undefined;
};

/** Whether a segment of a path names an element by its key. */
export const isKeySegment = (segment: string): boolean =>
  keyOfSegment(segment) !== undefined;

/**
 * A text for the document and the path of a reference, the same for two
 * references where both are the same: what a reference is held under in a
 * set or a table of one store. It is no address: `Store.addressText` gives
 * the text that names what a reference names.
 */
const positionText = (ref: Ref): string =>
  `${ref.doc}\n${JSON.stringify(ref.path)}`;

/** Whether two paths have the same segments. */
const samePath = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((segment, index) => segment === b[index]);

/**
 * The key fields that the schema of an array declares, beside `items`
 * (ruling Z49).
 */
export const keyFieldsOf = (schema: Schema | undefined): string[] =>
  typeof schema === "object" ? schema.keyFields ?? [] : [];

/**
 * The body a read is made through a handle of, and the entry of its
 * `Body.handles` that is the handle.
 */
export type ReadThrough = { body: number; handle: number };

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
  ) {
    // Value code is handed a reference inside a value, and sets no member
    // of it.
    Object.freeze(this);
  }

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
  ) {
    Object.freeze(this);
  }
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
  /**
   * The position holds a link at which the read stopped: the schema the
   * read was made under does not read what the link leads to, as where it
   * declares a handle, and the read gave a reference in its place. The read
   * observed the link as a reference and nothing at its target.
   */
  stopped?: true;
  /**
   * The read found which position a reference names and read nothing of
   * what that position holds: it is the read of the links crossed on the
   * way and of whether the last position holds a link. A write at the
   * position changes what the read found; a write below it does not.
   */
  own?: true;
  keyed?: {
    ref: Ref;
    seen: string;
    /**
     * The key, and the array that the read found it in, as what stands
     * for the array through its changes (`Store.lineageOf`).
     */
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

/**
 * Where a read gave a stored container as the object the store holds
 * (`Store.handed`): the address the container was read from, in the form
 * that names it, and what the read was made under, which the keys of the
 * arrays below it are formed with.
 */
export type Handed = {
  at: Ref;
  /** The schema the read was made under at the container. */
  shape: Schema | undefined;
  /** The schema that a link the read resolved through holds for it. */
  given: Schema | undefined;
  /** Whether the read was made under `shape` (`Store.read`, `bound`). */
  bounded: boolean;
};

/**
 * A stored link. `redirect`: the link is a write redirect, the form today's
 * runtime stores a cell a pattern returns in: a write at its position lands
 * where it leads, whatever the write is (`Store.write`).
 */
type StoredLink = {
  $link: { doc: string; path: string[]; schema?: Schema; redirect?: true };
};
type StoredStream = {
  $stream: { binding: number; keys: string[]; instance?: string };
};

/** A position of a document that holds the link to a stream. */
export type StreamPosition = {
  path: string[];
  stream: StoredStream["$stream"];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  !isDataPrimitive(value);

export const isLink = (value: unknown): value is StoredLink =>
  isRecord(value) && isRecord(value.$link) &&
  typeof value.$link.doc === "string";

/** Whether a stored value is a link or holds one at any depth. */
const holdsLink = (value: unknown): boolean =>
  isLink(value) ||
  (Array.isArray(value)
    ? value.some(holdsLink)
    : isRecord(value) && Object.values(value).some(holdsLink));

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
 * held, and no copy: a change replaces a value and changes none in place.
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
  /** The array, which is another object after each change below it. */
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

/**
 * The documents of a store by identifier. A document it does not hold is
 * asked of `load` once, where the store was given one, and held from then
 * on: a later change of it outside the store is the store's to be told of.
 */
class Documents extends Map<string, { kind: string; value: unknown }> {
  /** The identifiers `load` gave no document for. */
  readonly #absent = new Set<string>();
  readonly #load:
    | ((id: string) => { kind: string; value: unknown } | undefined)
    | undefined;
  /** Gives a value as the store holds one (`Store.#keep`). */
  readonly #keep: (value: unknown) => unknown;
  /**
   * The scope keys the store is read and written for: a document named
   * for a scope is held once for each key, under the name of its instance
   * (`ScopeInstances.resolve`).
   */
  readonly #scopes: ScopeInstances | undefined;

  constructor(
    keep: (value: unknown) => unknown,
    load?: (id: string) => { kind: string; value: unknown } | undefined,
    scopes?: ScopeInstances,
  ) {
    super();
    this.#keep = keep;
    this.#load = load;
    this.#scopes = scopes;
  }

  override get(id: string): { kind: string; value: unknown } | undefined {
    const instance = this.#scopes?.resolve(id) ?? id;
    const held = super.get(instance);
    if (held !== undefined || this.#load === undefined) return held;
    if (this.#absent.has(instance)) return undefined;
    // The store outside is asked by the name for every key: it reads the
    // instance of the key that is evaluated for.
    const loaded = this.#load(id);
    if (loaded === undefined) {
      this.#absent.add(instance);
      return undefined;
    }
    this.set(id, loaded);
    return loaded;
  }

  override has(id: string): boolean {
    return super.has(this.#scopes?.resolve(id) ?? id) ||
      this.get(id) !== undefined;
  }

  override set(id: string, document: { kind: string; value: unknown }): this {
    const instance = this.#scopes?.resolve(id) ?? id;
    this.#absent.delete(instance);
    document.value = this.#keep(document.value);
    return super.set(instance, document);
  }

  override delete(id: string): boolean {
    return super.delete(this.#scopes?.resolve(id) ?? id);
  }

  /** Asks `load` again for an identifier it gave no document for. */
  forget(id: string): void {
    this.#absent.delete(this.#scopes?.resolve(id) ?? id);
  }
}

export class Store {
  /**
   * The secret of the space, which the hash of the element part of a
   * plain value is salted with (`execution-and-storage.md` §5.3).
   */
  readonly #secret: string;

  /** The space that the documents are in, where the store was given one. */
  readonly #space: string | undefined;

  /**
   * The space of each document that is in another space than the store's:
   * one that exists outside the instances of the store, which a reference
   * leads to.
   */
  readonly spaces = new Map<string, string>();

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
      /**
       * Gives a document the store does not hold, by its identifier: one
       * that a store outside holds. It is asked once for each identifier.
       */
      load?: (id: string) => { kind: string; value: unknown } | undefined;
      /**
       * Says which scope key the store is read and written for, where
       * documents of the scope `user` or `session` are held once for each
       * key (`scope-instances.ts`).
       */
      scopes?: ScopeInstancesOptions;
    } = {},
  ) {
    this.scopes = options.scopes === undefined
      ? undefined
      : new ScopeInstances(options.scopes);
    this.docs = new Documents(
      (value) => this.#keep(value),
      options.load,
      this.scopes,
    );
    this.#secret = options.secret ?? crypto.randomUUID();
    this.#space = options.space;
    this.#kept = (options.keys ?? "kept") === "kept";
    this.parts = options.parts === false ? undefined : new PartedDocuments({
      keyAt: (doc, path, index) => this.#rowKey(doc, path, index),
      ...options.parts,
    });
  }

  /**
   * The scope keys the store is read and written for, where it was given
   * who says them.
   */
  readonly scopes: ScopeInstances | undefined;

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

  /**
   * The collection of the plan of the instance whose result holds each
   * array of `rowKeys`, by the same text.
   */
  readonly rowCollections = new Map<string, number>();

  /** The position of each key of a list of row keys, by the list. */
  readonly #rowPositions = new WeakMap<
    readonly string[],
    Map<string, number>
  >();

  /**
   * The position of the row of `key` among the rows whose keys are
   * `keys`, or -1. The positions of a list are found once, so a lookup is
   * no scan of the rows.
   */
  #rowPosition(keys: readonly string[], key: string): number {
    let positions = this.#rowPositions.get(keys);
    if (positions === undefined) {
      positions = new Map(keys.map((each, index) => [each, index]));
      this.#rowPositions.set(keys, positions);
    }
    return positions.get(key) ?? -1;
  }

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

  /**
   * The documents by identifier. The value of a document is frozen with
   * every container in it, and no change is made in place: a change
   * replaces each container on the way to what it changes with a copy
   * that holds the new member, and leaves every other container the
   * object it was. So a value that was read from a document stays what it
   * was read as, and what a change costs is the length of its path.
   */
  readonly docs: Map<string, { kind: string; value: unknown }>;

  /**
   * For each container that the store holds or held: how many of its
   * members are a link, a stream or an error state, or hold one at any
   * depth. A container with an entry is frozen with every container in it,
   * and each record in it holds its members in the order of the storage
   * (`inStorageOrder`).
   */
  readonly #linksIn = new WeakMap<object, number>();

  /** How many containers the changes copied to replace a member of one. */
  copiedByWrites = 0;

  /** How many containers the reads copied. */
  copiedByReads = 0;

  /**
   * Whether a value is a link, a stream or an error state, or a container
   * that holds one.
   */
  #holdsLinks(value: unknown): boolean {
    return typeof value === "object" && value !== null &&
      (this.#linksIn.get(value) ?? 1) > 0;
  }

  /**
   * Whether a value is a container the store holds or held with no link, no
   * stream and no error state at any depth. Such a container is frozen
   * with all it holds, and a read of it replaces nothing in it.
   */
  plain(value: unknown): value is object {
    return typeof value === "object" && value !== null &&
      this.#linksIn.get(value) === 0;
  }

  /** Whether a value is a container the store holds or held. */
  holds(value: unknown): boolean {
    return typeof value === "object" && value !== null &&
      this.#linksIn.has(value);
  }

  /**
   * Where the last read that gave a stored container as the object the
   * store holds read it from, by the container. A read gives such a
   * container where it would copy it member for member: the container is
   * `plain`, the read is no read through a handle, and the schema of the
   * read leaves no member out and fills in no default. The containers
   * below it carry no address of their own: `addressesBelow` gives them.
   */
  readonly handed = new WeakMap<object, Handed>();

  /**
   * For each stored array and each schema of its elements: whether a read
   * under a schema with those `items` leaves no member of an element out
   * (`#nothingLeftOut`), and whether it fills in no default
   * (`#noDefaults`). An array has an entry for a schema once a read asked,
   * and the copy that replaces the array after a change gets the entries
   * that hold for the members the change put in (`#replaced`).
   */
  readonly #wholeUnder = new WeakMap<object, Map<Schema, boolean>>();
  readonly #fullUnder = new WeakMap<object, Map<Schema, boolean>>();

  /**
   * How many members of stored arrays the reads examined one by one to
   * find whether a read gives the array as the store holds it.
   */
  membersExamined = 0;

  /**
   * Whether `holds` is true of each member of a stored array. A loop by
   * position: `every` of a frozen array costs several times as much.
   */
  #everyMember(
    array: readonly unknown[],
    holds: (member: unknown) => boolean,
  ): boolean {
    for (let index = 0; index < array.length; index++) {
      this.membersExamined += 1;
      if (!holds(array[index])) return false;
    }
    return true;
  }

  /** Notes what a check of an array under a schema of its elements found. */
  #noteChecked(
    table: WeakMap<object, Map<Schema, boolean>>,
    array: object,
    items: Schema,
    holds: boolean,
  ): boolean {
    let known = table.get(array);
    if (known === undefined) {
      known = new Map();
      table.set(array, known);
    }
    // A reader that makes a schema for each read leaves an entry for each.
    if (known.size >= 8) known.delete(known.keys().next().value!);
    known.set(items, holds);
    return holds;
  }

  /**
   * Whether a read of the plain container `value` under `shape` leaves no
   * member out: each record in it holds only members that the schema at
   * its place declares, where that schema declares some and admits no
   * other (`declaredMembers`).
   */
  #nothingLeftOut(value: unknown, shape: Schema | undefined): boolean {
    if (typeof value !== "object" || value === null) return true;
    const outer = containerOf(shape);
    if (typeof outer !== "object") return true;
    if (Array.isArray(value)) {
      const { items } = outer;
      if (
        typeof items !== "object" ||
        (items.properties === undefined && items.items === undefined &&
          items.anyOf === undefined)
      ) return true;
      const known = this.#wholeUnder.get(value)?.get(items);
      if (known !== undefined) return known;
      return this.#noteChecked(
        this.#wholeUnder,
        value,
        items,
        this.#everyMember(
          value,
          (member) => this.#nothingLeftOut(member, items),
        ),
      );
    }
    if (outer.properties === undefined) return true;
    const declared = declaredMembers(shape);
    const record = value as Record<string, unknown>;
    for (const name of Object.keys(record)) {
      if (declared !== undefined && !declared.includes(name)) return false;
      if (!this.#nothingLeftOut(record[name], outer.properties[name])) {
        return false;
      }
    }
    return true;
  }

  /**
   * Whether `withDefaults` fills in nothing for the plain container or the
   * scalar `value` under `schema`.
   */
  #noDefaults(value: unknown, schema: Schema | undefined): boolean {
    if (typeof schema !== "object") return true;
    if (value === undefined) return schema.default === undefined;
    if (typeof value !== "object" || value === null) return true;
    if (Array.isArray(value)) {
      const { items } = schema;
      if (
        typeof items !== "object" ||
        (items.properties === undefined && items.items === undefined &&
          items.default === undefined)
      ) return true;
      const known = this.#fullUnder.get(value)?.get(items);
      if (known !== undefined) return known;
      return this.#noteChecked(
        this.#fullUnder,
        value,
        items,
        this.#everyMember(
          value,
          (member) => this.#noDefaults(member, items),
        ),
      );
    }
    if (schema.properties === undefined) return true;
    const record = value as Record<string, unknown>;
    for (const [name, member] of Object.entries(schema.properties)) {
      if (!this.#noDefaults(record[name], member)) return false;
    }
    return true;
  }

  /**
   * Gives the entries of `#wholeUnder` and `#fullUnder` that hold for the
   * array `from` to `next`, the copy that replaces it, where they hold for
   * each of `put`, the members the change put into the copy.
   */
  #checkedStill(from: object, next: object, put: readonly unknown[]): void {
    const tables = [
      [
        this.#wholeUnder,
        (member: unknown, items: Schema) => this.#nothingLeftOut(member, items),
      ],
      [
        this.#fullUnder,
        (member: unknown, items: Schema) => this.#noDefaults(member, items),
      ],
    ] as const;
    for (const [table, check] of tables) {
      const known = table.get(from);
      if (known === undefined) continue;
      for (const [items, holds] of known) {
        if (!holds || !put.every((member) => check(member, items))) continue;
        this.#noteChecked(table, next, items, true);
      }
    }
  }

  /**
   * Names the address of `member`, the member at `segment` of `parent`,
   * where `parent` is a container that a read gave as the object the
   * store holds and `member` is a container too: the address `handed`
   * then holds for `member` is the one `addressesBelow` gives it. Whoever
   * steps from a value to one of its members calls this, so that the
   * member carries its address as the value does.
   */
  handMember(parent: object, segment: string, member: unknown): void {
    if (typeof member !== "object" || member === null) return;
    if (!this.#linksIn.has(member)) return;
    const handed = this.handed.get(parent);
    if (handed === undefined) return;
    const { shape, given, bounded } = handed;
    const outer = bounded ? containerOf(shape) : shape;
    if (!Array.isArray(parent)) {
      this.handed.set(member, {
        at: new Ref(handed.at.doc, [...handed.at.path, segment]),
        shape: schemaBelow(outer, segment),
        given: schemaBelow(given, segment),
        bounded,
      });
      return;
    }
    if (!/^\d+$/.test(segment)) return;
    const declared = keyFieldsOf(shape);
    const keys = this.#keysOf(
      parent,
      new Ref(handed.at.doc, handed.at.path),
      parent,
      declared.length > 0 ? declared : keyFieldsOf(given),
      true,
    );
    this.handed.set(member, {
      at: new Ref(handed.at.doc, [
        ...handed.at.path,
        keySegment(keys[Number(segment)]),
      ]),
      shape: typeof outer === "object" ? outer.items : undefined,
      given: typeof given === "object" ? given.items : undefined,
      bounded,
    });
  }

  /**
   * Adds to `into` the address of each container below `root`, a
   * container that a read gave as the object the store holds (`handed`):
   * what a read that copies registers for each copy as it makes it. A
   * member of a record has the path of the record and its name, and a
   * member of an array the path of the array and the key of the member,
   * formed with the key fields the read declares for the array.
   */
  addressesBelow(root: object, handed: Handed, into: Map<object, Ref>): void {
    const walk = (
      value: object,
      // The address with a position for each array crossed below the root,
      // and the address in the form that names the container.
      here: Ref,
      named: Ref,
      shape: Schema | undefined,
      given: Schema | undefined,
    ): void => {
      const outer = handed.bounded ? containerOf(shape) : shape;
      if (Array.isArray(value)) {
        let containers = false;
        for (let index = 0; index < value.length && !containers; index++) {
          containers = typeof value[index] === "object" &&
            value[index] !== null;
        }
        if (!containers) return;
        const declared = keyFieldsOf(shape);
        const keys = this.keysOf(
          value,
          here,
          value,
          declared.length > 0 ? declared : keyFieldsOf(given),
          true,
        );
        const items = typeof outer === "object" ? outer.items : undefined;
        for (let index = 0; index < value.length; index++) {
          const member = value[index];
          if (typeof member !== "object" || member === null) continue;
          const at = named.key(keySegment(keys[index]));
          into.set(member, at);
          walk(
            member,
            here.key(`${index}`),
            at,
            items,
            typeof given === "object" ? given.items : undefined,
          );
        }
        return;
      }
      const record = value as Record<string, unknown>;
      for (const name of Object.keys(record)) {
        const member = record[name];
        if (typeof member !== "object" || member === null) continue;
        const at = named.key(name);
        into.set(member, at);
        walk(
          member,
          here.key(name),
          at,
          schemaBelow(outer, name),
          schemaBelow(given, name),
        );
      }
    };
    const at = new Ref(handed.at.doc, handed.at.path);
    walk(root, at, at, handed.shape, handed.given);
  }

  /**
   * A value as the store holds one: frozen with every container in it, and
   * each record with its members in the order of the storage. A container
   * is frozen where it stands, and a record is replaced by a copy where its
   * members are in another order, as is a container that was frozen
   * already and holds such a record. A container that the store holds
   * already is returned as it is, with no look at what it holds. The schema
   * of a link is left as it is: a plan shares it.
   */
  #keep(value: unknown): unknown {
    if (typeof value !== "object" || value === null) return value;
    if (this.#linksIn.has(value)) return value;
    if (isLink(value)) {
      Object.freeze(value.$link.path);
      Object.freeze(value.$link);
      this.#linksIn.set(Object.freeze(value), 1);
      return value;
    }
    if (isStream(value)) {
      Object.freeze(value.$stream.keys);
      Object.freeze(value.$stream);
      this.#linksIn.set(Object.freeze(value), 1);
      return value;
    }
    if (isErrorState(value)) {
      Object.freeze(value.$error);
      this.#linksIn.set(Object.freeze(value), 1);
      return value;
    }
    if (Array.isArray(value)) {
      let kept: unknown[] = value;
      let links = 0;
      for (let index = 0; index < value.length; index++) {
        const member = value[index];
        if (typeof member !== "object" || member === null) continue;
        const held = this.#keep(member);
        if (held !== member) {
          if (kept === value && Object.isFrozen(value)) {
            kept = copyOfArray(value);
          }
          kept[index] = held;
        }
        if (this.#holdsLinks(held)) links += 1;
      }
      this.#linksIn.set(Object.freeze(kept), links);
      return kept;
    }
    // An object of a class is left as it is, and a read of what holds it
    // copies as a read of a link does. A primitive of the data model is
    // such an object and a value of a document: it is immutable from its
    // construction, and a copy of what holds it holds the same object
    // (`#copy`).
    if (!isPlainRecord(value)) return value;
    const names = Object.keys(value);
    let kept: Record<string, unknown> = value;
    // A record with no prototype is held as one with the prototype of a
    // record: what takes a stored value from the store takes it as a
    // record like any other.
    if (!inStorageOrder(names) || Object.getPrototypeOf(value) === null) {
      kept = {};
      for (const name of names.sort(utf8Compare)) kept[name] = value[name];
    }
    let links = 0;
    for (const name of names) {
      const member = kept[name];
      if (typeof member !== "object" || member === null) continue;
      const held = this.#keep(member);
      if (held !== member) {
        if (kept === value && Object.isFrozen(value)) kept = { ...value };
        kept[name] = held;
      }
      if (this.#holdsLinks(held)) links += 1;
    }
    this.#linksIn.set(Object.freeze(kept), links);
    return kept;
  }

  /**
   * What stands for a stored array through its changes: an object that the
   * array has from when it is first asked for, and that each copy that
   * replaces the array after a change below it has too. A reader of a key
   * of the array is registered under it, so a change of another member of
   * the array leaves the registration where it is.
   */
  readonly #lineage = new WeakMap<object, object>();

  /** What stands for a stored array through its changes (`#lineage`). */
  lineageOf(array: object): object {
    let lineage = this.#lineage.get(array);
    if (lineage === undefined) {
      lineage = {};
      this.#lineage.set(array, lineage);
    }
    return lineage;
  }

  /**
   * What stands for an array through its changes where something asked
   * for it before, and nothing otherwise.
   */
  lineageHeld(array: object): object | undefined {
    return this.#lineage.get(array);
  }

  /**
   * Freezes `next`, the copy that replaces the container `from` of a
   * document, and gives it what the store keeps for `from`: the count of
   * its members that hold a link, and for an array its keys, what stands
   * for it through its changes, and whether a whole read formed its keys.
   */
  #replaced(
    from: object,
    next: object,
    links: number,
    /** The members the change put into the copy. */
    put: readonly unknown[],
  ): void {
    this.#linksIn.set(Object.freeze(next), links);
    this.copiedByWrites += 1;
    if (!Array.isArray(from) || !Array.isArray(next)) return;
    this.#checkedStill(from, next, put);
    const states = this.#states.get(from);
    if (states !== undefined) {
      this.#states.delete(from);
      this.#states.set(next, states);
      for (const state of states.values()) state.held = next;
    }
    const lineage = this.#lineage.get(from);
    if (lineage !== undefined) this.#lineage.set(next, lineage);
    if (this.#readWhole.has(from)) this.#readWhole.add(next);
  }

  /** How many members of a container hold a link (`#linksIn`). */
  #linksOf(container: object): number {
    const known = this.#linksIn.get(container);
    if (known !== undefined) return known;
    let links = 0;
    for (const member of Object.values(container)) {
      if (this.#holdsLinks(member)) links += 1;
    }
    return links;
  }

  /**
   * Puts `value`, a value as the store holds one, at `path` of a document
   * in the place of what the path holds, or with `remove` takes the member
   * at `path` out of the record that holds it. Each container on the way
   * is replaced by a copy that holds the new member, and every other
   * container stays the object it was. Returns whether each container on
   * the way exists; where one does not, nothing is changed.
   */
  #setAt(
    document: { kind: string; value: unknown },
    path: readonly string[],
    value: unknown,
    remove = false,
  ): boolean {
    if (path.length === 0) {
      document.value = value;
      return true;
    }
    const holders: Record<string, unknown>[] = [];
    let holder = document.value;
    for (const segment of path) {
      if (typeof holder !== "object" || holder === null) return false;
      holders.push(holder as Record<string, unknown>);
      holder = (holder as Record<string, unknown>)[segment];
    }
    let next = value;
    let removed = remove;
    for (let index = path.length - 1; index >= 0; index--) {
      const from = holders[index];
      const name = path[index];
      let links = this.#linksOf(from) - (this.#holdsLinks(from[name]) ? 1 : 0);
      let copy: Record<string, unknown>;
      if (Array.isArray(from)) {
        copy = copyOfArray(from) as unknown as Record<string, unknown>;
        copy[name] = next;
      } else {
        copy = { ...from };
        if (removed) {
          delete copy[name];
        } else if (Object.hasOwn(from, name) || isIndexName(name)) {
          copy[name] = next;
        } else {
          // A name the record gets is put where the order of the storage
          // has it.
          const names = Object.keys(from);
          const last = names[names.length - 1];
          copy[name] = next;
          if (
            last !== undefined && !isIndexName(last) &&
            utf8Compare(last, name) > 0
          ) {
            const ordered: Record<string, unknown> = {};
            for (const each of Object.keys(copy).sort(utf8Compare)) {
              ordered[each] = copy[each];
            }
            copy = ordered;
          }
        }
      }
      if (!removed && this.#holdsLinks(next)) links += 1;
      this.#replaced(from, copy, links, removed ? [] : [next]);
      next = copy;
      removed = false;
    }
    document.value = next;
    return true;
  }

  /**
   * Replaces the stored array `held` at `path` of a document by a copy with
   * a splice applied: `removed` members from `start` on give way to
   * `members`. Returns the members the splice took out.
   */
  #spliced(
    document: { kind: string; value: unknown },
    path: readonly string[],
    held: readonly unknown[],
    start: number,
    removed: number,
    members: readonly unknown[],
  ): unknown[] {
    const next = copyOfArray(held);
    const kept = members.map((member) => this.#keep(member));
    const taken = spliceIn(next, start, removed, kept);
    let links = this.#linksOf(held);
    for (const member of taken) if (this.#holdsLinks(member)) links -= 1;
    for (const member of kept) if (this.#holdsLinks(member)) links += 1;
    this.#replaced(held, next, links, kept);
    this.#setAt(document, path, next);
    return taken;
  }

  /**
   * The places that hold nothing until a write: a state cell has no
   * document when it is created, and a read of it reads the default of
   * its schema (`plan-and-label-templates.md` §1.3, "The first value of
   * a state cell").
   */
  readonly declared = new Map<string, { kind: string; default: unknown }>();
  /** Counts the writes and the evaluations whose value changed. */
  clock = 0;
  /**
   * Where a caller sets it: every write since, with where it was made and
   * the clock after it. Nothing is kept where no caller did, so the store
   * holds nothing that grows with the number of writes made.
   */
  log: { doc: string; path: readonly string[]; at: number }[] | undefined;
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
          found.push({ path: at, stream: copyOfData(held.$stream) });
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
   * Called for a write that leaves the value at its path as it was, with
   * the document, the path and the schema of the reference the write was
   * made through. The write is no change: nothing is journaled and no
   * reader is marked.
   */
  onUnchanged:
    | ((doc: string, path: readonly string[], schema?: Schema) => void)
    | undefined;

  /**
   * Called after each change of a document, with what changed: whoever
   * keeps an index from a position to its readers marks them
   * (`scheduler-and-serving-loop.md` §3.1). `keyed` is absent where the
   * change is in no array, and otherwise says, for each array on the way
   * to the path and for an array at it, which keys changed what they
   * hold or whether a position holds them: `keys` is absent where every
   * key may have. `array` is what stands for the array through its
   * changes (`lineageOf`), and `now` is what stands for the array that a
   * write of the whole array put in its place.
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
        /**
         * The shortest path the change covers, where it is shorter than
         * `path`: a write below a value that held no container replaced that
         * value with one.
         */
        covers?: readonly string[];
        /** The schema of the reference a write or a splice was made through. */
        schema?: Schema;
      },
    ) => void)
    | undefined;

  /**
   * Called for each position a read goes through, with the document and
   * the path: the position of each link the read follows, and the
   * position it ends at. Whoever keeps the documents in a store with a
   * journal of reads, as the runtime's transactions do, records the read
   * there. `by` is the body and the entry of its `Body.handles` that the
   * read is made through, while `reader` names one.
   */
  onRead:
    | ((
      doc: string,
      path: readonly string[],
      by?: ReadThrough,
    ) => void)
    | undefined;

  /**
   * The body and the handle of the read being made through a handle, and
   * each position that read went through so far (PL §1.1,
   * `DynamicRead`).
   */
  reader:
    | { by: ReadThrough; seen: { doc: string; path: string[] }[] }
    | undefined;

  /**
   * What each change of a transaction in progress replaced, in order,
   * while a transaction keeps one: enough to put back what a path held
   * before the transaction, without a copy of its document.
   */
  journal: Undo[] | undefined;

  /**
   * Where a caller sets it: for each stored array whose last changes were
   * additions at its end, by the text of its document and path, the first
   * position of the members those additions placed. An array has no entry
   * once a change removed, moved or replaced a member at or behind that
   * position, or wrote the array whole with other members.
   */
  appended: Map<string, number> | undefined;

  /**
   * While `appended` is set: the arrays, and the paths above arrays, that
   * a change other than an addition at the end was made at.
   */
  readonly changedOtherwise = new Set<string>();

  /**
   * Whether a change other than an addition at its end was made of the
   * stored array at `ref`, or at a path above it, while `appended` was
   * set.
   */
  changedOtherwiseAt(ref: Ref): boolean {
    const reported = this.onRead;
    this.onRead = undefined;
    try {
      const located = this.locate(ref, true);
      const key = arrayKey(located.ref.doc, located.ref.path);
      for (const changed of this.changedOtherwise) {
        if (key.startsWith(changed)) return true;
      }
      return false;
    } finally {
      this.onRead = reported;
    }
  }

  /**
   * The position whose value a read of `ref` gives (`Handle.get`): past
   * each write redirect at `ref`, past the one link the position then
   * holds, and past each write redirect after that link. It is found with
   * no read reported: what calls it has read through `ref` already, and
   * went through these positions then.
   */
  oneLinkPast(ref: Ref): Located {
    const { onRead, reader } = this;
    this.onRead = undefined;
    this.reader = undefined;
    try {
      const at = this.locate(ref, "redirects");
      if (!isLink(at.value)) return at;
      const { doc, path, schema } = at.value.$link;
      return this.locate(new Ref(doc, path, schema ?? ref.schema), "redirects");
    } finally {
      this.onRead = onRead;
      this.reader = reader;
    }
  }

  /**
   * The first position of the members that additions at the end of the
   * stored array at `ref` placed, with no member removed, moved or
   * replaced since (`appended`), or `undefined` where there is none or
   * nothing keeps track.
   */
  appendedFrom(ref: Ref): number | undefined {
    if (this.appended === undefined) return undefined;
    const reported = this.onRead;
    this.onRead = undefined;
    try {
      const located = this.locate(ref, true);
      return located.missing
        ? undefined
        : this.appended.get(arrayKey(located.ref.doc, located.ref.path));
    } finally {
      this.onRead = reported;
    }
  }

  /**
   * The position a splice that is written as a whole list adds from, while
   * that write is made.
   */
  #adding: number | undefined;

  /** Brings `appended` up to date with one change. */
  #noteAppended(
    appended: Map<string, number>,
    doc: string,
    path: readonly string[],
    old: unknown,
    splice?: { start: number; removed: number; inserted: number },
  ): void {
    const key = arrayKey(doc, path);
    const now = this.peek(doc, path);
    // The position from which the change is one of additions at the end
    // of the array at `path` alone, where it is one.
    let from: number | undefined;
    if (splice !== undefined) {
      if (
        Array.isArray(now) && splice.removed === 0 &&
        splice.start + splice.inserted === now.length
      ) from = splice.start;
    } else if (this.#adding !== undefined && Array.isArray(now)) {
      from = this.#adding;
    } else if (
      Array.isArray(old) && Array.isArray(now) && old.length < now.length &&
      old.every((member, index) => sameStored(member, now[index]))
    ) from = old.length;
    if (from !== undefined) {
      if (!appended.has(key)) appended.set(key, from);
      return;
    }
    // A member replaced where it stands, before the members the additions
    // placed, leaves those as they are.
    if (splice !== undefined || Array.isArray(old) || Array.isArray(now)) {
      this.changedOtherwise.add(key);
    }
    const kept = splice !== undefined && splice.removed === splice.inserted &&
      splice.start + splice.removed <= (appended.get(key) ?? 0);
    for (const other of [...appended.keys()]) {
      if (other === key ? !kept : other.startsWith(key)) {
        appended.delete(other);
      }
    }
    // A write of one position of an array replaces the member there.
    const last = path[path.length - 1];
    if (splice === undefined && last !== undefined && /^\d+$/.test(last)) {
      const above = arrayKey(doc, path.slice(0, -1));
      if (Number(last) >= (appended.get(above) ?? Infinity)) {
        appended.delete(above);
      }
      if (Array.isArray(this.peek(doc, path.slice(0, -1)))) {
        this.changedOtherwise.add(above);
      }
    }
  }

  /** A change was made: the clock, the log, the keys, and the readers. */
  #changed(
    doc: string,
    path: readonly string[],
    old: unknown,
    splice?: { start: number; removed: number; inserted: number },
    reported: { covers?: readonly string[]; schema?: Schema } = {},
  ): void {
    this.clock += 1;
    this.log?.push({ doc, path, at: this.clock });
    this.#noteChange(doc, path);
    if (this.appended !== undefined) {
      this.#noteAppended(this.appended, doc, path, old, splice);
    }
    const keyed = this.#touch(doc, path, splice, old);
    this.parts?.changed(doc, path, this.docs.get(doc)?.value, old, splice);
    this.onChange?.({
      doc,
      path,
      old,
      ...(splice === undefined ? {} : { splice }),
      keyed,
      ...(reported.covers === undefined ? {} : { covers: reported.covers }),
      ...(reported.schema === undefined ? {} : { schema: reported.schema }),
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
      value: copyOfData(
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
          : { value: copyOfData(undo.old.value) };
        continue;
      }
      if (copy === undefined || !isPrefix(top, undo.path)) continue;
      const rest = undo.path.slice(top.length);
      if (rest.length === 0 && !("splice" in undo)) {
        copy.value = copyOfData(undo.old);
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
            copyOfData(undo.splice.removed),
          );
        }
      } else if (undo.old === undefined && !Array.isArray(holder)) {
        delete holder[name];
      } else {
        holder[name] = copyOfData(undo.old);
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
      const holder = this.peek(doc, path.slice(0, -1));
      if (typeof holder !== "object" || holder === null) return;
      this.#setAt(
        held,
        path,
        this.#keep(value),
        value === undefined && !Array.isArray(holder),
      );
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
      if ("splice" in undo) {
        const array = this.peek(undo.doc, undo.path);
        if (Array.isArray(array)) {
          const taken = this.#spliced(
            held,
            undo.path,
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
      const holder = this.peek(undo.doc, undo.path.slice(0, -1));
      if (typeof holder !== "object" || holder === null) continue;
      const now = this.peek(undo.doc, undo.path);
      this.#setAt(
        held,
        undo.path,
        undo.old,
        undo.old === undefined && !Array.isArray(holder),
      );
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

  /**
   * Where a write of `value` at `ref` lands. A write follows the links on
   * its path and each write redirect at its position, and replaces any
   * other link there; a write redirect replaces what the position holds.
   * So does today's runtime (`normalizeAndDiff` in
   * `runtime/runner/src/data-updating.ts`).
   */
  landing(ref: Ref, value?: unknown, reads?: Position[]): Located {
    return this.locate(
      ref,
      isLink(value) && value.$link.redirect === true ? false : "redirects",
      reads,
    );
  }

  /**
   * The cell an input names, for `ref` at a position of an argument
   * document: past each write redirect at the position, and past the link
   * the argument then holds to the cell the instance was given. A link
   * that a position of another document holds is part of what the cell
   * holds, and is not passed.
   */
  pastBinding(ref: Ref): Ref {
    let at = ref;
    for (let hops = 0; hops < MAX_LINKS; hops++) {
      const { value, ref: position } = this.locate(at, false);
      if (!isLink(value)) return at;
      const next = new Ref(
        value.$link.doc,
        value.$link.path,
        value.$link.schema ?? at.schema,
      );
      if (value.$link.redirect !== true) {
        return position.doc === ref.doc ? next : at;
      }
      at = next;
    }
    return at;
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
   * and the key fields. A write below an array and a splice of it replace
   * the array with a copy, which gets the keys (`#replaced`), and the keys
   * are then brought up to date for the positions that the change touched
   * (`#touch`).
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

  /**
   * Notes what forming a part read of other documents: each document
   * whole for the reads of a member that is a plain value, and for the
   * reads that found what a member that is a link names (`named`) the
   * positions themselves, since the key of such a member is the address
   * the link names and nothing of what is stored there. Each is noted
   * once.
   */
  #others(
    state: KeyState,
    reads: readonly Position[],
    named: readonly Position[] = [],
  ): void {
    const array = this.locate(state.at, true).ref;
    const known = new Set(
      state.others.map(({ doc, path, own }) =>
        own ? JSON.stringify([doc, path]) : doc
      ),
    );
    for (const { doc, path } of reads) {
      if (doc === array.doc && isPrefix(array.path, path)) continue;
      if (known.has(doc)) continue;
      known.add(doc);
      state.others.push({ doc, path: [] });
    }
    for (const { doc, path } of named) {
      if (doc === array.doc && isPrefix(array.path, path)) continue;
      const text = JSON.stringify([doc, path]);
      if (known.has(doc) || known.has(text)) continue;
      known.add(text);
      state.others.push({ doc, path: [...path], own: true });
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
      const id = positionText(state.at);
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
          array: this.lineageOf(value),
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
          array: this.lineageOf(value),
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
        array: this.lineageOf(old),
        ...(Array.isArray(value) ? { now: this.lineageOf(value) } : {}),
      });
      return keyed;
    }
    let head = 0;
    while (
      head < old.length && head < value.length &&
      sameStored(old[head], value[head])
    ) head += 1;
    let tail = 0;
    while (
      tail < old.length - head && tail < value.length - head &&
      sameStored(old[old.length - 1 - tail], value[value.length - 1 - tail])
    ) tail += 1;
    this.#states.delete(old);
    this.#states.set(value, states);
    for (const state of states.values()) state.held = value;
    keyed.push({
      array: this.lineageOf(old),
      now: this.lineageOf(value),
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

  /**
   * A stored plain value with each link in it replaced by a record of the
   * address the link names. `namings` gets the reads that found what each
   * link names.
   */
  #linksNamed(value: unknown, namings: Position[]): unknown {
    if (isLink(value)) {
      const { named } = this.locate(
        new Ref(value.$link.doc, value.$link.path),
        true,
        namings,
        true,
      );
      return { $named: this.addressOf(named) };
    }
    if (Array.isArray(value)) {
      return value.map((member) => this.#linksNamed(member, namings));
    }
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map((
          [name, member],
        ) => [name, this.#linksNamed(member, namings)]),
      );
    }
    return value;
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
      const space = this.spaces.get(named.doc) ?? this.#space;
      return {
        ...(space === undefined ? {} : { space }),
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
   *
   * With `whole`, `copies` hold every member of what the positions hold:
   * a read under no schema gave them, or one under a schema that left no
   * member out. Where no position then is a link or holds one, the keys
   * are those the store forms from the array alone, and from the second
   * such read of an array on it keeps them and brings them up to date as
   * it does those: a third read of the array forms no key. The keys of a
   * read that left a member out are not kept.
   */
  keysOf(
    held: readonly unknown[],
    at: Ref,
    copies?: readonly unknown[],
    fields: readonly string[] = [],
    whole = false,
  ): string[] {
    return [...this.#keysOf(held, at, copies, fields, whole)];
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
    whole = false,
  ): string[] {
    const id = positionText(at);
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
    // The reads that found what a member that is a link names.
    const namings: Position[] = [];
    try {
      const parts = held.map((member, index): ElementPart => {
        if (isLink(member)) {
          // What the link names, with no key resolved: a link to an
          // element by key is keyed by that reference.
          const { named } = this.locate(
            new Ref(member.$link.doc, member.$link.path),
            true,
            namings,
            true,
          );
          return this.addressOf(named);
        }
        if (reentered) return { position: index };
        // A plain member that holds links is keyed by its own content with
        // each link as the address of what it names: nothing the links
        // lead to is read, so the work is the size of the member and not
        // of everything reachable from it, and a change of a document a
        // link leads to forms no key.
        if (copies === undefined && holdsLink(member)) {
          return this.partOf(this.#linksNamed(member, namings), fields);
        }
        return this.partOf(
          copies === undefined
            ? this.read(at.key(`${index}`), reads)
            : copies[index],
          fields,
        );
      });
      const keys = keysOfParts(parts);
      // Copies of a read under no schema, of positions that hold no link,
      // are what the store reads at those positions itself.
      // Kept keys are brought up to date at each write to the array, which
      // reads the member written. That pays for an array that is read
      // whole again and again, and costs for one that is read once and
      // then written member by member, so the keys of copies are kept
      // from the second such read of an array on.
      let kept = copies === undefined;
      if (!kept && whole && !reentered && !held.some(holdsLink)) {
        kept = this.#readWhole.has(held);
        this.#readWhole.add(held);
      }
      if (!reentered && kept && this.clock === clock) {
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
        this.#others(state, reads, namings);
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
    /**
     * Whether a link at the position itself is followed: every link, or
     * with `redirects` each write redirect and no other link.
     */
    through: boolean | "redirects",
    reads?: Position[],
    /** Stop at a key: the reference is named and no key is resolved. */
    names = false,
    /**
     * The members a read under a schema takes of a record at the position
     * (`declaredMembers`). Where the position holds a record with a member
     * that is none of these, and the path crossed no key, the positions of
     * these members are the ones read, and the position of the record is
     * not: a change of another member of the record is no change of what
     * the read gave. A change at the position or above it is one of every
     * member.
     */
    members?: readonly string[],
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
      while (
        isLink(value) &&
        (rest.length > 0 || through === true ||
          (through === "redirects" && value.$link.redirect === true))
      ) {
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
        this.#read(doc, at);
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
      // A path below a position that holds an error state reads that error
      // state, as a read of a member of a value in an error state does
      // (PL §5.2): a reader through a reference that crosses it fails.
      if (rest.length > 0 && isErrorState(value)) break;
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
        // The rows of a collection that are stored under their element
        // keys are found by those keys (`rowKeys`), and no key is formed
        // from what a row holds. Such a key does not follow what the row
        // holds, so the read keeps no copy of the row to find a change of
        // the key by: it reads the position that holds the row now.
        const rows = this.rowKeys.get(JSON.stringify([doc, at]));
        if (
          rows === undefined && reads !== undefined &&
          this.#beforeKeys.has(reads)
        ) {
          reads = undefined;
        } else if (
          rows === undefined && reads !== undefined && !this.#plain.has(reads)
        ) {
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
              ...(Array.isArray(value) ? { array: this.lineageOf(value) } : {}),
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
          !Array.isArray(held)
            ? -1
            : rows !== undefined
            ? this.#rowPosition(rows(), key)
            : this.#positionOf(
              this.#keysOf(held, here, undefined, fieldsOfKey(key)),
              key,
            );
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
    if (
      members !== undefined && crossed.length === 0 && !missing &&
      isRecord(value) && !isLink(value) && !isStream(value) &&
      Object.keys(value).some((name) => !members.includes(name))
    ) {
      for (const name of members) {
        reads?.push({ doc, path: [...at, name] });
        this.#read(doc, [...at, name]);
      }
    } else {
      reads?.push({ doc, path: at });
      this.#read(doc, at);
    }
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
   * `locate`, for a caller that takes the position found and the positions
   * the read went through, and nothing of a read by key: where `locate`
   * would put one read by key in the place of the positions from a key on,
   * `crossed` gets nothing from the key on, and the element the key names
   * is not read to keep what it holds.
   */
  locateCrossed(ref: Ref, through: boolean, crossed: Position[]): Located {
    this.#beforeKeys.add(crossed);
    return this.locate(ref, through, crossed);
  }

  /** The lists of reads that end at the first key (`locateCrossed`). */
  readonly #beforeKeys = new WeakSet<Position[]>();

  /** Reports a position a read went through (`onRead`, `reader`). */
  #read(doc: string, path: string[]): void {
    const { reader } = this;
    reader?.seen.push({ doc, path });
    this.onRead?.(doc, path, reader?.by);
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
   * A document that two links of one read lead to is given once.
   *
   * With `bound`, the read is made under that schema, as a read through a
   * handle is (LS §7.8, ES §2.4): a member of a record that the schema
   * does not declare is left out, and a link at a position the schema
   * types `unknown` is given as a reference stand-in, an object with no
   * member that carries the address, and not followed.
   *
   * A read without `copies` gives a container that holds no link, no
   * stream and no error state as the frozen object the store holds, where
   * the schema of the read leaves no member of it out and fills in no
   * default. The work of such a read does not follow the size of the
   * container. Its address is in `handed`, and those of the containers
   * below it are what `addressesBelow` gives.
   */
  read(ref: Ref, reads?: Position[], copies = false, bound?: Schema): unknown {
    const outer = this.#reached;
    this.#reached = new Map();
    try {
      return this.#deep(ref, reads, new Set(), copies, bound);
    } finally {
      this.#reached = outer;
    }
  }

  /**
   * What the read under way gave for each document it followed a link
   * to, by the schema it was read under. A document that two links of
   * one read lead to is given once, as one value, so that a read of
   * references that share their targets follows each target once.
   */
  #reached: Map<Schema | undefined, Map<string, unknown>> | undefined;

  #deep(
    ref: Ref,
    reads: Position[] | undefined,
    open: Set<string>,
    copies: boolean,
    bound?: Schema,
  ): unknown {
    const located = this.locate(
      ref,
      true,
      reads,
      false,
      declaredMembers(bound),
    );
    const id = positionText(located.ref);
    if (open.has(id)) return undefined;
    const reached = this.#reached?.get(bound);
    if (reached?.has(id)) return reached.get(id);
    if (located.value === undefined && isStreamSchema(located.ref.schema)) {
      return { $stream: true };
    }
    // A reference by key whose key no position holds reads as nothing
    // (ruling Z24), whatever default a link on the way to it declares.
    if (located.missing && located.value === undefined) return undefined;
    const shape = bound ?? located.ref.schema;
    if (
      !copies && this.plain(located.value) &&
      (bound === undefined || this.#nothingLeftOut(located.value, shape)) &&
      this.#noDefaults(located.value, shape)
    ) {
      this.handed.set(located.value, {
        at: located.named,
        shape,
        given: located.given,
        bounded: bound !== undefined,
      });
      if (this.#reached !== undefined) {
        if (!this.#reached.has(bound)) this.#reached.set(bound, new Map());
        this.#reached.get(bound)!.set(id, located.value);
      }
      return located.value;
    }
    open.add(id);
    const copied = copies && located.inPlace;
    // A container that is copied to fill in a default keeps the address
    // it was read from.
    const value = withDefaults(
      located.value === undefined && located.fallback !== undefined
        ? copyOfData(located.fallback)
        : this.#copy(
          located.value,
          reads,
          open,
          located.named,
          copies,
          copied,
          bound ?? located.ref.schema,
          located.given,
          bound !== undefined,
        ),
      bound ?? located.ref.schema,
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
    if (this.#reached !== undefined) {
      if (!this.#reached.has(bound)) this.#reached.set(bound, new Map());
      this.#reached.get(bound)!.set(id, value);
    }
    return value;
  }

  /** The stored arrays whose keys a whole read has formed from its copies. */
  readonly #readWhole = new WeakSet<object>();

  /**
   * How many members the reads under a schema left out of their copies,
   * in all: a read that leaves it as it was copied every member.
   */
  #leftOut = 0;

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
    /** Whether the read is made under `shape` (`read()`, `bound`). */
    bounded = false,
  ): unknown {
    if (isLink(value)) {
      const { doc, path, schema } = value.$link;
      // The position of a link the value holds is one the read crossed,
      // where its path names the position and not an element by its key.
      const stops = bounded && unread(shape);
      if (!at.path.some(isKeySegment)) {
        reads?.push({
          doc: at.doc,
          path: at.path,
          ...(stops ? { stopped: true as const } : {}),
        });
      }
      const target = new Ref(doc, path, schema);
      if (stops) {
        const standIn = Object.freeze({});
        this.addresses.set(standIn, target);
        return standIn;
      }
      return this.#deep(
        target,
        reads,
        open,
        copies,
        bounded ? shape ?? {} : undefined,
      );
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
      const outer = bounded ? containerOf(shape) : shape;
      const items = typeof outer === "object" ? outer.items : undefined;
      const leftOut = this.#leftOut;
      // A member that is no container, no link and no stream is given as
      // it is, and no reference to its position is made for it.
      const copy = value.map((member, index) =>
        typeof member !== "object" || member === null ? member : this.#copy(
          member,
          reads,
          open,
          here.key(`${index}`),
          copies,
          copies,
          bounded ? items ?? {} : items,
          typeof given === "object" ? given.items : undefined,
          bounded,
        )
      );
      if (containers) {
        const declared = keyFieldsOf(shape);
        const keys = this.keysOf(
          value,
          here,
          copy,
          declared.length > 0 ? declared : keyFieldsOf(given),
          // The copies hold every member of what is stored where the read
          // is under no schema, or under one that left no member out.
          !bounded || this.#leftOut === leftOut,
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
      this.copiedByReads += 1;
      if (copied) this.copies.add(copy);
      else this.addresses.set(copy, here);
      return copy;
    }
    if (isRecord(value)) {
      const outer = bounded ? containerOf(shape) : shape;
      const declared = bounded ? declaredMembers(shape) : undefined;
      // The members in the order of the storage, whatever order the
      // process that wrote the record holds them in (`membersInOrder`).
      const copy = Object.fromEntries(
        membersInOrder(value).filter((name) => {
          if (declared === undefined || declared.includes(name)) return true;
          this.#leftOut += 1;
          return false;
        }).map((name) => [
          name,
          typeof value[name] !== "object" || value[name] === null
            ? value[name]
            : this.#copy(
              value[name],
              reads,
              open,
              here.key(name),
              copies,
              copied,
              bounded
                ? schemaBelow(outer, name) ?? {}
                : schemaBelow(shape, name),
              schemaBelow(given, name),
              bounded,
            ),
        ]),
      );
      this.copiedByReads += 1;
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
   * written is itself a link. The store holds the value that it is given,
   * frozen with every container in it (`#keep`): the caller changes
   * nothing of it afterwards.
   */
  write(ref: Ref, given: unknown): void {
    const value = this.#keep(given);
    const located = this.landing(ref, value);
    // A write through a reference by key whose key no position holds is
    // refused (`plan-and-label-templates.md` §1.3, assumed there under
    // question 112).
    if (located.missing) throw new MissingKey();
    const { doc, path } = located.ref;
    let document = this.docs.get(doc);
    if (document?.kind === OUTPUT) throw new ComputedOutput();
    if (document === undefined) {
      // The first write of a declared place makes its document. A write
      // below the root starts from the default the place read as. So does
      // the first write of a document no place of the instance declares,
      // as the state cell of another instance that nothing wrote yet,
      // which a link leads to: today's runtime makes the document a write
      // reaches, and the write is not lost. A write below its root starts
      // from nothing, and a reader takes the members it lacks from the
      // schema it reads under.
      const declared = this.declared.get(doc);
      this.onWrite?.(doc, path);
      this.journal?.push({ doc, whole: true, old: undefined });
      document = {
        kind: declared?.kind ?? "external",
        value: path.length === 0 || declared === undefined
          ? undefined
          : copyOfData(declared.default),
      };
      this.docs.set(doc, document);
    } else if (sameStored(located.value, value)) {
      this.onUnchanged?.(doc, path, located.ref.schema);
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
      // The shortest path whose value the write replaced with a container.
      let covers: readonly string[] | undefined;
      if (!isRecord(document.value) && !Array.isArray(document.value)) {
        this.journal?.push({ doc, path: [], old: document.value });
        document.value = this.#keep({});
        covers = [];
      }
      let holder = document.value as Record<string, unknown>;
      for (let index = 0; index < path.length - 1; index++) {
        const next = (holder as Record<string, unknown>)[path[index]];
        if (typeof next !== "object" || next === null) {
          const above = path.slice(0, index + 1);
          this.journal?.push({ doc, path: above, old: next });
          this.#setAt(
            document,
            above,
            this.#keep(/^\d+$/.test(path[index + 1]) ? [] : {}),
          );
          covers ??= above;
          holder = this.peek(doc, above) as Record<string, unknown>;
        } else {
          holder = next as Record<string, unknown>;
        }
      }
      const reported = {
        ...(covers === undefined ? {} : { covers }),
        ...(located.ref.schema === undefined
          ? {}
          : { schema: located.ref.schema }),
      };
      const last = path[path.length - 1];
      if (Array.isArray(holder) && last === "length") {
        // The array is stored without the positions past the length.
        const length = value as number;
        const taken = this.#spliced(
          document,
          path.slice(0, -1),
          holder,
          length,
          holder.length - length,
          [],
        );
        this.journal?.push({
          doc,
          path: path.slice(0, -1),
          splice: { start: length, inserted: 0, removed: taken },
        });
        this.#changed(doc, path.slice(0, -1), taken, {
          start: length,
          removed: taken.length,
          inserted: 0,
        }, reported);
      } else {
        old = holder[last];
        this.journal?.push({ doc, path, old });
        this.#setAt(document, path, value);
        this.#changed(doc, path, old, undefined, reported);
      }
    }
    if (path.length === 0) {
      this.#changed(
        doc,
        path,
        old,
        undefined,
        located.ref.schema === undefined ? {} : { schema: located.ref.schema },
      );
    }
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
   * Changes the members of a stored array: removes `removed` members
   * from `start` on and puts `members`, in stored form, in their place,
   * as one change of the array, which a copy with the change then stands
   * for (`PatchOp` in
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
      // A splice that adds at the end of a list no document holds yet is
      // an addition, written as the whole list.
      this.#adding = removed === 0 && start === before.length
        ? start
        : undefined;
      try {
        this.write(ref, [
          ...before.slice(0, start),
          ...members,
          ...before.slice(start + removed),
        ]);
      } finally {
        this.#adding = undefined;
      }
      return;
    }
    if (removed === 0 && members.length === 0) return;
    this.onWrite?.(doc, path);
    const taken = this.#spliced(document, path, held, start, removed, members);
    this.journal?.push({
      doc,
      path,
      splice: { start, inserted: members.length, removed: taken },
    });
    this.#changed(doc, path, taken, {
      start,
      removed: taken.length,
      inserted: members.length,
    }, located.ref.schema === undefined ? {} : { schema: located.ref.schema });
  }

  /**
   * Stores a value at a path of a document, with no link followed: the
   * write of the runtime to a document that it lays out itself, as the
   * result document is. A value that the path holds already is not
   * written.
   */
  put(doc: string, path: readonly string[], given: unknown): void {
    const document = this.docs.get(doc);
    if (document === undefined) return;
    const old = this.peek(doc, path);
    const value = this.#keep(given);
    if (sameStored(old, value)) return;
    this.onWrite?.(doc, path);
    if (path.length === 0) {
      this.journal?.push({ doc, path, old });
      document.value = value;
    } else {
      const holder = this.peek(doc, path.slice(0, -1));
      if (typeof holder !== "object" || holder === null) return;
      this.journal?.push({ doc, path, old });
      // A record that is put nothing at a member holds no such member.
      this.#setAt(
        document,
        path,
        value,
        value === undefined && !Array.isArray(holder),
      );
    }
    this.#changed(doc, path, old);
  }

  /**
   * Takes `value` as what a document holds at a path, where a store
   * outside the executor holds it there already: nothing is told of it as
   * a change, the clock stands, and no reader is marked. Does nothing
   * where a segment on the way does not exist.
   */
  adopt(doc: string, path: readonly string[], value: unknown): void {
    const document = this.docs.get(doc);
    if (document === undefined) return;
    this.#setAt(document, path, this.#keep(value));
  }

  /**
   * Holds `keys` as the keys of the stored array `held`, formed with
   * `fields` through `at`, as `keysOf` holds the keys it forms: `parts` is
   * the element part of each position. For a caller that knows the part
   * of each position without a read of what the position leads to. The
   * keys then stand until the array changes, and the store brings them up
   * to date with each change of it.
   */
  adoptKeys(
    held: readonly unknown[],
    at: Ref,
    fields: readonly string[],
    parts: ElementPart[],
    keys: string[],
  ): void {
    const named = JSON.stringify(fields);
    const known = this.#states.get(held)?.get(named);
    const texts = parts.map(textOf);
    const counts = new Map<string, number>();
    for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
    const states = this.#states.get(held) ?? new Map<string, KeyState>();
    states.set(named, {
      at,
      fields: [...fields],
      held,
      keys,
      parts,
      texts,
      counts,
      clock: this.clock,
      others: [],
      formed: (known?.formed ?? 0) + 1,
      ops: [],
      dropped: 0,
    });
    this.#states.set(held, states);
  }

  /** The splice of `splice`, at a path of a document, with no link followed. */
  spliceAt(
    doc: string,
    path: readonly string[],
    start: number,
    removed: number,
    members: readonly unknown[],
  ): void {
    const document = this.docs.get(doc);
    const held = this.peek(doc, path);
    if (document === undefined || !Array.isArray(held)) return;
    if (removed === 0 && members.length === 0) return;
    this.onWrite?.(doc, path);
    const taken = this.#spliced(document, path, held, start, removed, members);
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

  /**
   * The time of the last change at each path of each document, and of the
   * last change at or below it: what `changedSince` reads, so that its work
   * is the length of a path and not the number of changes made.
   */
  readonly #changes = new Map<string, ChangeNode>();

  /** The nodes `changedSince` visited, in all its calls. */
  changeNodesVisited = 0;

  /** Notes a change at a path in `#changes`. */
  #noteChange(doc: string, path: readonly string[]): void {
    // A change of a scope instance is one of that instance alone.
    const instance = this.scopes?.resolve(doc) ?? doc;
    let node = this.#changes.get(instance);
    if (node === undefined) {
      node = { at: 0, below: 0 };
      this.#changes.set(instance, node);
    }
    node.below = this.clock;
    for (const segment of path) {
      node.children ??= new Map();
      let child = node.children.get(segment);
      if (child === undefined) {
        child = { at: 0, below: 0 };
        node.children.set(segment, child);
      }
      child.below = this.clock;
      node = child;
    }
    node.at = this.clock;
  }

  /** Whether a write after `since` is at, above, or below a position. */
  changedSince(since: number, positions: readonly Position[]): boolean {
    if (this.clock <= since) return false;
    for (const { keyed } of positions) {
      if (
        keyed !== undefined && canonical(this.read(keyed.ref)) !== keyed.seen
      ) {
        return true;
      }
    }
    for (const position of positions) {
      if (position.keyed !== undefined) continue;
      let node = this.#changes.get(
        this.scopes?.resolve(position.doc) ?? position.doc,
      );
      let depth = 0;
      // A change at a path above the position, and then one at or below it.
      while (node !== undefined) {
        this.changeNodesVisited += 1;
        if (depth === position.path.length) {
          if ((position.own ? node.at : node.below) > since) return true;
          break;
        }
        if (node.at > since) return true;
        node = node.children?.get(position.path[depth]);
        depth += 1;
      }
    }
    return false;
  }
}
