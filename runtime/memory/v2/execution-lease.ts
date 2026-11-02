/**
 * The server-execution v2 single-deriver lease
 * (docs/specs/server-side-execution/serving-loop.md §2), held in memory: a
 * memory server keeps a map from space to holder, its engines' derived-class
 * admission checks that map with one equality, and a SpaceServer's host
 * acquires and releases through it. Nothing about the lease is stored or rides
 * the commit stream, so a process starts holding nothing. The route's
 * assignment of each space to one process is what keeps two processes from
 * deriving one space (serving-loop.md §2's precondition).
 */

/**
 * The process-instance component of the lease holder identity, minted once
 * at PROCESS START (module initialization) — DR1, serving-loop.md §2. Stable
 * across every reacquire within one process lifetime; fresh whenever the
 * process is genuinely new. A realm that serves on a process's behalf adopts
 * the component that process minted for it ({@link adoptProcessInstanceId}) in
 * place of this one.
 */
export const processInstanceId: string = crypto.randomUUID();

/** The component holders are minted with: the adopted one, else the realm's. */
let currentProcessInstance: string = processInstanceId;

/** The process-instance component every holder minted from now on carries. */
export const currentProcessInstanceId = (): string => currentProcessInstance;

/**
 * Makes `id` the process-instance component of every holder minted from here
 * on. The serving loop's worker adopts the component the process minted for
 * that worker's start: the leases the worker then acquires name the holder the
 * process's memory server matches against, and a component fresh per start
 * keeps a restarted worker's commits apart from its predecessor's under the
 * engine's replay keying, and refused once its predecessor's lease is
 * released. The process adopts the same component itself, so the two realms
 * agree.
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
 * The map a memory server keeps from space to lease holder. A `Server` shares
 * one across its spaces' engines, and an engine opened on its own has one of
 * its own. Holding has no expiry: an entry stands until its holder releases it
 * or the serving worker that holds it is replaced.
 */
export class ExecutionLeases {
  readonly #holders = new Map<string, string>();

  /** The space's holder, or `undefined` when no one holds it. */
  holderOf(space: string): string | undefined {
    return this.#holders.get(space);
  }

  /**
   * Takes the space's lease for `holder`. Returns whether `holder` now holds
   * it: `true` when it was free or already `holder`'s, `false` when another
   * holder has it.
   */
  acquire(space: string, holder: string): boolean {
    const current = this.#holders.get(space);
    if (current !== undefined && current !== holder) return false;
    this.#holders.set(space, holder);
    return true;
  }

  /** Releases `holder`'s lease on the space. Another holder's is left alone. */
  release(space: string, holder: string): void {
    if (this.#holders.get(space) === holder) this.#holders.delete(space);
  }

  /** Releases every lease `holder` holds, and returns how many there were. */
  releaseAllOf(holder: string): number {
    let released = 0;
    for (const [space, current] of this.#holders) {
      if (current !== holder) continue;
      this.#holders.delete(space);
      released += 1;
    }
    return released;
  }
}

/**
 * A memory server's lease map as a serving loop reaches it: the map itself on
 * the server's own thread or, for a loop in a worker, calls that cross the port
 * as requests.
 */
export type ExecutionLeaseAccess = {
  /** @see ExecutionLeases.acquire */
  acquire(space: string, holder: string): boolean | Promise<boolean>;

  /** @see ExecutionLeases.release */
  release(space: string, holder: string): void | Promise<void>;
};

/** What a lease cycle is built from. */
export type ExecutionLeaseCycleOptions = {
  leases: ExecutionLeaseAccess;
  space: string;

  /** The DR1 per-process holder identity (`executionLeaseHolder`). */
  holder: string;
};

/**
 * One space's acquire/release cycle from the holder's side, with the
 * abort-before-reacquire discipline enforced IN-PROCESS (serving-loop.md §2,
 * DR1's residue). The discipline is structural, not procedural:
 *
 * - a TENURE is one stretch of holding between an acquire and the release that
 *   ends it. Work seals under the tenure it read (`tenure` at seal time) and
 *   checks `isCurrentTenure` at its commit step;
 * - a release ends the tenure before it reaches the server, so
 *   `isCurrentTenure` goes false for everything in flight at once, which is
 *   "stop committing immediately";
 * - a reacquire mints the NEXT tenure, so work sealed under the ended one can
 *   never pass the check afterward either.
 *
 * This in-memory counter is the whole mechanism, which is why the lease needs
 * no per-commit token on the wire (serving-loop.md §2's FORBIDDEN list):
 * succession between workers is fenced by the holder's process-instance
 * component, and the same-process residue is this local obligation.
 */
export class ExecutionLeaseCycle {
  readonly #leases: ExecutionLeaseAccess;
  readonly #space: string;
  readonly #holder: string;
  #held = false;
  #tenure = 0;

  /** Constructs an instance which holds nothing yet. */
  constructor(options: ExecutionLeaseCycleOptions) {
    this.#leases = options.leases;
    this.#space = options.space;
    this.#holder = options.holder;
  }

  /** The DR1 holder identity this cycle acquires under. */
  get holder(): string {
    return this.#holder;
  }

  /** Whether a tenure is current. */
  get held(): boolean {
    return this.#held;
  }

  /**
   * The current tenure number. Captured at seal time by work that will check
   * `isCurrentTenure` at its commit step. Meaningful only while `held`.
   */
  get tenure(): number {
    return this.#tenure;
  }

  /**
   * The in-process discipline check: whether work sealed under `sealedTenure`
   * may still commit. False the moment the tenure ends and forever after — a
   * reacquire starts a NEW tenure.
   */
  isCurrentTenure(sealedTenure: number): boolean {
    return this.#held && sealedTenure === this.#tenure;
  }

  /**
   * Acquires the lease. On success the cycle enters a new tenure. Already
   * holding returns `true` with the tenure unchanged: an accidental double
   * acquire must not abort the tenure's in-flight work.
   */
  async acquire(): Promise<boolean> {
    if (this.#held) return true;
    const acquired = await this.#leases.acquire(this.#space, this.#holder);
    if (acquired) {
      this.#tenure += 1;
      this.#held = true;
    }
    return acquired;
  }

  /** Ends the tenure at once, then releases the lease (parking). */
  async release(): Promise<void> {
    this.#held = false;
    await this.#leases.release(this.#space, this.#holder);
  }
}
