/** Durable router epochs and client-proof replay bindings. */
import { dirname } from "@std/path";
import { isCanonicalEd25519DID } from "@commonfabric/identity";
import { parseRoutedJson } from "./routed-parser.ts";
import { requireRouted } from "./routed-wire.ts";

type Claim = {
  router: string;
  deployment: string;
  principal: string;
  challenge: string;
  digest: string;
  epoch: string;
  context: string;
  exp: number;
  released: boolean;
};
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_CLAIMS = 8192;

/** Exclusive toolshed-local ledger; every authority change is fsynced first. */
export class RoutedEpochStore {
  #file!: Deno.FsFile;
  #lock: Deno.FsFile;
  #path: string;
  #epochs = new Map<string, Set<string>>();
  #revoked = new Set<string>();
  #claims = new Map<string, Claim>();
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
        if (line === "") continue;
        const record = parseRoutedJson(line);
        requireRouted(
          Array.isArray(record) && isCanonicalEd25519DID(record[1]),
        );
        if (record[0] === "epoch") {
          requireRouted(
            record.length === 3 && typeof record[2] === "string" &&
              /^[0-9a-f]{32}$/.test(record[2]),
          );
          this.#remember(record[1], record[2]);
        } else if (record[0] === "revoke") {
          requireRouted(record.length === 3 && record[2] === "permanent");
          this.#revoked.add(record[1]);
        } else {
          requireRouted(record[0] === "claim" && record.length === 10);
          const [
            ,
            router,
            deployment,
            principal,
            challenge,
            digest,
            epoch,
            context,
            exp,
            released,
          ] = record;
          requireRouted(
            typeof deployment === "string" &&
              /^[\x21-\x7e]{1,256}$/.test(deployment) &&
              isCanonicalEd25519DID(principal),
          );
          requireRouted(
            [challenge, digest].every((s) =>
              typeof s === "string" && /^[0-9a-f]{64}$/.test(s)
            ) && [epoch, context].every((s) =>
              typeof s === "string" && /^[0-9a-f]{32}$/.test(s)
            ),
          );
          requireRouted(
            Number.isSafeInteger(exp) && exp > 0 &&
              typeof released === "boolean" &&
              this.#epochs.get(router)?.has(epoch),
          );
          const claim: Claim = {
            router,
            deployment,
            principal,
            challenge,
            digest,
            epoch,
            context,
            exp,
            released,
          };
          const key = this.#key(claim), prior = this.#claims.get(key);
          requireRouted(
            prior === undefined ||
              this.#same(prior, claim) && (!prior.released || released),
          );
          if (exp > Math.floor(Date.now() / 1000)) this.#claims.set(key, claim);
        }
      }
      requireRouted(this.#claims.size <= MAX_CLAIMS);
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
  #key(c: Claim): string {
    return `${c.router} ${c.deployment} ${c.principal} ${c.challenge}`;
  }
  #same(a: Claim, b: Claim): boolean {
    return a.digest === b.digest && a.epoch === b.epoch &&
      a.context === b.context && a.exp === b.exp;
  }
  #record(c: Claim): unknown[] {
    return [
      "claim",
      c.router,
      c.deployment,
      c.principal,
      c.challenge,
      c.digest,
      c.epoch,
      c.context,
      c.exp,
      c.released,
    ];
  }
  #remember(router: string, epoch: string): void {
    let epochs = this.#epochs.get(router);
    if (epochs === undefined) {
      requireRouted(this.#epochs.size < 16);
      epochs = new Set();
      this.#epochs.set(router, epochs);
    }
    requireRouted(!epochs.has(epoch) && epochs.size < 1024);
    epochs.add(epoch);
  }
  #write(file: Deno.FsFile, record: unknown[]): void {
    const bytes = new TextEncoder().encode(`${JSON.stringify(record)}\n`);
    requireRouted(file.statSync().size + bytes.length <= MAX_BYTES);
    let at = 0;
    while (at < bytes.length) {
      const count = file.writeSync(bytes.subarray(at));
      requireRouted(count > 0);
      at += count;
    }
  }
  #compact(now: number): void {
    for (const [key, claim] of this.#claims) {
      if (claim.exp <= now) this.#claims.delete(key);
    }
    const path = `${this.#path}.next`,
      file = Deno.openSync(path, {
        create: true,
        truncate: true,
        write: true,
        mode: 0o600,
      });
    try {
      for (const [router, epochs] of this.#epochs) {
        for (const epoch of epochs) {
          this.#write(file, ["epoch", router, epoch]);
        }
      }
      for (const router of this.#revoked) {
        this.#write(file, ["revoke", router, "permanent"]);
      }
      for (const claim of this.#claims.values()) {
        this.#write(file, this.#record(claim));
      }
      file.syncDataSync();
      Deno.renameSync(path, this.#path);
      this.#syncDirectory();
      this.#file.close();
      this.#file = this.#open();
    } finally {
      file.close();
    }
  }
  #append(record: unknown[], now = Math.floor(Date.now() / 1000)): void {
    requireRouted(!this.#closed);
    try {
      if (this.#file.statSync().size > MAX_BYTES / 2) this.#compact(now);
      this.#write(this.#file, record);
      this.#file.syncDataSync();
    } catch (error) {
      this.#healthy = false;
      throw error;
    }
  }
  /** Permanently consumes each link epoch before acknowledging its handshake. */
  consume(router: string, epoch: string): void {
    requireRouted(!this.revoked(router));
    this.#remember(router, epoch);
    this.#append(["epoch", router, epoch]);
  }
  /** Claims exact client bytes for one context; re-attestation cannot move them. */
  claim(input: Omit<Claim, "released">, now: number): void {
    requireRouted(
      !this.#closed && this.#healthy && !this.revoked(input.router) &&
        input.exp > now && this.#epochs.get(input.router)?.has(input.epoch),
    );
    const key = this.#key({ ...input, released: false }),
      prior = this.#claims.get(key);
    if (prior !== undefined) {
      requireRouted(
        !prior.released && this.#same(prior, { ...input, released: false }),
      );
      return;
    }
    if (this.#claims.size >= MAX_CLAIMS) this.#compact(now);
    requireRouted(this.#claims.size < MAX_CLAIMS);
    const claim = { ...input, released: false };
    this.#append(this.#record(claim), now);
    this.#claims.set(key, claim);
  }
  /** Release tombstones every accepted challenge for this principal/context. */
  release(
    router: string,
    epoch: string,
    context: string,
    principal: string,
    now: number,
  ): void {
    for (const claim of this.#claims.values()) {
      if (
        claim.router === router && claim.epoch === epoch &&
        claim.context === context && claim.principal === principal &&
        !claim.released && claim.exp > now
      ) {
        claim.released = true;
        this.#append(this.#record(claim), now);
      }
    }
  }
  /** Permanent router-key revocation; key rotation requires a new DID. */
  revoke(router: string): void {
    if (!this.#revoked.has(router)) {
      this.#revoked.add(router);
      this.#append(["revoke", router, "permanent"]);
    }
  }
  /** Disk failures stop every subsequent admission until an operator repairs the ledger. */
  get healthy(): boolean {
    return this.#healthy;
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
