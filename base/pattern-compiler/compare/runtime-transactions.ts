/**
 * Keeps the documents of an executor in the runtime's storage, so that
 * what the runtime's transactions cost the compiled path can be measured
 * (milestone 1 of `docs/plans/compiled-pattern-language-integration.md`).
 *
 * Each transaction of the executor is a transaction of the runtime
 * (`Runtime.edit()`). Each position the executor reads is read through it,
 * which journals the read and marks the transaction as one that observed
 * labels where the document has some. Each change the executor makes is
 * written into it as the change is made, so that a later read in the same
 * transaction finds it. When the executor's transaction ends the runtime's
 * commits, and `ExtendedStorageTransaction.commit()` runs the preparation of
 * Contextual Flow Control that it runs for every commit; a transaction the
 * executor does not commit is aborted. The executor computes on the
 * documents it holds in memory, and the storage holds the same documents
 * (`RuntimeTransactions.stored()`).
 *
 * A document of the executor is the entity `of:<identifier>` of the space,
 * and a link the executor stores is written as the runtime's link to that
 * entity (`createSigilLinkFromParsedLink()`). A path of a link that crosses
 * an array by key holds the key's text, which the runtime does not resolve:
 * nothing but the executor reads these documents.
 */
import { debugStr, type FabricValue } from "@commonfabric/data-model";

import {
  createSigilLinkFromParsedLink,
  parseLink,
} from "../../../runtime/runner/src/link-utils.ts";
import {
  isPrimitiveCellLink,
  type NormalizedFullLink,
} from "../../../runtime/runner/src/link-types.ts";
import type { JSONSchema } from "../../../runtime/runner/src/builder/types.ts";
import type { MemorySpace } from "../../../runtime/runner/src/cell.ts";
import type { Runtime } from "../../../runtime/runner/src/runtime.ts";
import type { URI } from "../../../runtime/runner/src/sigil-types.ts";
import type {
  IExtendedStorageTransaction,
  TransactionCommitReceipt,
} from "../../../runtime/runner/src/storage/interface.ts";
import type { Transaction, TransactionHooks } from "../exec/executor.ts";
import { isLink, type Schema, type Store } from "../exec/store.ts";

/** What the runtime's transactions were given, counted. */
export type RuntimeCounts = {
  /** Transactions committed. */
  committed: number;
  /** Transactions committed, by the cause the executor gave each. */
  byCause: Record<string, number>;
  /** Transactions aborted, because the executor did not commit them. */
  aborted: number;
  /** Positions read through a transaction, each once per transaction. */
  reads: number;
  /** Writes staged, one for each change of the executor. */
  writes: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Keeps the documents of one executor in one space of a runtime. */
export class RuntimeTransactions implements TransactionHooks {
  readonly #runtime: Runtime;
  readonly #space: MemorySpace;
  #tx: IExtendedStorageTransaction | undefined;
  #cause = "";
  /** The positions the transaction in progress read, as text. */
  readonly #read = new Set<string>();
  readonly #receipts: TransactionCommitReceipt[] = [];
  readonly #counts: RuntimeCounts = {
    committed: 0,
    byCause: {},
    aborted: 0,
    reads: 0,
    writes: 0,
  };
  /** The identifier of each document the storage holds. */
  readonly #documents = new Set<string>();
  /** The document of the executor that each entity holds. */
  readonly #byEntity = new Map<string, string>();

  /**
   * Constructs an instance which keeps the documents in `space` of
   * `runtime`.
   */
  constructor(runtime: Runtime, space: MemorySpace) {
    this.#runtime = runtime;
    this.#space = space;
  }

  /** What the transactions were given so far. */
  get counts(): Readonly<RuntimeCounts> {
    return { ...this.#counts, byCause: { ...this.#counts.byCause } };
  }

  /** @inheritDoc */
  begin(cause: Transaction["cause"] | "send" | "watermark"): void {
    if (this.#tx !== undefined) {
      throw new Error("A transaction began while another was open.");
    }
    this.#cause = cause;
    this.#tx = this.#runtime.edit();
    this.#read.clear();
  }

  /** @inheritDoc */
  read(doc: string, path: readonly string[]): void {
    const tx = this.#open();
    const text = JSON.stringify([doc, path]);
    if (this.#read.has(text)) return;
    this.#read.add(text);
    this.#counts.reads += 1;
    tx.readValueOrThrow(this.#address(doc, path));
  }

  /** @inheritDoc */
  change(doc: string, path: readonly string[], store: Store): void {
    const tx = this.#open();
    this.#counts.writes += 1;
    const document = store.docs.get(doc);
    if (document === undefined) {
      if (!this.#documents.delete(doc)) return;
      tx.writeValueOrThrow(this.#address(doc, []), undefined, {
        delete: true,
      });
      return;
    }
    this.#documents.add(doc);
    const parent = path.length === 0
      ? undefined
      : store.peek(doc, path.slice(0, -1));
    const absent = path.length > 0 && isRecord(parent) &&
      !Object.hasOwn(parent, path[path.length - 1]);
    if (absent) {
      tx.writeValueOrThrow(this.#address(doc, path), undefined, {
        delete: true,
      });
      return;
    }
    tx.writeValueOrThrow(
      this.#address(doc, path),
      this.#encode(store.peek(doc, path)),
    );
  }

  /** @inheritDoc */
  end({ committed }: { committed: boolean }): void {
    const tx = this.#open();
    this.#tx = undefined;
    if (!committed) {
      tx.abort();
      this.#counts.aborted += 1;
      return;
    }
    this.#receipts.push(tx.commit());
    this.#counts.committed += 1;
    this.#counts.byCause[this.#cause] = (this.#counts.byCause[this.#cause] ??
      0) + 1;
  }

  /**
   * Waits until every commit so far has settled, and returns the reason
   * of each commit the storage refused.
   */
  async settled(): Promise<string[]> {
    const refused: string[] = [];
    for (const receipt of this.#receipts.splice(0)) {
      const { error } = await receipt.settled;
      if (error !== undefined) refused.push(`${error.name}: ${error.message}`);
    }
    return refused;
  }

  /**
   * What the storage holds for each document the executor's commits
   * wrote, read in a transaction of its own, with each of the runtime's
   * links written back as the executor's.
   */
  stored(): Map<string, unknown> {
    const tx = this.#runtime.edit();
    try {
      return new Map(
        [...this.#documents].map((
          doc,
        ) => [doc, this.#decode(tx.readValueOrThrow(this.#address(doc, [])))]),
      );
    } finally {
      tx.abort();
    }
  }

  /**
   * The entity of the space that holds a document of the executor: the
   * identifier itself where it is an entity's, as that of a document the
   * runtime made is, and `of:` before it otherwise.
   */
  entityOf(doc: string): URI {
    const entity: URI = doc.startsWith("of:") ? doc as URI : `of:${doc}`;
    this.#byEntity.set(entity, doc);
    return entity;
  }

  /** The document of the executor that an entity holds. */
  documentOf(entity: string): string {
    return this.#byEntity.get(entity) ?? entity;
  }

  /** Helper for the hooks, which gives the transaction in progress. */
  #open(): IExtendedStorageTransaction {
    if (this.#tx === undefined) {
      throw new Error("The executor used a transaction that is not open.");
    }
    return this.#tx;
  }

  /** The address of a path of a document of the executor. */
  #address(doc: string, path: readonly string[]): NormalizedFullLink {
    return {
      space: this.#space,
      id: this.entityOf(doc),
      path: [...path],
      scope: "space",
    };
  }

  /**
   * A value of the executor, with each link written as the runtime's. The
   * executor's documents hold JSON values and its own records of a link,
   * a stream and an error state, which are records too.
   */
  #encode(value: unknown): FabricValue {
    if (isLink(value)) {
      const { doc, path, schema } = value.$link;
      return createSigilLinkFromParsedLink(
        {
          id: this.entityOf(doc),
          space: this.#space,
          path,
          // A schema of a plan is a JSON schema with the members the
          // executor reads typed (`Schema` of `exec/store.ts`).
          ...(schema === undefined ? {} : { schema: schema as JSONSchema }),
        },
        { includeSchema: true },
      );
    }
    if (Array.isArray(value)) {
      return value.map((member) => this.#encode(member));
    }
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([name, member]) => [
          name,
          this.#encode(member),
        ]),
      );
    }
    if (
      value === null || value === undefined || typeof value === "string" ||
      typeof value === "number" || typeof value === "boolean"
    ) {
      return value;
    }
    throw new Error(debugStr`The executor holds no JSON value: ${value}`);
  }

  /** A stored value, with each of the runtime's links written back. */
  #decode(value: unknown): unknown {
    if (isPrimitiveCellLink(value)) {
      const link = parseLink(value);
      return {
        $link: {
          doc: this.documentOf(link.id ?? ""),
          path: [...link.path],
          ...(link.schema === undefined
            ? {}
            : { schema: link.schema as Schema }),
        },
      };
    }
    if (Array.isArray(value)) {
      return value.map((member) => this.#decode(member));
    }
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([name, member]) => [
          name,
          this.#decode(member),
        ]),
      );
    }
    return value;
  }
}
