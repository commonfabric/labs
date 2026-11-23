import type { Identity } from "@commonfabric/identity";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";

import type { Cell } from "../../src/cell.ts";
import { isPrimitiveCellLink } from "../../src/link-types.ts";
import { parseLink } from "../../src/link-utils.ts";
import type { Runtime } from "../../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
  StorageManager,
} from "../../src/storage/cache.deno.ts";

/** The storage a test of a compiled piece runs on. */
export type TestStorage = ReturnType<typeof StorageManager.emulate>;

/**
 * Whether the tests of a compiled piece run on a memory server reached over
 * a websocket of this process (`COMPILED_PIECE_STORAGE=socket`), in place of
 * the emulated storage, whose server shares the thread and the turn of its
 * client.
 */
export const overSocket = (): boolean =>
  Deno.env.get("COMPILED_PIECE_STORAGE") === "socket";

/**
 * Opens the storage of one test as `signer`. Over a socket, each call starts
 * a memory server of its own on an ephemeral localhost port, which the
 * returned manager closes behind itself.
 */
export const openStorage = (signer: Identity): TestStorage => {
  if (!overSocket()) return StorageManager.emulate({ as: signer });
  const server = StandaloneMemoryServer.start();
  const storageManager = StorageManager.open({
    as: signer,
    memoryHost: server.url,
  }) as TestStorage;
  const close = storageManager.close.bind(storageManager);
  storageManager.close = async () => {
    await close();
    await server.close();
  };
  return storageManager;
};

/** A memory server that several sessions of one test share. */
export type SharedStorage = {
  /** Opens a session of the server as `signer`. */
  open(signer: Identity): TestStorage;
  /** Closes the server, behind the sessions opened on it. */
  close(): Promise<void>;
};

/**
 * Starts a memory server for the sessions of one test: over a socket, one
 * that listens on an ephemeral localhost port, and otherwise one in this
 * thread that tells its sessions of a commit on the next turn.
 */
export const shareStorage = (): SharedStorage => {
  if (overSocket()) {
    const server = StandaloneMemoryServer.start();
    return {
      open: (signer) =>
        StorageManager.open({
          as: signer,
          memoryHost: server.url,
        }) as TestStorage,
      close: () => server.close(),
    };
  }
  const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
  return {
    open: (signer) =>
      EmulatedStorageManager.connectTo(server, { as: signer }) as TestStorage,
    close: () => server.close(),
  };
};

/**
 * What the storage holds at `path` of the entity of `cell`, with the link
 * to a list document followed (`CompiledPieceOptions.lists`): where the
 * path holds a link, what the document it names holds, and for a list in
 * chunks the members of the chunks in order. A path that holds no link is
 * returned as the storage has it, so the same read serves both layouts.
 * No link of a row or of a bucket is followed.
 */
export const storedList = (
  runtime: Runtime,
  cell: Cell<unknown>,
  path: string[],
): unknown => {
  const tx = runtime.edit();
  try {
    const base = cell.getAsNormalizedFullLink();
    const at = (link: unknown): unknown => {
      const { id, path } = parseLink(link as never);
      return tx.readValueOrThrow({ ...base, id: id!, path: [...(path ?? [])] });
    };
    const held = tx.readValueOrThrow({ ...base, path });
    if (!isPrimitiveCellLink(held)) return held;
    const list = at(held);
    if (
      !Array.isArray(list) || list.length === 0 ||
      !list.every((member) => isPrimitiveCellLink(member))
    ) return list;
    // A chunk is an array, and a row is a record or a view node.
    const members = list.map(at);
    return members.every((member) => Array.isArray(member))
      ? members.flat()
      : list;
  } finally {
    tx.abort();
  }
};

/**
 * The rows of a list as a client of the runtime reads them, `read`: a list
 * of more rows than one list document holds is read as an array of its
 * chunks, so the members of each member that is an array stand in its
 * place, one level deep (note 925 of `base/pattern-compiler/SPEC-NOTES.md`).
 * A row is a record or a view node, never an array.
 */
export const rowsRead = <T>(read: readonly unknown[] | undefined): T[] =>
  (read ?? []).flatMap((member) =>
    Array.isArray(member) ? member : [member]
  ) as T[];

/**
 * The cell of the row at `at` of the list that `list` reads, through the
 * chunk that holds it where the list is read as an array of chunks
 * (`rowsRead`).
 */
export const rowCell = <T>(list: Cell<unknown>, at: number): Cell<T> => {
  const read = list.get() as unknown[] | undefined;
  // deno-lint-ignore no-explicit-any
  const cell = list as Cell<any>;
  if (!Array.isArray(read) || !read.every((member) => Array.isArray(member))) {
    return cell.key(at);
  }
  let offset = at;
  for (const [index, chunk] of read.entries()) {
    const { length } = chunk as unknown[];
    if (offset < length) return cell.key(index).key(offset);
    offset -= length;
  }
  return cell.key(at);
};
