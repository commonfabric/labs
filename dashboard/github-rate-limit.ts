/**
 * Shares one budget of GitHub requests out among the performance history
 * views. GitHub reports the primary core budget in every API response, and
 * each guarded request batch reads /rate_limit as well, so the token-wide
 * spend is known before collection starts.
 */

import { isObjectOrArray } from "@commonfabric/utils/types";
import { dashboardCacheFile } from "./history-files.ts";

export const GITHUB_RATE_LIMIT_FRACTION = 0.8;
export const GITHUB_REST_POINTS_PER_MINUTE = 900;

const LEDGER_VERSION = 1;
const ledgerOperationTails = new Map<string, Promise<void>>();

async function withGitHubRateLimitLedgerTurn<T>(
  file: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = ledgerOperationTails.get(file) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  ledgerOperationTails.set(file, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (ledgerOperationTails.get(file) === tail) {
      ledgerOperationTails.delete(file);
    }
  }
}

export interface GitHubPrimaryRateLimit {
  limit: number;
  used: number;
  remaining: number;
  reset: number;
}

interface GitHubRateLimitState {
  limit: number;
  used: number;
  resetAt: number;
  inFlight: number;
}

interface StoredPrimaryRateLimit {
  limit: number;
  used: number;
  resetAt: number;
}

interface StoredReservation {
  id: string;
  resetAt: number;
}

interface StoredTokenBudget {
  key: string;
  primary?: StoredPrimaryRateLimit;
  reservations: StoredReservation[];
  requestTimes: number[];
}

interface StoredRateLimitLedger {
  version: number;
  tokens: StoredTokenBudget[];
}

export interface GitHubRateLimitReservation {
  complete(response?: Response): void | Promise<void>;
}

export interface GitHubRateLimitLedgerLock {
  lock(exclusive?: boolean): Promise<void>;
  unlock(): Promise<void>;
  close(): void;
}

export interface GitHubRateLimitBudgetOptions {
  fraction?: number;
  restPointsPerMinute?: number;
  now?: () => number;
  file?: string | null;
  openLedgerLock?: (file: string) => Promise<GitHubRateLimitLedgerLock>;
}

export class GitHubRateLimitBudgetError extends Error {
  readonly resetAt?: number;

  constructor(message: string, resetAt?: number) {
    super(message);
    this.name = "GitHubRateLimitBudgetError";
    this.resetAt = resetAt;
  }
}

function finiteInteger(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && Number.isInteger(number) ? number : null;
}

function normalizePrimary(
  value: GitHubPrimaryRateLimit,
): GitHubPrimaryRateLimit | null {
  if (
    !Number.isInteger(value.limit) || value.limit <= 0 ||
    !Number.isInteger(value.used) || value.used < 0 ||
    !Number.isInteger(value.remaining) || value.remaining < 0 ||
    value.remaining > value.limit ||
    !Number.isInteger(value.reset) || value.reset <= 0
  ) return null;
  return {
    ...value,
    used: Math.max(value.used, value.limit - value.remaining),
  };
}

function primaryFromHeaders(response: Response): GitHubPrimaryRateLimit | null {
  if (response.headers.get("x-ratelimit-resource") !== "core") return null;
  const limit = finiteInteger(response.headers.get("x-ratelimit-limit"));
  const remaining = finiteInteger(
    response.headers.get("x-ratelimit-remaining"),
  );
  const reset = finiteInteger(response.headers.get("x-ratelimit-reset"));
  const reportedUsed = finiteInteger(response.headers.get("x-ratelimit-used"));
  if (limit === null || remaining === null || reset === null) return null;
  return normalizePrimary({
    limit,
    used: reportedUsed ?? limit - remaining,
    remaining,
    reset,
  });
}

function storedPrimary(
  primary: GitHubPrimaryRateLimit,
): StoredPrimaryRateLimit {
  return {
    limit: primary.limit,
    used: primary.used,
    resetAt: primary.reset * 1_000,
  };
}

function mergePrimary(
  current: StoredPrimaryRateLimit | undefined,
  incoming: GitHubPrimaryRateLimit,
): StoredPrimaryRateLimit {
  const next = storedPrimary(incoming);
  if (!current || next.resetAt > current.resetAt) return next;
  if (next.resetAt < current.resetAt) return current;
  return {
    limit: Math.min(current.limit, next.limit),
    used: Math.max(current.used, next.used),
    resetAt: current.resetAt,
  };
}

function isStoredPrimary(value: unknown): value is StoredPrimaryRateLimit {
  if (typeof value !== "object" || value === null) return false;
  const primary = value as StoredPrimaryRateLimit;
  return Number.isInteger(primary.limit) && primary.limit > 0 &&
    Number.isInteger(primary.used) && primary.used >= 0 &&
    Number.isInteger(primary.resetAt) && primary.resetAt > 0;
}

function isStoredReservation(value: unknown): value is StoredReservation {
  if (typeof value !== "object" || value === null) return false;
  const reservation = value as StoredReservation;
  return typeof reservation.id === "string" && reservation.id.length > 0 &&
    Number.isInteger(reservation.resetAt) && reservation.resetAt > 0;
}

function isStoredTokenBudget(value: unknown): value is StoredTokenBudget {
  if (typeof value !== "object" || value === null) return false;
  const budget = value as StoredTokenBudget;
  return typeof budget.key === "string" && /^[0-9a-f]{64}$/.test(budget.key) &&
    (budget.primary === undefined || isStoredPrimary(budget.primary)) &&
    Array.isArray(budget.reservations) &&
    budget.reservations.every(isStoredReservation) &&
    Array.isArray(budget.requestTimes) &&
    budget.requestTimes.every((at) => Number.isFinite(at) && at >= 0);
}

const defaultFile = (): string =>
  dashboardCacheFile("fabric-wall-github-rate-limit.json");

export class GitHubRateLimitBudget {
  #fraction: number;
  #restPointsPerMinute: number;
  #now: () => number;
  #file: string | null;
  #openLedgerLock: (file: string) => Promise<GitHubRateLimitLedgerLock>;
  #states = new Map<string, GitHubRateLimitState>();
  #probes = new Map<string, Promise<void>>();
  #requestTimes = new Map<string, number[]>();
  #tokenKeys = new Map<string, Promise<string>>();

  constructor(options: GitHubRateLimitBudgetOptions = {}) {
    const fraction = options.fraction ?? GITHUB_RATE_LIMIT_FRACTION;
    if (!(fraction > 0 && fraction <= 1)) {
      throw new RangeError(
        "GitHub rate limit fraction must be above 0 and at most 1.",
      );
    }
    const restPoints = options.restPointsPerMinute ??
      GITHUB_REST_POINTS_PER_MINUTE;
    if (!Number.isInteger(restPoints) || restPoints <= 0) {
      throw new RangeError(
        "GitHub REST points per minute must be a positive integer.",
      );
    }
    this.#fraction = fraction;
    this.#restPointsPerMinute = restPoints;
    this.#now = options.now ?? Date.now;
    this.#file = options.file ?? null;
    this.#openLedgerLock = options.openLedgerLock ??
      ((file) =>
        Deno.open(file, {
          create: true,
          write: true,
        }));
  }

  #primaryCeiling(limit: number): number {
    return Math.floor(limit * this.#fraction);
  }

  #secondaryCeiling(): number {
    return Math.floor(this.#restPointsPerMinute * this.#fraction);
  }

  #primaryError(limit: number, resetAt: number): GitHubRateLimitBudgetError {
    const ceiling = this.#primaryCeiling(limit);
    return new GitHubRateLimitBudgetError(
      `GitHub rate limit has been hit at the ${
        Math.round(this.#fraction * 100)
      }% performance-history safety threshold (${ceiling} of ${limit} primary requests).`,
      resetAt,
    );
  }

  #secondaryError(): GitHubRateLimitBudgetError {
    return new GitHubRateLimitBudgetError(
      `GitHub rate limit has been hit at the ${
        Math.round(this.#fraction * 100)
      }% performance-history safety threshold for REST request points.`,
    );
  }

  #normalizeProbe(primary: GitHubPrimaryRateLimit): GitHubPrimaryRateLimit {
    const normalized = normalizePrimary(primary);
    if (!normalized) {
      throw new GitHubRateLimitBudgetError(
        "GitHub rate limit status was invalid; performance history made no request.",
      );
    }
    return normalized;
  }

  #reserveMemoryPoint(token: string): void {
    const now = this.#now();
    const cutoff = now - 60_000;
    const recent = (this.#requestTimes.get(token) ?? []).filter((at) =>
      at > cutoff
    );
    if (recent.length + 1 > this.#secondaryCeiling()) {
      throw this.#secondaryError();
    }
    recent.push(now);
    this.#requestTimes.set(token, recent);
  }

  #setMemoryPrimary(token: string, primary: GitHubPrimaryRateLimit): void {
    const normalized = this.#normalizeProbe(primary);
    const current = this.#states.get(token);
    const merged = mergePrimary(
      current && {
        limit: current.limit,
        used: current.used,
        resetAt: current.resetAt,
      },
      normalized,
    );
    this.#states.set(token, {
      ...merged,
      inFlight: current?.inFlight ?? 0,
    });
  }

  async #ensureMemoryPrimary(
    token: string,
    probe: () => Promise<GitHubPrimaryRateLimit>,
  ): Promise<void> {
    let request = this.#probes.get(token);
    if (!request) {
      request = (async () => {
        this.#reserveMemoryPoint(token);
        let primary: GitHubPrimaryRateLimit;
        try {
          primary = await probe();
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          throw new GitHubRateLimitBudgetError(
            `GitHub rate limit status could not be read: ${message}`,
          );
        }
        this.#setMemoryPrimary(token, primary);
      })().finally(() => this.#probes.delete(token));
      this.#probes.set(token, request);
    }
    await request;
  }

  async #reserveMemory(
    token: string,
    probe: () => Promise<GitHubPrimaryRateLimit>,
  ): Promise<GitHubRateLimitReservation> {
    await this.#ensureMemoryPrimary(token, probe);
    const state = this.#states.get(token)!;
    if (
      state.used + state.inFlight + 1 > this.#primaryCeiling(state.limit)
    ) {
      throw this.#primaryError(state.limit, state.resetAt);
    }
    this.#reserveMemoryPoint(token);
    state.inFlight++;
    let completed = false;
    return {
      complete: (response?: Response) => {
        if (completed) return;
        completed = true;
        const current = this.#states.get(token)!;
        current.inFlight = Math.max(0, current.inFlight - 1);
        const primary = response && primaryFromHeaders(response);
        if (primary) this.#setMemoryPrimary(token, primary);
        else current.used++;
      },
    };
  }

  #tokenKey(token: string): Promise<string> {
    let key = this.#tokenKeys.get(token);
    if (!key) {
      key = crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(token),
      ).then((digest) =>
        [...new Uint8Array(digest)].map((byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("")
      );
      this.#tokenKeys.set(token, key);
    }
    return key;
  }

  async #readLedger(): Promise<StoredRateLimitLedger> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await Deno.readTextFile(this.#file!));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return { version: LEDGER_VERSION, tokens: [] };
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new GitHubRateLimitBudgetError(
        `GitHub rate limit ledger could not be read: ${message}`,
      );
    }
    const ledger = parsed as StoredRateLimitLedger;
    if (
      !isObjectOrArray(parsed) ||
      ledger.version !== LEDGER_VERSION ||
      !Array.isArray(ledger.tokens) ||
      !ledger.tokens.every(isStoredTokenBudget) ||
      new Set(ledger.tokens.map((token) => token.key)).size !==
        ledger.tokens.length
    ) {
      throw new GitHubRateLimitBudgetError(
        "GitHub rate limit ledger was invalid; performance history made no request.",
      );
    }
    return ledger;
  }

  async #writeLedger(ledger: StoredRateLimitLedger): Promise<void> {
    const temporary = `${this.#file!}.${crypto.randomUUID()}.tmp`;
    try {
      await Deno.writeTextFile(temporary, JSON.stringify(ledger));
      await Deno.rename(temporary, this.#file!);
    } catch (error) {
      try {
        await Deno.remove(temporary);
      } catch {
        // Ignore cleanup when no temporary file remains.
      }
      throw error;
    }
  }

  #ledgerError(error: unknown): GitHubRateLimitBudgetError {
    if (error instanceof GitHubRateLimitBudgetError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new GitHubRateLimitBudgetError(
      `GitHub rate limit ledger could not be updated: ${message}`,
    );
  }

  async #withLedger<T>(
    update: (ledger: StoredRateLimitLedger) => T | Promise<T>,
  ): Promise<T> {
    return await withGitHubRateLimitLedgerTurn(this.#file!, async () => {
      let lock: GitHubRateLimitLedgerLock | undefined;
      let locked = false;
      let result: T | undefined;
      let failed = false;
      let failure: unknown;
      try {
        lock = await this.#openLedgerLock(`${this.#file!}.lock`);
        await lock.lock(true);
        locked = true;
        const ledger = await this.#readLedger();
        result = await update(ledger);
        await this.#writeLedger(ledger);
      } catch (error) {
        failed = true;
        failure = error;
      } finally {
        let cleanupFailure: unknown;
        if (locked) {
          try {
            await lock!.unlock();
          } catch (error) {
            cleanupFailure = error;
          }
        }
        try {
          lock?.close();
        } catch (error) {
          cleanupFailure ??= error;
        }
        if (!failed && cleanupFailure !== undefined) {
          failed = true;
          failure = cleanupFailure;
        }
      }
      if (failed) throw this.#ledgerError(failure);
      return result as T;
    });
  }

  #storedToken(
    ledger: StoredRateLimitLedger,
    key: string,
  ): StoredTokenBudget {
    let state = ledger.tokens.find((value) => value.key === key);
    if (!state) {
      state = { key, reservations: [], requestTimes: [] };
      ledger.tokens.push(state);
    }
    return state;
  }

  #reservationLease(id: string): string {
    return `${this.#file!}.${id}.reservation.lock`;
  }

  async #openReservationLease(id: string): Promise<Deno.FsFile> {
    const path = this.#reservationLease(id);
    let lease: Deno.FsFile | undefined;
    try {
      lease = await Deno.open(path, {
        createNew: true,
        read: true,
        write: true,
      });
      await lease.lock(true);
      return lease;
    } catch (error) {
      await Promise.resolve().then(() => lease?.close()).catch(() => undefined);
      await Promise.resolve().then(() => Deno.remove(path)).catch(() =>
        undefined
      );
      throw this.#ledgerError(error);
    }
  }

  async #closeReservationLease(id: string, lease: Deno.FsFile): Promise<void> {
    let failure: unknown;
    try {
      await lease.unlock();
    } catch (error) {
      failure = error;
    }
    try {
      lease.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      await Deno.remove(this.#reservationLease(id));
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw this.#ledgerError(failure);
  }

  async #abandonReservationLease(lease: Deno.FsFile): Promise<void> {
    let failure: unknown;
    try {
      await lease.unlock();
    } catch (error) {
      failure = error;
    }
    try {
      lease.close();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw this.#ledgerError(failure);
  }

  async #releaseFailedReservation(
    id: string,
    lease: Deno.FsFile,
    mayBeStored: boolean,
  ): Promise<void> {
    if (!mayBeStored) {
      await this.#closeReservationLease(id, lease);
      return;
    }
    let stored = true;
    try {
      const ledger = await this.#readLedger();
      stored = ledger.tokens.some((token) =>
        token.reservations.some((reservation) => reservation.id === id)
      );
    } catch {
      // Keep the lease when the ledger cannot establish whether it references it.
    }
    if (stored) await this.#abandonReservationLease(lease);
    else await this.#closeReservationLease(id, lease);
  }

  async #reservationIsLive(id: string): Promise<boolean> {
    let lease: Deno.FsFile;
    try {
      lease = await Deno.open(this.#reservationLease(id), {
        read: true,
        write: true,
      });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw this.#ledgerError(error);
    }
    let acquired = false;
    try {
      acquired = await lease.tryLock(true);
      if (acquired) await lease.unlock();
      return !acquired;
    } catch (error) {
      throw this.#ledgerError(error);
    } finally {
      lease.close();
    }
  }

  async #pruneStored(
    state: StoredTokenBudget,
    now: number,
  ): Promise<string[]> {
    const cutoff = now - 60_000;
    state.requestTimes = state.requestTimes.filter((at) => at > cutoff);
    const retained: StoredReservation[] = [];
    const expired: string[] = [];
    for (const reservation of state.reservations) {
      if (
        reservation.resetAt > now ||
        await this.#reservationIsLive(reservation.id)
      ) {
        retained.push(reservation);
      } else {
        expired.push(reservation.id);
      }
    }
    state.reservations = retained;
    return expired;
  }

  async #removeReservationLeases(ids: string[]): Promise<void> {
    for (const id of ids) {
      try {
        await Deno.remove(this.#reservationLease(id));
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw this.#ledgerError(error);
        }
      }
    }
  }

  #reserveStoredPoint(state: StoredTokenBudget, now: number): void {
    if (state.requestTimes.length + 1 > this.#secondaryCeiling()) {
      throw this.#secondaryError();
    }
    state.requestTimes.push(now);
  }

  async #ensureStoredPrimary(
    token: string,
    key: string,
    probe: () => Promise<GitHubPrimaryRateLimit>,
  ): Promise<void> {
    let request = this.#probes.get(token);
    if (!request) {
      request = (async () => {
        let expiredLeases: string[] = [];
        await this.#withLedger(async (ledger) => {
          const now = this.#now();
          const state = this.#storedToken(ledger, key);
          expiredLeases = await this.#pruneStored(state, now);
          this.#reserveStoredPoint(state, now);
        });
        await this.#removeReservationLeases(expiredLeases);
        let primary: GitHubPrimaryRateLimit;
        try {
          primary = this.#normalizeProbe(await probe());
        } catch (error) {
          if (error instanceof GitHubRateLimitBudgetError) throw error;
          const message = error instanceof Error
            ? error.message
            : String(error);
          throw new GitHubRateLimitBudgetError(
            `GitHub rate limit status could not be read: ${message}`,
          );
        }
        await this.#withLedger((ledger) => {
          const state = this.#storedToken(ledger, key);
          state.primary = mergePrimary(state.primary, primary);
        });
      })().finally(() => this.#probes.delete(token));
      this.#probes.set(token, request);
    }
    await request;
  }

  async #reserveStored(
    token: string,
    probe: () => Promise<GitHubPrimaryRateLimit>,
  ): Promise<GitHubRateLimitReservation> {
    const key = await this.#tokenKey(token);
    await this.#ensureStoredPrimary(token, key, probe);
    const id = crypto.randomUUID();
    const lease = await this.#openReservationLease(id);
    let reservationAdded = false;
    try {
      let expiredLeases: string[] = [];
      await this.#withLedger(async (ledger) => {
        const now = this.#now();
        const state = this.#storedToken(ledger, key);
        expiredLeases = await this.#pruneStored(state, now);
        const primary = state.primary;
        if (!primary || now >= primary.resetAt) {
          throw new GitHubRateLimitBudgetError(
            "GitHub rate limit status expired before the request started; performance history made no request.",
          );
        }
        const inFlight = state.reservations.length;
        if (
          primary.used + inFlight + 1 > this.#primaryCeiling(primary.limit)
        ) {
          throw this.#primaryError(primary.limit, primary.resetAt);
        }
        this.#reserveStoredPoint(state, now);
        state.reservations.push({ id, resetAt: primary.resetAt });
        reservationAdded = true;
      });
      await this.#removeReservationLeases(expiredLeases);
    } catch (error) {
      try {
        await this.#releaseFailedReservation(id, lease, reservationAdded);
      } catch (cleanupError) {
        throw this.#ledgerError(cleanupError);
      }
      throw error;
    }
    let completed = false;
    return {
      complete: async (response?: Response) => {
        if (completed) return;
        completed = true;
        const primary = response && primaryFromHeaders(response);
        try {
          await this.#withLedger((ledger) => {
            const state = this.#storedToken(ledger, key);
            state.reservations = state.reservations.filter((reservation) =>
              reservation.id !== id
            );
            if (primary) state.primary = mergePrimary(state.primary, primary);
            else if (state.primary) state.primary.used++;
          });
        } catch (error) {
          try {
            await this.#releaseFailedReservation(id, lease, true);
          } catch (cleanupError) {
            throw this.#ledgerError(cleanupError);
          }
          throw error;
        }
        await this.#closeReservationLease(id, lease);
      },
    };
  }

  reserve(
    token: string,
    probe: () => Promise<GitHubPrimaryRateLimit>,
  ): Promise<GitHubRateLimitReservation> {
    return this.#file
      ? this.#reserveStored(token, probe)
      : this.#reserveMemory(token, probe);
  }
}

export const performanceGitHubRateLimit = new GitHubRateLimitBudget({
  file: defaultFile(),
});
