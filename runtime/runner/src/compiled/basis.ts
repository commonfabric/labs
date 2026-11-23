/**
 * The basis of a compiled piece: the record, kept in a document of the
 * piece, of which documents its derivation read without deriving them, and
 * of the sequence number each had when the stored result was derived from
 * it. A piece whose basis matches the storage is current: a runtime that
 * holds nothing of it evaluates nothing to find that out
 * (`resumeCompiledPieceFromBasis`, milestone 6 of
 * `docs/plans/compiled-pattern-language-integration.md`).
 *
 * The documents of the basis are the sources of the piece: a document that
 * exists outside the executor and that the executor read, the argument
 * document, a document a handler or the creation of the instance wrote, a
 * place of the executor that was read while the storage held no document
 * of it, a document another writer changed and the executor took the
 * change of, and the document of the counts, which every handled event
 * writes. A document the derivation alone writes, the result and the rows
 * among them, is no source.
 *
 * The document of the basis holds, beside the identity of the compiled
 * pattern:
 *
 * - `inputs`: for a source, the sequence number the replica's confirmed
 *   view of it stood at when a derivation of the piece ran with no write of
 *   the piece to it unconfirmed. The source is unchanged while its head is
 *   that number.
 * - `recent`: the sources that a transaction of the piece wrote and whose
 *   commit the replica had not confirmed when the basis was last written. The piece
 *   cannot know the number its own commit gives such a document. The
 *   transaction that writes the basis reads each of them, so it commits
 *   only where the document is as the derivation saw it, and every write
 *   of the basis names all of them again. Such a source is unchanged while
 *   its head is not behind the head of the document of the basis.
 *
 * Only a transaction of the derivation writes the basis, with what the
 * derivation wrote. A handler whose transaction committed while the
 * derivation behind it did not leaves a source ahead of the basis.
 */
import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import { identifierOf } from "../../../../base/pattern-compiler/exec/store.ts";
import { hashStringOf } from "@commonfabric/data-model";

/** What the document of the basis of a piece holds. */
export type StoredBasis = {
  /** The identity of the compiled pattern the piece was derived with. */
  pattern: string;
  /** Counts the writes of the document, so that each one changes it. */
  revision: number;
  inputs: Record<string, number>;
  recent: string[];
  /**
   * The documents the piece made that are no rows, the entities of its
   * streams among them: a resume brings each into the replica before the
   * executor is started, since the stored result links to some of them by
   * no link a sync follows.
   */
  documents?: Record<string, 1>;
};

/** The document that holds the basis of the piece whose result is `result`. */
export const basisDocumentOf = (result: string): string =>
  identifierOf({ type: "basis", parent: result });

const identities = new WeakMap<Artifact, string>();

/**
 * The identity of a compiled pattern as a basis names it: the identity its
 * plan begins with, and the hash of the artifact where the plan names none.
 */
export const compiledIdentityOf = (artifact: Artifact): string => {
  let identity = identities.get(artifact);
  if (identity === undefined) {
    identity = artifact.plan.patterns?.[0] ??
      hashStringOf(JSON.parse(JSON.stringify(artifact)));
    identities.set(artifact, identity);
  }
  return identity;
};

/** What the storage holds as a basis, where it holds one. */
export const storedBasisOf = (value: unknown): StoredBasis | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { pattern, revision, inputs, recent, documents } = value as Record<
    string,
    unknown
  >;
  if (
    typeof pattern !== "string" || typeof revision !== "number" ||
    typeof inputs !== "object" || inputs === null || Array.isArray(inputs) ||
    !Array.isArray(recent) ||
    !recent.every((doc) => typeof doc === "string") ||
    !Object.values(inputs).every((seq) => typeof seq === "number")
  ) return undefined;
  return {
    pattern,
    revision,
    inputs: { ...inputs as Record<string, number> },
    recent: [...recent],
    documents: typeof documents === "object" && documents !== null
      ? Object.fromEntries(Object.keys(documents).map((doc) => [doc, 1]))
      : {},
  };
};

/** The sequence number recorded for a source that is never current. */
const NEVER = -1;

/**
 * Whether a stored basis matches the storage: `seqOf` gives the sequence
 * number of the confirmed view of a document, and `basisSeq` that of the
 * document of the basis.
 */
export const basisMatches = (
  basis: StoredBasis,
  basisSeq: number,
  seqOf: (doc: string) => number,
): boolean => {
  const recent = new Set(basis.recent);
  for (const doc of recent) if (seqOf(doc) > basisSeq) return false;
  for (const [doc, seq] of Object.entries(basis.inputs)) {
    if (!recent.has(doc) && (seq === NEVER || seqOf(doc) !== seq)) return false;
  }
  return true;
};

/** What `PieceBasis` writes and reads through. */
export type BasisStorage<Tx extends object> = {
  /**
   * The sequence number of the replica's confirmed view of a document, or
   * nothing for a document whose number the basis cannot compare: one of
   * another space.
   */
  seqOf(doc: string): number | undefined;
  /** Writes `value` at `path` of the document of the basis, in `tx`. */
  write(tx: Tx, path: readonly string[], value: unknown): void;
  /** Reads a document in `tx`, so that the commit depends on what it holds. */
  affirm(tx: Tx, doc: string): void;
  /**
   * The sequence number the storage accepted the commit of `tx` at, or
   * nothing while it has not. The replica's confirmed view of a document
   * the transaction wrote takes the number after the transaction knows it.
   */
  confirmedAt(tx: Tx): number | undefined;
  /**
   * The documents `tx` has written so far, whoever wrote them into it: a
   * caller that hands the piece a transaction can have written a source
   * there before.
   */
  writtenIn(tx: Tx): Iterable<string>;
  /** Whether `tx` ended in an error: it was aborted, or its commit failed. */
  failed(tx: Tx): boolean;
};

/** Keeps the basis of one piece while a runtime runs it. */
export class PieceBasis<Tx extends object> {
  readonly #pattern: string;
  readonly #storage: BasisStorage<Tx>;
  /** The sources, with what the storage holds as the number of each. */
  readonly #sources = new Map<string, number | undefined>();
  /** The sources whose number may differ from what the storage holds. */
  readonly #dirty = new Set<string>();
  /**
   * The transactions of the piece that wrote each source and whose commit
   * is neither confirmed nor refused.
   */
  readonly #own = new Map<string, Set<Tx>>();
  /** What each transaction wrote of the basis. */
  readonly #recorded = new WeakMap<Tx, string[]>();
  /** The list `recent` the storage holds, where that is known. */
  #recent: string[] | undefined;
  /**
   * The sources that the list `recent` of a resumed piece named and that
   * were not behind the basis when the piece was resumed: each stays in
   * the list, which holds for it, until the basis is next written.
   */
  readonly #carried = new Set<string>();
  /** Whether the document of the basis exists, as far as is known. */
  #exists: boolean;
  /** A transaction of the piece wrote a source since the last record. */
  #wroteSince = false;
  /** The documents the piece made, as `StoredBasis.documents` lists them. */
  readonly #made = new Set<string>();
  /** Those of `#made` that the storage does not list. */
  readonly #madeSince = new Set<string>();
  #revision: number;

  constructor(
    artifact: Artifact,
    storage: BasisStorage<Tx>,
    /**
     * For a piece that is resumed: the basis the storage holds, and the
     * sequence number of the document that holds it. A source whose
     * number the basis still gives is not written again.
     */
    resumed?: { stored: StoredBasis; seq: number },
  ) {
    this.#pattern = compiledIdentityOf(artifact);
    this.#storage = storage;
    const stored = resumed?.stored;
    this.#exists = stored !== undefined && stored.pattern === this.#pattern;
    this.#revision = stored?.revision ?? 0;
    if (resumed === undefined || stored === undefined || !this.#exists) return;
    for (const doc of Object.keys(stored.documents ?? {})) this.#made.add(doc);
    this.#recent = stored.recent;
    const recent = new Set(stored.recent);
    for (const [doc, seq] of Object.entries(stored.inputs)) {
      this.#sources.set(doc, seq);
      if (!recent.has(doc) && storage.seqOf(doc) !== seq) this.#dirty.add(doc);
    }
    for (const doc of recent) {
      const seq = storage.seqOf(doc);
      if (seq !== undefined && seq <= resumed.seq) {
        if (!this.#sources.has(doc)) this.#sources.set(doc, undefined);
        this.#carried.add(doc);
      } else {
        this.#sources.set(doc, undefined);
        this.#dirty.add(doc);
      }
    }
  }

  /** How many sources the piece has. */
  get size(): number {
    return this.#sources.size;
  }

  /** Whether a document is a source of the piece. */
  has(doc: string): boolean {
    return this.#sources.has(doc);
  }

  /** The piece made a document that is no row. */
  made(doc: string): void {
    if (this.#made.has(doc)) return;
    this.#made.add(doc);
    this.#madeSince.add(doc);
  }

  /** Takes a document as a source of the piece. */
  source(doc: string): void {
    if (this.#sources.has(doc)) return;
    this.#sources.set(doc, undefined);
    this.#dirty.add(doc);
  }

  /** A commit of any writer changed a document: its number may differ. */
  changed(doc: string): void {
    if (this.#sources.has(doc)) this.#dirty.add(doc);
  }

  /**
   * A transaction of the piece wrote `written`, and `sources` among them
   * are documents that a transaction of the executor that was no
   * derivation wrote, each a source from then on. Returns whether a source
   * is among `written` that the transaction was not known to have written.
   */
  wrote(
    tx: Tx,
    written: Iterable<string>,
    sources: Iterable<string>,
  ): boolean {
    for (const doc of sources) this.source(doc);
    let added = false;
    for (const doc of written) {
      if (!this.#sources.has(doc)) continue;
      let txs = this.#own.get(doc);
      if (txs === undefined) {
        txs = new Set();
        this.#own.set(doc, txs);
      }
      if (txs.has(tx)) continue;
      txs.add(tx);
      this.#wroteSince = true;
      added = true;
    }
    return added;
  }

  /**
   * The commit of a transaction of the piece was refused, or taken back
   * after it had settled: what it wrote of the basis is not stored, and
   * the sources it wrote hold what the storage holds.
   */
  refused(tx: Tx): void {
    for (const [doc, txs] of this.#own) {
      if (!txs.delete(tx)) continue;
      this.#dirty.add(doc);
      if (txs.size === 0) this.#own.delete(doc);
    }
    const recorded = this.#recorded.get(tx);
    if (recorded === undefined) return;
    for (const doc of recorded) {
      this.#sources.set(doc, undefined);
      this.#dirty.add(doc);
    }
    this.#recent = undefined;
    this.#exists = false;
    this.#wroteSince = true;
  }

  /**
   * Writes into `tx`, a transaction of the derivation that brought the
   * piece up to date, what the basis holds that the storage does not.
   * Without `always`, it writes only where a transaction of the piece
   * wrote a source since the last record: a change by another writer that
   * the derivation wrote nothing for is recorded with the next write, and
   * until then the basis is behind that source. Returns how many paths it
   * wrote.
   */
  record(tx: Tx, always: boolean): number {
    this.wrote(tx, this.#storage.writtenIn(tx), []);
    if (!always && !this.#wroteSince && this.#madeSince.size === 0) return 0;
    const { seqOf, confirmedAt, failed } = this.#storage;
    // A transaction that was aborted has no commit to be refused.
    const ended = new Set<Tx>();
    for (const txs of this.#own.values()) {
      for (const one of txs) if (failed(one)) ended.add(one);
    }
    for (const one of ended) this.refused(one);
    const unconfirmed: string[] = [];
    for (const [doc, txs] of this.#own) {
      const held = seqOf(doc);
      for (const one of txs) {
        const at = confirmedAt(one);
        if (at !== undefined && held !== undefined && held >= at) {
          txs.delete(one);
        }
      }
      if (txs.size > 0) unconfirmed.push(doc);
      else {
        this.#own.delete(doc);
        this.#dirty.add(doc);
      }
    }
    const numbered = (docs: Iterable<string>): [string, number][] => {
      const inputs: [string, number][] = [];
      for (const doc of docs) {
        if (this.#own.has(doc)) continue;
        this.#dirty.delete(doc);
        const seq = seqOf(doc) ?? NEVER;
        if (this.#sources.get(doc) !== seq) inputs.push([doc, seq]);
      }
      return inputs;
    };
    const inputs = numbered(this.#dirty);
    const carried = [...this.#carried].filter((doc) => !this.#own.has(doc));
    const same = (recent: string[]) =>
      this.#recent !== undefined && this.#recent.length === recent.length &&
      recent.every((doc) => this.#recent!.includes(doc));
    if (
      this.#exists && inputs.length === 0 && this.#madeSince.size === 0 &&
      same([...carried, ...unconfirmed]) &&
      !(this.#wroteSince && unconfirmed.length > 0)
    ) return 0;
    // The basis is written: each source the list named for a resumed piece
    // is given its number, and leaves the list.
    inputs.push(...numbered(carried));
    this.#carried.clear();
    const recent = unconfirmed;
    const sameRecent = same(recent);
    this.#wroteSince = false;
    this.#revision += 1;
    for (const doc of recent) this.#storage.affirm(tx, doc);
    this.#recent = recent;
    for (const [doc, seq] of inputs) this.#sources.set(doc, seq);
    if (!this.#exists) {
      // The document whole: every source that has a number.
      const all: Record<string, number> = {};
      const written: string[] = [];
      for (const [doc, seq] of this.#sources) {
        if (seq === undefined) continue;
        all[doc] = seq;
        written.push(doc);
      }
      this.#recorded.set(tx, written);
      this.#storage.write(
        tx,
        [],
        {
          pattern: this.#pattern,
          revision: this.#revision,
          inputs: all,
          recent,
          documents: Object.fromEntries(
            [...this.#made].map((doc) => [doc, 1]),
          ),
        } satisfies StoredBasis,
      );
      this.#madeSince.clear();
      this.#exists = true;
      return 1;
    }
    this.#recorded.set(tx, inputs.map(([doc]) => doc));
    for (const doc of this.#madeSince) {
      this.#storage.write(tx, ["documents", doc], 1);
    }
    this.#madeSince.clear();
    for (const [doc, seq] of inputs) {
      this.#storage.write(tx, ["inputs", doc], seq);
    }
    if (!sameRecent) this.#storage.write(tx, ["recent"], recent);
    this.#storage.write(tx, ["revision"], this.#revision);
    return inputs.length + (sameRecent ? 1 : 2);
  }
}
