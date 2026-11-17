/**
 * The documents of one executed instance, held in memory.
 *
 * A document is a JSON value. A position of a document can hold a link to
 * a position of another document, and a read of a path continues at the
 * target of each link it meets, as `execution-and-storage.md` §2.2 says of
 * a slot's path ("A slot's path is resolved through links").
 */

/** The members of a JSON schema the executor reads. */
export type Schema = boolean | {
  type?: string | string[];
  default?: unknown;
  properties?: Record<string, Schema>;
  items?: Schema;
  asCell?: unknown;
  /**
   * In the schema of the items of an array: the key field that the
   * element type declares with `KeyedBy<T, "field">`
   * (`plan-and-label-templates.md` §1.3, "A declared key field").
   */
  keyField?: string;
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

const KEY = "$key:";

/**
 * The segment of a path that names an element of an array by its key and
 * not by its position (`plan-and-label-templates.md` §1.3, "A plain value
 * in place has an identity"). A reference whose path holds one is a
 * reference by key: the path up to the segment is the address of the
 * collection, the segment holds the key, and the rest is the path below
 * the element. A read or a write through it finds the position that
 * holds the key at that time.
 */
export const keySegment = (key: string): string => `${KEY}${key}`;

export const isKeySegment = (segment: string): boolean =>
  segment.startsWith(KEY);

const FIELDS = "fields:";

/** Whether a value can be the value of a key field: a string or a number. */
const isKeyValue = (value: unknown): value is string | number =>
  typeof value === "string" || typeof value === "number";

/**
 * The value of a key field as a key holds it: a number as `#` and its
 * canonical form, and a string as it is, so the number 7 and the string
 * `7` are two keys.
 */
const written = (value: string | number): string =>
  typeof value === "number" ? `#${canonical(value)}` : value;

/**
 * The element part of the key of a plain value
 * (`plan-and-label-templates.md` §1.3). With `field`, the key field the
 * element type declares, and a value that is a record whose field holds
 * a string or a number, the part names the field: `fields:`, the name,
 * `=`, and the value of the field (ruling Z44). Any
 * other value is keyed whole, as `value:` and its canonical form, which
 * names no field. So a key formed from a field `id` that holds 7 is not
 * the key of a whole value 7.
 */
export const valuePart = (value: unknown, field?: string): string =>
  field !== undefined && isPlainRecord(value) && isKeyValue(value[field])
    ? `${FIELDS}${field}=${written(value[field])}`
    : `value:${canonical(value)}`;

/**
 * The key field that a key names, where it was formed from one: a key
 * is resolved from this alone, with no schema (ruling Z44).
 */
export const fieldOfKey = (key: string): string | undefined => {
  if (!key.startsWith(FIELDS)) return undefined;
  const end = key.indexOf("=");
  return end < 0 ? undefined : key.slice(FIELDS.length, end);
};

/** The key field that the schema of an array declares for its items. */
export const keyFieldOf = (schema: Schema | undefined): string | undefined => {
  const items = typeof schema === "object" ? schema.items : undefined;
  return typeof items === "object" ? items.keyField : undefined;
};

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
  keyed?: { ref: Ref; seen: string };
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

/** A write through a reference by key whose key no position holds. */
export class MissingKey extends Error {
  constructor() {
    super("a write through a reference by key that no position holds");
  }
}

/** The longest chain of links a read follows before it gives up. */
const MAX_LINKS = 64;

export class Store {
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
   * The link to a stream at each position that holds one, by document:
   * a write records the position of each such link in the value it
   * stores, and drops the record of a position it stores another value
   * at (ruling Z43). The entries of a document are in no stated order.
   */
  readonly streams = new Map<string, StreamPosition[]>();

  /**
   * Records the stream links of a value stored at a path of a document,
   * in place of what the record has at that path and below it.
   */
  #record(doc: string, path: readonly string[], value: unknown): void {
    const kept = (this.streams.get(doc) ?? []).filter((entry) =>
      !isPrefix(path, entry.path)
    );
    const walk = (held: unknown, at: string[]) => {
      if (isStream(held)) {
        kept.push({ path: at, stream: structuredClone(held.$stream) });
      } else if (Array.isArray(held)) {
        held.forEach((member, index) => walk(member, [...at, `${index}`]));
      } else if (isRecord(held)) {
        for (const [name, member] of Object.entries(held)) {
          walk(member, [...at, name]);
        }
      }
    };
    walk(value, [...path]);
    if (kept.length === 0) this.streams.delete(doc);
    else this.streams.set(doc, kept);
  }

  create(id: string, kind: string, value: unknown): void {
    this.docs.set(id, { kind, value });
    this.#record(id, [], value);
    this.clock += 1;
    this.log.push({ doc: id, path: [], at: this.clock });
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

  /** The arrays whose keys are being formed. */
  readonly #keying = new Set<string>();

  /**
   * The key of each position of a stored array
   * (`plan-and-label-templates.md` §1.3, "Element keys"): the identity of
   * the cell where the position holds a link, the value where it holds
   * one, and the count of the earlier positions with the same element
   * part. `copies` gives the values of the positions where the caller has
   * read them. With `field`, the key field that the collection or the
   * read declares, or that a key to resolve names, a plain value that
   * holds the field is keyed by the field and not by its whole value: a
   * change of another member changes no key (rulings Z38 and Z44). A
   * position that holds a link is keyed by its cell with or without a
   * declared field.
   */
  keysOf(
    held: readonly unknown[],
    at: Ref,
    copies?: readonly unknown[],
    field?: string,
  ): string[] {
    const id = `${at.doc}:${canonical(at.path)}`;
    // An element that holds a reference by key into its own array is
    // keyed by its position while the keys of that array are formed.
    const reentered = this.#keying.has(id);
    this.#keying.add(id);
    try {
      const seen = new Map<string, number>();
      return held.map((member, index) => {
        let part: string;
        if (isLink(member)) {
          // What the link names, with no key resolved: a link to an
          // element by key is keyed by that reference.
          const { named } = this.locate(
            new Ref(member.$link.doc, member.$link.path),
            true,
            undefined,
            true,
          );
          part = `cell:${named.doc}:${canonical(named.path)}`;
        } else if (reentered) {
          part = `position:${index}`;
        } else {
          part = valuePart(
            copies === undefined
              ? this.read(at.key(`${index}`))
              : copies[index],
            field,
          );
        }
        const count = seen.get(part) ?? 0;
        seen.set(part, count + 1);
        return `${part}#${count}`;
      });
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
   * whose key, formed with the field that the key names, is the key.
   */
  locate(
    ref: Ref,
    through: boolean,
    reads?: Position[],
    /** Stop at a key: the reference is named and no key is resolved. */
    names = false,
  ): Located {
    let doc = ref.doc;
    let value = this.#held(doc);
    let at: string[] = [];
    let named_: string[] = [];
    let schema = ref.schema;
    let fallback = typeof ref.schema === "object"
      ? ref.schema.default
      : undefined;
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
        doc = value.$link.doc;
        rest = [...value.$link.path, ...rest];
        at = [];
        named_ = [];
        inPlace = false;
        crossed = [];
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
            fallback,
          };
        }
        if (reads !== undefined) {
          const keyed = new Ref(doc, [...named_, segment, ...rest]);
          reads.push({
            doc,
            path: at,
            keyed: { ref: keyed, seen: canonical(this.read(keyed)) },
          });
          reads = undefined;
        }
        // A key that a write of the transaction in progress changed is
        // found under the key the element has now (ruling Z24).
        let key = segment.slice(KEY.length);
        const held = value;
        const here = new Ref(doc, at);
        const indexOf = (key: string) =>
          Array.isArray(held)
            ? this.keysOf(held, here, undefined, fieldOfKey(key)).indexOf(key)
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
      fallback,
    };
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
    const id = canonical(array);
    return this.rekeys.findLast((rekey) =>
      rekey.doc === doc && rekey.from === key && canonical(rekey.array) === id
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
        let key = segment.slice(KEY.length);
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

  /** Gives a document another identifier, with what it was declared as. */
  move(from: string, to: string): void {
    const document = this.docs.get(from);
    const declared = this.declared.get(from);
    this.docs.delete(to);
    this.declared.delete(to);
    if (document !== undefined) {
      this.docs.delete(from);
      this.docs.set(to, document);
    }
    const streams = this.streams.get(from);
    this.streams.delete(from);
    this.streams.delete(to);
    if (streams !== undefined) this.streams.set(to, streams);
    if (declared !== undefined) {
      this.declared.delete(from);
      this.declared.set(to, declared);
    }
    this.clock += 1;
    this.log.push({ doc: from, path: [], at: this.clock });
    this.log.push({ doc: to, path: [], at: this.clock });
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
    const id = `${located.ref.doc}\u0000${located.ref.path.join("\u0000")}`;
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
     * array are formed with the key field it declares (ruling Z44).
     */
    shape?: Schema,
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
        )
      );
      if (containers) {
        const keys = this.keysOf(value, here, copy, keyFieldOf(shape));
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
    if (document === undefined) {
      // The first write of a declared place makes its document. A write
      // below the root starts from the default the place read as.
      const declared = this.declared.get(doc);
      if (declared === undefined) return;
      document = {
        kind: declared.kind,
        value: path.length === 0
          ? undefined
          : structuredClone(declared.default),
      };
      this.docs.set(doc, document);
    } else if (JSON.stringify(located.value) === JSON.stringify(value)) {
      return;
    }
    if (path.length === 0) {
      document.value = value;
      this.#record(doc, path, value);
    } else {
      if (!isRecord(document.value) && !Array.isArray(document.value)) {
        document.value = {};
      }
      let holder = document.value as Record<string, unknown>;
      for (let index = 0; index < path.length - 1; index++) {
        const next = (holder as Record<string, unknown>)[path[index]];
        if (typeof next !== "object" || next === null) {
          holder[path[index]] = /^\d+$/.test(path[index + 1]) ? [] : {};
        }
        holder = holder[path[index]] as Record<string, unknown>;
      }
      const last = path[path.length - 1];
      if (Array.isArray(holder) && last === "length") {
        // The array is stored without the positions past the length.
        (holder as unknown[]).length = value as number;
        this.#record(doc, path.slice(0, -1), holder);
      } else {
        holder[last] = value;
        this.#record(doc, path, value);
      }
    }
    this.clock += 1;
    this.log.push({ doc, path, at: this.clock });
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
        fieldOfKey(key),
      )[index];
      if (now !== undefined && now !== key) {
        this.rekeys.push({ doc, array, from: key, to: now });
      }
    }
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
