const DEFAULT_MAX_ENTRIES = 512;

/**
 * A bounded, insertion-ordered record of cold-load failures by identity.
 * Runtime-version changes reopen an identity and discard its stale record.
 */
export class ColdLoadNegativeMemo {
  #entries = new Map<string, string | undefined>();
  #maxEntries: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError("maxEntries must be a positive integer");
    }
    this.#maxEntries = maxEntries;
  }

  /** Whether `key` is suppressed under the current runtime version. */
  suppresses(key: string, runtimeVersion: string | undefined): boolean {
    if (!this.#entries.has(key)) return false;
    if (this.#entries.get(key) === runtimeVersion) return true;
    this.#entries.delete(key);
    return false;
  }

  /** Record a failure, evicting the oldest distinct identity when full. */
  add(key: string, runtimeVersion: string | undefined): void {
    if (!this.#entries.has(key) && this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    this.#entries.set(key, runtimeVersion);
  }
}
