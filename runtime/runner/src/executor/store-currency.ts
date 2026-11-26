/**
 * A serving loop's side of the currency index
 * (docs/specs/server-side-execution/serving-loop.md §3b): the records it
 * takes of the pieces it runs, and the judgment of which demanded roots the
 * store can serve with no piece started (§1).
 */

import { getLogger } from "@commonfabric/logger";
import type {
  CurrencyMarked,
  CurrencyRecord,
  CurrencyUpstreamRead,
} from "@commonfabric/memory/v2/currency-index";
import { ANY_INSTANCE } from "@commonfabric/memory/v2/currency-keys";
import { entityKindOfIdString } from "../entity-kind.ts";
import type { Runtime } from "../runtime.ts";
import type { MemorySpace, URI } from "../storage/interface.ts";
import type { HostMemoryServer } from "./host-memory-server.ts";
import type { ServingLoopStats } from "./stats.ts";

const logger = getLogger("store-currency", { enabled: true, level: "warn" });

/**
 * The modes a serving loop keeps the currency index in, as
 * `SERVER_EXECUTION_CURRENCY_INDEX` and `SpaceServerPolicy.currencyIndex`
 * name them.
 */
export const CURRENCY_INDEX_MODES = [
  "record",
  "skip",
  "start-upstream",
] as const;

/**
 * What a serving loop does with the currency index
 * (docs/specs/server-side-execution/serving-loop.md §1):
 *
 * - `record` stores records and judges each root it loads, and still loads
 *   every root. A piece that runs and is stale only through what is upstream
 *   of it has the pieces upstream started.
 * - `skip` leaves unloaded each root the judgment says the store can serve,
 *   parks without a load each root the judgment says a load starts no piece
 *   from, and does nothing else on the judgment: a root that is stale only
 *   through what is upstream of it is loaded as a refused one is, so its piece
 *   derives from what the store holds of the pieces upstream, and nothing
 *   upstream is started for it or for a piece that runs. It carries no
 *   demand, into another space or its own, as a loop that keeps no index
 *   carries none.
 * - `start-upstream` does what `skip` does, and where a root or a running
 *   piece is stale only through what is upstream of it, starts the pieces
 *   upstream and holds the root unloaded meanwhile.
 */
export type CurrencyIndexMode = (typeof CURRENCY_INDEX_MODES)[number];

/**
 * The mode `raw` names, or `undefined` where it names none: the comparison
 * is exact, so a value in another case or with a space around it names none.
 */
export const currencyIndexModeOf = (
  raw: string | undefined,
): CurrencyIndexMode | undefined =>
  CURRENCY_INDEX_MODES.find((mode) => mode === raw);

/**
 * The reason a `skip` loop counts a root under in `currency.refused` where
 * the judgment found it stale only through what is upstream of it. The
 * memory server counts no such root as refused, so the count is of the
 * roots a `start-upstream` loop would have held.
 */
export const STALE_UPSTREAM_REFUSAL = "stale-upstream";

/** The records of one quiescent point, before they are stored. */
export type CurrencySnapshot = {
  /** The highest input seq the quiescent point covered. */
  asOf: number;

  /** The loop's own derived commits above `asOf` at that point. */
  seen: number[];

  /** The records, one per piece. */
  records: CurrencyRecord[];
};

/**
 * An instance a serving loop demands for a read of it: one in another space
 * that a run of a piece read, or one in the loop's own space that keeps a
 * slice stale until the piece that writes it has run. `slice` is the key of
 * the slice the read belongs to, which says whose read it was.
 */
export type ForeignRead = {
  /** The key of the slice the read belongs to. */
  slice: string;

  /** The space the instance is in. */
  space: string;
  id: string;
  scopeKey: string;
};

/** A demand key to re-arm, with a seq at or below the input that marked it. */
export type CurrencyRearm = { key: string; seq: number };

/** How many records one request to the memory server carries. */
const RECORDS_PER_REQUEST = 64;

/** Whether `id` has the `scheme:rest` form of a document id. */
const isDocumentId = (id: string): id is URI => id.includes(":");

/** One tenure's records and judgments. */
export class StoreCurrency {
  readonly #space: MemorySpace;
  readonly #server: HostMemoryServer;
  readonly #mode: CurrencyIndexMode;
  readonly #epoch: string;
  readonly #serviceIdentity: string;
  readonly #stats: ServingLoopStats;
  readonly #onOwed: () => void;
  readonly #onMarked: (rearm: CurrencyRearm[]) => void;

  /** Whether the piece `piece` has nodes on the tenure's runtime. */
  readonly #runs: (piece: string) => boolean;

  /** The pieces a later snapshot covers whether or not they change again. */
  readonly #owed = new Set<string>();

  /**
   * What the runs of each piece read in another space, as the piece's
   * latest snapshot found it. A piece with no such read has no entry.
   */
  readonly #foreignReads = new Map<string, ForeignRead[]>();

  /** Whether `#foreignReads` changed since `takeForeignReadsChanged()`. */
  #foreignReadsChanged = false;

  /**
   * The pieces that run here and read the output of a piece of this space
   * that is not started here, as each one's latest snapshot found it. The
   * runtime recomputes nothing upstream of such a read, so only the index
   * says when it has gone stale.
   */
  readonly #readsUnstarted = new Set<string>();

  /** Whether `#upstream` changed since `takeUpstreamChanged()`. */
  #upstreamChanged = false;

  /**
   * The owed pieces a record of which was stored behind a commit its settle
   * had not covered, each with that settle's `asOf`. A snapshot taken at
   * that seq or below would be stored behind the same commit, so such a
   * piece waits for a settle that covers more.
   */
  readonly #behindAt = new Map<string, number>();

  /**
   * The pieces a snapshot was owed for because one marked piece kept
   * another at `1`, until a computation of theirs changes. Each is owed that
   * once, so two pieces that mark each other are not snapshotted in turns.
   */
  readonly #retakenForBlock = new Set<string>();

  /**
   * The demand keys left unloaded, each with the piece it is the root of and
   * the pieces it rests on that record a source origin.
   */
  readonly #served = new Map<
    string,
    { piece: string; origins: readonly string[] }
  >();

  /**
   * The demand keys left unloaded because what the store holds of them is
   * stale only through what is upstream, each with the piece it is the root
   * of and the pieces whose reads hold it: that piece, or pieces beneath
   * it. Starting the root's piece would not make it current, so the pieces
   * upstream are started and the root is judged again.
   */
  readonly #held = new Map<string, { piece: string; readers: string[] }>();

  /**
   * The pieces that run here and that the index holds stale only through
   * what is upstream of them.
   */
  readonly #staleRunning = new Set<string>();

  /**
   * The reads that keep a held root or a stale running piece from being
   * current, as the last judgment found them.
   */
  #upstream: CurrencyUpstreamRead[] = [];

  /**
   * The pieces `#upstream` names as the ones to start, each with how many
   * judgments have named it in a row and whether a record of it was stored
   * since the first of them.
   */
  readonly #producers = new Map<
    string,
    { judgments: number; recorded: boolean }
  >();

  /**
   * The pieces whose upstream the loop has given up on, each with the
   * producers that were named for it then: a judgment that names no other
   * producer for it holds nothing for it.
   */
  readonly #abandoned = new Map<string, Set<string>>();

  /**
   * The pieces that run here, that a stored record left stale, and that a
   * judgment then found with nothing upstream to start. A further record
   * that leaves one stale asks nothing; a slice of it newly marked does.
   */
  readonly #noUpstream = new Set<string>();

  /** Whether the roots left unloaded are owed a fresh judgment. */
  #judgmentOwed = true;

  /** How many judgments the memory server has not returned yet. */
  #judging = 0;

  /**
   * The earliest time a slice of the space expires at, as the last judgment
   * the memory server made found it.
   */
  #nextExpiry: number | undefined;

  /** The store head the marks were last brought up to from here. */
  #advancedThrough = 0;

  /** Settles once every record handed to `store()` so far has been stored. */
  #stored: Promise<void> = Promise.resolve();

  /** How many calls of `store()` have records still on their way. */
  #storing = 0;

  /**
   * Constructs an instance for the tenure serving `space`, whose records are
   * stored and whose roots are judged by `server`. `onOwed` is called when a
   * stored record leaves a piece owed another snapshot, which only a further
   * cycle of the loop takes, and when a judgment is owed for what is stale
   * upstream. `onMarked` is called with the keys left unloaded whose pieces
   * storing a record found marked. `runs` says whether a piece has nodes on
   * the tenure's runtime.
   */
  constructor(options: {
    space: MemorySpace;
    server: HostMemoryServer;
    mode: CurrencyIndexMode;
    epoch: string;
    serviceIdentity: string;
    stats: ServingLoopStats;
    onOwed: () => void;
    onMarked: (rearm: CurrencyRearm[]) => void;
    runs?: (piece: string) => boolean;
  }) {
    this.#runs = options.runs ?? (() => false);
    this.#space = options.space;
    this.#server = options.server;
    this.#mode = options.mode;
    this.#epoch = options.epoch;
    this.#serviceIdentity = options.serviceIdentity;
    this.#stats = options.stats;
    this.#onOwed = options.onOwed;
    this.#onMarked = options.onMarked;
  }

  /** The pieces a later snapshot covers whether or not they change again. */
  get accessForTestingOnly(): {
    readonly owed: Set<string>;
  } {
    return { owed: this.#owed };
  }

  /** Settles once every record handed to `store()` so far has been stored. */
  get stored(): Promise<void> {
    return this.#stored;
  }

  /** Whether records handed to `store()` are still on their way. */
  get storing(): boolean {
    return this.#storing > 0;
  }

  /** Whether a root the store can serve is left unloaded. */
  get skips(): boolean {
    return this.#mode !== "record";
  }

  /**
   * Whether the loop carries demand (serving-loop.md §3b): into the spaces
   * its runs read, and into its own space for what keeps something stale
   * upstream or what a withdrawn run waits on. Every mode but `skip`.
   */
  get carriesDemand(): boolean {
    return this.#mode !== "skip";
  }

  /** Whether any root is left unloaded on a judgment. */
  get servesFromStore(): boolean {
    return this.#served.size > 0 || this.#held.size > 0;
  }

  /**
   * Whether the index's marks are to be brought up to the store's head as
   * inputs arrive: a root is left unloaded, or a piece that runs here reads
   * the output of one that does not and the loop starts what is upstream of
   * a stale piece.
   */
  get followsMarks(): boolean {
    return this.servesFromStore ||
      (this.#startsUpstream && this.#readsUnstarted.size > 0);
  }

  /**
   * Whether a root is held, or a running piece is stale, through what is
   * upstream of it, with the pieces to start for it not yet run: what a
   * session reads of it is not current, so the watermark waits.
   */
  get staleUpstream(): boolean {
    return this.#held.size > 0 || this.#staleRunning.size > 0;
  }

  /**
   * The instances of this space that keep a held root or a stale running
   * piece from being current, which the loop demands so that the pieces
   * that write them run.
   */
  get upstreamReads(): readonly ForeignRead[] {
    return this.#upstream.map(({ slice, id, scopeKey }) => ({
      slice,
      space: this.#space,
      id,
      scopeKey,
    }));
  }

  /**
   * The pieces the last judgment named as the ones to start, by the piece
   * each is upstream of: one whose read holds a root, or one that runs.
   */
  get upstreamProducers(): ReadonlyMap<string, ReadonlySet<string>> {
    const producers = new Map<string, Set<string>>();
    for (const { reader, piece } of this.#upstream) {
      let pieces = producers.get(reader);
      if (pieces === undefined) {
        pieces = new Set();
        producers.set(reader, pieces);
      }
      pieces.add(piece);
    }
    return producers;
  }

  /**
   * What the loop knows of `piece`, which the last judgment named as one
   * to start: whether that judgment was the first to name it, and whether
   * a record of it is still on its way, owed, or not yet stored since it
   * was named.
   */
  producerProgress(piece: string): { named: boolean; unrecorded: boolean } {
    const known = this.#producers.get(piece);
    return {
      named: (known?.judgments ?? 0) <= 1,
      unrecorded: known?.recorded !== true || this.#owed.has(piece) ||
        this.#storing > 0,
    };
  }

  /**
   * Gives up on what is upstream of `reader`, a piece whose reads hold a
   * root or a stale running piece: none of the pieces named for it can be
   * started, or each has run and been recorded and it is stale still. A
   * root that no other piece's reads hold is no longer held, so the caller
   * loads it as it loads a refused root.
   *
   * @returns The demand keys that are no longer held.
   */
  abandonUpstream(reader: string): string[] {
    const producers = this.upstreamProducers.get(reader);
    if (producers === undefined) return [];
    this.#abandoned.set(reader, new Set(producers));
    this.#upstream = this.#upstream.filter((read) => read.reader !== reader);
    this.#upstreamChanged = true;
    this.#staleRunning.delete(reader);
    const released: string[] = [];
    for (const [key, held] of this.#held) {
      const readers = held.readers.filter((piece) => piece !== reader);
      if (readers.length === held.readers.length) continue;
      if (readers.length > 0) {
        this.#held.set(key, { piece: held.piece, readers });
      } else {
        this.#held.delete(key);
        released.push(key);
      }
    }
    this.#stats.currency.upstreamAbandoned += 1;
    return released;
  }

  /**
   * Gives up on what is upstream of every piece the last judgment named a
   * read of, and holds no root and no running piece for it any longer: the
   * loop came to rest with nothing under way that would bring the judgment
   * that clears them.
   *
   * @returns The demand keys that are no longer held.
   */
  abandonAllUpstream(): string[] {
    const released: string[] = [];
    for (const reader of [...this.upstreamProducers.keys()]) {
      for (const key of this.abandonUpstream(reader)) released.push(key);
    }
    // What is held or stale with no read named for it has nothing to wait
    // on either.
    for (const key of this.#held.keys()) released.push(key);
    this.#held.clear();
    this.#staleRunning.clear();
    return released;
  }

  /** Has the next call of `judge()` ask the memory server again. */
  oweJudgment(): void {
    this.#judgmentOwed = true;
  }

  /**
   * The time, in milliseconds since the epoch, at which a fresh judgment is
   * owed because a slice's record expires then, or `undefined` where no
   * slice expires or nothing rests on a record: no root is left unloaded,
   * and no piece that runs here is stale upstream. No commit marks such a
   * slice, so the loop has to ask at that time.
   */
  get nextExpiry(): number | undefined {
    return this.#restsOnRecords ? this.#nextExpiry : undefined;
  }

  /**
   * What the runs of the pieces this loop holds read in another space, by
   * piece. A read of every instance of a document names no instance to
   * demand, and is left out.
   */
  get foreignReads(): ReadonlyMap<string, readonly ForeignRead[]> {
    return this.#foreignReads;
  }

  /**
   * Whether a snapshot found a piece's reads in another space changed, or
   * gone, since this was last called.
   */
  takeForeignReadsChanged(): boolean {
    const changed = this.#foreignReadsChanged;
    this.#foreignReadsChanged = false;
    return changed;
  }

  /**
   * Whether a judgment, or a given-up reader, changed the reads that keep
   * something stale upstream since this was last called.
   */
  takeUpstreamChanged(): boolean {
    const changed = this.#upstreamChanged;
    this.#upstreamChanged = false;
    return changed;
  }

  /**
   * Snapshots each piece of `runtime` a computation of which changed since
   * the last snapshot, and each piece a snapshot is owed. The caller has
   * established that the scheduler is idle and that no effect is
   * outstanding. `asOf` is the input seq the settle covered and `ownSeqs` the
   * loop's own derived commits. Returns `undefined` when no piece is due.
   */
  snapshot(
    runtime: Runtime,
    asOf: number,
    ownSeqs: Iterable<number>,
  ): CurrencySnapshot | undefined {
    const changed = runtime.scheduler.takeChangedPieces();
    for (const piece of changed) {
      this.#behindAt.delete(piece);
      this.#retakenForBlock.delete(piece);
    }
    const pieces = new Set(changed);
    for (const piece of this.#owed) {
      // A settle that covers no more than the last one would be stored
      // behind the same commit.
      if ((this.#behindAt.get(piece) ?? -1) >= asOf) continue;
      pieces.add(piece);
    }
    const records: CurrencyRecord[] = [];
    for (const piece of pieces) {
      this.#owed.delete(piece);
      this.#behindAt.delete(piece);
      // A piece that is gone, or reads no other space any longer, has none.
      if (this.#foreignReads.delete(piece)) this.#foreignReadsChanged = true;
      this.#readsUnstarted.delete(piece);
      if (!isDocumentId(piece)) continue;
      const taken = runtime.scheduler.pieceCurrencySnapshot(this.#space, piece);
      if (taken === undefined) continue;
      if (taken.readsUnstarted) this.#readsUnstarted.add(piece);
      const foreign = taken.slices.flatMap((slice) =>
        slice.reads.filter((read) =>
          read.space !== this.#space && read.scopeKey !== ANY_INSTANCE
        ).map((read) => ({
          slice: slice.key,
          space: read.space,
          id: read.id,
          scopeKey: read.scopeKey,
        }))
      );
      if (foreign.length > 0) {
        this.#foreignReads.set(piece, foreign);
        this.#foreignReadsChanged = true;
      }
      const facts = runtime.runner.pieceCurrencyFacts(
        runtime.getCellFromLink({
          space: this.#space,
          id: piece,
          path: [],
          scope: taken.rootScope,
        }),
      );
      // What keeps the whole piece from being vouched for.
      const reasons: string[] = [...taken.unvouched];
      if (facts === undefined) reasons.push("no-pattern");
      // An origin is followed through the piece's one result document, so
      // a piece that holds an instance of it for each viewer, one of which
      // records an origin, is started rather than followed.
      else if (taken.rootScope !== "space" && facts.followsOrigin) {
        reasons.push("scoped-origin");
      }
      // A reason is counted once for a piece, whether it holds for the
      // piece or for some of its slices.
      const counted = new Set([
        ...reasons,
        ...taken.slices.flatMap((slice) => slice.unvouched),
      ]);
      for (const reason of counted) {
        const counts = this.#stats.currency.unvouched;
        counts[reason] = (counts[reason] ?? 0) + 1;
      }
      records.push({
        piece,
        under: taken.under,
        vouched: reasons.length === 0,
        writes: taken.writes,
        owned: facts?.owned ?? [],
        ...(facts !== undefined && facts.absentAsDefault.length > 0 &&
          { absentAsDefault: facts.absentAsDefault }),
        // The loop follows a recorded origin before it leaves a root that
        // rests on the piece unstarted (serving-loop.md §3e).
        ...(facts?.followsOrigin === true && taken.rootScope === "space" &&
          { followsOrigin: true }),
        slices: taken.slices.map((slice) => ({
          key: slice.key,
          vouched: slice.unvouched.length === 0,
          reads: slice.reads,
          vouches: slice.vouches,
          ...(slice.decides.length > 0 && { decides: slice.decides }),
          ...(slice.superseded.length > 0 &&
            { superseded: slice.superseded }),
          ...(slice.expiresAt !== undefined && { expiresAt: slice.expiresAt }),
        })),
      });
    }
    if (records.length === 0) return undefined;
    return { asOf, seen: [...ownSeqs].filter((seq) => seq > asOf), records };
  }

  /**
   * Stores `snapshot`, whose pieces' writes are all in the store: the wave
   * that carried them committed at `waveSeq`, or the cycle wrote nothing.
   * Returns at once; `stored` settles when the records are in.
   */
  store(snapshot: CurrencySnapshot, waveSeq?: number): void {
    const seen = waveSeq === undefined
      ? snapshot.seen
      : [...snapshot.seen, waveSeq];
    this.#storing += 1;
    this.#stored = this.#stored.then(async () => {
      for (
        let at = 0;
        at < snapshot.records.length;
        at += RECORDS_PER_REQUEST
      ) {
        const records = snapshot.records.slice(at, at + RECORDS_PER_REQUEST);
        // The last request names the pieces the earlier ones stored, so
        // pieces that read each other's writes across requests settle
        // together.
        const last = at + RECORDS_PER_REQUEST >= snapshot.records.length;
        const later = new Set(
          snapshot.records.slice(at + RECORDS_PER_REQUEST).map(({ piece }) =>
            piece
          ),
        );
        const stored = await this.#server.storeCurrencyRecords(this.#space, {
          asOf: snapshot.asOf,
          seen,
          epoch: this.#epoch,
          records,
          ...(last && at > 0 && {
            settle: snapshot.records.slice(0, at).map(({ piece }) => piece),
          }),
        });
        this.#stats.currency.recordsStored += records.length;
        this.#stats.currency.falseClean += stored.falseClean.length;
        if (stored.falseClean.length > 0) {
          logger.warn("currency-false-clean", () => [
            `space ${this.#space}: ${stored.falseClean.length} piece(s) the ` +
            "currency index held clean wrote a different value to an " +
            "output it answered for with no input changed: " +
            stored.falseClean.join(", "),
          ]);
        }
        let owed = false;
        // A piece a commit this settle had not covered left marked is
        // recorded again once a settle covers more: the serving runtime can
        // hold a frame above the settle's visible input head.
        for (const piece of stored.behind) {
          this.#owed.add(piece);
          this.#behindAt.set(piece, snapshot.asOf);
          owed = true;
        }
        // A piece that keeps one of these marked is recorded with it, so
        // that a producer running here clears what reads it.
        // A producer a later request of this snapshot stores is not one to
        // take again: the last request settles what it keeps marked.
        const blockedBy = last
          ? stored.blockedBy
          : stored.blockedBy.filter((piece) => !later.has(piece));
        if (blockedBy.length > 0) {
          for (const piece of [...blockedBy, ...stored.blocked]) {
            if (this.#retakenForBlock.has(piece)) continue;
            this.#retakenForBlock.add(piece);
            this.#owed.add(piece);
            owed = true;
          }
        }
        for (const { piece } of records) {
          const producer = this.#producers.get(piece);
          if (producer !== undefined) producer.recorded = true;
        }
        // A piece stored marked for an input upstream of it, and one a
        // slice of which the store found marked, may be stale only through
        // a piece that does not run here.
        const blocked = new Set(stored.blocked);
        for (const { piece } of records) {
          if (!blocked.has(piece)) this.#noUpstream.delete(piece);
        }
        this.#noteStale([
          ...stored.blocked.filter((piece) => !this.#noUpstream.has(piece)),
          ...upstreamMarked(stored.marked),
        ]);
        // A stored record is what clears a held root or a stale running
        // piece, or shows that it stays stale, so either is judged again.
        if (this.staleUpstream) {
          this.#judgmentOwed = true;
          owed = true;
        }
        if (owed) this.#onOwed();
        if (stored.marked.length > 0) {
          this.#judgmentOwed = true;
          const rearm = this.#rearmsFor(stored.marked);
          if (rearm.length > 0) this.#onMarked(rearm);
        }
      }
    }).catch((error) => {
      // What was not stored is owed again, to the next cycle that settles.
      this.owe(snapshot);
      logger.warn("currency-store-failed", () => [
        `space ${this.#space}: storing currency records failed`,
        error,
      ]);
    }).finally(() => {
      this.#storing -= 1;
    });
  }

  /**
   * Has a later snapshot cover the pieces of `snapshot` again: the wave that
   * carried their writes did not commit every one of them.
   */
  owe(snapshot: CurrencySnapshot): void {
    for (const record of snapshot.records) this.#owed.add(record.piece);
  }

  /**
   * Judges the roots of `rootKeys` that are space-scoped or `computed:`
   * documents and that `eligible` passes: the ones awaiting their first
   * structure load that are not warm demand. A root whose piece is running
   * here is not judged. `demandChanged` says whether any session's rows
   * changed since the last call. The pieces that run here and are stale
   * upstream are asked about with them, and alone where no root is.
   *
   * @returns The keys the store can serve, which the caller leaves unloaded
   * where the loop skips (`skips`) and loads anyway under `record`, with the
   * pieces each rests on that record a source origin (`origins`), which the
   * caller follows first; the keys a structure load starts no piece from,
   * which the caller parks without a load where the loop skips; the keys held because what the store holds of them is
   * stale only upstream, which the caller leaves unloaded while the
   * pieces upstream are started (`upstreamReads`), and which only a
   * `start-upstream` loop returns any of; and the keys a judgment had left
   * unloaded that an input has since marked, which the caller re-arms at
   * that input's seq and leaves to the re-arm's retry.
   */
  async judge(
    runtime: Runtime,
    rootKeys: ReadonlyMap<string, { id: string; scope: string }>,
    eligible: (key: string, root: { id: string; scope: string }) => boolean,
    demandChanged: boolean,
  ): Promise<
    {
      servable: string[];
      origins: ReadonlyMap<string, readonly string[]>;
      plain: string[];
      held: string[];
      rearm: CurrencyRearm[];
    }
  > {
    const eligibleRoots = new Map<string, string>();
    for (const [key, root] of rootKeys) {
      // A root narrower than the space is judged only where it is a
      // `computed:` document, which the judgment reads as the piece that
      // writes it and as one of the demanded instances that piece vouches
      // for.
      const judgeable = root.scope === "space" ||
        entityKindOfIdString(root.id) === "computed";
      if (judgeable && eligible(key, root)) {
        eligibleRoots.set(key, root.id);
      } else {
        this.#served.delete(key);
        this.#held.delete(key);
      }
    }
    // A root left unloaded whose piece has nodes was started some other
    // way, as an event's auto-start does, and is loaded like any other.
    const candidates = new Map<string, string>();
    for (const [key, root] of eligibleRoots) {
      const piece = this.#served.get(key)?.piece ??
        this.#held.get(key)?.piece;
      if (
        piece !== undefined && runtime.scheduler.hasNodesUnderDemandRoot(piece)
      ) {
        this.#served.delete(key);
        this.#held.delete(key);
      } else {
        candidates.set(key, root);
      }
    }
    const unloaded = () => {
      const servable = [...candidates.keys()].filter((key) =>
        this.#served.has(key)
      );
      return {
        servable,
        origins: this.#originsOf(servable),
        plain: [],
        held: [...candidates.keys()].filter((key) => this.#held.has(key)),
        rearm: [],
      };
    };
    // The pieces that run here whose slices the judgment is asked about:
    // those the index holds stale for an input upstream of them.
    const asked = new Set(this.#staleRunning);
    if (candidates.size === 0 && asked.size === 0) return unloaded();
    const settled = !this.#judgmentOwed && !demandChanged &&
      [...candidates.keys()].every((key) =>
        this.#served.has(key) || this.#held.has(key)
      );
    if (settled) return unloaded();
    this.#judgmentOwed = false;
    this.#stats.currency.judged += candidates.size;
    this.#judging += 1;
    const judged = await this.#server.judgeCurrencyRoots(
      this.#space,
      [...new Set(candidates.values())],
      {
        excludePrincipal: this.#serviceIdentity,
        epoch: this.#epoch,
        ...(asked.size > 0 && { running: [...asked] }),
      },
    ).finally(() => {
      this.#judging -= 1;
    });
    this.#nextExpiry = judged.nextExpiry;
    for (const [reason, count] of Object.entries(judged.refused)) {
      const counts = this.#stats.currency.refused;
      counts[reason] = (counts[reason] ?? 0) + count;
    }
    // A loop that starts nothing upstream takes no read to demand, so no
    // root is held and no running piece is kept as stale upstream.
    const upstream = this.#startsUpstream
      ? this.#takeUpstream(
        judged.upstream,
        new Set([...asked, ...judged.servable.map(({ piece }) => piece)]),
      )
      : new Set<string>();
    for (const piece of asked) {
      if (!upstream.has(piece)) this.#noUpstream.add(piece);
    }
    // A piece a slice of which this judgment found marked, and that was
    // not asked about, is asked about by the next.
    this.#noteStale(
      upstreamMarked(judged.marked).filter((piece) => !asked.has(piece)),
    );
    const pieces = new Map(
      judged.servable.map(({ root, piece }) => [root, piece]),
    );
    const origins = new Map(
      judged.servable.map(({ root, origins }) => [root, origins]),
    );
    const holding = new Map(
      judged.held.map(({ root, piece, readers }) => [root, { piece, readers }]),
    );
    const plainRoots = new Set(judged.plain);
    const servable: string[] = [];
    const plain: string[] = [];
    const held: string[] = [];
    const rearm: CurrencyRearm[] = [];
    for (const [key, root] of candidates) {
      // A document a load starts no piece from rests on no piece, so no mark
      // reaches it. The caller parks it as that load would, and a commit to
      // it brings the load.
      if (plainRoots.has(root)) {
        this.#served.delete(key);
        this.#held.delete(key);
        plain.push(key);
        this.#stats.currency.plainRoots += 1;
        continue;
      }
      const piece = pieces.get(root);
      // A piece with nodes here is running, and its root is loaded as one a
      // start already covers.
      if (
        piece !== undefined &&
        !runtime.scheduler.hasNodesUnderDemandRoot(piece)
      ) {
        this.#held.delete(key);
        servable.push(key);
        this.#stats.currency.servable += 1;
        if (this.skips) {
          if (!this.#served.has(key)) {
            this.#stats.currency.servedFromStore += 1;
          }
          this.#served.set(key, { piece, origins: origins.get(root) ?? [] });
        }
        continue;
      }
      const stale = holding.get(root);
      if (stale !== undefined && !this.#startsUpstream) {
        const counts = this.#stats.currency.refused;
        counts[STALE_UPSTREAM_REFUSAL] = (counts[STALE_UPSTREAM_REFUSAL] ?? 0) +
          1;
      }
      // The pieces whose reads hold the root, its own or ones beneath it,
      // less those whose upstream the loop gave up on.
      const readers = stale?.readers.filter((reader) => upstream.has(reader));
      // A root stale only upstream is held under `start-upstream` while the
      // pieces upstream are started. Under `record` it is loaded, and the
      // pieces whose reads hold it are then ones that run here and are stale
      // upstream. Under `skip` no reader is taken, and the root is loaded as
      // a refused one is.
      if (stale !== undefined && readers !== undefined && readers.length > 0) {
        this.#served.delete(key);
        if (
          this.skips &&
          !runtime.scheduler.hasNodesUnderDemandRoot(stale.piece)
        ) {
          held.push(key);
          if (!this.#held.has(key)) this.#stats.currency.heldUpstream += 1;
          this.#held.set(key, { piece: stale.piece, readers });
          continue;
        }
        this.#held.delete(key);
        for (const reader of readers) this.#staleRunning.add(reader);
        continue;
      }
      this.#held.delete(key);
      const left = this.#served.get(key);
      if (left === undefined) continue;
      this.#served.delete(key);
      this.#stats.currency.rearmed += 1;
      const seq = markingSeq(judged.marked, left.piece);
      if (seq !== undefined) rearm.push({ key, seq });
    }
    return {
      servable,
      origins: this.#originsOf(servable),
      plain,
      held,
      rearm,
    };
  }

  /**
   * Helper for `judge()`, which returns, for each of `keys` left unloaded
   * that rests on a piece recording a source origin, those pieces.
   */
  #originsOf(keys: readonly string[]): Map<string, readonly string[]> {
    const origins = new Map<string, readonly string[]>();
    for (const key of keys) {
      const pieces = this.#served.get(key)?.origins ?? [];
      if (pieces.length > 0) origins.set(key, pieces);
    }
    return origins;
  }

  /**
   * Takes the demand key `key` out of the keys left unloaded, for a caller
   * that loads it after all: the origin of a piece it rests on moved, and a
   * start is what runs the piece on the source it adopted.
   */
  load(key: string): void {
    this.#served.delete(key);
  }

  /**
   * Takes `upstream`, the reads a judgment found keeping a root or a
   * running piece stale upstream, in place of the last judgment's, leaving
   * out those of a piece whose upstream the loop gave up on with the same
   * producers named. A piece that runs here stays among the stale running
   * ones only while a read of its own is among them.
   *
   * `judged` are the pieces this judgment asked about, so one of them with
   * no read named has nothing upstream left to wait on.
   *
   * @returns The pieces a read of which was taken.
   */
  #takeUpstream(
    upstream: readonly CurrencyUpstreamRead[],
    judged: ReadonlySet<string>,
  ): Set<string> {
    const named = new Map<string, Set<string>>();
    for (const { reader, piece } of upstream) {
      let pieces = named.get(reader);
      if (pieces === undefined) {
        pieces = new Set();
        named.set(reader, pieces);
      }
      pieces.add(piece);
    }
    for (const [reader, given] of this.#abandoned) {
      const pieces = named.get(reader);
      // Resolved, or a piece upstream that was not named before: either
      // way the reader is asked about afresh. A judgment that did not ask
      // about the reader says nothing of it.
      if (
        pieces === undefined
          ? judged.has(reader)
          : [...pieces].some((piece) => !given.has(piece))
      ) this.#abandoned.delete(reader);
    }
    const taken = upstream.filter((read) => !this.#abandoned.has(read.reader));
    const signature = (reads: readonly CurrencyUpstreamRead[]) =>
      reads.map(({ slice, id, scopeKey }) => `${slice}\0${scopeKey}\0${id}`)
        .sort().join("\n");
    if (signature(taken) !== signature(this.#upstream)) {
      this.#upstreamChanged = true;
    }
    this.#upstream = taken;
    const readers = new Set(taken.map(({ reader }) => reader));
    for (const piece of [...this.#staleRunning]) {
      if (!readers.has(piece)) this.#staleRunning.delete(piece);
    }
    const producers = new Set(taken.map(({ piece }) => piece));
    for (const piece of [...this.#producers.keys()]) {
      if (!producers.has(piece)) this.#producers.delete(piece);
    }
    for (const piece of producers) {
      const known = this.#producers.get(piece);
      if (known !== undefined) {
        known.judgments += 1;
        continue;
      }
      this.#producers.set(piece, { judgments: 1, recorded: false });
      // One that runs here already may have nothing to recompute, and is
      // recorded all the same: its record is what says whether what reads
      // it is still stale.
      if (this.#runs(piece)) this.#owed.add(piece);
    }
    return readers;
  }

  /**
   * Notes that the index holds a slice of each of `pieces` stale for an
   * input upstream of it, with none of its own rows behind. One that runs
   * here may be stale only through a piece that does not, which the next
   * judgment is asked. A loop that starts nothing upstream notes none.
   */
  #noteStale(pieces: readonly string[]): void {
    if (!this.#startsUpstream) return;
    for (const piece of pieces) {
      this.#noUpstream.delete(piece);
      if (this.#staleRunning.has(piece) || !this.#runs(piece)) continue;
      this.#staleRunning.add(piece);
      this.#judgmentOwed = true;
    }
  }

  /**
   * Brings the index's marks up to the store's head, `head`, when the marks
   * are followed (`followsMarks`) and the head has moved since the last
   * call.
   *
   * @returns The keys left unloaded that an input has marked, each with a
   * seq at or below that input, which the caller re-arms.
   */
  async advance(head: number): Promise<CurrencyRearm[]> {
    if (!this.followsMarks || head <= this.#advancedThrough) return [];
    this.#advancedThrough = head;
    const marked = await this.#server.advanceCurrency(this.#space);
    if (marked.length === 0) return [];
    this.#judgmentOwed = true;
    this.#noteStale(upstreamMarked(marked));
    return this.#rearmsFor(marked);
  }

  /**
   * Notes that the index changed from outside this loop: a space a slice
   * read told this one of a change, or a request made for another space
   * marked a slice here.
   *
   * @returns Whether anything here rests on what the index holds, or a
   * judgment that may leave a root unloaded is under way: a further
   * judgment is then owed.
   */
  noteIndexChanged(): boolean {
    this.#judgmentOwed = true;
    return this.#restsOnRecords || this.#judging > 0;
  }

  /**
   * Whether the loop acts on what is stale only upstream, by starting the
   * pieces upstream of a held root or of a piece that runs: every mode but
   * `skip`.
   */
  get #startsUpstream(): boolean {
    return this.#mode !== "skip";
  }

  /**
   * Whether anything here rests on what the index holds: a root is left
   * unloaded, or a piece that runs here is stale upstream.
   */
  get #restsOnRecords(): boolean {
    return this.servesFromStore || this.#staleRunning.size > 0;
  }

  /** Forgets the demand key `key`, which no session demands any longer. */
  forget(key: string): void {
    this.#served.delete(key);
    this.#held.delete(key);
  }

  /**
   * Helper for `advance()` and `store()`, which takes each key left unloaded
   * whose piece `marked` marks, or a piece beneath it, out of the keys left
   * unloaded, and returns it with the seq it is re-armed at.
   */
  #rearmsFor(marked: readonly CurrencyMarked[]): CurrencyRearm[] {
    const rearm: CurrencyRearm[] = [];
    for (const [key, { piece }] of this.#served) {
      const seq = markingSeq(marked, piece);
      if (seq === undefined) continue;
      this.#served.delete(key);
      this.#stats.currency.rearmed += 1;
      rearm.push({ key, seq });
    }
    return rearm;
  }
}

/** The pieces a slice of which `marked` reports as stale upstream. */
const upstreamMarked = (marked: readonly CurrencyMarked[]): string[] =>
  marked.filter(({ upstream }) => upstream === true).map(({ piece }) => piece);

/**
 * The lowest seq at which `marked` marks `piece` or a piece beneath it, or
 * `undefined` when it marks neither.
 */
function markingSeq(
  marked: readonly CurrencyMarked[],
  piece: string,
): number | undefined {
  let lowest: number | undefined;
  for (const entry of marked) {
    if (entry.piece !== piece && !entry.under.includes(piece)) continue;
    if (lowest === undefined || entry.seq < lowest) lowest = entry.seq;
  }
  return lowest;
}
