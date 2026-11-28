// The read graph the currency index recorded, across spaces — the offline
// view of "which pieces, in which spaces, read what each other writes?".
//
// A serving loop records, for each piece it runs, the documents the piece
// writes and the documents each slice of it read, some of them in other
// spaces (docs/specs/server-side-execution/serving-loop.md §3b). Those rows
// are durable, so the stores alone say where a change in one space can come
// back to it through the pieces of another: a cycle in that graph. The
// memory server slows such a cycle while it spins and reports the spaces on
// it (`currencyDelivery` on `/api/health/stats`); this names the pieces and
// the documents, which is what a pattern author needs to break it.
//
// It reports what was recorded and does not judge it. A cycle here is a
// path a change can take, whether or not one is going round: pieces that
// settle after one pass form the same cycle as pieces that never do.

import type { SpaceRef } from "./multispace.ts";
import { spaceDidFromLabel } from "./multispace.ts";

/** A piece, by the space it is in and the id of its result document. */
export interface CurrencyPieceRef {
  space: string;
  piece: string;
}

/** One document a piece writes that a piece read. */
export interface CurrencyReadEdge {
  /** The piece that writes the document. */
  from: CurrencyPieceRef;

  /** The piece a slice of which read it. */
  to: CurrencyPieceRef;

  /** The document, which is in the writer's space. */
  id: string;

  /** The slices of the reading piece that read it, sorted. */
  slices: string[];
}

/** Pieces in more than one space that read what each other write. */
export interface CurrencyCycle {
  /**
   * A shortest cycle through the pieces that crosses a space boundary: each
   * edge's reader is the next edge's writer, and the last edge's reader is
   * the first edge's writer. It starts at the piece that sorts first.
   */
  edges: CurrencyReadEdge[];

  /** The spaces the cycle passes through, sorted. */
  spaces: string[];

  /**
   * How many pieces can each reach every other through what they read. More
   * than the cycle holds means other cycles pass through the same pieces.
   */
  pieces: number;
}

/** How many documents the pieces of one space read in another. */
export interface CurrencySpaceReads {
  /** The space that holds the documents. */
  from: string;

  /** The space whose pieces read them. */
  to: string;

  /** How many documents. */
  documents: number;
}

/** One store `currencyCycles()` was given. */
export interface CurrencyExaminedSpace {
  /** The store's label, usually its file name. */
  label: string;

  /** The space's DID. */
  space: string;

  /** Whether the store has a currency index at all. */
  indexed: boolean;

  /** How many pieces the index holds a record of. */
  pieces: number;
}

/** What `currencyCycles()` found. */
export interface CurrencyCyclesResult {
  /** The stores examined, in the order given. */
  spaces: CurrencyExaminedSpace[];

  /** The reads from one space into another, by the pair of spaces. */
  reads: CurrencySpaceReads[];

  /**
   * The spaces a recorded slice read whose store was not among those given,
   * sorted. A cycle through one of them cannot be seen.
   */
  unexamined: string[];

  /** The cycles, shortest first, at most `limit` of them. */
  cycles: CurrencyCycle[];

  /** How many cycles there are, listed or not. */
  cycleCount: number;
}

/** What `currencyCycles()` takes besides the stores. */
export interface CurrencyCyclesOptions {
  /** The most cycles to list. Defaults to 50. */
  limit?: number;

  /** The branch whose records are read. Defaults to the main branch. */
  branch?: string;
}

/** The key of a piece among the graph's nodes. */
const nodeKey = (ref: CurrencyPieceRef): string => `${ref.space}\0${ref.piece}`;

/** The piece a node key names. */
const refOf = (key: string): CurrencyPieceRef => {
  const at = key.indexOf("\0");
  return { space: key.slice(0, at), piece: key.slice(at + 1) };
};

/** Whether `ref`'s store has the table `name`. */
const hasTable = (ref: SpaceRef, name: string): boolean =>
  ref.space.get(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
    name,
  ) !== undefined;

/**
 * The strongly connected components of the graph `next` describes over
 * `nodes`: the sets of nodes that can each reach every other.
 */
const components = (
  nodes: readonly string[],
  next: (node: string) => Iterable<string>,
): string[][] => {
  // Tarjan's algorithm, with its recursion kept on a stack of its own: a
  // chain of pieces can be longer than the call stack is deep.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];
  let counter = 0;
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: Array<{ node: string; rest: Iterator<string> }> = [];
    const enter = (node: string) => {
      index.set(node, counter);
      low.set(node, counter);
      counter += 1;
      stack.push(node);
      onStack.add(node);
      work.push({ node, rest: next(node)[Symbol.iterator]() });
    };
    enter(root);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const step = frame.rest.next();
      if (!step.done) {
        const target = step.value;
        if (!index.has(target)) {
          enter(target);
        } else if (onStack.has(target)) {
          low.set(
            frame.node,
            Math.min(low.get(frame.node)!, index.get(target)!),
          );
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        low.set(
          parent.node,
          Math.min(low.get(parent.node)!, low.get(frame.node)!),
        );
      }
      if (low.get(frame.node) !== index.get(frame.node)) continue;
      const component: string[] = [];
      for (;;) {
        const node = stack.pop()!;
        onStack.delete(node);
        component.push(node);
        if (node === frame.node) break;
      }
      found.push(component);
    }
  }
  return found;
};

/**
 * Finds the pieces, in the stores `refs` names, that read what each other
 * write across a space boundary, from what each store's currency index
 * recorded.
 *
 * A piece reads another where a slice of it read a document the other
 * writes. A cycle is reported where the pieces on it are in more than one
 * space; one inside a single space is its scheduler's to bound and is left
 * out. Each set of pieces that can all reach each other is reported once,
 * by a shortest cycle through it that crosses a space boundary.
 */
export function currencyCycles(
  refs: readonly SpaceRef[],
  options: CurrencyCyclesOptions = {},
): CurrencyCyclesResult {
  const branch = options.branch ?? "";
  const limit = options.limit ?? 50;

  /** The pieces that write each document, by space and id. */
  const writers = new Map<string, Set<string>>();

  /** Each space's reads, as the index holds them. */
  const reads: Array<
    { space: string; slice: string; piece: string; source: string; id: string }
  > = [];
  const examined: CurrencyExaminedSpace[] = [];
  const known = new Set<string>();
  for (const ref of refs) {
    const indexed = hasTable(ref, "currency_read") &&
      hasTable(ref, "currency_write") && hasTable(ref, "currency_slice");
    // A record's first read is its piece's own result document, in the
    // piece's own space, so the index names the space it is of.
    const own = indexed
      ? ref.space.get<{ space: string }>(
        `SELECT entity_space AS space FROM currency_read
         WHERE branch = ? AND entity = piece LIMIT 1`,
        branch,
      )?.space
      : undefined;
    const space = own ?? spaceDidFromLabel(ref.label);
    known.add(space);
    if (!indexed) {
      examined.push({ label: ref.label, space, indexed, pieces: 0 });
      continue;
    }
    const pieces = ref.space.get<{ count: number }>(
      `SELECT COUNT(DISTINCT piece) AS count FROM currency_slice
       WHERE branch = ?`,
      branch,
    )?.count ?? 0;
    examined.push({ label: ref.label, space, indexed, pieces });
    const written = ref.space.all<{ piece: string; id: string }>(
      `SELECT piece, id FROM currency_write WHERE branch = ? AND owned = 0`,
      branch,
    );
    for (const { piece, id } of written) {
      const key = `${space}\0${id}`;
      let pieces = writers.get(key);
      if (pieces === undefined) writers.set(key, pieces = new Set());
      pieces.add(piece);
    }
    const read = ref.space.all<
      { slice: string; piece: string; source: string; id: string }
    >(
      `SELECT slice, piece, entity_space AS source, entity AS id
       FROM currency_read WHERE branch = ?`,
      branch,
    );
    for (const row of read) reads.push({ space, ...row });
  }

  /** The edges, by writer and then reader, each by document. */
  const edges = new Map<string, Map<string, Map<string, Set<string>>>>();
  const nodes = new Set<string>();
  const across = new Map<string, Set<string>>();
  const unexamined = new Set<string>();
  for (const { space, slice, piece, source, id } of reads) {
    if (source !== space) {
      const pair = `${source}\0${space}`;
      let documents = across.get(pair);
      if (documents === undefined) across.set(pair, documents = new Set());
      documents.add(id);
      if (!known.has(source)) unexamined.add(source);
    }
    const to = nodeKey({ space, piece });
    for (const writer of writers.get(`${source}\0${id}`) ?? []) {
      // A piece that reads its own output gets an edge to itself, which no
      // cycle of several pieces passes along.
      const from = nodeKey({ space: source, piece: writer });
      nodes.add(from);
      nodes.add(to);
      let targets = edges.get(from);
      if (targets === undefined) edges.set(from, targets = new Map());
      let documents = targets.get(to);
      if (documents === undefined) targets.set(to, documents = new Map());
      let slices = documents.get(id);
      if (slices === undefined) documents.set(id, slices = new Set());
      slices.add(slice);
    }
  }

  /** The edge from `from` to `to`, by the first document it rests on. */
  const edgeBetween = (from: string, to: string): CurrencyReadEdge => {
    const documents = edges.get(from)!.get(to)!;
    const [id] = [...documents.keys()].sort();
    return {
      from: refOf(from),
      to: refOf(to),
      id,
      slices: [...documents.get(id)!].sort(),
    };
  };

  const cycles: CurrencyCycle[] = [];
  const found = components(
    [...nodes].sort(),
    (node) => [...edges.get(node)?.keys() ?? []].sort(),
  );
  for (const component of found) {
    const members = new Set(component);
    const spaces = new Set(component.map((key) => refOf(key).space));
    if (spaces.size < 2) continue;
    // The shortest cycle through an edge that crosses spaces: that edge,
    // and the shortest way back from its reader to its writer. A component
    // whose pieces are in more than one space has such an edge.
    const paths: string[][] = [];
    for (const from of [...members].sort()) {
      for (const to of [...edges.get(from)?.keys() ?? []].sort()) {
        if (!members.has(to) || refOf(from).space === refOf(to).space) {
          continue;
        }
        const back = new Map([[to, to]]);
        const queue = [to];
        for (let at = 0; at < queue.length && !back.has(from); at++) {
          const node = queue[at];
          for (const target of [...edges.get(node)?.keys() ?? []].sort()) {
            if (!members.has(target) || back.has(target)) continue;
            back.set(target, node);
            queue.push(target);
          }
        }
        const path = [from];
        for (let node = from; node !== to;) {
          node = back.get(node)!;
          path.push(node);
        }
        // `path` runs from the writer back to the reader, against the
        // edges.
        paths.push(path.reverse());
      }
    }
    const shortest = paths.reduce((best, path) =>
      path.length < best.length ? path : best
    );
    // The crossing edge closes the path. The cycle is told from its first
    // piece in sort order, so the same cycle reads the same way each time.
    const first = shortest.indexOf([...shortest].sort()[0]);
    const walk = [...shortest.slice(first), ...shortest.slice(0, first)];
    cycles.push({
      edges: walk.map((node, at) =>
        edgeBetween(node, walk[(at + 1) % walk.length])
      ),
      spaces: [...spaces].sort(),
      pieces: members.size,
    });
  }
  cycles.sort((a, b) =>
    a.edges.length - b.edges.length ||
    nodeKey(a.edges[0].from).localeCompare(nodeKey(b.edges[0].from))
  );

  return {
    spaces: examined,
    reads: [...across].map(([pair, documents]) => {
      const at = pair.indexOf("\0");
      return {
        from: pair.slice(0, at),
        to: pair.slice(at + 1),
        documents: documents.size,
      };
    }).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    unexamined: [...unexamined].sort(),
    cycles: cycles.slice(0, limit),
    cycleCount: cycles.length,
  };
}
