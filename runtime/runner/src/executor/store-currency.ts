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
} from "@commonfabric/memory/v2/currency-index";
import { ANY_INSTANCE } from "@commonfabric/memory/v2/currency-keys";
import { entityKindOfIdString } from "../entity-kind.ts";
import type { Runtime } from "../runtime.ts";
import type { MemorySpace, URI } from "../storage/interface.ts";
import type { HostMemoryServer } from "./host-memory-server.ts";
import type { ServingLoopStats } from "./stats.ts";

const logger = getLogger("store-currency", { enabled: true, level: "warn" });

/**
 * What a serving loop does with the currency index: `record` stores records
 * and judges each root it loads, and still loads every root; `skip` leaves
 * unloaded each root the judgment says the store can serve.
 */
export type CurrencyIndexMode = "record" | "skip";

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
 * An instance in another space that a run of a piece read, with the slice
 * the run belongs to, which says whose run it was.
 */
export type ForeignRead = {
  /** The key of the slice the run that read belongs to. */
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

  /** The demand keys left unloaded, each with the piece it is the root of. */
  readonly #served = new Map<string, string>();

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
   * cycle of the loop takes. `onMarked` is called with the keys left
   * unloaded whose pieces storing a record found marked.
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
  }) {
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
    return this.#mode === "skip";
  }

  /** Whether any root is left unloaded on a judgment. */
  get servesFromStore(): boolean {
    return this.#served.size > 0;
  }

  /**
   * The time, in milliseconds since the epoch, at which a root left
   * unloaded is owed a fresh judgment because a slice's record expires
   * then, or `undefined` where no root is left unloaded or no slice expires.
   * No commit marks such a slice, so the loop has to ask at that time.
   */
  get nextExpiry(): number | undefined {
    return this.#served.size > 0 ? this.#nextExpiry : undefined;
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
      if (!isDocumentId(piece)) continue;
      const taken = runtime.scheduler.pieceCurrencySnapshot(this.#space, piece);
      if (taken === undefined) continue;
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
          scope: "space",
        }),
      );
      // What keeps the whole piece from being vouched for.
      const reasons: string[] = [...taken.unvouched];
      // A start is where a piece's source origin is followed, so a piece
      // that records one is never left unstarted.
      if (facts === undefined) reasons.push("no-pattern");
      else if (facts.followsOrigin) reasons.push("source-origin");
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
        slices: taken.slices.map((slice) => ({
          key: slice.key,
          vouched: slice.unvouched.length === 0,
          reads: slice.reads,
          vouches: slice.vouches,
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
            "currency index held clean wrote a different value to a " +
            "vouched output with no input changed: " +
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
   * changed since the last call.
   *
   * @returns The keys the store can serve, which the caller leaves unloaded
   * under `skip` and loads anyway under `record`, and the keys a judgment
   * had left unloaded that an input has since marked, which the caller
   * re-arms at that input's seq and leaves to the re-arm's retry.
   */
  async judge(
    runtime: Runtime,
    rootKeys: ReadonlyMap<string, { id: string; scope: string }>,
    eligible: (key: string, root: { id: string; scope: string }) => boolean,
    demandChanged: boolean,
  ): Promise<{ servable: string[]; rearm: CurrencyRearm[] }> {
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
      }
    }
    if (eligibleRoots.size === 0) return { servable: [], rearm: [] };
    // A root left unloaded whose piece has nodes was started some other
    // way, as an event's auto-start does, and is loaded like any other.
    const candidates = new Map<string, string>();
    for (const [key, root] of eligibleRoots) {
      const piece = this.#served.get(key);
      if (
        piece !== undefined && runtime.scheduler.hasNodesUnderDemandRoot(piece)
      ) {
        this.#served.delete(key);
      } else {
        candidates.set(key, root);
      }
    }
    if (candidates.size === 0) return { servable: [], rearm: [] };
    const settled = !this.#judgmentOwed && !demandChanged &&
      [...candidates.keys()].every((key) => this.#served.has(key));
    if (settled) return { servable: [...candidates.keys()], rearm: [] };
    this.#judgmentOwed = false;
    this.#stats.currency.judged += candidates.size;
    this.#judging += 1;
    const judged = await this.#server.judgeCurrencyRoots(
      this.#space,
      [...new Set(candidates.values())],
      {
        excludePrincipal: this.#serviceIdentity,
        epoch: this.#epoch,
      },
    ).finally(() => {
      this.#judging -= 1;
    });
    this.#nextExpiry = judged.nextExpiry;
    for (const [reason, count] of Object.entries(judged.refused)) {
      const counts = this.#stats.currency.refused;
      counts[reason] = (counts[reason] ?? 0) + count;
    }
    const pieces = new Map(
      judged.servable.map(({ root, piece }) => [root, piece]),
    );
    const servable: string[] = [];
    const rearm: CurrencyRearm[] = [];
    for (const [key, root] of candidates) {
      const piece = pieces.get(root);
      // A piece with nodes here is running, and its root is loaded as one a
      // start already covers.
      if (
        piece !== undefined &&
        !runtime.scheduler.hasNodesUnderDemandRoot(piece)
      ) {
        servable.push(key);
        this.#stats.currency.servable += 1;
        if (this.#mode === "skip" && !this.#served.has(key)) {
          this.#served.set(key, piece);
          this.#stats.currency.servedFromStore += 1;
        }
        continue;
      }
      const left = this.#served.get(key);
      if (left === undefined) continue;
      this.#served.delete(key);
      this.#stats.currency.rearmed += 1;
      const seq = markingSeq(judged.marked, left);
      if (seq !== undefined) rearm.push({ key, seq });
    }
    return { servable, rearm };
  }

  /**
   * Brings the index's marks up to the store's head, `head`, when any root
   * is left unloaded and the head has moved since the last call.
   *
   * @returns The keys left unloaded that an input has marked, each with a
   * seq at or below that input, which the caller re-arms.
   */
  async advance(head: number): Promise<CurrencyRearm[]> {
    if (this.#served.size === 0 || head <= this.#advancedThrough) return [];
    this.#advancedThrough = head;
    const marked = await this.#server.advanceCurrency(this.#space);
    if (marked.length === 0) return [];
    this.#judgmentOwed = true;
    return this.#rearmsFor(marked);
  }

  /**
   * Notes that the index changed from outside this loop: a space a slice
   * read told this one of a change, or a request made for another space
   * marked a slice here.
   *
   * @returns Whether a root is left unloaded, or a judgment that may leave
   * one is under way: a further judgment is then owed.
   */
  noteIndexChanged(): boolean {
    this.#judgmentOwed = true;
    return this.#served.size > 0 || this.#judging > 0;
  }

  /** Forgets the demand key `key`, which no session demands any longer. */
  forget(key: string): void {
    this.#served.delete(key);
  }

  /**
   * Helper for `advance()` and `store()`, which takes each key left unloaded
   * whose piece `marked` marks, or a piece beneath it, out of the keys left
   * unloaded, and returns it with the seq it is re-armed at.
   */
  #rearmsFor(marked: readonly CurrencyMarked[]): CurrencyRearm[] {
    const rearm: CurrencyRearm[] = [];
    for (const [key, piece] of this.#served) {
      const seq = markingSeq(marked, piece);
      if (seq === undefined) continue;
      this.#served.delete(key);
      this.#stats.currency.rearmed += 1;
      rearm.push({ key, seq });
    }
    return rearm;
  }
}

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
