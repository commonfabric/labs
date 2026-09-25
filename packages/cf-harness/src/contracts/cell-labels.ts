/**
 * Contract shape of the per-cell CFC label snapshot a run records.
 *
 * A run's artifact tree knows which cells it touched and what the sandbox
 * decided about each tool call; the space knows what each of those cells is
 * labelled. Nothing joined the two, so a reader working from artifacts alone
 * saw no label on any cell. This artifact is that join, taken at the run's own
 * space and written beside the run: an entity id, the labels the space holds
 * for it, and the space it was read from.
 *
 * Shapes only — reading the space DB lives in `../space-labels.ts`, and
 * persisting the artifact in `../artifacts.ts`.
 */

/** Discriminator value of a {@link HarnessCellLabels}. */
export const HARNESS_CELL_LABELS_TYPE = "cf-harness.cell-labels";

/**
 * One CFC atom, as the space stored it. `type` is the atom's full type URL
 * for an object atom and the whole string for a bare string atom; `name` is
 * the last segment of that URL, which is what a label reads as. `fields`
 * carries everything else the atom said about itself — a `TransformedBy`
 * atom's `codeHash`, `operation`, and `inputs`, a `Resource` atom's `class`
 * and `subject` — so an atom this contract has no name for still arrives
 * whole. A field the space
 * committed rather than stored reads as its commitment object, so nothing
 * here may be assumed to be a string.
 */
export interface HarnessCfcAtom {
  type: string;
  name: string;
  fields?: Record<string, unknown>;

  /**
   * The alternatives of a disjunctive confidentiality clause, when this
   * stands for one. A clause satisfied by any one of its atoms is not the
   * same requirement as the atoms listed side by side, so it arrives as one
   * atom naming its alternatives rather than as several.
   */
  anyOf?: readonly HarnessCfcAtom[];
}

/**
 * How a label came to sit at a path, as the space recorded it. `declared` is
 * an author's own label on a schema; `derived` is one the runtime computed
 * from what a lifted function read; `link` is one that rode in on a
 * reference. The distinction is the whole reading: a value's label may be the
 * join of the fields it was built from, so an input that carries a
 * confidentiality atom is not by itself a value that was derived from
 * anything. `derived` and the provenance atom beside it are what say that.
 */
export type HarnessCellLabelOrigin =
  | "declared"
  | "derived"
  | "link"
  | "structure"
  | "external-ingest"
  | "label-metadata";

/** The labels the space holds at one path inside one cell. */
export interface HarnessCellLabelEntry {
  /** The path inside the document, empty for the document itself. */
  path: readonly string[];

  confidentiality: readonly HarnessCfcAtom[];
  integrity: readonly HarnessCfcAtom[];

  /**
   * The recorded origin. Typed as the union this contract knows plus the
   * open string, because the space is the authority on what it wrote and a
   * name added there must still reach a reader rather than being dropped.
   */
  origin?: HarnessCellLabelOrigin | string;

  /**
   * What the entry observed, when it observed something narrower than the
   * value: its shape, its members, or the reference it followed. An entry
   * with none covers the value at its path.
   */
  observes?: string;

  /**
   * The provenance atom lifted out of `integrity`, when one rides at this
   * path: which implementation produced the value. Its `codeHash` and
   * optional `operation` name the artifact and operation, which is what makes
   * a derived label something to follow rather than something to take on
   * trust.
   */
  transformedBy?: HarnessCfcAtom;

  /**
   * The entity the entry was read from, when the path crosses a link rather
   * than sitting inside one document. A pattern's results are their own
   * cells, linked from the piece that names them, and the derived label is on
   * the cell — so a snapshot that read only the document a run holds a
   * reference to would report a result with nothing on it.
   */
  source?: string;
}

/**
 * Why a cell or a path of a read snapshot holds no labels because none were
 * looked for. Each names a place the reader did not look, and asserts that it
 * looked everywhere else it says it read.
 *
 * `cross-space` and `space-unproven` are one hazard: an entity id addresses a
 * document within its own space, so asking the opened store for an id that
 * belongs to another answers with whatever local document shares it.
 * `cross-space` is an address in a space the opened store is known not to be.
 * `space-unproven` is an address in a space the opened store cannot be shown
 * to be either way, which is every spaced address against a file whose name is
 * not a DID — a fixture, or a copy taken by hand.
 *
 * `below-read-depth` is a path sitting deeper inside a document than the
 * reader descends into one. Nothing was read at it or beneath it, and the
 * path names exactly where that begins.
 *
 * `beyond-link-hops` is the same fact along the other axis: a link sitting
 * further out of the cell than the reader follows links. The document it
 * addresses was not read, and neither was anything it links to in turn.
 *
 * `no-document` is an id the opened store holds no document for — never
 * written, deleted, or undecodable. The run held a reference to it, so the
 * cell exists somewhere; a store with nothing at it is a store that did not
 * receive the run's writes, which is what a snapshot taken against the wrong
 * file looks like, and the reading "this cell carries no label" would be
 * exactly wrong. A label a stored entry holds by reference to a label
 * document the store cannot supply is the same reason, recorded at the
 * entry's own path: the entry says a label sits there, and the reader could
 * not read it.
 */
export type HarnessCellLabelUnreadReason =
  | "cross-space"
  | "space-unproven"
  | "below-read-depth"
  | "beyond-link-hops"
  | "no-document";

/**
 * Why a cell's labels are some of what the space holds rather than all of it.
 *
 * `node-budget-exhausted` is a reader that ran out of value nodes partway
 * through one document and stopped. It states less than an unread path does,
 * and states it of the whole record rather than of a path, because that is
 * the whole of what is true: the values left unwalked were never enumerated,
 * so nothing names them, and a path cannot be produced for a place never
 * reached. Wherever it is set, every path of the record that carries no entry
 * is unknown rather than unlabelled.
 *
 * A document a pattern writes sits far below the budget. Reaching it is
 * evidence of the value the budget exists against — a restored graph with a
 * cycle in it, or a row no reader could enumerate the paths of — so it is
 * something to investigate rather than something to expect.
 *
 * `document-budget-exhausted` is the same statement about the graph rather
 * than about one value: the reader spent its allowance of documents before
 * the cells reachable from this one ran out. The links it had yet to follow
 * were enumerated, but the paths beneath each of them were not, so naming
 * them would claim more than was read.
 */
export type HarnessCellLabelTruncationReason =
  | "node-budget-exhausted"
  | "document-budget-exhausted";

/**
 * One path inside a cell whose labels were not looked for, and why.
 *
 * A link is followed only where the store it addresses is the opened one,
 * holds a document at it, and the reader still has hops to spend, and a path
 * deeper than the reader descends is not reached at all; either way the path
 * holds no entry.
 * Recording it is what keeps it readable as a cell nobody asked about: an
 * entry list carries no gaps of its own, so a path missing from one is
 * otherwise a path the space holds no label for.
 */
export interface HarnessCellLabelUnreadPath {
  /** The path inside the document, as an entry at it would be written. */
  path: readonly string[];

  reason: HarnessCellLabelUnreadReason;
}

/** Every label the space holds for one cell. */
export interface HarnessCellLabelRecord {
  /** The entity the labels belong to, as the store ids it (`of:fid1:…`). */
  entityId: string;

  /**
   * The canonical reference the run held for this cell, when the run held
   * one. A cell reached only by a whole link carries the link instead.
   */
  ref?: string;

  /**
   * The space the reference named, when it named one. An id is unique only
   * within its space, so this is what says which cell the record is about
   * when the id alone does not — and, where it differs from the space the
   * snapshot was taken in, it is why the cell went unread.
   */
  space?: string;

  /** The hash of the schema the labels were computed against, if recorded. */
  schemaHash?: string;

  /**
   * Set when this cell's labels were not looked for, naming which of the
   * reasons it was. It is what separates the two readings of an empty
   * `entries`, at the granularity of one cell rather than of the snapshot.
   */
  unreadReason?: HarnessCellLabelUnreadReason;

  /**
   * The paths of this cell that were not looked for, where the cell itself
   * was. It is the same separation as `unreadReason` one level down, and a
   * reader owes it the same reading: a reference the run held that lands at
   * or under one of these paths is a cell nothing is known about, not a cell
   * with no label.
   */
  unreadPaths?: readonly HarnessCellLabelUnreadPath[];

  /**
   * Set where the reader did not finish this cell, naming why. It is weaker
   * than `unreadPaths` and no substitute for one: `unreadPaths` names each
   * path nothing was read at and thereby vouches for every other path, while
   * this says only that something was missed and cannot say where. A reader
   * that meets it takes `entries` as some of what the space holds for this
   * cell, and every path with no entry as unknown.
   */
  truncationReason?: HarnessCellLabelTruncationReason;

  /**
   * The labels, one entry per labelled path. An empty list is a positive
   * finding — the space was read and holds no label for this cell — except
   * where `unreadReason` is set, which says nothing was asked, at the paths
   * `unreadPaths` names, which say the same of one path each, and under a
   * `truncationReason`, which says the same of paths it cannot name.
   */
  entries: readonly HarnessCellLabelEntry[];
}

/** Why a snapshot holds no labels, when it holds none. */
export type HarnessCellLabelsUnavailableReason =
  /** No space DB for the run's space was found on this host. */
  | "space-not-found"
  /** The DB was found but could not be opened or read. */
  | "read-failed";

/**
 * The run's per-cell labels, read from the space it wrote into.
 *
 * `status` is load-bearing. A cell with no atoms under a `read` snapshot is a
 * cell the space holds no label for; the same cell under an `unavailable`
 * snapshot is a cell nobody asked about. Collapsing the two would make every
 * unreadable host look like a space with nothing to hide.
 */
export interface HarnessCellLabels {
  type: typeof HARNESS_CELL_LABELS_TYPE;
  version: 1;
  generatedAt: string;
  status: "read" | "unavailable";

  /** Set when `status` is `unavailable`, naming which of the two it was. */
  unavailableReason?: HarnessCellLabelsUnavailableReason;

  /** What the reason above says in prose, for a reader to show as it stands. */
  unavailableDetail?: string;

  /**
   * The space the labels were read from. Recorded even for an unavailable
   * snapshot, because "which space" is the first question a reader asks and
   * a run's other artifacts name no space at all.
   */
  space?: {
    /** The space as the run was configured with it: a name, or a DID. */
    configured: string;

    did?: string;

    /** The database file read, for a reader that wants to open it too. */
    dbPath?: string;
  };

  cells: readonly HarnessCellLabelRecord[];
}
