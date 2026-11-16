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

/** A value with the defaults its schema declares for what it lacks. */
export const withDefaults = (
  value: unknown,
  schema: Schema | undefined,
): unknown => {
  if (typeof schema !== "object") return value;
  if (value === undefined) {
    return schema.default === undefined
      ? undefined
      : structuredClone(schema.default);
  }
  if (isRecord(value) && schema.properties !== undefined) {
    const filled: Record<string, unknown> = { ...value };
    for (const [name, member] of Object.entries(schema.properties)) {
      const given = withDefaults(filled[name], member);
      if (given !== undefined) filled[name] = given;
    }
    return filled;
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    return value.map((member) => withDefaults(member, schema.items));
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

  has(id: string): boolean {
    return this.docs.has(id);
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
    let value = this.docs.get(doc)?.value;
    let at: string[] = [];
    let schema = ref.schema;
    let rest = [...ref.path];
    let links = 0;
    for (;;) {
      while (isLink(value) && (rest.length > 0 || through)) {
        links += 1;
        if (links > MAX_LINKS) return { ref: new Ref(doc, at), value: undefined };
        reads?.push({ doc, path: at });
        // The schema of the link nearest the position read, where the
        // reference has none of its own.
        schema ??= rest.reduce(schemaBelow, value.$link.schema);
        doc = value.$link.doc;
        rest = [...value.$link.path, ...rest];
        at = [];
        value = this.docs.get(doc)?.value;
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
   * `undefined`. The stream of a binding reads as `{ $stream: true }`.
   */
  read(ref: Ref, reads?: Position[]): unknown {
    return this.#deep(ref, reads, new Set());
  }

  #deep(ref: Ref, reads: Position[] | undefined, open: Set<string>): unknown {
    const located = this.locate(ref, true, reads);
    const id = `${located.ref.doc}\u0000${located.ref.path.join("\u0000")}`;
    if (open.has(id)) return undefined;
    open.add(id);
    const value = withDefaults(
      this.#copy(located.value, reads, open),
      located.ref.schema,
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
  ): unknown {
    if (isLink(value)) {
      const { doc, path, schema } = value.$link;
      return this.#deep(new Ref(doc, path, schema), reads, open);
    }
    if (isStream(value)) return { $stream: true };
    if (Array.isArray(value)) {
      return value.map((member) => this.#copy(member, reads, open));
    }
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map((
          [name, member],
        ) => [name, this.#copy(member, reads, open)]),
      );
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
    const document = this.docs.get(doc);
    if (document === undefined) return;
    if (JSON.stringify(located.value) === JSON.stringify(value)) return;
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
