/**
 * The units of a compiled piece as the storage holds them, for a resume
 * that evaluates the units a change reaches and leaves every other unit as
 * stored (note 843 of `base/pattern-compiler/SPEC-NOTES.md`, milestone 6 of
 * `docs/plans/compiled-pattern-language-integration.md`).
 *
 * A unit is the row of one element of a `map` over an array of references
 * whose rows are documents of their own (`storedRowCollections`). The piece
 * keeps, beside the rows:
 *
 * - The lists of the readers, kept in reverse: for each document that the
 *   body of an element read, the elements that read it, each with the
 *   paths it read. The lists are spread over the documents of the parts,
 *   by the document read (`basisPartOf`), as the numbers of the basis are.
 *   A runtime that resumed the piece and holds a row as stored reads the
 *   list of a document when the document changes, and evaluates the bodies
 *   the list names.
 * - One document that says which compiled pattern the lists are of, which
 *   parts have a document, and for each collection whether every element
 *   of it depends on nothing but the positions it read
 *   (`ElementReads.plain`).
 *
 * The transaction of the derivation that evaluated a body writes what the
 * body read where that differs from what the lists hold, so a body that
 * reads the same positions again writes nothing.
 */
import type {
  ElementReads,
  StoredReader,
  StoredUnits,
} from "../../../../base/pattern-compiler/exec/stored-units.ts";
import { identifierOf } from "../../../../base/pattern-compiler/exec/store.ts";
import { basisPartOf } from "./basis.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The document that says what the lists of the readers of a piece are of. */
export const unitsDocumentOf = (result: string): string =>
  identifierOf({ type: "units", parent: result });

/**
 * The document that holds one part of the lists of the readers of the
 * piece whose result is `result`: for each document read, a record from
 * the element that read it to what it read.
 */
export const readersPartDocumentOf = (result: string, part: number): string =>
  identifierOf({ type: "readers part", parent: result, part });

/** What the document of the units holds. */
type Flag = {
  pattern: string;
  plain: Record<string, boolean>;
  parts: Record<string, 1>;
};

/** The parts that a stored document of the units names, where it is one. */
export const readersPartsOf = (value: unknown): number[] =>
  isRecord(value) && isRecord(value.parts)
    ? Object.keys(value.parts).map(Number).filter((part) =>
      Number.isInteger(part) && part >= 0
    )
    : [];

/** What a list holds for one element: its collection, its key, the paths
 * it read and the paths it read as the position a reference names. */
type Listed = { c: number; k: string; p: string[][]; o: string[][] };

/** A part as stored: by the document read, and by the element. */
type Part = Record<string, Record<string, Listed>>;

/** What `PieceUnits` reads and writes through. */
export type UnitsStorage<Tx extends object> = {
  /** What the replica holds of a document the piece keeps, as stored. */
  held(doc: string): unknown;
  /** Writes `value` at `path` of a document the piece keeps, in `tx`. */
  write(tx: Tx, doc: string, path: readonly string[], value: unknown): void;
  /** `StoredUnits.result`. */
  result: StoredUnits["result"];
  /** `StoredUnits.held`. */
  rowsHeld: StoredUnits["held"];
  /** `StoredUnits.bound`. */
  streamsHeld: StoredUnits["bound"];
};

/** Keeps the lists of the readers of one piece while a runtime runs it. */
export class PieceUnits<Tx extends object> implements StoredUnits {
  readonly stale: readonly string[] | undefined;
  readonly #result: string;
  readonly #pattern: string;
  readonly #storage: UnitsStorage<Tx>;
  /** The parts as the storage holds them with what was written since. */
  readonly #parts = new Map<number, Part | undefined>();
  /** What each element was last told to have read, by document. */
  readonly #noted = new Map<string, Map<string, Listed>>();
  /** The entries to write: by document, the element and what it read, or
   * nothing for an entry to remove. */
  readonly #dirty = new Map<string, Map<string, Listed | undefined>>();
  /** What each transaction wrote of the lists. */
  readonly #recorded = new WeakMap<
    Tx,
    { doc: string; id: string; listed: Listed | undefined }[]
  >();
  /** Whether each collection is plain, as far as this runtime was told. */
  readonly #plain = new Map<number, boolean>();
  /** What the document of the units holds, where that is known. */
  #stored: Flag | undefined;
  #storedRead = false;

  /**
   * Constructs an instance for the piece whose result document is
   * `result`, which runs the compiled pattern `pattern`. `stale` names the
   * documents that changed since the run before, for a piece that is
   * resumed and may leave rows as stored.
   */
  constructor(
    result: string,
    pattern: string,
    storage: UnitsStorage<Tx>,
    stale?: readonly string[],
  ) {
    this.#result = result;
    this.#pattern = pattern;
    this.#storage = storage;
    this.stale = stale;
  }

  /** What the document of the units holds, read once. */
  #flag(): Flag | undefined {
    if (this.#storedRead) return this.#stored;
    this.#storedRead = true;
    const held = this.#storage.held(unitsDocumentOf(this.#result));
    if (
      isRecord(held) && typeof held.pattern === "string" &&
      isRecord(held.plain)
    ) {
      const plain: Record<string, boolean> = {};
      for (const [collection, value] of Object.entries(held.plain)) {
        plain[collection] = value === true;
      }
      const parts: Record<string, 1> = {};
      for (const part of readersPartsOf(held)) parts[`${part}`] = 1;
      this.#stored = { pattern: held.pattern, plain, parts };
    }
    return this.#stored;
  }

  /** A part as the storage holds it, read once. */
  #part(part: number): Part | undefined {
    if (this.#parts.has(part)) return this.#parts.get(part);
    const held = this.#storage.held(readersPartDocumentOf(this.#result, part));
    let stored: Part | undefined;
    if (isRecord(held)) {
      stored = {};
      for (const [doc, entries] of Object.entries(held)) {
        if (!isRecord(entries)) continue;
        stored[doc] = {};
        for (const [id, entry] of Object.entries(entries)) {
          if (
            isRecord(entry) && typeof entry.c === "number" &&
            typeof entry.k === "string" && Array.isArray(entry.p) &&
            Array.isArray(entry.o)
          ) {
            stored[doc][id] = {
              c: entry.c,
              k: entry.k,
              p: entry.p.map((path) => [...path as string[]]),
              o: entry.o.map((path) => [...path as string[]]),
            };
          }
        }
      }
    }
    this.#parts.set(part, stored);
    return stored;
  }

  /** @inheritDoc */
  result(
    rows: readonly (readonly string[])[],
  ): ReturnType<StoredUnits["result"]> {
    return this.#storage.result(rows);
  }

  /** @inheritDoc */
  row(path: readonly string[], key: string): { doc: string; entity: string } {
    const doc = identifierOf({ rows: [this.#result, ...path], key });
    return { doc, entity: `of:${doc}` };
  }

  /** @inheritDoc */
  listed(collection: number): boolean {
    const flag = this.#flag();
    return flag !== undefined && flag.pattern === this.#pattern &&
      flag.plain[`${collection}`] === true &&
      this.#plain.get(collection) !== false;
  }

  /** @inheritDoc */
  readers(doc: string): readonly StoredReader[] {
    const entries = this.#part(basisPartOf(doc))?.[doc];
    if (entries === undefined) return [];
    return Object.values(entries).map(({ c, k, p, o }) => ({
      collection: c,
      key: k,
      paths: p,
      own: o,
    }));
  }

  /** @inheritDoc */
  held(path: readonly string[], keys: readonly string[]): void {
    this.#storage.rowsHeld(path, keys);
  }

  /** @inheritDoc */
  bound(bindings: readonly number[], keys: readonly string[]): void {
    this.#storage.streamsHeld(bindings, keys);
  }

  #note(doc: string, id: string, listed: Listed | undefined): void {
    let entries = this.#dirty.get(doc);
    if (entries === undefined) {
      entries = new Map();
      this.#dirty.set(doc, entries);
    }
    entries.set(id, listed);
  }

  /** @inheritDoc */
  read({ collection, key, plain, reads }: ElementReads): void {
    if (!this.#plain.has(collection) || !plain) {
      this.#plain.set(
        collection,
        plain && this.#plain.get(collection) !== false,
      );
    }
    const id = `${collection} ${key}`;
    const now = new Map<string, Listed>();
    for (const { doc, path, own } of reads) {
      let listed = now.get(doc);
      if (listed === undefined) {
        listed = { c: collection, k: key, p: [], o: [] };
        now.set(doc, listed);
      }
      const paths = own ? listed.o : listed.p;
      if (
        !paths.some((held) =>
          held.length === path.length &&
          held.every((segment, index) => segment === path[index])
        )
      ) paths.push([...path]);
    }
    for (const doc of this.#noted.get(id)?.keys() ?? []) {
      if (!now.has(doc)) this.#note(doc, id, undefined);
    }
    for (const [doc, listed] of now) this.#note(doc, id, listed);
    this.#noted.set(id, now);
  }

  /** @inheritDoc */
  left(collection: number, key: string): void {
    const id = `${collection} ${key}`;
    for (const doc of this.#noted.get(id)?.keys() ?? []) {
      this.#note(doc, id, undefined);
    }
    this.#noted.delete(id);
  }

  /**
   * The commit of a transaction of the piece was refused, or taken back:
   * what it wrote of the lists is not stored, and is written again.
   */
  refused(tx: Tx): void {
    const recorded = this.#recorded.get(tx);
    if (recorded === undefined) return;
    this.#recorded.delete(tx);
    for (const { doc, id, listed } of recorded) {
      // The part holds what the transaction wrote: it is taken out, so
      // that the next record writes the entry.
      const entries = this.#part(basisPartOf(doc))?.[doc];
      if (entries !== undefined) delete entries[id];
      if (!this.#dirty.get(doc)?.has(id)) this.#note(doc, id, listed);
    }
    this.#stored = undefined;
    this.#storedRead = true;
  }

  /**
   * Writes into `tx`, a transaction of the derivation, what the bodies
   * evaluated since the last record read, where it differs from what the
   * lists hold, and the document of the units where it differs. Returns
   * how many paths it wrote.
   */
  record(tx: Tx): number {
    let wrote = 0;
    const recorded = this.#recorded.get(tx) ?? [];
    // A part that has no document is written whole, once.
    const fresh = new Map<number, Part>();
    for (const [doc, entries] of this.#dirty) {
      const part = basisPartOf(doc);
      let stored = this.#part(part);
      const at = readersPartDocumentOf(this.#result, part);
      for (const [id, listed] of entries) {
        const held = stored?.[doc]?.[id];
        if (JSON.stringify(held) === JSON.stringify(listed)) continue;
        recorded.push({ doc, id, listed });
        if (stored === undefined) {
          if (listed === undefined) continue;
          stored = {};
          this.#parts.set(part, stored);
          fresh.set(part, stored);
        }
        if (listed === undefined) {
          delete stored[doc][id];
          if (!fresh.has(part)) {
            this.#storage.write(tx, at, [doc, id], undefined);
            wrote += 1;
          }
          continue;
        }
        if (stored[doc] === undefined) {
          stored[doc] = { [id]: listed };
          if (!fresh.has(part)) {
            this.#storage.write(tx, at, [doc], { [id]: listed });
            wrote += 1;
          }
          continue;
        }
        stored[doc][id] = listed;
        if (!fresh.has(part)) {
          this.#storage.write(tx, at, [doc, id], listed);
          wrote += 1;
        }
      }
    }
    this.#dirty.clear();
    for (const [part, stored] of fresh) {
      this.#storage.write(
        tx,
        readersPartDocumentOf(this.#result, part),
        [],
        JSON.parse(JSON.stringify(stored)),
      );
      wrote += 1;
    }
    if (recorded.length > 0) this.#recorded.set(tx, recorded);
    // The document of the units: every collection this runtime was told of
    // with whether it is plain, and what the storage held for the others,
    // where it is of the same compiled pattern.
    const flag = this.#flag();
    const plain: Record<string, boolean> = flag?.pattern === this.#pattern
      ? { ...flag.plain }
      : {};
    for (const [collection, value] of this.#plain) {
      plain[`${collection}`] = value && plain[`${collection}`] !== false;
    }
    const parts: Record<string, 1> = { ...flag?.parts };
    for (const part of fresh.keys()) parts[`${part}`] = 1;
    const names = Object.keys(plain);
    if (
      this.#plain.size > 0 &&
      (flag?.pattern !== this.#pattern ||
        names.length !== Object.keys(flag.plain).length ||
        names.some((name) => flag.plain[name] !== plain[name]) ||
        Object.keys(parts).length !== Object.keys(flag.parts).length)
    ) {
      this.#stored = { pattern: this.#pattern, plain, parts };
      this.#storedRead = true;
      this.#storage.write(tx, unitsDocumentOf(this.#result), [], {
        pattern: this.#pattern,
        plain: { ...plain },
        parts: { ...parts },
      });
      wrote += 1;
    }
    return wrote;
  }
}
