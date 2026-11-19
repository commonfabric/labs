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

  /** The pieces a later snapshot covers whether or not they change again. */
  readonly #owed = new Set<string>();

  /** The demand keys left unloaded, each with the piece it is the root of. */
  readonly #served = new Map<string, string>();

  /** Whether the roots left unloaded are owed a fresh judgment. */
  #judgmentOwed = true;

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
   * cycle of the loop takes.
   */
  constructor(options: {
    space: MemorySpace;
    server: HostMemoryServer;
    mode: CurrencyIndexMode;
    epoch: string;
    serviceIdentity: string;
    stats: ServingLoopStats;
    onOwed: () => void;
  }) {
    this.#space = options.space;
    this.#server = options.server;
    this.#mode = options.mode;
    this.#epoch = options.epoch;
    this.#serviceIdentity = options.serviceIdentity;
    this.#stats = options.stats;
    this.#onOwed = options.onOwed;
  }

  /** Settles once every record handed to `store()` so far has been stored. */
  get stored(): Promise<void> {
    return this.#stored;
  }

  /** Whether records handed to `store()` are still on their way. */
  get storing(): boolean {
    return this.#storing > 0;
  }

  /** Whether any root is left unloaded on a judgment. */
  get servesFromStore(): boolean {
    return this.#served.size > 0;
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
    const pieces = new Set([
      ...this.#owed,
      ...runtime.scheduler.takeChangedPieces(),
    ]);
    this.#owed.clear();
    const records: CurrencyRecord[] = [];
    for (const piece of pieces) {
      if (!isDocumentId(piece)) continue;
      const taken = runtime.scheduler.pieceCurrencySnapshot(this.#space, piece);
      if (taken === undefined) continue;
      const facts = runtime.runner.pieceCurrencyFacts(
        runtime.getCellFromLink({
          space: this.#space,
          id: piece,
          path: [],
          scope: "space",
        }),
      );
      records.push({
        piece,
        under: taken.under,
        // A start is where a piece's source origin is followed, so a piece
        // that records one is never left unstarted.
        vouched: taken.vouched && facts !== undefined && !facts.followsOrigin,
        reads: taken.reads,
        writes: taken.writes,
        owned: facts?.owned ?? [],
        vouches: taken.vouches,
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
        const stored = await this.#server.storeCurrencyRecords(this.#space, {
          asOf: snapshot.asOf,
          seen,
          epoch: this.#epoch,
          records,
        });
        this.#stats.currency.recordsStored += records.length;
        this.#stats.currency.falseClean += stored.falseClean.length;
        if (stored.falseClean.length > 0) {
          logger.warn("currency-false-clean", () => [
            `space ${this.#space}: ${stored.falseClean.length} piece(s) the ` +
            "currency index held clean wrote a vouched output again with " +
            "no input changed: " + stored.falseClean.join(", "),
          ]);
        }
        // A piece that keeps one of these marked is recorded next, so that
        // a producer running here clears what reads it. So is a piece a
        // commit this settle had not covered left marked: the serving
        // runtime can hold a frame above the settle's visible input head,
        // and the next settle covers it.
        const owed = [...stored.blockedBy, ...stored.behind];
        for (const piece of owed) this.#owed.add(piece);
        if (owed.length > 0) this.#onOwed();
        if (stored.marked.length > 0) this.#judgmentOwed = true;
      }
    }).catch((error) => {
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
   * Judges the roots of `rootKeys` that await their first structure load,
   * whose pieces are not running, are not warm demand, and are space-scoped
   * result documents; `eligible` says which keys are neither. `demandChanged`
   * says whether any session's rows changed since the last call.
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
    const candidates = new Map<string, string>();
    for (const [key, root] of rootKeys) {
      if (
        !isDocumentId(root.id) || root.scope !== "space" ||
        !eligible(key, root)
      ) {
        this.#served.delete(key);
        continue;
      }
      const cell = runtime.getCellFromLink({
        space: this.#space,
        id: root.id,
        path: [],
        scope: "space",
      });
      if (runtime.runner.isRunning(cell)) {
        this.#served.delete(key);
        continue;
      }
      candidates.set(key, root.id);
    }
    if (candidates.size === 0) return { servable: [], rearm: [] };
    const settled = !this.#judgmentOwed && !demandChanged &&
      [...candidates.keys()].every((key) => this.#served.has(key));
    if (settled) return { servable: [...candidates.keys()], rearm: [] };
    this.#judgmentOwed = false;
    const judged = await this.#server.judgeCurrencyRoots(
      this.#space,
      [...new Set(candidates.values())],
      { excludePrincipal: this.#serviceIdentity, epoch: this.#epoch },
    );
    const passing = new Set(judged.servable);
    const servable: string[] = [];
    const rearm: CurrencyRearm[] = [];
    for (const [key, piece] of candidates) {
      if (passing.has(piece)) {
        servable.push(key);
        this.#stats.currency.servable += 1;
        if (this.#mode === "skip" && !this.#served.has(key)) {
          this.#served.set(key, piece);
          this.#stats.currency.servedFromStore += 1;
        }
        continue;
      }
      if (!this.#served.delete(key)) continue;
      this.#stats.currency.rearmed += 1;
      const seq = markingSeq(judged.marked, piece);
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

  /** Forgets the demand key `key`, which no session demands any longer. */
  forget(key: string): void {
    this.#served.delete(key);
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
