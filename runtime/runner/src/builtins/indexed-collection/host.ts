import { getLogger } from "@commonfabric/logger";
import type {
  AdmittedCommitNotice,
  Server,
} from "@commonfabric/memory/v2/server";

import { Runtime, type RuntimeOptions } from "../../runtime.ts";
import type { MemorySpace } from "../../storage/interface.ts";
import { indexedCollectionRegistryId } from "./registry.ts";

const logger = getLogger("indexed-collection-host");

/** The members of the memory server an {@link IndexedCollectionHost} calls. */
export type IndexedCollectionHostServer = Pick<
  Server,
  "watchAdmittedCommits" | "readDocument"
>;

/**
 * What a host knows of one space: that it lists a collection, that it listed
 * none when its registry was read, or, while that read is in flight, the ids
 * of the documents written meanwhile.
 */
type SpaceListing = "listed" | "unlisted" | string[];

/**
 * Keeps the indexed collections of every space a memory server holds
 * current, from the commits that server admits, with one runtime that does
 * nothing else. Toolshed runs one while server execution is off: no serving
 * runtime maintains a space's collections then, and the runtimes of clients
 * talking to the toolshed maintain none.
 *
 * Only a space that lists a collection reaches the runtime. The host learns
 * which spaces do without one: a commit that writes a space's registry marks
 * that space, and for any other space the host reads the registry document
 * once, from the store, and keeps the answer, since a registry only grows.
 * The runtime is constructed on the first commit to a space that lists a
 * collection, so a server whose spaces list none builds no runtime.
 *
 * The runtime starts no piece. The member fields it reads are the stored
 * ones, which is what a collection mirrors.
 */
export class IndexedCollectionHost {
  readonly #server: IndexedCollectionHostServer;
  readonly #runtimeOptions: () => RuntimeOptions;
  readonly #registryId = indexedCollectionRegistryId();
  readonly #spaces = new Map<string, SpaceListing>();
  readonly #reads = new Set<Promise<void>>();
  readonly #unwatch: () => void;
  #runtime: Runtime | undefined;
  #closed = false;

  /**
   * Constructs an instance which watches the commits `server` admits, and
   * builds its runtime from what `runtimeOptions` returns once a space lists
   * a collection. That runtime maintains every listed collection, whatever
   * the options say about maintenance.
   */
  constructor(options: {
    server: IndexedCollectionHostServer;
    runtimeOptions: () => RuntimeOptions;
  }) {
    this.#server = options.server;
    this.#runtimeOptions = options.runtimeOptions;
    this.#unwatch = this.#server.watchAdmittedCommits((notice) =>
      this.#admitted(notice)
    );
  }

  /** The registry reads in flight, which a test waits for. */
  get accessForTestingOnly(): { readonly reads: Set<Promise<void>> } {
    return { reads: this.#reads };
  }

  /** The maintenance runtime, once a space has listed a collection. */
  get runtime(): Runtime | undefined {
    return this.#runtime;
  }

  /** Stops watching, and disposes the runtime with its storage. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unwatch();
    await Promise.all(this.#reads);
    const runtime = this.#runtime;
    this.#runtime = undefined;
    await runtime?.dispose();
  }

  /**
   * Hands the documents `notice` wrote to the runtime's maintainer, when the
   * space the commit landed in lists a collection.
   */
  #admitted(notice: AdmittedCommitNotice): void {
    if (this.#closed || notice.writes.length === 0) return;
    const ids = notice.writes.map((write) => write.id);
    const known = this.#spaces.get(notice.space);
    if (known === "listed" || ids.includes(this.#registryId)) {
      this.#spaces.set(notice.space, "listed");
      if (Array.isArray(known)) this.#forward(notice.space, known);
      this.#forward(notice.space, ids);
      return;
    }
    if (known === "unlisted") return;
    if (known !== undefined) {
      for (const id of ids) known.push(id);
      return;
    }
    this.#spaces.set(notice.space, ids);
    this.#read(notice.space, ids);
  }

  /**
   * Helper for `#admitted()`, which reads whether `space` lists a collection
   * and then hands on the ids `held` gathered while it read.
   */
  #read(space: string, held: string[]): void {
    const read = this.#server.readDocument(space, this.#registryId).then(
      (document) => {
        // A commit that wrote the registry while this read was in flight has
        // marked the space and handed on what was held.
        if (this.#closed || this.#spaces.get(space) !== held) return;
        if (document?.value === undefined) {
          this.#spaces.set(space, "unlisted");
          return;
        }
        this.#spaces.set(space, "listed");
        this.#forward(space, held);
      },
      (error) => {
        // The next commit to the space reads the registry again. The
        // documents written up to now are followed again once one of them is
        // written again.
        if (this.#spaces.get(space) === held) this.#spaces.delete(space);
        logger.warn("registry-read-failed", () => [space, held.length, error]);
      },
    ).finally(() => {
      this.#reads.delete(read);
    });
    this.#reads.add(read);
  }

  /**
   * Helper for `#admitted()` and `#read()`, which reports the documents
   * `ids` of `space` as written to the maintainer, constructing the runtime
   * when there is none yet.
   */
  #forward(space: string, ids: readonly string[]): void {
    this.#runtime ??= new Runtime({
      ...this.#runtimeOptions(),
      indexedCollectionMaintenance: "listed",
    });
    this.#runtime.indexedCollections.noteWrites(space as MemorySpace, ids);
  }
}
