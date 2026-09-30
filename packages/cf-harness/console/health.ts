/**
 * Trusted console observations for operator status panels. Rows retain the
 * record and time that decided their state; reading a snapshot starts eligible
 * background checks without waiting for an external service.
 */

/** Display text common to configuration facts and live observations. */
export interface ConsoleHealthFact {
  /** Stable row identity across snapshots. */
  id: string;

  /** Open grouping key a consumer can render without a new decoder. */
  group: string;

  /** Fixed names use Title Case; connection names retain their recorded spelling. */
  label: string;

  /** Present state in words. */
  value: string;

  /** Short human label for the record or observation that decided the value. */
  source: string;

  /** Opaque selectable evidence: exact deciding paths, command, or endpoint. */
  detail?: string;

  /** Why the observed state holds. */
  reason?: string;

  /** The operator action that can change the state. */
  remedy?: string;
}

/** Removes URL credentials, query values, and fragments from operator diagnostics. */
export const consoleHealthUrl = (value: string): string => {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
};

/** A state is established only when an observation supplies its timestamp. */
export type ConsoleHealthRow =
  & ConsoleHealthFact
  & (
    | { state: "ok" | "degraded" | "failed"; checkedAt: string }
    | { state: "unknown"; checkedAt: string | null }
  );

/** Additive wire format; clients render unfamiliar groups as ordinary rows. */
export interface ConsoleHealthSnapshot {
  /** Additive format revision. */
  version: 1;

  /** Time the cache was read, independent of each observation's age. */
  generatedAt: string;

  /** Configuration facts and the latest completed external observations. */
  rows: readonly ConsoleHealthRow[];
}

/** One independently cached external observation. */
export interface ConsoleHealthProbe {
  /** Cache key for one independent acquisition. */
  id: string;

  /** Rows shown as unknown until the first acquisition completes. */
  initial: readonly ConsoleHealthFact[];

  /** Host operation that establishes these rows. */
  read: () => Promise<readonly ConsoleHealthRow[]>;

  /** Honest unknown rows if the host could not complete the observation. */
  unavailable: (
    checkedAt: string,
    error?: unknown,
  ) => readonly ConsoleHealthRow[];
}

/** The launcher values whose deciding records the console can retain. */
export interface ConsoleResolvedValue {
  /** Configuration name used in the launch report. */
  name: string;

  /** Value selected for this launch. */
  value: string;

  /** Record or flag that selected it. */
  source: string;
}

/** Host-selected launch facts, passed directly from the launcher to serving. */
export interface ConsoleLaunchHealth {
  /** Configuration selected by the launcher. */
  resolved: readonly ConsoleResolvedValue[];

  /** Every connector decision, including refused grants. */
  connectors: readonly ConsoleHealthFactWithState[];
}

/** A launch decision whose observation time is stamped when the launch is read. */
export type ConsoleHealthFactWithState = ConsoleHealthFact & {
  /** Classification established by the launch records. */
  state: "ok" | "degraded" | "failed" | "unknown";
};

/** The completed launch observation carried across the serving boundary. */
export type ConsoleObservedLaunchHealth = ConsoleLaunchHealth & {
  /** Time the launcher read the deciding records. */
  checkedAt: string;
};

/** Cached host observations; each probe progresses independently. */
export class ConsoleHealth {
  readonly #rows: Map<string, ConsoleHealthRow>;
  readonly #probes: readonly ConsoleHealthProbe[];
  readonly #clock: () => number;
  readonly #maxAgeMs: number;
  readonly #pending = new Map<string, Promise<void>>();
  readonly #lastCheck = new Map<string, number>();

  /** Constructs an instance retaining launch facts and independent probe caches. */
  constructor(
    rows: readonly ConsoleHealthRow[],
    probes: readonly ConsoleHealthProbe[] = [],
    clock: () => number = Date.now,
    maxAgeMs = 30_000,
  ) {
    this.#rows = new Map(rows.map((row) => [row.id, row]));
    for (const probe of probes) {
      for (const row of probe.initial) {
        this.#rows.set(row.id, { ...row, state: "unknown", checkedAt: null });
      }
    }
    this.#probes = probes;
    this.#clock = clock;
    this.#maxAgeMs = maxAgeMs;
  }

  /** Returns the current evidence immediately and schedules stale probes. */
  snapshot(): ConsoleHealthSnapshot {
    const snapshot: ConsoleHealthSnapshot = {
      version: 1,
      generatedAt: new Date(this.#clock()).toISOString(),
      rows: [...this.#rows.values()],
    };
    void this.refresh();
    return snapshot;
  }

  /** Shares in-flight checks and refreshes only observations past their age. */
  async refresh(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const probe of this.#probes) {
      const existing = this.#pending.get(probe.id);
      if (existing !== undefined) {
        pending.push(existing);
        continue;
      }
      const lastCheck = this.#lastCheck.get(probe.id);
      if (
        lastCheck !== undefined && this.#clock() - lastCheck < this.#maxAgeMs
      ) continue;
      const check = Promise.resolve().then(probe.read).catch((error) =>
        probe.unavailable(new Date(this.#clock()).toISOString(), error)
      ).then((rows) => {
        for (const row of rows) this.#rows.set(row.id, row);
      }).finally(() => {
        this.#pending.delete(probe.id);
        this.#lastCheck.set(probe.id, this.#clock());
      });
      this.#pending.set(probe.id, check);
      pending.push(check);
    }
    await Promise.all(pending);
  }
}
