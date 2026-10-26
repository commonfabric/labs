/**
 * Holds a client runtime's derived state for a space its principal cannot
 * write. A reactive computation writes its outputs where its inputs live, and
 * a principal granted READ there still runs the computation: the view they
 * read is made of those outputs. The space refuses the writes, so a derived
 * transaction is sealed into the replica's process-local layer instead of
 * being pushed. Reads see the held value through the ordinary pending
 * materialization; nothing is sent, synced, or kept past the runtime's life.
 * The store is the cache of derived state for principals who may write it,
 * and a principal who may not keeps a working copy of their own
 * (`docs/specs/memory-v2/03-commit-model.md` §3.8.3).
 *
 * A held derivation stands only where the store holds nothing: a write to a
 * document the store already holds a value for is dropped, and the principal's
 * view keeps the stored value, which someone who may write the space
 * computed from inputs this principal may not read. The drop changes nothing
 * in the replica, so it notifies nothing and the writer stays at rest rather
 * than computing the same write again.
 *
 * A held derivation is replaced rather than accumulated. A newer whole-document
 * derivation of the same documents retires the older one, an authoritative
 * value arriving for a document it wrote retires it, and a grant of WRITE
 * retires every held derivation in the space and runs their writers again,
 * which then commit to the store.
 *
 * Only a transaction marked `derivedWrites` is held. Every other write — an
 * event append, a binding edit, a setup a host asks for — commits as it would
 * without this destination, so a refusal of one still reaches its author.
 */

import { type ACL, aclDocId } from "@commonfabric/memory/acl";
import type { CellScope } from "@commonfabric/memory/v2";
import { getLogger } from "@commonfabric/utils/logger";

import { spaceReaderRole } from "../cfc/space-membership.ts";
import type { Runtime } from "../runtime.ts";
import type { Action } from "../scheduler.ts";
import type {
  CommitError,
  IExtendedStorageTransaction,
  IStorageTransaction,
  ITransactionSealSink,
  MemorySpace,
  NativeStorageCommit,
  Result,
  SealedCommitVerdict,
  TransactionCommitOptions,
  TransactionCommitReceipt,
  TransactionSealDestination,
  Unit,
  URI,
} from "../storage/interface.ts";
import { isPermanentAuthorizationRefusal } from "../storage/rejection.ts";
import { CoalescedDocListener } from "./doc-notification-listener.ts";

const logger = getLogger("local-derivation", {
  enabled: true,
  level: "warn",
});

/** A principal's standing to write a space, as far as this runtime can tell. */
type WriteAccess = "granted" | "refused" | "unknown";

/** One derived transaction held in a space's process-local layer. */
type HeldDerivation = {
  space: MemorySpace;

  /** The replica-local seq the held pending writes are keyed by. */
  localSeq: number;

  resolveVerdict: (verdict: SealedCommitVerdict) => void;

  /**
   * The document instances the transaction wrote, and whether each was
   * written whole, which is what lets a later whole write stand in for it.
   */
  writtenDocs: Array<{ id: URI; scope?: CellScope; wholeDoc: boolean }>;

  /** The scheduler action whose run produced the derivation, when one did. */
  writer: Action | undefined;

  /** Resolves once the verdict has been applied to the replica. */
  settled: Promise<unknown>;
};

const isAction = (value: unknown): value is Action =>
  typeof value === "function";

const docKey = (doc: { id: string; scope?: CellScope }): string =>
  `${doc.scope ?? ""}\0${doc.id}`;

/**
 * The seal destination that holds derived writes locally where the principal
 * cannot store them: one per client runtime, consulted for every transaction
 * the runtime mints while it seals into neither a wave nor the speculation
 * overlay.
 */
export class LocalDerivationDestination implements TransactionSealDestination {
  readonly #runtime: Runtime;

  /** space → localSeq → held derivation. */
  readonly #held = new Map<MemorySpace, Map<number, HeldDerivation>>();

  /**
   * Spaces whose access list this destination has asked the replica for and
   * keeps watched: those it holds derivations for, or that refused one.
   */
  readonly #watchedLists = new Set<MemorySpace>();

  /**
   * Spaces the store refused a derived write of for lack of a grant since
   * the replica's copy of their access list last changed: the list the
   * replica holds was behind the one the store decided by.
   */
  readonly #refused = new Set<MemorySpace>();

  /**
   * The one storage-notification listener that re-reads a space's access
   * list when it changes: outside the scheduler, so a change costs no
   * transaction and no run of anything.
   */
  readonly #accessListListener: CoalescedDocListener;

  /** space → release of the arrival wake installed on the replica. */
  readonly #arrivalReleases = new Map<MemorySpace, () => void>();

  #closed = false;

  /**
   * Constructs an instance which holds derivations for `runtime`. It asks
   * the replica for nothing until a space refuses a derivation or holds one,
   * so a runtime whose principal may write every space it touches is left
   * exactly as it would be without it.
   */
  constructor(runtime: Runtime) {
    this.#runtime = runtime;
    this.#accessListListener = new CoalescedDocListener(
      runtime.storageManager,
      {
        wants: (space, id, scope) =>
          (scope === undefined || scope === "space") &&
          this.#watchedLists.has(space) && id === aclDocId(space),
        onNotify: (space) => this.#accessListChanged(space),
      },
    );
  }

  /**
   * Whether an effect completion sealing here asserts its writes whole. It
   * does not: a completion commits to the store, where the ordinary no-op
   * elision diffs against the right view.
   */
  get authoritativeCompletions(): false {
    return false;
  }

  /** DIAGNOSTIC (tests): the derivations held for `space`. */
  heldCount(space: MemorySpace): number {
    return this.#held.get(space)?.size ?? 0;
  }

  /**
   * DIAGNOSTIC (tests): what this runtime's principal may write in `space`,
   * as far as the access list the replica holds says.
   */
  writeAccess(space: MemorySpace): WriteAccess {
    return this.#writeAccess(space);
  }

  /**
   * Holds a derived transaction into a space the principal is known not to
   * write, and forwards every other transaction to the store. The decision
   * never waits, since a wait between a transaction's reads and its commit
   * is a window for the replica's view to move under it, and asks the
   * replica for nothing: a derived transaction into a space whose access
   * list the replica does not hold is forwarded, and the store's verdict
   * teaches this destination what the list would have.
   */
  seal(
    tx: IExtendedStorageTransaction,
    options?: TransactionCommitOptions,
  ): Promise<Result<Unit, CommitError>> | TransactionCommitReceipt {
    if (this.#closed || tx.tx.derivedWrites !== true) {
      return tx.tx.commit(options);
    }
    const spaces = tx.tx.writtenSpaces?.() ?? [];
    if (spaces.some((space) => this.#writeAccess(space) === "refused")) {
      return this.#hold(tx);
    }
    return this.#forward(tx, options, spaces);
  }

  /**
   * Withdraws every held derivation and releases the watches. The replica
   * may already be closing, so the rollback is best-effort.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [space, held] of this.#held) {
      for (const entry of held.values()) {
        entry.resolveVerdict({
          withdrawn: {
            message: `held derivation in ${space} released: runtime closed`,
            superseded: true,
          },
        });
      }
      held.clear();
    }
    this.#held.clear();
    this.#accessListListener.release();
    for (const release of this.#arrivalReleases.values()) {
      try {
        release();
      } catch {
        // observer release is best-effort during teardown
      }
    }
    this.#arrivalReleases.clear();
    this.#watchedLists.clear();
    this.#refused.clear();
  }

  /**
   * Helper for {@link seal}, which commits `tx` to the store and learns from
   * a refusal: a grant refusal says the store's access list is ahead of the
   * replica's, so later derivations into the same spaces are held, and the
   * writer whose run was refused, when the transaction names one, runs once
   * more so that its derivation is held rather than lost. The rerun is
   * requested only once the refusal's revert has been applied, so the writer
   * reads the restored state rather than the write the store refused. Under
   * the `localFold` flag the replica keeps the refused write and the
   * scheduler's own retry reads it, so no rerun is requested here.
   */
  #forward(
    tx: IExtendedStorageTransaction,
    options: TransactionCommitOptions | undefined,
    spaces: readonly MemorySpace[],
  ): TransactionCommitReceipt {
    const receipt = tx.tx.commit(options);
    const writer = tx.tx.sourceAction;
    receipt.settled.then((result) => {
      if (
        this.#closed || result.error === undefined ||
        !isPermanentAuthorizationRefusal(result.error)
      ) {
        return;
      }
      for (const space of spaces) {
        this.#refused.add(space);
        this.#watchAccessList(space);
      }
      if (isAction(writer) && this.#runtime.experimental.localFold !== true) {
        this.#runtime.scheduler.invalidateAction(writer);
      }
    }, () => {});
    return receipt;
  }

  /**
   * Helper for {@link seal}, which seals `tx` into the replica's local layer
   * as whole-document writes and registers what it holds.
   */
  async #hold(
    tx: IExtendedStorageTransaction,
  ): Promise<Result<Unit, CommitError>> {
    const inner = tx.tx;
    if (
      inner.sealInto === undefined ||
      inner.markWholeDocumentWrites === undefined
    ) {
      return {
        error: {
          name: "StorageTransactionAborted",
          message: "a derived write the principal cannot store could not " +
            "be held locally: the storage transaction does not support " +
            "sealing whole-document writes",
          reason: new Error("local-derivation-unsupported"),
        },
      };
    }
    const held: HeldDerivation[] = [];
    const collector: ITransactionSealSink = {
      sealSpaceCommit: (
        space: MemorySpace,
        native: NativeStorageCommit,
        source: IStorageTransaction,
      ): Promise<Result<Unit, CommitError>> => {
        const replica = this.#runtime.storageManager.open(space).replica;
        if (replica.sealNative === undefined) {
          return Promise.resolve({
            error: {
              name: "StorageTransactionAborted",
              message: `space replica for ${space} does not support ` +
                "sealing, so a derived write there cannot be held locally",
              reason: new Error("local-derivation-unsupported"),
            },
          });
        }
        // A document the store holds a value for is left as the store has
        // it: the write to it is dropped before anything applies, so the
        // replica changes nothing for it and no reader, the writer
        // included, is notified.
        const yielded = new Set(
          native.operations
            .filter((op) => this.#storeHolds(replica, op))
            .map(docKey),
        );
        if (yielded.size > 0) {
          native = {
            ...native,
            operations: native.operations.filter((op) =>
              !yielded.has(docKey(op))
            ),
            ...(native.preconditions === undefined ? {} : {
              preconditions: native.preconditions.filter((precondition) =>
                precondition.kind === "origin-committed" ||
                !yielded.has(docKey(precondition))
              ),
            }),
          };
          if (
            native.operations.length === 0 &&
            (native.sqliteOps?.length ?? 0) === 0
          ) {
            return Promise.resolve({ ok: {} });
          }
        }
        const { promise, resolve } = Promise.withResolvers<
          SealedCommitVerdict
        >();
        const sealed = replica.sealNative(native, source, promise, {
          speculative: true,
        });
        const writtenDocs = new Map<
          string,
          { id: URI; scope?: CellScope; wholeDoc: boolean }
        >();
        for (
          const op of sealed.commit.operations as Array<
            { id?: string; scope?: CellScope; op?: string }
          >
        ) {
          if (typeof op.id !== "string") continue;
          const key = docKey({ id: op.id, scope: op.scope });
          const wholeDoc = op.op === "set" || op.op === "delete";
          const existing = writtenDocs.get(key);
          if (existing === undefined) {
            writtenDocs.set(key, {
              id: op.id as URI,
              scope: op.scope,
              wholeDoc,
            });
          } else if (!wholeDoc) {
            existing.wholeDoc = false;
          }
        }
        const writer = source.sourceAction;
        const entry: HeldDerivation = {
          space,
          localSeq: sealed.localSeq,
          resolveVerdict: resolve,
          writtenDocs: [...writtenDocs.values()],
          writer: isAction(writer) ? writer : undefined,
          settled: sealed.settled.catch(() => undefined),
        };
        held.push(entry);
        // Registered in the same synchronous stretch as the layer is applied,
        // so a frame that moves a written document's confirmed seq before the
        // seal as a whole resolves still finds the entry and retires it; a
        // layer the arrival wake cannot see would stand over a newer base.
        this.#register(entry);
        return Promise.resolve({ ok: {} });
      },
    };
    let result: Result<Unit, CommitError>;
    try {
      // The held writes are materialized over the confirmed value on every
      // read, and that value moves under them, so each says what the run
      // computed rather than how that differed from what it ran over.
      inner.markWholeDocumentWrites();
      result = await inner.sealInto(collector);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      result = {
        error: {
          name: "StorageTransactionAborted",
          message: `holding a derived write locally failed: ${message}`,
          reason: cause,
        },
      };
    }
    if (result.error) {
      for (const entry of held) {
        this.#held.get(entry.space)?.delete(entry.localSeq);
        entry.resolveVerdict({
          withdrawn: {
            message: `holding a derived write locally failed: ` +
              result.error.message,
          },
        });
      }
      return result;
    }
    // A close that ran while the seal was in flight withdrew the entries the
    // sink registered; either way the run's results are re-derivable.
    return { ok: {} };
  }

  /**
   * Helper for {@link seal}, which returns whether the store holds a value for
   * the document `op` writes, read beneath every held layer: a value the
   * store holds is one a principal who may write the space produced, and the
   * derivation yields to it.
   */
  #storeHolds(
    replica: {
      getNonSpeculativeDocument?: (
        id: URI,
        scope?: CellScope,
      ) => { value?: unknown } | undefined;
    },
    op: { id: URI; scope?: CellScope },
  ): boolean {
    return replica.getNonSpeculativeDocument?.(op.id, op.scope)?.value !==
      undefined;
  }

  /**
   * Helper for {@link seal}, which records `entry` and retires the held
   * derivations it stands in for: one whose every document `entry` wrote
   * whole reads the same with or without its layer, so it goes.
   */
  #register(entry: HeldDerivation): void {
    let held = this.#held.get(entry.space);
    if (held === undefined) {
      held = new Map();
      this.#held.set(entry.space, held);
    }
    const covered = new Set(
      entry.writtenDocs.filter((doc) => doc.wholeDoc).map(docKey),
    );
    for (const older of [...held.values()]) {
      if (
        older.localSeq >= entry.localSeq || older.writtenDocs.length === 0 ||
        !older.writtenDocs.every((doc) => covered.has(docKey(doc)))
      ) {
        continue;
      }
      held.delete(older.localSeq);
      older.resolveVerdict({
        withdrawn: {
          message: "held derivation superseded by a newer derivation of " +
            "the same documents",
          superseded: true,
        },
      });
    }
    held.set(entry.localSeq, entry);
    this.#ensureArrivalObserver(entry.space);
    this.#watchAccessList(entry.space);
  }

  /**
   * Helper for {@link seal}, which returns the principal's standing in
   * `space` from the access list the replica holds, read beneath every held
   * layer: `refused` while a refusal from the store stands and for a list
   * that grants less than WRITE, `granted` for an owner or writer, and
   * `unknown` for a space whose list the replica does not hold, which a
   * space with no list reads as too.
   */
  #writeAccess(space: MemorySpace): WriteAccess {
    if (this.#refused.has(space)) return "refused";
    const replica = this.#runtime.storageManager.open(space).replica;
    const acl = (replica.getNonSpeculativeDocument ?? replica.getDocument)
      .call(replica, aclDocId(space) as URI, "space")?.value;
    if (acl === undefined) return "unknown";
    const role = spaceReaderRole(acl as ACL, this.#runtime.userIdentityDID);
    return role === "owner" || role === "writer" ? "granted" : "refused";
  }

  /**
   * Helper for {@link seal}, which asks the replica for `space`'s access
   * list once and keeps it watched, so that a grant made while this runtime
   * runs releases what it holds. Asked only for a space that refused a
   * derivation or holds one: for every other space the replica is left as
   * it is.
   */
  #watchAccessList(space: MemorySpace): void {
    if (this.#closed || this.#watchedLists.has(space)) return;
    this.#watchedLists.add(space);
    this.#accessListListener.ensure();
    const report = (error: unknown) => {
      logger.warn("access-list-load-failed", () => [
        `the access list of ${space} could not be loaded; a grant made ` +
        "while this runtime runs reaches it only through a reload",
        error,
      ]);
    };
    Promise.resolve(
      this.#runtime.storageManager.open(space).sync(
        aclDocId(space) as URI,
        { path: [], schema: false },
        "space",
      ),
    ).then((result) => {
      if (result?.error !== undefined) report(result.error);
    }, report);
  }

  /**
   * Helper for the access-list listener, which acts on a change to `space`'s
   * access list: a refusal decided by the old list is retired, and a grant of
   * WRITE releases what is held and runs the writers again.
   */
  #accessListChanged(space: MemorySpace): void {
    if (this.#closed) return;
    this.#refused.delete(space);
    if (this.#writeAccess(space) === "granted") {
      this.#release(space, "the principal may now write the space");
    }
  }

  /**
   * Helper for the access-list watch, which withdraws every derivation held
   * for `space` and runs their writers again, which commit to the store now
   * that the principal may write it. The writers run only once the withdrawn
   * layers have left the replica: a run that still read a held layer would
   * find its own value in place and write nothing, and the drop that follows
   * is its own flip, which does not run it either.
   */
  #release(space: MemorySpace, reason: string): void {
    const held = this.#held.get(space);
    if (held === undefined || held.size === 0) return;
    const entries = [...held.values()];
    held.clear();
    const writers = new Set<Action>();
    for (const entry of entries) {
      if (entry.writer !== undefined) writers.add(entry.writer);
      entry.resolveVerdict({
        withdrawn: {
          message: `held derivation in ${space} released: ${reason}`,
          superseded: true,
        },
      });
    }
    void Promise.all(entries.map((entry) => entry.settled)).then(() => {
      if (this.#closed) return;
      for (const writer of writers) {
        this.#runtime.scheduler.invalidateAction(writer);
      }
    });
  }

  /**
   * Helper for {@link seal}, which installs the replica's arrival wake for
   * `space`: a frame that moves the confirmed seq of a document a held
   * derivation wrote retires that derivation, since the store now holds an
   * authoritative value for it. A wake another destination installed is
   * left alone.
   */
  #ensureArrivalObserver(space: MemorySpace): void {
    if (this.#arrivalReleases.has(space)) return;
    const replica = this.#runtime.storageManager.open(space).replica;
    if (typeof replica.speculationRetirementView !== "function") return;
    const observable = replica as {
      speculationArrivalObserver:
        | ((arrived: readonly { id: URI; scope?: CellScope }[]) => void)
        | undefined;
    };
    if (observable.speculationArrivalObserver !== undefined) return;
    const observer = (arrived: readonly { id: URI; scope?: CellScope }[]) => {
      if (this.#closed) return;
      const held = this.#held.get(space);
      if (held === undefined || held.size === 0) return;
      const arrivedKeys = new Set(arrived.map(docKey));
      for (const entry of [...held.values()]) {
        if (!entry.writtenDocs.some((doc) => arrivedKeys.has(docKey(doc)))) {
          continue;
        }
        held.delete(entry.localSeq);
        entry.resolveVerdict({
          withdrawn: {
            message: "held derivation retired: an authoritative value " +
              "arrived for a document it wrote",
            superseded: true,
          },
        });
      }
    };
    observable.speculationArrivalObserver = observer;
    this.#arrivalReleases.set(space, () => {
      if (observable.speculationArrivalObserver === observer) {
        observable.speculationArrivalObserver = undefined;
      }
    });
  }
}
