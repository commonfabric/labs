/**
 * What the `wish` operations of a compiled piece and the built-ins its
 * derivations called read outside the executor, kept so that a piece that
 * was resumed from a basis that matches is woken when one of those
 * documents changes, behind the experimental option `compiledPatterns`.
 *
 * The basis of a piece (`basis.ts`) names the documents the executor
 * read. The runtime's `wish` and its built-ins read through the
 * transaction of an action of their own: the root of a space, the list of
 * the profiles of a home, an access list, the label of a document. A
 * piece that runs hears of a change of those through the scheduler, which
 * runs the action again. A piece that was resumed from a matching basis
 * runs no action, so the piece stores, for each `wish` and each question
 * of a built-in, the documents its run read, by the position that read
 * them, and `wakeOnOutsideReads()` watches them for a resumed piece.
 *
 * A piece that has documents of a scope narrower than the space is never
 * resumed without its executor (`CompiledPiece`), so nothing is kept for
 * it, and a read of a document of such a scope is not kept.
 */
import { identifierOf } from "../../../../base/pattern-compiler/exec/store.ts";
import type { JSONSchema } from "../builder/types.ts";
import type { Cancel } from "../cancel.ts";
import type { Cell } from "../cell.ts";
import type {
  IExtendedStorageTransaction,
  IStorageSubscription,
} from "../storage/interface.ts";
import type { Runtime } from "../runtime.ts";
import type { URI } from "../sigil-types.ts";
import type { ResumedPiece } from "./resume.ts";
import { linkOfDocument } from "./scopes.ts";

/** A document a run read: its space and its entity. */
export type OutsideRead = { space: string; id: string };

/**
 * The document that keeps what the wishes and the built-ins of the piece
 * whose result document is `result` read: a record of the positions, each
 * with the documents its last run read.
 */
export const outsideReadsDocumentOf = (result: string): string =>
  identifierOf({ type: "outside reads", parent: result });

/** What `OutsideReads` takes. */
export type OutsideReadsOptions = {
  /** Whether the storage holds the document of the piece already. */
  stored: boolean;
  /**
   * Writes, into a transaction of the derivation of the piece, the
   * documents of a position at `path` of the document of the piece, or
   * the whole record where `path` is empty.
   */
  write: (
    tx: IExtendedStorageTransaction,
    path: readonly string[],
    value: unknown,
  ) => void;
  /** Called when a position read other documents than it had. */
  changed: () => void;
};

/**
 * The documents each `wish` and each question of a built-in of a piece
 * read, as the piece stores them.
 */
export class OutsideReads {
  readonly #options: OutsideReadsOptions;
  /** The text of the documents each position read, by its key. */
  readonly #held = new Map<string, string>();
  /** The documents of the positions that are not stored yet, by key. */
  readonly #pending = new Map<string, OutsideRead[]>();
  #stored: boolean;

  /** Constructs an instance that holds no position. */
  constructor(options: OutsideReadsOptions) {
    this.#options = options;
    this.#stored = options.stored;
  }

  /**
   * Takes the documents of the space scope that the run on `tx` read as
   * what `position` read: `wish` and the identifier of the state document
   * for a `wish`, and the principal and the question for a built-in.
   */
  noted(position: string, tx: IExtendedStorageTransaction): void {
    const seen = new Set<string>();
    const reads: OutsideRead[] = [];
    for (const read of tx.getReadActivities?.() ?? []) {
      if ((read.scope ?? "space") !== "space") continue;
      const text = `${read.space}\n${read.id}`;
      if (seen.has(text)) continue;
      seen.add(text);
      reads.push({ space: read.space, id: read.id });
    }
    reads.sort((a, b) =>
      `${a.space}\n${a.id}`.localeCompare(`${b.space}\n${b.id}`)
    );
    const key = identifierOf({ read: position });
    const text = JSON.stringify(reads);
    if (this.#held.get(key) === text) return;
    this.#held.set(key, text);
    this.#pending.set(key, reads);
    this.#options.changed();
  }

  /** Writes into `tx` the positions that read other documents than stored. */
  flush(tx: IExtendedStorageTransaction): void {
    if (this.#pending.size === 0) return;
    if (!this.#stored) {
      this.#options.write(tx, [], Object.fromEntries(this.#pending));
      this.#stored = true;
    } else {
      for (const [key, reads] of this.#pending) {
        this.#options.write(tx, [key], reads);
      }
    }
    this.#pending.clear();
  }
}

/** A schema under which a sync brings a document and follows no link. */
const NOTHING_BELOW = false as JSONSchema;

/**
 * Wakes the piece `resumed`, whose result is `resultCell` and whose basis
 * matched the storage, when a document that a `wish` or a built-in of the
 * piece read changes. Brings the document that names them, and each of
 * them, into the replica of `runtime`, so that the replica hears of their
 * changes. Returns what stops the watch.
 */
export const wakeOnOutsideReads = async (
  runtime: Runtime,
  resultCell: Cell<unknown>,
  resumed: ResumedPiece,
): Promise<Cancel> => {
  const { space, id } = resultCell.getAsNormalizedFullLink();
  const document = linkOfDocument(space, outsideReadsDocumentOf(id));
  await runtime.getCellFromLink(document, NOTHING_BELOW).sync();
  const read = runtime.edit();
  let held: unknown;
  try {
    held = read.readValueOrThrow(document);
  } finally {
    read.abort();
  }
  const watched = new Map<string, OutsideRead>();
  if (typeof held === "object" && held !== null) {
    for (const reads of Object.values(held)) {
      if (!Array.isArray(reads)) continue;
      for (const one of reads as OutsideRead[]) {
        if (typeof one?.space !== "string" || typeof one?.id !== "string") {
          continue;
        }
        watched.set(`${one.space}\n${one.id}`, one);
      }
    }
  }
  if (watched.size === 0) return () => {};
  await Promise.all(
    [...watched.values()].map(({ space, id }) =>
      runtime.getCellFromLink(
        { space: space as never, id: id as URI, path: [], scope: "space" },
        NOTHING_BELOW,
      ).sync()
    ),
  );
  let stopped = false;
  const subscription: IStorageSubscription = {
    next: (notification) => {
      if (stopped || notification.type === "reset") return undefined;
      for (const { address } of notification.changes) {
        if (!watched.has(`${notification.space}\n${address.id}`)) continue;
        stop();
        resumed.wake().catch(() => {});
        break;
      }
      return undefined;
    },
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    runtime.storageManager.unsubscribe?.(subscription);
  };
  runtime.storageManager.subscribe(subscription);
  return stop;
};
