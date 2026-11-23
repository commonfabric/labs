/**
 * What an executor that is resumed reads of the units a run before stored,
 * so that it evaluates the units a change reaches and leaves every other
 * unit as the storage holds it (note 843 of `SPEC-NOTES.md`, milestone 6 of
 * `docs/plans/compiled-pattern-language-integration.md`).
 *
 * A unit here is the row of one element of a `map` over an array of
 * references whose rows are stored as documents of their own. The executor
 * forms the element table of such a collection from the links of the array
 * and from the links to the row documents that the stored result holds,
 * evaluates no body, and holds `STORED_ROW` in the place of each row. The
 * body of an element is evaluated when a document it read changes, which
 * the lists of `StoredUnits.readers` say, when something reads the row, or
 * when an event arrives for a stream that the body binds
 * (`StoredUnits.bound`).
 *
 * Every other construct is evaluated whole by the resumed executor.
 */
import type { Artifact } from "./executor.ts";

/** Stands, in the assembled result of a collection, for a row that the
 * storage holds and that the executor has not evaluated. */
export const STORED_ROW: Readonly<Record<string, unknown>> = Object.freeze({
  $stored: true,
});

/** One entry of the list of the readers of a document. */
export type StoredReader = {
  /** The collection whose element body read the document. */
  collection: number;
  /** The key of the element. */
  key: string;
  /** The paths of the document that the body read. */
  paths: (readonly string[])[];
  /**
   * The paths at which the body found which position a reference names
   * and read nothing below (`Position.own`).
   */
  own: (readonly string[])[];
};

/** What an evaluation of the body of one element read. */
export type ElementReads = {
  collection: number;
  key: string;
  /**
   * Whether a change of what the evaluation depends on is always a change
   * of a document at a path it read: it used no other entry, read no
   * position of its element, demanded no cone with side-writes and read
   * through no reference by key. The rows of a collection are left as
   * stored only while every element of it is such.
   */
  plain: boolean;
  reads: { doc: string; path: readonly string[]; own: boolean }[];
};

/**
 * The store outside the executor as a resumed executor reads the units of
 * a run before, and as any executor tells it what the units read.
 */
export type StoredUnits = {
  /**
   * The documents that changed while no executor ran the instance, where a
   * resumed executor may leave rows as stored. Without it every row is
   * evaluated.
   */
  readonly stale?: readonly string[];
  /**
   * What the storage holds as the result document, with nothing at each
   * path of `rows`, and for each of those paths the entity that each
   * position of the stored array links to, or nothing where the storage
   * holds no array of links to whole documents there.
   */
  result(
    rows: readonly (readonly string[])[],
  ): { value: unknown; rows: (readonly string[] | undefined)[] } | undefined;
  /**
   * The document and the entity that hold the row of `key` of the array at
   * `path` of the result document.
   */
  row(path: readonly string[], key: string): { doc: string; entity: string };
  /**
   * Whether the lists of the readers name every element of `collection`
   * that the storage holds a row of, and every such element is plain
   * (`ElementReads.plain`).
   */
  listed(collection: number): boolean;
  /** The elements that the storage lists as readers of a document. */
  readers(doc: string): readonly StoredReader[];
  /** The executor holds the rows of `keys` at `path` as stored. */
  held(path: readonly string[], keys: readonly string[]): void;
  /**
   * The executor holds as stored the rows of `keys`, whose element body
   * binds each handler of `bindings`: the stream of each binding for each
   * key takes events, though no evaluation of this executor formed it.
   */
  bound(bindings: readonly number[], keys: readonly string[]): void;
  /** An evaluation of the body of an element ended. */
  read(reads: ElementReads): void;
  /** The element of `key` left `collection`. */
  left(collection: number, key: string): void;
};

/**
 * The collections of the plan of `artifact` whose rows a resumed executor
 * can leave as stored, each with the path of the result that keeps it:
 *
 * - its rows are documents of their own (`rows`, as
 *   `rowDocumentCollections` gives them), and its source is a slot that
 *   holds an array, so each element is a reference;
 * - nothing but a handler binding is declared inside its element body: no
 *   state cell, no instance, no operation and no other collection, and no
 *   cone of the body has side-writes. A row then names no document that
 *   exists only once the body ran. The stream of a binding of the body is
 *   named by the binding and the key of the element, so it is known with
 *   no evaluation (`boundInElement`);
 * - no label template of the plan folds over it: the label of a fold is
 *   formed from the labels of the members, which the executor holds for
 *   the members it evaluated.
 */
export const storedRowCollections = (
  artifact: Artifact,
  rows: ReadonlySet<number>,
): Map<number, readonly string[]> => {
  const { plan } = artifact;
  const found = new Map<number, readonly string[]>();
  const inside = (within: readonly { element?: number }[] | undefined) =>
    (within ?? []).flatMap((step) =>
      step.element === undefined ? [] : [step.element]
    );
  const declaredIn = new Set<number>();
  for (
    const { within } of [
      ...plan.stateCells,
      ...plan.children ?? [],
      ...plan.operations,
      ...plan.collections,
    ]
  ) for (const collection of inside(within)) declaredIn.add(collection);
  for (const cone of plan.cones) {
    if (cone.sideWrites === undefined) continue;
    for (const collection of inside(cone.within)) declaredIn.add(collection);
  }
  const folded = new Set<number>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const member of value) walk(member);
    } else if (typeof value === "object" && value !== null) {
      const node = value as Record<string, unknown>;
      if (node.op === "fold" && typeof node.collection === "number") {
        folded.add(node.collection);
      }
      for (const member of Object.values(node)) walk(member);
    }
  };
  walk(plan);
  plan.collections.forEach((collection, index) => {
    if (!rows.has(index) || declaredIn.has(index) || folded.has(index)) {
      return;
    }
    if (collection.construct !== "map" || collection.within.length > 0) return;
    if (collection.source.slot === undefined) return;
    if (collection.source.entries === true) return;
    const place = plan.outputs.find((output) => output.collection === index);
    if (
      place === undefined || place.kept !== true || place.path.includes("*")
    ) return;
    found.set(index, place.path);
  });
  return found;
};

/**
 * The handler bindings of the plan of `artifact` that the element body of
 * `collection` declares, by their position among the bindings.
 */
export const boundInElement = (
  artifact: Artifact,
  collection: number,
): number[] =>
  artifact.plan.bindings.flatMap(({ within }, binding) =>
    within.some((step) => step.element === collection) ? [binding] : []
  );
