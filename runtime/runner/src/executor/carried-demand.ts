/**
 * The demand a serving loop carries into the spaces its runs read
 * (serving-loop.md §3b): a read of an instance of another space by a run
 * under an actor is that actor's demand in that space. This module works
 * out the rows a loop offers each space from what its pieces' runs read
 * and the pairs that demand in its own space, and keeps each space sent
 * the set that stands.
 */

import { getLogger } from "@commonfabric/logger";
import {
  type CellScope,
  type ScopeKey,
  scopeKeyApplicableTo,
  type ScopeKeyIdentity,
  scopeOfScopeKey,
} from "@commonfabric/memory/v2";
import type { CarriedDemandRow } from "@commonfabric/memory/v2/server";
import type { HostMemoryServer } from "./host-memory-server.ts";
import type { ServingLoopStats } from "./stats.ts";
import type { ForeignRead } from "./store-currency.ts";

const logger = getLogger("carried-demand", { enabled: true, level: "warn" });

/**
 * A pair that demands in a space, with the client session it is carried
 * into another space for: the pair's own session there, or the origin of a
 * pair another space carried there. A demand that reached the space with
 * no pair, carried for an actor who may not read it, has an origin and no
 * principal.
 */
export type CarriedPair = ScopeKeyIdentity & {
  origin: CarriedDemandRow["origin"];
};

/**
 * What stands for the rows a space was last sent when it did not take
 * them. No set of rows is named by it.
 */
const NOT_TAKEN = "\0not-taken";

/**
 * The rows `reads` carry for `pairs`, by the space each is carried into
 * and then by a key that names the row. A read is carried for each pair
 * its run was made for, which the key of the run's slice says: every pair
 * for a run in the `space` slice, a user's pairs for one in that user's
 * slice, and the one pair for one in a session's slice. An instance
 * narrower than the space is carried for no pair but its own. A demand
 * with no pair carries the reads made in the `space` slice, and no other.
 */
export const carriedRowsOf = (
  reads: Iterable<ForeignRead>,
  pairs: readonly CarriedPair[],
): Map<string, Map<string, CarriedDemandRow>> => {
  const bySource = new Map<string, Map<string, CarriedDemandRow>>();
  for (const read of reads) {
    for (const pair of pairs) {
      if (
        !scopeKeyApplicableTo(read.slice, pair) ||
        !scopeKeyApplicableTo(read.scopeKey, pair)
      ) continue;
      let rows = bySource.get(read.space);
      if (rows === undefined) {
        rows = new Map();
        bySource.set(read.space, rows);
      }
      rows.set(
        [read.id, read.scopeKey, pair.origin.space, pair.origin.sessionId]
          .join("\0"),
        {
          id: read.id,
          scope: scopeOfScopeKey(read.scopeKey) as CellScope,
          scopeKey: read.scopeKey as ScopeKey,
          origin: pair.origin,
        },
      );
    }
  }
  return bySource;
};

/** What one serving loop carries into other spaces, as it was last sent. */
export class CarriedDemand {
  readonly #space: string;
  readonly #server: Pick<HostMemoryServer, "setCarriedDemand">;
  readonly #serviceIdentity: string;
  readonly #stats: ServingLoopStats;

  /**
   * What each space was last sent: its rows as one string, so that a set
   * that has not changed is not sent again, and how many they were. A space
   * that did not take its last set holds `NOT_TAKEN` in place of the
   * string, which no set matches.
   */
  readonly #sent = new Map<string, { signature: string; rows: number }>();

  #settled: Promise<void> = Promise.resolve();
  #retryOwed = false;

  constructor(options: {
    /** The space whose loop this is. */
    space: string;
    server: Pick<HostMemoryServer, "setCarriedDemand">;
    serviceIdentity: string;
    stats: ServingLoopStats;
  }) {
    this.#space = options.space;
    this.#server = options.server;
    this.#serviceIdentity = options.serviceIdentity;
    this.#stats = options.stats;
  }

  /** Whether any space holds rows this loop sent it, as far as it knows. */
  get carries(): boolean {
    return this.#sent.size > 0;
  }

  /**
   * Whether a space did not take the last set it was sent, so that what it
   * holds is unknown until `send()` is called again.
   */
  get retryOwed(): boolean {
    return this.#retryOwed;
  }

  /** Settles once every set sent so far has been taken or has failed. */
  get settled(): Promise<void> {
    return this.#settled;
  }

  /**
   * Sends each space the rows `bySource` holds for it, and an empty set to
   * each space that was sent rows before and has none now. A space whose
   * rows are the ones it was last sent is sent nothing.
   */
  send(
    bySource: ReadonlyMap<string, ReadonlyMap<string, CarriedDemandRow>>,
  ): void {
    this.#retryOwed = false;
    for (const source of new Set([...bySource.keys(), ...this.#sent.keys()])) {
      const rows = bySource.get(source);
      this.#sendTo(
        source,
        rows === undefined ? [] : [...rows.values()],
        rows === undefined ? "" : [...rows.keys()].sort().join("\n"),
      );
    }
  }

  /** Withdraws everything this loop carries. */
  withdraw(): void {
    this.send(new Map());
  }

  /**
   * Helper for `send()`, which replaces what is carried into `source` with
   * `rows`, whose `signature` names them, unless it is what `source` was
   * last sent.
   */
  #sendTo(source: string, rows: CarriedDemandRow[], signature: string): void {
    const sent = this.#sent.get(source);
    if ((sent?.signature ?? "") === signature) return;
    const entry = { signature, rows: rows.length };
    if (rows.length === 0) this.#sent.delete(source);
    else this.#sent.set(source, entry);
    const stats = this.#stats.currency;
    stats.carried += rows.length - (sent?.rows ?? 0);
    this.#settled = this.#settled.then(async () => {
      const { refused } = await this.#server.setCarriedDemand(
        source,
        this.#space,
        rows,
        { excludePrincipal: this.#serviceIdentity },
      );
      stats.carriedRefused += refused;
    }).catch((error) => {
      logger.warn("carried-demand-failed", () => [
        `space ${this.#space}: the demand carried into ${source} was not ` +
        "taken",
        error,
      ]);
      // What `source` holds is now unknown, so the next set is sent
      // whatever it holds, unless a later one has been sent since.
      const latest = this.#sent.get(source);
      if (latest !== undefined && latest !== entry) return;
      this.#sent.set(source, { signature: NOT_TAKEN, rows: rows.length });
      this.#retryOwed = true;
    });
  }
}
