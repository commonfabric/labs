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
}

/** A reference to the stream of a binding, for one key of each element. */
export class StreamRef {
  constructor(readonly binding: number, readonly keys: readonly string[]) {}
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

/** A position that a read observed: the document and the path. */
export type Position = { doc: string; path: readonly string[] };

type StoredLink = { $link: { doc: string; path: string[]; schema?: Schema } };
type StoredStream = { $stream: { binding: number; keys: string[] } };

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

  create(id: string, kind: string, value: unknown): void {
    this.docs.set(id, { kind, value });
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

  /**
   * The position a reference resolves to, with the value stored there.
   * A link at a segment on the way is followed. With `through`, a link at
   * the last segment is followed as well. Each position where a link was
   * crossed, and the last one, is added to `reads`.
   */
  locate(
    ref: Ref,
    through: boolean,
    reads?: Position[],
  ): { ref: Ref; value: unknown } {
    let doc = ref.doc;
    let value = this.#held(doc);
    let at: string[] = [];
    let schema = ref.schema;
    let rest = [...ref.path];
    let links = 0;
    for (;;) {
      while (isLink(value) && (rest.length > 0 || through)) {
        links += 1;
        if (links > MAX_LINKS) {
          return { ref: new Ref(doc, at), value: undefined };
        }
        reads?.push({ doc, path: at });
        // The schema of the link nearest the position read, where the
        // reference has none of its own.
        schema ??= rest.reduce(schemaBelow, value.$link.schema);
        doc = value.$link.doc;
        rest = [...value.$link.path, ...rest];
        at = [];
        value = this.#held(doc);
      }
      const segment = rest.shift();
      if (segment === undefined) break;
      value = child(value, segment);
      at = [...at, segment];
    }
    reads?.push({ doc, path: at });
    return { ref: new Ref(doc, at, schema), value };
  }

  /**
   * The value at a reference, with every link in it replaced by the value
   * at its target. A link whose target is being read already gives
   * `undefined`. The stream of a binding reads as `{ $stream: true }`,
   * and so does a position that holds nothing and that the schema of the
   * reference declares as a stream: a stream the instance was given.
   */
  read(ref: Ref, reads?: Position[]): unknown {
    return this.#deep(ref, reads, new Set());
  }

  #deep(ref: Ref, reads: Position[] | undefined, open: Set<string>): unknown {
    const located = this.locate(ref, true, reads);
    const id = `${located.ref.doc}\u0000${located.ref.path.join("\u0000")}`;
    if (open.has(id)) return undefined;
    if (located.value === undefined && isStreamSchema(located.ref.schema)) {
      return { $stream: true };
    }
    open.add(id);
    // A container that is copied to fill in a default keeps the address
    // it was read from.
    const value = withDefaults(
      this.#copy(located.value, reads, open, located.ref),
      located.ref.schema,
      (from, to) => {
        const address = this.addresses.get(from);
        if (address !== undefined) this.addresses.set(to, address);
      },
    );
    open.delete(id);
    if (typeof value === "object" && value !== null) {
      this.addresses.set(value, located.ref);
    }
    return value;
  }

  #copy(
    value: unknown,
    reads: Position[] | undefined,
    open: Set<string>,
    at: Ref,
  ): unknown {
    if (isLink(value)) {
      const { doc, path, schema } = value.$link;
      return this.#deep(new Ref(doc, path, schema), reads, open);
    }
    if (isStream(value)) return { $stream: true };
    const here = new Ref(at.doc, at.path);
    if (Array.isArray(value)) {
      const copy = value.map((member, index) =>
        this.#copy(member, reads, open, here.key(`${index}`))
      );
      this.addresses.set(copy, here);
      return copy;
    }
    if (isRecord(value)) {
      const copy = Object.fromEntries(
        Object.entries(value).map((
          [name, member],
        ) => [name, this.#copy(member, reads, open, here.key(name))]),
      );
      this.addresses.set(copy, here);
      return copy;
    }
    return value;
  }

  /**
   * Stores a value at a reference. The value is in stored form: a
   * reference in it is a link already. A link at a segment on the way is
   * followed, and so is a link at the last segment unless the value
   * written is itself a link.
   */
  write(ref: Ref, value: unknown): void {
    const located = this.locate(ref, !isLink(value) && !isStream(value));
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
        (holder as unknown[]).length = value as number;
      } else {
        holder[last] = value;
      }
    }
    this.clock += 1;
    this.log.push({ doc, path, at: this.clock });
  }

  /** Whether a write after `since` is at, above, or below a position. */
  changedSince(since: number, positions: readonly Position[]): boolean {
    for (let index = this.log.length - 1; index >= 0; index--) {
      const entry = this.log[index];
      if (entry.at <= since) return false;
      for (const position of positions) {
        if (
          position.doc === entry.doc &&
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
