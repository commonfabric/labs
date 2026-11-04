// invalidation.ts — Reverse kernel-cache invalidation queue for the FUSE daemon.
//
// The daemon answers FUSE requests on the isolate thread. A reverse
// invalidation (notify_inval_entry / notify_inval_inode) enters the Linux
// kernel and takes the target directory's inode lock for write; a concurrent
// lookup under that directory holds the same lock for read until the daemon
// answers it. Issuing the invalidation on the isolate thread would block that
// thread inside the kernel behind a lookup only it can answer, deadlocking the
// mount. The daemon therefore hands the invalidation FFI calls to this queue,
// which issues them off the isolate thread and awaits them, leaving the request
// path free.
//
// The queue coalesces invalidations, snapshots and clears its pending sets each
// pass so work queued during an await is not lost, and disables an invalidation
// kind when libfuse reports it as unsupported (return code -ENOSYS; FUSE-T on
// macOS accepts the call and does nothing instead).

/** A reverse-invalidation FFI result: the libfuse return code, sync or async. */
export type NotifyResult = number | Promise<number>;

export interface ReverseInvalidationDeps {
  /**
   * Issue notify_inval_entry off the isolate thread. `nameBuf` is the
   * null-terminated entry name; `nameLen` excludes the terminator. The buffer
   * is typed as `ArrayBuffer`-backed (not the wider `ArrayBufferLike`) so it
   * satisfies the FFI buffer parameter, which a nonblocking call pins and so
   * rejects a possibly-shared buffer.
   */
  invalidateEntry(
    parentIno: bigint,
    nameBuf: Uint8Array<ArrayBuffer>,
    nameLen: bigint,
  ): NotifyResult;

  /** Issue notify_inval_inode off the isolate thread (whole inode). */
  invalidateInode(ino: bigint): NotifyResult;

  /** Whether the mount is tearing down; queued work is dropped once true. */
  isUnmounting(): boolean;

  /** Emit per-call diagnostics when set. */
  debug: boolean;

  /** Diagnostic sink; defaults to console.log. */
  log?: (message: string) => void;

  /** Failure sink; defaults to console.warn. */
  warn?: (message: string) => void;
}

// libfuse returns -ENOSYS when a notify op is not implemented by the provider.
const NOTIFY_UNSUPPORTED = -38;

export class ReverseInvalidationQueue {
  readonly #deps: ReverseInvalidationDeps;
  readonly #encoder = new TextEncoder();
  #entrySupported = true;
  #inodeSupported = true;
  #closed = false;
  readonly #pendingEntry = new Map<
    string,
    { parentIno: bigint; names: Set<string> }
  >();
  readonly #pendingInode = new Set<bigint>();
  #flushing = false;
  #activeFlush: Promise<void> = Promise.resolve();

  constructor(deps: ReverseInvalidationDeps) {
    this.#deps = deps;
  }

  get entryNotifySupported(): boolean {
    return this.#entrySupported;
  }

  get inodeNotifySupported(): boolean {
    return this.#inodeSupported;
  }

  get pendingEntryCount(): number {
    return this.#pendingEntry.size;
  }

  get pendingInodeCount(): number {
    return this.#pendingInode.size;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Permanently stop the queue: refuse further additions and issue no more
   * notify calls, halting a flush already in progress at its next step.
   *
   * The daemon calls this during shutdown before the session is destroyed. The
   * session loop can exit without going through the unmounting flag (an
   * external unmount or a kernel abort), so closing here — not only in the
   * signal handler — is what guarantees no flush scheduled just before the exit
   * calls the notify FFI symbols against freed session memory.
   */
  close(): void {
    this.#closed = true;
  }

  /**
   * Queue an entry invalidation for `names` under `parentIno`. Returns whether
   * the work was accepted, so the caller can schedule a flush only when it was.
   */
  addEntry(parentIno: bigint, names: string[]): boolean {
    if (this.#closed || !this.#entrySupported || this.#deps.isUnmounting()) {
      return false;
    }
    const key = parentIno.toString();
    let pending = this.#pendingEntry.get(key);
    if (!pending) {
      pending = { parentIno, names: new Set<string>() };
      this.#pendingEntry.set(key, pending);
    }
    for (const name of names) {
      pending.names.add(name);
    }
    return true;
  }

  /** Queue an inode invalidation. Returns whether the work was accepted. */
  addInode(ino: bigint): boolean {
    if (this.#closed || !this.#inodeSupported || this.#deps.isUnmounting()) {
      return false;
    }
    this.#pendingInode.add(ino);
    return true;
  }

  /**
   * The most recent flush. Await this before the session is destroyed so no
   * notify call is still running on an FFI thread when the session memory it
   * dereferences is freed.
   */
  active(): Promise<void> {
    return this.#activeFlush;
  }

  /**
   * Drain the queued invalidations off the isolate thread. A re-entrant call
   * while a flush is running returns the running flush rather than starting a
   * second one; that running flush drains anything queued during its awaits.
   */
  flush(): Promise<void> {
    if (this.#closed || this.#flushing) return this.#activeFlush;
    this.#flushing = true;
    this.#activeFlush = this.#run();
    return this.#activeFlush;
  }

  #shuttingDown(): boolean {
    return this.#closed || this.#deps.isUnmounting();
  }

  async #run(): Promise<void> {
    try {
      // Snapshot each pass and clear the pending sets first, so invalidations
      // queued while an await is outstanding are picked up by the next loop
      // iteration rather than lost.
      while (
        !this.#shuttingDown() &&
        (this.#pendingEntry.size > 0 || this.#pendingInode.size > 0)
      ) {
        const entryBatch = [...this.#pendingEntry.values()];
        this.#pendingEntry.clear();
        const inodeBatch = [...this.#pendingInode];
        this.#pendingInode.clear();

        if (this.#entrySupported) await this.#flushEntries(entryBatch);
        if (this.#inodeSupported) await this.#flushInodes(inodeBatch);
      }

      if (this.#shuttingDown()) {
        this.#pendingEntry.clear();
        this.#pendingInode.clear();
      }
    } finally {
      this.#flushing = false;
    }
  }

  async #flushEntries(
    batch: { parentIno: bigint; names: Set<string> }[],
  ): Promise<void> {
    const log = this.#deps.log ?? console.log;
    const warn = this.#deps.warn ?? console.warn;
    for (const { parentIno, names } of batch) {
      if (!this.#entrySupported || this.#shuttingDown()) break;
      for (const name of names) {
        if (!this.#entrySupported || this.#shuttingDown()) break;
        const nameBuf = this.#encoder.encode(name + "\0");
        try {
          const rc = await this.#deps.invalidateEntry(
            parentIno,
            nameBuf,
            BigInt(nameBuf.length - 1),
          );
          if (rc === NOTIFY_UNSUPPORTED) {
            log(
              "notify_inval_entry not supported; skipping entry invalidation",
            );
            this.#entrySupported = false;
            break;
          }
          if (this.#deps.debug && rc !== 0) {
            log(
              `notify_inval_entry(parent=${parentIno}, name=${name}) => ${rc}`,
            );
          }
        } catch (e) {
          warn(`notify_inval_entry failed: ${e}`);
          this.#entrySupported = false;
          break;
        }
      }
    }
  }

  async #flushInodes(batch: bigint[]): Promise<void> {
    const log = this.#deps.log ?? console.log;
    const warn = this.#deps.warn ?? console.warn;
    for (const ino of batch) {
      if (!this.#inodeSupported || this.#shuttingDown()) break;
      try {
        const ret = await this.#deps.invalidateInode(ino);
        if (ret === NOTIFY_UNSUPPORTED) {
          this.#inodeSupported = false;
          break;
        }
        if (this.#deps.debug) {
          log(`notify_inval_inode(ino=${ino}) => ${ret}`);
        }
      } catch (e) {
        warn(`notify_inval_inode failed: ${e}`);
        this.#inodeSupported = false;
        break;
      }
    }
  }
}
