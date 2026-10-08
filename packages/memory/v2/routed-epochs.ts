/** Durable router epochs and router-key revocations. */
import { dirname } from "@std/path";
import { isCanonicalEd25519DID } from "@commonfabric/identity";
import { parseRoutedJson } from "./routed-parser.ts";
import { requireRouted, ROUTED_PROOF_HORIZON_SECONDS } from "./routed-wire.ts";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_EPOCHS = 1024;
/**
 * How long a closed link's epoch stays recorded. Every proof bound to the
 * epoch has expired by then, so forgetting it cannot revive one, and a router
 * that relinks after toolshed restarts never exhausts its bound.
 */
const EPOCH_RETENTION_SECONDS = ROUTED_PROOF_HORIZON_SECONDS;

/**
 * Exclusive toolshed-local ledger of what must outlive a restart: link epochs,
 * which a router may not reuse while proofs bound to them can be presented,
 * and permanent router-key revocations. Every change is fsynced first. Client
 * proofs are not recorded here: the host holds them with their context and
 * drops them when it closes, and a restart closes every context.
 */
export class RoutedEpochStore {
  #file!: Deno.FsFile;
  #lock: Deno.FsFile;
  #path: string;
  /** Router -> epoch -> when its link closed; undefined while it is live. */
  #epochs = new Map<string, Map<string, number | undefined>>();
  #revoked = new Set<string>();
  #closed = false;
  #healthy = true;

  /** The separate lock inode remains stable across atomic ledger compaction. */
  constructor(path: string) {
    this.#path = path;
    this.#lock = Deno.openSync(`${path}.lock`, {
      create: true,
      write: true,
      mode: 0o600,
    });
    this.#lock.lockSync(true);
    try {
      this.#file = this.#open();
      this.#file.syncDataSync();
      this.#syncDirectory();
      requireRouted(this.#file.statSync().size <= MAX_BYTES);
      const text = Deno.readTextFileSync(path);
      requireRouted(text === "" || text.endsWith("\n"));
      for (const line of text.split("\n")) {
        // An earlier toolshed's client proofs bind nothing once it restarts,
        // and the rewrite below drops them, so they are not decoded.
        if (line === "" || line.startsWith('["claim",')) continue;
        const record = parseRoutedJson(line);
        requireRouted(
          Array.isArray(record) && isCanonicalEd25519DID(record[1]),
        );
        if (record[0] === "epoch") {
          requireRouted(
            record.length === 3 && typeof record[2] === "string" &&
              /^[0-9a-f]{32}$/.test(record[2]),
          );
          // The bound applies after loading, once retired epochs are dropped.
          // A repeated line is an epoch consumed again after it was forgotten;
          // compaction has not yet removed its earlier lines.
          const known = this.#epochs.get(record[1]);
          if (known?.has(record[2])) known.set(record[2], undefined);
          else this.#remember(record[1], record[2], false);
        } else if (record[0] === "retire") {
          requireRouted(
            record.length === 4 && typeof record[2] === "string" &&
              Number.isSafeInteger(record[3]) && record[3] > 0 &&
              this.#epochs.get(record[1])?.has(record[2]),
          );
          this.#epochs.get(record[1])!.set(record[2], record[3]);
        } else if (record[0] === "revoke") {
          requireRouted(record.length === 3 && record[2] === "permanent");
          this.#revoked.add(record[1]);
        } else requireRouted(false);
      }
      // No link survives a restart: every epoch still marked live closed now.
      // The retirement is written down, so repeated restarts cannot keep
      // resetting its retention period and hold the epoch forever. The file
      // is rewritten to what memory holds, so a restart also leaves it well
      // under half its bound, where appends next compact it.
      const loaded = Math.floor(Date.now() / 1000);
      for (const epochs of this.#epochs.values()) {
        for (const [epoch, closed] of epochs) {
          if (closed === undefined) epochs.set(epoch, loaded);
        }
      }
      this.#compact(loaded);
      requireRouted(
        this.#epochs.size <= 16 &&
          [...this.#epochs.values()].every((e) => e.size <= MAX_EPOCHS),
      );
    } catch (error) {
      this.#file?.close();
      this.#lock.close();
      throw error;
    }
  }
  #open(): Deno.FsFile {
    return Deno.openSync(this.#path, {
      read: true,
      write: true,
      create: true,
      append: true,
      mode: 0o600,
    });
  }
  #syncDirectory(): void {
    const parent = Deno.openSync(dirname(this.#path), { read: true });
    try {
      parent.syncSync();
    } finally {
      parent.close();
    }
  }
  #remember(router: string, epoch: string, bounded = true): void {
    let epochs = this.#epochs.get(router);
    if (epochs === undefined) {
      requireRouted(!bounded || this.#epochs.size < 16);
      epochs = new Map();
      this.#epochs.set(router, epochs);
    }
    requireRouted(!epochs.has(epoch) && (!bounded || epochs.size < MAX_EPOCHS));
    epochs.set(epoch, undefined);
  }
  /**
   * Drops epochs whose link closed more than the retention period ago. The
   * file keeps them until compaction.
   */
  #forget(now: number): void {
    for (const [router, epochs] of this.#epochs) {
      for (const [epoch, retired] of epochs) {
        if (retired !== undefined && retired + EPOCH_RETENTION_SECONDS <= now) {
          epochs.delete(epoch);
        }
      }
      if (epochs.size === 0) this.#epochs.delete(router);
    }
  }
  #writeBytes(file: Deno.FsFile, bytes: Uint8Array): void {
    let at = 0;
    while (at < bytes.length) {
      const count = file.writeSync(bytes.subarray(at));
      requireRouted(count > 0);
      at += count;
    }
  }
  /** Rewrites the file to what memory holds, in one write. */
  #compact(now: number): void {
    this.#forget(now);
    const lines: string[] = [];
    for (const [router, epochs] of this.#epochs) {
      for (const [epoch, retired] of epochs) {
        lines.push(JSON.stringify(["epoch", router, epoch]));
        if (retired !== undefined) {
          lines.push(JSON.stringify(["retire", router, epoch, retired]));
        }
      }
    }
    for (const router of this.#revoked) {
      lines.push(JSON.stringify(["revoke", router, "permanent"]));
    }
    const bytes = new TextEncoder().encode(
      lines.length === 0 ? "" : `${lines.join("\n")}\n`,
    );
    requireRouted(bytes.length <= MAX_BYTES);
    const path = `${this.#path}.next`,
      file = Deno.openSync(path, {
        create: true,
        truncate: true,
        write: true,
        mode: 0o600,
      });
    try {
      this.#writeBytes(file, bytes);
      file.syncDataSync();
      Deno.renameSync(path, this.#path);
      this.#syncDirectory();
      this.#file.close();
      this.#file = this.#open();
    } finally {
      file.close();
    }
  }
  /**
   * Appends one record and fsyncs it. A file past half its bound is
   * compacted first. What it then holds is at most 16 routers' 1,024 epochs,
   * about 4 MiB, and the routers an operator revoked, so compaction always
   * leaves room.
   */
  #append(record: unknown[], now = Math.floor(Date.now() / 1000)): void {
    requireRouted(!this.#closed && this.#healthy);
    try {
      let size = this.#file.statSync().size;
      if (size > MAX_BYTES / 2) {
        this.#compact(now);
        size = this.#file.statSync().size;
      }
      const bytes = new TextEncoder().encode(`${JSON.stringify(record)}\n`);
      requireRouted(size + bytes.length <= MAX_BYTES);
      this.#writeBytes(this.#file, bytes);
      this.#file.syncDataSync();
    } catch (error) {
      this.#healthy = false;
      throw error;
    }
  }
  /**
   * Consumes a link epoch before acknowledging its handshake. It cannot be
   * reused while recorded: while its link lives, then for the retention
   * period after `retire`.
   */
  consume(
    router: string,
    epoch: string,
    now = Math.floor(Date.now() / 1000),
  ): void {
    requireRouted(!this.revoked(router));
    this.#forget(now);
    const held = this.#epochs.get(router);
    requireRouted(
      !held?.has(epoch) && (held?.size ?? 0) < MAX_EPOCHS &&
        (held !== undefined || this.#epochs.size < 16),
    );
    // Compaction must see only previously persisted epochs. A pending epoch
    // enters memory after its append/fsync, so it is serialized exactly once.
    this.#append(["epoch", router, epoch], now);
    this.#remember(router, epoch);
  }
  /** Records that an epoch's link closed; its retention period starts now. */
  retire(router: string, epoch: string, now: number): void {
    const epochs = this.#epochs.get(router);
    if (epochs?.has(epoch) !== true || epochs.get(epoch) !== undefined) return;
    this.#append(["retire", router, epoch, now], now);
    epochs.set(epoch, now);
  }
  /** Permanent router-key revocation; key rotation requires a new DID. */
  revoke(router: string): void {
    if (!this.#revoked.has(router)) {
      this.#revoked.add(router);
      this.#append(["revoke", router, "permanent"]);
    }
  }
  /**
   * Whether the ledger can still record: a disk failure, or closing it,
   * stops every later admission until an operator repairs it.
   */
  get healthy(): boolean {
    return this.#healthy && !this.#closed;
  }
  /** Whether the router key is permanently revoked. */
  revoked(router: string): boolean {
    return this.#revoked.has(router);
  }
  /** Closes after the private listener, releasing exclusive file custody. */
  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#file.close();
      this.#lock.unlockSync();
      this.#lock.close();
    }
  }
}
