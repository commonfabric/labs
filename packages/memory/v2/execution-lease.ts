// The holder side of the server-execution v2 single-deriver lease
// (docs/specs/server-side-execution/serving-loop.md §2). One row per space in
// `execution_lease` — `(space, holder, expires_at)`, exactly — created by the
// engine schema; this module is how a SpaceServer's host acquires, renews,
// and releases that row. Every write here is a DIRECT engine-table write on
// the direct-engine plane (serving-loop.md §1 plane (c)): a lease acquire or
// renewal is NEVER a commit, and nothing about the lease rides the commit
// stream. The admission-side half — the one equality check a derived-class
// commit must pass — lives with the engine's `applyCommit`.

import type { Engine } from "./engine.ts";

/** How long an acquired or renewed lease lives (serving-loop.md §2). */
export const EXECUTION_LEASE_TTL_MS = 15_000;

/**
 * The cadence a holder renews on (serving-loop.md §2): a third of the TTL,
 * so a holder misses two renewals before its lease can lapse. The timer that
 * drives `ExecutionLeaseCycle.renew` on this cadence belongs to the
 * SpaceServer (serving-loop.md §1 lists the lease, "renewed on a timer",
 * among its components); this module owns the transitions, not the schedule.
 */
export const EXECUTION_LEASE_RENEW_INTERVAL_MS = 5_000;

/**
 * The process-instance component of the lease holder identity, minted once
 * at PROCESS START (module initialization) — DR1, serving-loop.md §2. Stable
 * across every renew and reacquire within one process lifetime; fresh
 * whenever the process is genuinely new. This is what lets the admission
 * equality check itself fence every CROSS-process succession: a successor
 * process's holder never equals its predecessor's. A realm that serves on a
 * process's behalf adopts the component that process minted for it
 * ({@link adoptProcessInstanceId}) in place of this one.
 */
export const processInstanceId: string = crypto.randomUUID();

/** The component holders are minted with: the adopted one, else the realm's. */
let currentProcessInstance: string = processInstanceId;

/** The process-instance component every holder minted from now on carries. */
export const currentProcessInstanceId = (): string => currentProcessInstance;

/**
 * Makes `id` the process-instance component of every holder minted from here
 * on. The serving loop's worker adopts the component the process minted for
 * that worker's start: the lease rows the worker then writes name the holder
 * the process's memory server matches against, and a component fresh per
 * start keeps a restarted worker's commits apart from its predecessor's under
 * the engine's replay keying. The process adopts the same component itself,
 * so the two realms agree.
 */
export const adoptProcessInstanceId = (id: string): void => {
  currentProcessInstance = id;
};

/**
 * The DR1 holder identity: the SpaceServer's service identity plus the
 * process-instance component. It stays a nameable, attestable identity —
 * protocol.md §1's "the envelope principal IS the lease holder" reads
 * literally. The `processInstance` parameter exists for tests that model a
 * process succession; production callers take the default.
 */
export const executionLeaseHolder = (
  serviceIdentity: string,
  processInstance: string = currentProcessInstance,
): string => `${serviceIdentity}#${processInstance}`;

/**
 * The service-identity component of a DR1 holder — everything before the
 * process-instance suffix. The lease-holder READ admission (protocol.md
 * §2's read row) matches a session's authenticated principal against
 * this: the holder is `<serviceIdentity>#<processInstance>` and the
 * process instance is a UUID (never containing `#`), so the last `#`
 * splits exactly.
 */
export const serviceIdentityOfExecutionLeaseHolder = (
  holder: string,
): string => {
  const separator = holder.lastIndexOf("#");
  return separator === -1 ? holder : holder.slice(0, separator);
};

/**
 * The space's live lease holder, judged by the caller's clock (the memory
 * server's own — the two are co-hosted). Returns undefined when no live
 * lease exists; an expired row matches nobody (serving-loop.md §2). The
 * read-side admission (protocol.md §2's read row) consumes this.
 */
export const liveExecutionLeaseHolder = (
  engine: Engine,
  space: string,
  now: number = Date.now(),
): string | undefined => {
  // The engine's own prepared admission statement — ONE copy of the
  // liveness query, so read-side and commit-side liveness semantics
  // cannot drift.
  const row = engine.statements.selectLiveExecutionLease.get({
    space,
    now,
  }) as { holder: string } | undefined;
  return row?.holder;
};

export type ExecutionLeaseWrite = {
  space: string;
  holder: string;

  /** The caller's clock. The host and the memory server are co-hosted (one
   *  process — serving-loop.md §1), so this is the same clock admission
   *  judges liveness by. Injectable so tests can construct expiry without
   *  waiting on real time. */
  now?: number;

  ttlMs?: number;
};

// The conditional write (serving-loop.md §2): take the row when it is free,
// expired, or already ours. `excluded` carries the VALUES of the attempted
// insert; the WHERE guards the update half so a live foreign lease is never
// overwritten.
const ACQUIRE = `
INSERT INTO execution_lease (space, holder, expires_at)
VALUES (:space, :holder, :expires_at)
ON CONFLICT (space) DO UPDATE SET
  holder = excluded.holder,
  expires_at = excluded.expires_at
WHERE execution_lease.holder = excluded.holder
   OR execution_lease.expires_at <= :now
`;

// Renewal only ever EXTENDS a lease the caller still holds live: a lapsed or
// succeeded holder's renewal matches zero rows, and that zero is the signal
// to stop committing (serving-loop.md §2's MUST).
const RENEW = `
UPDATE execution_lease
SET expires_at = :expires_at
WHERE space = :space
  AND holder = :holder
  AND expires_at > :now
`;

const RELEASE = `
DELETE FROM execution_lease
WHERE space = :space
  AND holder = :holder
`;

/**
 * Acquire the space's lease with one conditional write. Returns whether the
 * caller now holds it: `true` when the row was free, expired, or already the
 * caller's own; `false` when another holder's lease is still live.
 */
export const acquireExecutionLease = (
  engine: Engine,
  {
    space,
    holder,
    now = Date.now(),
    ttlMs = EXECUTION_LEASE_TTL_MS,
  }: ExecutionLeaseWrite,
): boolean =>
  engine.database.prepare(ACQUIRE).run({
    space,
    holder,
    now,
    expires_at: now + ttlMs,
  }) > 0;

/**
 * Renew a held lease by direct table update — a renewal is NEVER a commit
 * (serving-loop.md §2). Returns `false` when there was nothing live to
 * renew — the row expired or another holder took it — which is the moment
 * the holder MUST stop committing.
 */
export const renewExecutionLease = (
  engine: Engine,
  {
    space,
    holder,
    now = Date.now(),
    ttlMs = EXECUTION_LEASE_TTL_MS,
  }: ExecutionLeaseWrite,
): boolean =>
  engine.database.prepare(RENEW).run({
    space,
    holder,
    now,
    expires_at: now + ttlMs,
  }) > 0;

/**
 * Release the caller's own lease row (parking — serving-loop.md §1). A row
 * held by someone else is left alone.
 */
export const releaseExecutionLease = (
  engine: Engine,
  { space, holder }: Pick<ExecutionLeaseWrite, "space" | "holder">,
): void => {
  engine.database.prepare(RELEASE).run({ space, holder });
};

export type ExecutionLeaseCycleOptions = {
  engine: Engine;
  space: string;

  /** The DR1 per-process holder identity (`executionLeaseHolder`). */
  holder: string;

  ttlMs?: number;

  /** The cycle's clock; injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
};

/**
 * One space's acquire/renew/expire cycle from the holder's side, with the
 * abort-before-reacquire discipline enforced IN-PROCESS (serving-loop.md §2,
 * DR1's residue). The discipline is structural, not procedural:
 *
 * - a TENURE is one stretch of holding between an acquire and the loss that
 *   ends it. Work seals under the tenure it read (`tenure` at seal time) and
 *   checks `isCurrentTenure` at its commit step;
 * - a failed renewal (or a release) ends the tenure BEFORE any reacquire can
 *   begin — `isCurrentTenure` goes false for everything in flight, which is
 *   "stop committing immediately";
 * - a reacquire mints the NEXT tenure, so work sealed under the lapsed one
 *   can never pass the check afterward either.
 *
 * There is no path to a reacquire that does not first end the old tenure.
 * This in-memory counter is the whole mechanism — co-hosting makes the
 * sequencing local, which is why the lease needs no per-commit token in the
 * table or on the wire (serving-loop.md §2's FORBIDDEN list): cross-process
 * succession is already fenced by the holder's process-instance component,
 * and the same-process residue is this local obligation.
 */
export class ExecutionLeaseCycle {
  readonly #engine: Engine;
  readonly #space: string;
  readonly #holder: string;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #held = false;
  #tenure = 0;

  constructor(options: ExecutionLeaseCycleOptions) {
    this.#engine = options.engine;
    this.#space = options.space;
    this.#holder = options.holder;
    this.#ttlMs = options.ttlMs ?? EXECUTION_LEASE_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  get holder(): string {
    return this.#holder;
  }

  get held(): boolean {
    return this.#held;
  }

  /** The current tenure number. Captured at seal time by work that will
   *  check `isCurrentTenure` at its commit step. Meaningful only while
   *  `held`. */
  get tenure(): number {
    return this.#tenure;
  }

  /** The in-process discipline check: whether work sealed under
   *  `sealedTenure` may still commit. False the moment the lease is lost
   *  and forever after — a reacquire starts a NEW tenure. */
  isCurrentTenure(sealedTenure: number): boolean {
    return this.#held && sealedTenure === this.#tenure;
  }

  /**
   * Acquire (or re-acquire) the lease. On success the cycle enters a new
   * tenure. Already holding is a no-op `true` — an accidental double
   * acquire must not abort the tenure's in-flight work.
   */
  acquire(): boolean {
    if (this.#held) return true;
    const acquired = acquireExecutionLease(this.#engine, {
      space: this.#space,
      holder: this.#holder,
      now: this.#now(),
      ttlMs: this.#ttlMs,
    });
    if (acquired) {
      this.#tenure += 1;
      this.#held = true;
    }
    return acquired;
  }

  /**
   * Renew the held lease (the SpaceServer drives this every
   * `EXECUTION_LEASE_RENEW_INTERVAL_MS`). A failed renewal ends the tenure
   * right here — before the caller can see the `false`, let alone
   * reacquire — which is the abort-before-reacquire sequencing.
   */
  renew(): boolean {
    if (!this.#held) return false;
    const renewed = renewExecutionLease(this.#engine, {
      space: this.#space,
      holder: this.#holder,
      now: this.#now(),
      ttlMs: this.#ttlMs,
    });
    if (!renewed) {
      this.#held = false;
    }
    return renewed;
  }

  /** Release the lease (parking): ends the tenure, deletes our own row. */
  release(): void {
    this.#held = false;
    releaseExecutionLease(this.#engine, {
      space: this.#space,
      holder: this.#holder,
    });
  }
}
