// A NON-REACTIVE storage-notification listener for a small set of docs
// (server-execution v2 stage C design (e), RULED 2026-08-18 — design
// §5 items 4 and 15: the intent watch "may be a non-reactive
// storage-notification listener outside the scheduler", on
// `storageManager.subscribe`).
//
// The shape it replaces was a schema-less `cell.sink` over a WHOLE doc:
// a scheduler EFFECT node that ran on every change of the doc, minted
// two transactions per run, deep-traversed every entry FOLLOWING PAYLOAD
// LINKS into other docs (a demand leak), and paid the CFC flow-relevance
// probe over that read set on every commit — O(entries²) per change on
// the stream sidecar (the attribution's 65 % of a saturated worker; the
// design's §3.1). Nothing in the spec asks for a reactive effect there:
// the consumer only needs to know THAT its doc changed and, ideally,
// WHERE (design §3.2).
//
// This listener subscribes ONCE to the storage manager's notification
// relay — the same `IStorageNotification` relay the scheduler consumes —
// and, per notification, filters the merged changes to the docs a
// consumer currently WANTS: O(changes) map lookups, no transaction, no
// query proxy, no CFC probe, no scheduler node, no `idle()`
// participation, no demand edge. It records the LEAF-granular change
// paths the differential already computed (a consequenced mark arrives
// as `["value","entries","<i>","consequenced"]`; an append as
// `["value","entries"]`) and calls the consumer ONCE per (space, doc) in
// a MICROTASK — never inline: the replica dispatches notifications
// inside its commit / integrate step, and a consumer that resolves
// verdicts (dropping speculative layers through the rollback path) or
// calls arbitrary UI subscribers must not interleave with that
// integration (the `#sealSpeculative` deferred-sweep precedent). A
// `reset` notification carries no changes and is relayed as
// `id === undefined` for its space (everything the consumer tracks there
// is dirty).

import type {
  IStorageNotification,
  IStorageNotificationCapability,
  MemorySpace,
  StorageNotification,
} from "../storage/interface.ts";

export type DocNotificationConsumer = {
  /** Does the consumer currently care about this doc? Evaluated per
   * change at notification time — cheap (a map lookup). `scope` is the
   * change address's normalized scope name (`"space"`, `"session"`, …). */
  wants(space: MemorySpace, id: string, scope: string | undefined): boolean;

  /** Called in a microtask, once per (space, id) per burst, with every
   * change path recorded since the previous call. `id === undefined` is
   * a storage RESET for the space: everything the consumer tracks there
   * must be treated as dirty (no paths). */
  onNotify(
    space: MemorySpace,
    id: string | undefined,
    paths: ReadonlyArray<ReadonlyArray<string>>,
  ): void;
};

type PendingKey = string;
type PendingRecord = {
  space: MemorySpace;
  id: string | undefined;
  paths: string[][];
};

export class CoalescedDocListener {
  readonly #manager: IStorageNotificationCapability;
  readonly #consumer: DocNotificationConsumer;
  readonly #pending = new Map<PendingKey, PendingRecord>();
  #subscription: IStorageNotification | undefined;
  #released = false;

  /** DIAGNOSTIC: notifications that touched a wanted doc; microtask
   * checks dispatched. */
  #relevantNotifications = 0;

  #dispatches = 0;

  constructor(
    manager: IStorageNotificationCapability,
    consumer: DocNotificationConsumer,
  ) {
    this.#manager = manager;
    this.#consumer = consumer;
  }

  get installed(): boolean {
    return this.#subscription !== undefined && !this.#released;
  }

  get relevantNotificationCount(): number {
    return this.#relevantNotifications;
  }

  get dispatchCount(): number {
    return this.#dispatches;
  }

  /** Subscribe (idempotent). A released listener cannot be re-armed —
   * construct a new one. */
  ensure(): void {
    if (this.#released || this.#subscription !== undefined) return;
    const subscription: IStorageNotification = {
      next: (notification) => this.#next(notification),
    };
    this.#subscription = subscription;
    this.#manager.subscribe(subscription);
  }

  /** Unsubscribe and drop every pending dispatch: no consumer callback
   * runs after release (a manager without `unsubscribe` still sees the
   * next `next` return `{ done: true }`, which self-cancels). */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#pending.clear();
    const subscription = this.#subscription;
    this.#subscription = undefined;
    if (subscription !== undefined) {
      try {
        this.#manager.unsubscribe?.(subscription);
      } catch {
        // best-effort: the relay drops the subscriber on its next call
      }
    }
  }

  #next(
    notification: StorageNotification,
  ): Omit<IteratorResult<unknown, unknown>, "value"> | undefined {
    if (this.#released) return { done: true };
    if (notification.type === "reset") {
      // The consumer decides what it tracks in the space; relay the
      // reset as one dirty mark for the whole space.
      this.#record(notification.space, undefined, undefined);
      return undefined;
    }
    let touched = false;
    for (const change of notification.changes) {
      const id = change.address.id as string;
      if (!this.#consumer.wants(notification.space, id, change.address.scope)) {
        continue;
      }
      touched = true;
      this.#record(notification.space, id, change.address.path);
    }
    if (touched) this.#relevantNotifications += 1;
    return undefined;
  }

  #record(
    space: MemorySpace,
    id: string | undefined,
    path: readonly string[] | undefined,
  ): void {
    const key = `${space}\0${id ?? ""}`;
    let record = this.#pending.get(key);
    if (record === undefined) {
      record = { space, id, paths: [] };
      this.#pending.set(key, record);
      // ONE coalesced dispatch per (space, doc) per burst, off the
      // dispatching stack.
      queueMicrotask(() => {
        const due = this.#pending.get(key);
        if (due === undefined || due !== record) return;
        this.#pending.delete(key);
        if (this.#released) return;
        this.#dispatches += 1;
        this.#consumer.onNotify(due.space, due.id, due.paths);
      });
    }
    if (path !== undefined) record.paths.push([...path]);
  }
}
