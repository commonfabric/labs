/**
 * Reading a space's per-cell CFC labels, offline and read-only.
 *
 * The labels a run's cells carry live in the space's own durable store, not in
 * the run's artifact tree, so a reader working from artifacts alone sees a
 * cell with no label on it however loudly the run was enforcing. This module
 * opens the space SQLite the server already wrote — the same read-only lens
 * `cf inspect` uses — and answers "what is this cell labelled" for the cells a
 * run held a reference to.
 *
 * Nothing here writes: the database is opened read-only, and a failure is
 * returned as an unavailable snapshot rather than thrown, because a run whose
 * space cannot be read is still a run to record.
 */

import type { FabricValue } from "@commonfabric/data-model";
import {
  discoverSpaceDbs,
  linksWithPaths,
  type LinkWalkBounds,
  openSpace,
  reconstructOutcome,
  resolveSpace,
  type SpaceDb,
} from "@commonfabric/state-inspector";
import { parseLLMFriendlyLink } from "@commonfabric/runner/shared";
import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  HARNESS_CELL_LABELS_TYPE,
  type HarnessCellLabelEntry,
  type HarnessCellLabelRecord,
  type HarnessCellLabels,
  type HarnessCellLabelTruncationReason,
  type HarnessCellLabelUnreadPath,
  type HarnessCellLabelUnreadReason,
  type HarnessCfcAtom,
} from "./contracts/cell-labels.ts";

/** The atom type whose identity resolves a derived value to its producer. */
const TRANSFORMED_BY = "https://commonfabric.org/cfc/atom/TransformedBy";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  isObjectNotArray(value);

/**
 * One stored atom, normalized. A string atom is its own type and its own
 * name; an object atom names its type by URL and keeps every other field it
 * carried, so an atom this module has no special reading for still arrives
 * whole at whoever shows it.
 *
 * A disjunctive confidentiality clause — the one record shape whose sole key
 * is `anyOf` — is one requirement satisfiable several ways, so it arrives as
 * one atom carrying its alternatives rather than as several atoms, which
 * would read as several requirements.
 */
const atomOf = (value: unknown): HarnessCfcAtom | undefined => {
  if (typeof value === "string") {
    return { type: value, name: value };
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "anyOf" && Array.isArray(value.anyOf)) {
    const alternatives = atomsOf(value.anyOf);
    return {
      type: "anyOf",
      name: alternatives.map((atom) => atom.name).join(" or ") || "anyOf",
      anyOf: alternatives,
    };
  }
  if (typeof value.type !== "string") {
    return undefined;
  }
  const { type, ...fields } = value;
  const name = type.split("/").pop() ?? type;
  return Object.keys(fields).length === 0
    ? { type, name }
    : { type, name, fields };
};

const atomsOf = (value: unknown): HarnessCfcAtom[] =>
  Array.isArray(value)
    ? value.flatMap((clause) => {
      const atom = atomOf(clause);
      return atom === undefined ? [] : [atom];
    })
    : [];

/** The labels one stored document holds, and the schema they were cut to. */
interface StoredCellLabels {
  entries: HarnessCellLabelEntry[];
  schemaHash?: string;

  /**
   * Set when nothing was looked for, naming why. An entry list is otherwise
   * a positive finding about the opened store, so a lookup that never
   * reached it says so rather than reading as a document with no label.
   */
  unread?: HarnessCellLabelUnreadReason;

  /**
   * The paths of this document nothing was looked for at, where the document
   * itself was read: one per link the walk could not follow, and one per path
   * it sits too deep to descend to. The same distinction as `unread`, held
   * per path rather than per document.
   */
  unreadPaths?: readonly HarnessCellLabelUnreadPath[];

  /**
   * Set where the walk over this document stopped before the end of it and
   * cannot say where, naming why. The paths it never reached were never
   * enumerated, so this states of the document as a whole what an unread path
   * states of one path: a path carrying no entry may still be one the space
   * labels.
   */
  truncation?: HarnessCellLabelTruncationReason;
}

/**
 * The label a stored entry holds: the entry's own label when inline, else
 * the value of the `cid:` label document its single-member `$ref` names,
 * read out of the same store. `undefined` for a reference the store cannot
 * supply a label for — no document, one holding no record, or a reference
 * outside the `cid:` namespace, which names no label document and is not
 * followed into whatever entity it names — which the caller records as an
 * unread path rather than as a label with no atoms: an entry list is a
 * positive finding about what the space holds, and a label that could not
 * be read is not a label of nothing.
 */
const storedLabelOf = (
  raw: Record<string, unknown>,
  read: (id: string) => Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  const label = isRecord(raw.label) ? raw.label : {};
  const ref = label.$ref;
  if (typeof ref !== "string" || Object.keys(label).length !== 1) {
    return label;
  }
  if (!ref.startsWith("cid:")) return undefined;
  const content = read(ref)?.value;
  return isLabelShaped(content) ? content : undefined;
};

/**
 * Whether a label document's value is label-shaped: a record whose every
 * member is `confidentiality` or `integrity` holding an array. A document
 * of any other shape holds no label the reader can report.
 */
const isLabelShaped = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) &&
  Object.entries(value).every(([key, member]) =>
    (key === "confidentiality" || key === "integrity") &&
    Array.isArray(member)
  );

/**
 * The labelled paths of one stored document. The document's `cfc` path holds
 * a `labelMap` whose entries each name a path and the label sitting at it; a
 * document with no `cfc` path has no labels, which is a finding rather than a
 * failure. Several entries may name one path, differing in what produced them
 * and what they observed, and all of them are kept: the effective label at a
 * path is the join of its components, so dropping one changes the answer. A
 * label the entry holds by reference is read from the label document `read`
 * resolves the reference to; one the store cannot supply is recorded as an
 * unread path at the entry's path, with the `no-document` reason.
 */
const labelsOf = (
  document: Record<string, unknown> | undefined,
  read: (id: string) => Record<string, unknown> | undefined,
): StoredCellLabels => {
  const cfc = document?.cfc;
  if (!isRecord(cfc)) {
    return { entries: [] };
  }
  const labelMap = cfc.labelMap;
  const stored = isRecord(labelMap) && Array.isArray(labelMap.entries)
    ? labelMap.entries
    : [];
  const entries: HarnessCellLabelEntry[] = [];
  const unreadPaths: HarnessCellLabelUnreadPath[] = [];
  for (const raw of stored) {
    if (!isRecord(raw)) {
      continue;
    }
    const entryPath = Array.isArray(raw.path)
      ? raw.path.filter((segment): segment is string =>
        typeof segment === "string"
      )
      : [];
    const label = storedLabelOf(raw, read);
    if (label === undefined) {
      unreadPaths.push({ path: entryPath, reason: "no-document" });
      continue;
    }
    const integrity = atomsOf(label.integrity);
    const transformedBy = integrity.find((atom) =>
      atom.type === TRANSFORMED_BY
    );
    entries.push({
      path: entryPath,
      confidentiality: atomsOf(label.confidentiality),
      integrity,
      ...(typeof raw.origin === "string" ? { origin: raw.origin } : {}),
      ...(typeof raw.observes === "string" ? { observes: raw.observes } : {}),
      ...(transformedBy !== undefined ? { transformedBy } : {}),
    });
  }
  return {
    entries,
    ...(typeof cfc.schemaHash === "string"
      ? { schemaHash: cfc.schemaHash }
      : {}),
    ...(unreadPaths.length > 0 ? { unreadPaths } : {}),
  };
};

/** The document and scope a reference names, or `undefined` for a non-link. */
export interface CellAddress {
  /** The entity as the store ids it (`of:fid1:…`). */
  id: string;

  /**
   * The space the reference named, when it named one. An entity id is only
   * unique within its space, so a reference that carries a space addresses a
   * document in that space and nowhere else; one that carries none addresses
   * the store it was read out of.
   */
  space?: string;

  /**
   * The scope kind the reference names, `space` unless it says otherwise. A
   * labelMap is written at the same scope as the document it labels, so a
   * per-user override's labels are not in the space scope.
   *
   * A reference names the kind and not the principal, though, while the store
   * partitions by principal — `user:<did>`, not `user`. So a scoped reference
   * addresses no row on its own, and the read falls back to the base scope,
   * whose labels every scope inherits. What that cannot report is a label an
   * override introduced and the base scope does not carry.
   */
  scope: string;
}

/**
 * The cell a reference addresses. The harness holds an LLM-friendly link
 * (`/of:fid1:…/path`, or `/@did:key:…/of:fid1:…` across spaces); labels are
 * stored per document, so the document is what a lookup keys on and a path
 * inside one resolves to the document that holds it.
 */
export const cellAddressOfRef = (ref: string): CellAddress | undefined => {
  const trimmed = ref.trim();
  try {
    const link = parseLLMFriendlyLink(
      trimmed.startsWith("/") ? trimmed : `/${trimmed}`,
    );
    return link.id === undefined ? undefined : {
      id: link.id,
      ...(link.space ? { space: link.space } : {}),
      scope: link.scope ?? "space",
    };
  } catch {
    return undefined;
  }
};

/**
 * A space DID pinned tightly enough to be read as a store's own identity.
 * `isDID` answers only whether a string is a DID, so it admits `did:` and a
 * method-specific identifier of any shape; a name that proves nothing about
 * which space a file holds must not be read as proving one.
 */
const STORE_FILENAME_SPACE_DID = /^did:[^:]+:[^:]+$/;

/**
 * The DID of the space a database file holds, from the file's own name: a
 * space store is named for its space, which is how `discoverSpaceDbs` in
 * `@commonfabric/state-inspector` reads a DID off one. A file named anything
 * else — a fixture, a copy taken by hand — proves no DID, and answering
 * `undefined` is what keeps a cross-space reference from being read against
 * it.
 */
const spaceDidOfDbPath = (dbPath: string): string | undefined => {
  const name = (dbPath.split("/").pop() ?? dbPath).replace(/\.sqlite$/, "");
  return STORE_FILENAME_SPACE_DID.test(name) ? name : undefined;
};

/**
 * Why an address is one the opened store cannot answer, or `undefined` where
 * it can. A reference naming no space names the store it came from, and is
 * read. A reference naming a space is read only where the opened store's own
 * DID is known and is that space: an entity id names a document within its
 * space, so reading a foreign id here would answer with whatever local
 * document shares the id and graft its labels onto the foreign cell. An
 * unknown DID proves nothing, so it fails closed — and says which of the two
 * it was, because a store that cannot name itself is a fact about this host
 * rather than about the reference.
 */
const unreadReasonOf = (
  space: string | undefined | null,
  did: string | undefined,
): HarnessCellLabelUnreadReason | undefined => {
  if (space === undefined || space === null) {
    return undefined;
  }
  if (did === undefined) {
    return "space-unproven";
  }
  return space === did ? undefined : "cross-space";
};

/** One cell reached from another, and the path it was reached by. */
interface LinkedCell {
  path: readonly string[];
  id: string;

  /**
   * The path inside the reached document the link addresses. A link names a
   * value within a document as readily as the document itself, and what sits
   * at `path` is that value: a label at or above `into` covers it, a label
   * beneath `into` sits correspondingly beneath `path`, and a label elsewhere
   * in the document is not about it.
   */
  into: readonly string[];
}

/**
 * Where a path inside a linked document sits, seen through the link that
 * reached the document — or `undefined` when the link does not reach it. A
 * path at or above `into` covers the whole of what the link addresses, so it
 * lands at the link itself; a path beneath `into` lands beneath the link by
 * the same remainder; a path that diverges from `into` is in a part of the
 * document the link does not address.
 */
const throughLink = (
  link: Pick<LinkedCell, "path" | "into">,
  inside: readonly string[],
): readonly string[] | undefined => {
  const shared = Math.min(link.into.length, inside.length);
  for (let index = 0; index < shared; index += 1) {
    if (link.into[index] !== inside[index]) {
      return undefined;
    }
  }
  return [...link.path, ...inside.slice(link.into.length)];
};

// How far into one document's value this reader walks for links. Both bounds
// sit far above the shape of any document a pattern writes, because this
// reader buys completeness with work rather than the other way round;
// `LinkWalkBounds` covers why a node count is needed alongside a depth this
// large. Where a bound does stop the walk, what it stopped short of is
// recorded — as an unread path where the walk can name one, and as a
// truncation of the whole cell where it cannot — so a link never looked at
// never reads as a cell the space says nothing about.
const LINK_WALK: LinkWalkBounds = {
  maxDepth: 64,
  maxNodes: 100_000,
};

/** How far out of one cell the reader follows links, and at what cost. */
export interface LinkGraphBounds {
  /**
   * Links followed in a row. A cell at this distance is read; one further out
   * is an unread path at the link that addresses it.
   */
  maxHops: number;

  /** Documents read per cell, across every hop, however many links reach them. */
  maxDocuments: number;
}

// How far out of a cell this reader follows links. The cell a run holds a
// reference to is the piece, and a pattern's results are their own cells
// hanging off it, each of which may name further cells of its own — so the
// derived label a reader is looking for sits however many links out the
// pattern's shape puts it, and a reader that stops at a fixed distance
// reports the cells beyond it as carrying no label. Both bounds sit far above
// the shape of a piece graph, for the same reason the value bounds above do.
const LINK_GRAPH: LinkGraphBounds = {
  maxHops: 16,
  maxDocuments: 4096,
};

/**
 * The cells one document links to, each at the path inside the document it
 * sits at, the paths whose links were not followed, and whether the walk ran
 * out before the end of the value.
 *
 * The walk descends through the objects and arrays of the value — an array
 * index is a path segment like any other — and stops at each link it meets.
 * What a linked document links to in turn is a question about that document,
 * asked by walking it too; this answers only for the one it was given.
 *
 * A link this store cannot answer for is returned as an unread path rather
 * than dropped, and so is a path the walk sat too shallow to reach. Dropped,
 * either would leave its path holding no entry, which is how a path the space
 * holds no label for reads — so the cell nobody looked at and the cell the
 * space says nothing about would render alike.
 *
 * A walk that exhausted its node budget can name no path, because it stopped
 * before enumerating what was left, so it says so of the whole document
 * instead. That is the weaker statement, and it is deliberately weaker: the
 * paths it missed are not knowledge this reader has.
 */
const linkedCellsOf = (
  document: Record<string, FabricValue> | undefined,
  space: string | undefined,
  bounds: LinkWalkBounds,
): {
  linked: LinkedCell[];
  unreadPaths: HarnessCellLabelUnreadPath[];
  truncation?: HarnessCellLabelTruncationReason;
} => {
  const linked: LinkedCell[] = [];
  const unreadPaths: HarnessCellLabelUnreadPath[] = [];
  const walk = linksWithPaths(document?.value, bounds);
  for (const { link, at } of walk.links) {
    if (link.id === undefined) {
      continue;
    }
    const reason = unreadReasonOf(link.space, space);
    if (reason === undefined) {
      linked.push({ path: at, id: link.id, into: link.path ?? [] });
    } else {
      unreadPaths.push({ path: at, reason });
    }
  }
  for (const at of walk.tooDeep) {
    unreadPaths.push({ path: at, reason: "below-read-depth" });
  }
  return {
    linked,
    unreadPaths,
    ...(walk.budgetExhausted
      ? { truncation: "node-budget-exhausted" as const }
      : {}),
  };
};

/** What one document contributed to the walk over the graph around it. */
interface GraphStep {
  entries: HarnessCellLabelEntry[];
  linked: LinkedCell[];
  unreadPaths: HarnessCellLabelUnreadPath[];
  truncation?: HarnessCellLabelTruncationReason;
}

/**
 * Every label the space holds on the cells reachable from one document, each
 * under the path it was reached by.
 *
 * The graph is walked breadth first, so the cells nearest the one a run holds
 * a reference to are the ones a narrow budget spends itself on. A document's
 * labels are recorded at every path that reaches it, because a label at a
 * path is a fact about that path: one document linked from two places is
 * labeled at both, and reporting it at one of them would leave the other
 * reading as unlabeled.
 *
 * Two bounds make that finite. A cell further out than `maxHops` links is not
 * read, and the link addressing it is recorded as an unread path. A walk that
 * runs out of documents stops where it stands and marks the whole cell
 * truncated — it enumerated the links it had left but read none of them, so
 * it cannot vouch for the paths beneath any of them.
 *
 * A cycle needs neither bound to terminate: a link back to a document already
 * on the chain that reached it contributes that document's labels at the path
 * it sits at, and is not descended into, so the walk unfolds each loop once
 * rather than to the hop bound.
 */
const walkLinkedLabels = (
  read: (id: string) => Record<string, FabricValue> | undefined,
  root: { id: string; document: Record<string, FabricValue> | undefined },
  space: string | undefined,
  bounds: LinkWalkBounds,
  graph: LinkGraphBounds,
): GraphStep => {
  const own = linkedCellsOf(root.document, space, bounds);
  const entries: HarnessCellLabelEntry[] = [];
  const unreadPaths = [...own.unreadPaths];
  let truncation = own.truncation;
  // Each queued cell carries the chain of ids that reached it, which is what
  // a cycle is recognized against. Sharing one set across the queue would
  // instead read a diamond — two paths to one cell — as a loop. The cell the
  // walk started from is on every chain: its labels are already recorded, so
  // a link back to it closes a loop exactly as any other repeat does.
  let frontier = own.linked.map((cell) => ({
    ...cell,
    chain: new Set([root.id]),
  }));
  const linked = [...own.linked];
  let documents = 0;
  for (let hop = 0; frontier.length > 0; hop += 1) {
    const next: typeof frontier = [];
    for (const { path, id, into, chain } of frontier) {
      if (hop >= graph.maxHops) {
        unreadPaths.push({ path, reason: "beyond-link-hops" });
        continue;
      }
      if (documents >= graph.maxDocuments) {
        truncation ??= "document-budget-exhausted";
        continue;
      }
      const document = read(id);
      documents += 1;
      if (document === undefined) {
        unreadPaths.push({ path, reason: "no-document" });
        continue;
      }
      const through = { path, into };
      const labels = labelsOf(document, read);
      for (const entry of labels.entries) {
        const at = throughLink(through, entry.path);
        if (at !== undefined) {
          entries.push({ ...entry, path: at, source: id });
        }
      }
      for (const unread of labels.unreadPaths ?? []) {
        const at = throughLink(through, unread.path);
        if (at !== undefined) {
          unreadPaths.push({ path: at, reason: unread.reason });
        }
      }
      // A document reached through itself has just had its labels recorded at
      // this path; descending again would walk the same loop one more time
      // for no fact this record does not already hold.
      if (chain.has(id)) {
        continue;
      }
      const step = linkedCellsOf(document, space, bounds);
      truncation ??= step.truncation;
      for (const unread of step.unreadPaths) {
        const at = throughLink(through, unread.path);
        if (at !== undefined) {
          unreadPaths.push({ path: at, reason: unread.reason });
        }
      }
      const reached = new Set(chain).add(id);
      for (const cell of step.linked) {
        const at = throughLink(through, cell.path);
        if (at === undefined) {
          continue;
        }
        // A link above `into` addresses a document this link reaches part
        // of, so the remainder of `into` carries on inside it; a link beneath
        // addresses whatever it addresses, whole.
        const below = {
          path: at,
          id: cell.id,
          into: [
            ...cell.into,
            ...into.slice(Math.min(cell.path.length, into.length)),
          ],
        };
        linked.push(below);
        next.push({ ...below, chain: reached });
      }
    }
    frontier = next;
  }
  return {
    entries,
    linked,
    unreadPaths,
    ...(truncation !== undefined ? { truncation } : {}),
  };
};

/** A space DB opened for reading labels, and the space it was resolved from. */
export interface SpaceLabelReader {
  readonly dbPath: string;

  /**
   * The DID of the space the opened file holds, when the file proves one.
   * Nothing but this establishes which space an id is being looked up in, so
   * a reader without it can answer for no reference that names a space.
   */
  readonly did?: string;

  /**
   * The labels stored for one cell, and for every cell reachable from it. A
   * reached cell's entries arrive under the path that reached it — the links
   * followed to get there, each at whatever depth in its own document it sat
   * at — and say which cell they were read from, so the two are never
   * confused.
   *
   * An entity the store holds no document for — never written, deleted, or
   * undecodable — comes back `unread`, which is a different fact from a
   * document that carries no `cfc` path: the second is a cell the space holds
   * no label for, the first is a cell this store cannot speak for at all. An
   * address in another space is not looked up, and comes back `unread` the
   * same way. A link to either is the same fact one level down, and comes
   * back as an `unreadPaths` entry at the path that held it — as does a path
   * lying deeper in the value than the walk descends, and a link lying
   * further out than it follows links.
   */
  read(address: CellAddress): StoredCellLabels & { linked: LinkedCell[] };

  close(): void;
}

/** What an opened reader may be told, beyond which space to open. */
export interface SpaceLabelReaderOptions {
  /** An explicit database file, for a host whose store is not discoverable. */
  dbPath?: string;

  /**
   * How far into each document's value the link walk reaches. {@link
   * LINK_WALK} is what a run records under, and sits far above the shape of
   * any document a pattern writes; a caller reading a store whose shape it
   * knows may trade that reach for work. Either way what a bound stopped
   * short of is reported rather than dropped, so a narrower reach costs
   * knowledge and never truthfulness.
   */
  linkWalk?: LinkWalkBounds;

  /**
   * How far out of each cell the walk follows links, and how many documents
   * it may read doing it. {@link LINK_GRAPH} is what a run records under; the
   * same trade as `linkWalk`, along the other axis, and reported the same
   * way.
   */
  linkGraph?: LinkGraphBounds;
}

/**
 * Opens the space named by a run's fabric session configuration — a space
 * name, a DID, a DID prefix, or a path to the file itself. Throws when no
 * database on this host matches, which is the caller's cue to record an
 * unavailable snapshot rather than a bare one.
 */
export const openSpaceLabelReader = async (
  space: string,
  options: SpaceLabelReaderOptions = {},
): Promise<SpaceLabelReader> => {
  const discovered = options.dbPath === undefined
    ? discoverSpaceDbs()
    : undefined;
  const dbPath = options.dbPath ?? await resolveSpace(space, discovered);
  const opened: SpaceDb = openSpace(dbPath);
  const did = spaceDidOfDbPath(dbPath);
  const bounds = options.linkWalk ?? LINK_WALK;
  const graph = options.linkGraph ?? LINK_GRAPH;
  return {
    dbPath,
    ...(did !== undefined ? { did } : {}),
    read: (address) => {
      const unread = unreadReasonOf(address.space, did);
      if (unread !== undefined) {
        return { entries: [], linked: [], unread };
      }
      // The named scope, then the base scope it inherits from: a reference
      // carries a scope kind rather than a principal, so a scoped one
      // addresses no stored row and would otherwise read as unlabelled.
      const outcome = [address.scope, "space"]
        .filter((scope, index, scopes) => scopes.indexOf(scope) === index)
        .map((scope) => reconstructOutcome(opened, { id: address.id, scope }))
        .find((candidate) => candidate.status === "present");
      if (outcome === undefined || outcome.status !== "present") {
        return { entries: [], linked: [], unread: "no-document" };
      }
      const readSpaceDocument = (id: string) => {
        const target = reconstructOutcome(opened, { id, scope: "space" });
        return target.status === "present" ? target.document : undefined;
      };
      const own = labelsOf(outcome.document, readSpaceDocument);
      const { entries, linked, unreadPaths, truncation } = walkLinkedLabels(
        readSpaceDocument,
        { id: address.id, document: outcome.document },
        did,
        bounds,
        graph,
      );
      if (truncation !== undefined) {
        // Said out loud as well as recorded. Both budgets are what make a
        // restored graph with a cycle in it finite, so a cell that reaches
        // one is the shape they exist against rather than an honestly large
        // one, and the labels of every cell beyond that point are now
        // unknown.
        console.warn(
          `cf-harness read only part of "${address.id}" in ${dbPath}: the ` +
            `walk stopped after ${bounds.maxNodes} value nodes or ` +
            `${graph.maxDocuments} documents, so the labels of the cells ` +
            `beyond that point are unknown rather than absent. A graph this ` +
            `large is usually a cycle.`,
        );
      }
      const allUnreadPaths = [...(own.unreadPaths ?? []), ...unreadPaths];
      return {
        ...own,
        entries: [...own.entries, ...entries],
        linked,
        ...(allUnreadPaths.length > 0 ? { unreadPaths: allUnreadPaths } : {}),
        ...(truncation !== undefined ? { truncation } : {}),
      };
    },
    close: () => opened.close(),
  };
};

/** What a snapshot is taken over: the cells a run held a reference to. */
export interface SpaceLabelSnapshotRequest {
  /** The space as the run was configured with it. */
  space: string;

  /** An explicit database file, for a host whose store is not discoverable. */
  dbPath?: string;

  /** How far into each cell's value the read walks; see {@link LINK_WALK}. */
  linkWalk?: LinkWalkBounds;

  /** How far out of each cell the read follows links; see {@link LINK_GRAPH}. */
  linkGraph?: LinkGraphBounds;

  /** The references the run held, in the order it minted them. */
  refs: readonly string[];

  generatedAt: string;
}

/**
 * The label snapshot for one run: every reference it held, resolved to the
 * document it names and read against the space.
 *
 * A reference that names no document is dropped rather than recorded empty —
 * it addresses nothing this reader can ask about, and an empty record would
 * read as a cell the space holds no label for. A reference into another
 * space does address a cell, so it is recorded and marked unread instead of
 * dropped: the run held it, and a reader that saw it vanish would take the
 * snapshot to cover every cell the run touched. So is a reference the store
 * holds no document for, and a store holding none of the cells a run wrote
 * is a store the run did not write into — said out loud, because the file
 * the search found is the likeliest thing to be wrong and the snapshot alone
 * cannot say so. A link the walk could not follow is the same, held as an
 * unread path at the path it sat at, as is a path it sat too shallow to
 * reach. A walk that ran out of nodes names no path — it stopped before
 * enumerating what it had left — so it marks the whole cell truncated
 * instead. Every other failure lands on the snapshot as a whole, so a reader
 * can tell "no labels" from "not read".
 */
export const readSpaceCellLabels = async (
  request: SpaceLabelSnapshotRequest,
): Promise<HarnessCellLabels> => {
  const base = {
    type: HARNESS_CELL_LABELS_TYPE,
    version: 1,
    generatedAt: request.generatedAt,
  } as const;
  let reader: SpaceLabelReader;
  try {
    reader = await openSpaceLabelReader(request.space, {
      ...(request.dbPath !== undefined ? { dbPath: request.dbPath } : {}),
      ...(request.linkWalk !== undefined ? { linkWalk: request.linkWalk } : {}),
      ...(request.linkGraph !== undefined
        ? { linkGraph: request.linkGraph }
        : {}),
    });
  } catch (error) {
    return {
      ...base,
      status: "unavailable",
      unavailableReason: "space-not-found",
      unavailableDetail: error instanceof Error ? error.message : String(error),
      space: { configured: request.space },
      cells: [],
    };
  }
  const space = {
    configured: request.space,
    ...(reader.did !== undefined ? { did: reader.did } : {}),
    dbPath: reader.dbPath,
  };
  try {
    const cells: HarnessCellLabelRecord[] = [];
    const seen = new Set<string>();
    for (const ref of request.refs) {
      const address = cellAddressOfRef(ref);
      if (address === undefined) {
        continue;
      }
      // Keyed by the space as well as the entity: one id can name a cell in
      // the opened space and a cell in another, and they are two cells.
      const key = `${address.space ?? ""}\x00${address.scope}\x00${address.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const read = reader.read(address);
      cells.push({
        entityId: address.id,
        ref,
        ...(address.space !== undefined ? { space: address.space } : {}),
        ...(read.schemaHash !== undefined
          ? { schemaHash: read.schemaHash }
          : {}),
        ...(read.unread !== undefined ? { unreadReason: read.unread } : {}),
        ...(read.unreadPaths !== undefined
          ? { unreadPaths: read.unreadPaths }
          : {}),
        ...(read.truncation !== undefined
          ? { truncationReason: read.truncation }
          : {}),
        entries: read.entries,
      });
    }
    if (
      cells.length > 0 &&
      cells.every((cell) => cell.unreadReason === "no-document")
    ) {
      console.warn(
        `cf-harness found none of the ${cells.length} cell(s) the run held ` +
          `in ${reader.dbPath}. The labels a session writes land in the ` +
          `serving toolshed's store; a file holding none of the run's cells ` +
          `is a different store, and every cell is recorded as unread ` +
          `rather than unlabeled. Point the reader at the serving ` +
          `toolshed's cache with MEMORY_DIR, or at the file with --space-db.`,
      );
    }
    return { ...base, status: "read", space, cells };
  } catch (error) {
    return {
      ...base,
      status: "unavailable",
      unavailableReason: "read-failed",
      unavailableDetail: error instanceof Error ? error.message : String(error),
      space,
      cells: [],
    };
  } finally {
    reader.close();
  }
};
