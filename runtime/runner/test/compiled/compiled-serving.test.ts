import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import {
  type Artifact,
  Instance,
} from "../../../../base/pattern-compiler/exec/executor.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import {
  type CompiledServingMemoryServer,
  listenCompiledServingMemoryServer,
} from "../../src/compiled/serving-memory-server.deno.ts";
import { compiledPiecesOf } from "../../src/compiled/serving.ts";
import { setUpCompiledPiece } from "../../src/compiled/setup.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        `../../../../base/pattern-compiler/compare/fixtures/${name}.emit.json`,
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

type Item = { id: string; title: string; done: boolean };
type Row = { label: string; done: boolean };
type List = { rows: Row[]; events: number };

const item = (index: number): Item => ({
  id: `i${index}`,
  title: `t${index}`,
  done: false,
});

/** The events of the tests, in the order the serving loop handles them. */
const EVENTS: [string, unknown][] = [
  ["rename", { at: 1, title: "renamed" }],
  ["add", { id: "new", title: "added" }],
  ["rename", { at: 3, title: "again" }],
  ["add", { id: "last", title: "last" }],
];

/**
 * What the executor with its documents in memory holds of
 * `fixtures/serving-list.tsx` over `count` items after `events`.
 */
const inMemory = (
  artifact: Artifact,
  count: number,
  events: [string, unknown][],
): { labels: string[]; events: number } => {
  const link = (doc: string) => ({ $link: { doc, path: [] } });
  const items = Array.from({ length: count }, (_, index) => ({
    id: `item ${index}`,
    kind: "item",
    value: item(index),
  }));
  const instance = new Instance(artifact, { items: link("items") }, {
    documents: [...items, {
      id: "items",
      kind: "items",
      value: items.map(({ id }) => link(id)),
    }],
  });
  for (const [name, event] of events) {
    const stream = instance.streams().find(({ path }) =>
      path.length === 1 && path[0] === name
    );
    instance.send(stream!.binding, event);
  }
  const result = instance.result() as List;
  return {
    labels: result.rows.map(({ label }) => label),
    events: result.events,
  };
};

describe("a compiled piece under the serving loop", () => {
  let signer: Identity;
  let space: MemorySpace;
  let serving: CompiledServingMemoryServer;
  let clients: Runtime[];
  let cancels: (() => void)[];

  /**
   * A client of the serving memory server, over its websocket, with server
   * execution on: it runs no handler and no derivation of the piece.
   */
  const client = (): Runtime => {
    const runtime = new Runtime({
      apiUrl: serving.url,
      storageManager: StorageManager.open({
        as: signer,
        memoryHost: serving.url,
      }),
      experimental: { serverExecution: true },
    });
    clients.push(runtime);
    return runtime;
  };

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("compiled piece serving");
    space = signer.did();
    serving = await listenCompiledServingMemoryServer();
    clients = [];
    cancels = [];
  });

  afterEach(async () => {
    for (const cancel of cancels) cancel();
    await serving.host.close();
    for (const runtime of clients) await runtime.dispose();
    await serving.close();
  });

  /** Commits what `write` writes in `runtime`. */
  const commit = async (
    runtime: Runtime,
    write: (tx: ReturnType<Runtime["edit"]>) => void,
  ) => {
    const tx = runtime.edit();
    write(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  /**
   * Sets `fixtures/serving-list.tsx` up from `runtime` over `count` items,
   * each a document of its own, and returns the result cell.
   */
  const setUp = async (runtime: Runtime, count: number) => {
    const artifact = await artifactOf("serving-list");
    const items = runtime.getCell<Item[]>(space, "items");
    await commit(runtime, (tx) => {
      const members = Array.from({ length: count }, (_, index) => {
        const member = runtime.getCell<Item>(
          space,
          `item ${index}`,
          undefined,
          tx,
        );
        member.set(item(index));
        return member;
      });
      items.withTx(tx).set(members as never);
    });
    const result = runtime.getCell<List>(space, "list");
    await commit(runtime, (tx) => {
      setUpCompiledPiece(runtime, tx, artifact, { items }, result.withTx(tx));
    });
    return { artifact, result };
  };

  /** The result cell of the piece as `runtime` reads it, kept in sync. */
  const reading = (runtime: Runtime, result: Cell<List>): Cell<List> => {
    const cell = runtime.getCellFromLink<List>(
      result.getAsNormalizedFullLink(),
    );
    cancels.push(cell.sink(() => {}));
    return cell;
  };

  /** The member of the result that links to the stream `name`. */
  const streamOf = (cell: Cell<List>, name: string): Cell<unknown> =>
    cell.key(name as never) as unknown as Cell<unknown>;

  /**
   * Waits until `cell` holds rows with `labels` and `events` events. A
   * state cell that nothing wrote has no document, so a client reads
   * nothing where the executor reads the default of the cell's schema.
   */
  const holds = (
    runtime: Runtime,
    cell: Cell<List>,
    expected: { labels: string[]; events: number },
  ) =>
    waitForCellValue<List>(
      runtime,
      cell,
      (value) =>
        (value?.events ?? 0) === expected.events &&
        JSON.stringify(value?.rows?.map((row) => row?.label)) ===
          JSON.stringify(expected.labels),
      { stuckLabel: `a client reads ${JSON.stringify(expected)}` },
    );

  it("derives a piece that a client set up, which the client reads through sync", async () => {
    const first = client();
    const { artifact, result } = await setUp(first, 3);

    const value = await holds(
      first,
      reading(first, result),
      inMemory(artifact, 3, []),
    );

    expect(value.rows.map(({ label }) => label)).toEqual(["t0!", "t1!", "t2!"]);
    expect(compiledPiecesOf(first)).toEqual([]);
  });

  it("handles the events two clients send, and both converge on what the executor in memory gives for the same order of events", async () => {
    const first = client();
    const second = client();
    const { artifact, result } = await setUp(first, 3);
    const cells = [reading(first, result), reading(second, result)];
    const senders = [first, second];
    await holds(second, cells[1], inMemory(artifact, 3, []));

    for (const [index, [name, event]] of EVENTS.entries()) {
      // The clients take turns, and each sends when it has read what the
      // event before gave, so the serving loop handles the events in the
      // order of `EVENTS`.
      const at = index % 2;
      await holds(
        senders[at],
        cells[at],
        inMemory(artifact, 3, EVENTS.slice(0, index)),
      );
      streamOf(cells[at], name).send(event);
    }

    const expected = inMemory(artifact, 3, EVENTS);
    expect(expected.labels).toEqual([
      "t0!",
      "renamed!",
      "t2!",
      "again!",
      "last!",
    ]);
    for (const at of [0, 1]) await holds(senders[at], cells[at], expected);
    // Neither client ran the piece: the serving runtime alone did.
    expect(compiledPiecesOf(first)).toEqual([]);
    expect(compiledPiecesOf(second)).toEqual([]);
    expect(serving.pieces().length).toBe(1);
    expect(serving.pieces()[0].counts.events).toBe(EVENTS.length);
    expect(serving.pieces()[0].refusals).toEqual([]);
  });

  it("goes on from what the storage holds when another serving loop takes the space over", async () => {
    const sender = client();
    const { artifact, result } = await setUp(sender, 3);
    const cell = reading(sender, result);
    await holds(sender, cell, inMemory(artifact, 3, []));
    for (const [index, [name, event]] of EVENTS.slice(0, 2).entries()) {
      streamOf(cell, name).send(event);
      await holds(
        sender,
        cell,
        inMemory(artifact, 3, EVENTS.slice(0, index + 1)),
      );
    }

    await serving.restart();
    for (const [index, [name, event]] of EVENTS.slice(2).entries()) {
      streamOf(cell, name).send(event);
      await holds(
        sender,
        cell,
        inMemory(artifact, 3, EVENTS.slice(0, index + 3)),
      );
    }

    // The loop that took over started the piece from the storage. The
    // memory server keeps the sequence numbers of the session of the loop
    // before, so it rejects the first waves of this one as replays, and
    // each event of a rejected wave is handled again.
    expect(serving.pieces().length).toBe(1);
    expect(serving.pieces()[0].counts.events).toBeGreaterThanOrEqual(2);
  });

  it("handles an event again from what the storage holds when the wave that held it is rejected", async () => {
    const sender = client();
    const { artifact, result } = await setUp(sender, 3);
    const cell = reading(sender, result);
    await holds(sender, cell, inMemory(artifact, 3, []));

    serving.rejectNextWave();
    streamOf(cell, "add").send(EVENTS[1][1]);

    // The handler ran twice, and the second run counted from what the
    // storage holds: one event, and one item added.
    const value = await holds(
      sender,
      cell,
      inMemory(artifact, 3, [EVENTS[1]]),
    );
    expect(value.events).toBe(1);
    const [piece] = serving.pieces();
    expect(piece.counts.events).toBe(2);
    expect(piece.refusals.length).toBeGreaterThan(0);
  });

  it("gives a client that sends nothing the result of the events another client sent", async () => {
    const sender = client();
    const { artifact, result } = await setUp(sender, 3);
    const sent = reading(sender, result);
    await holds(sender, sent, inMemory(artifact, 3, []));
    streamOf(sent, "rename").send(EVENTS[0][1]);
    await holds(sender, sent, inMemory(artifact, 3, EVENTS.slice(0, 1)));

    const reader = client();
    const value = await holds(
      reader,
      reading(reader, result),
      inMemory(artifact, 3, EVENTS.slice(0, 1)),
    );

    expect(value.rows.map(({ label }) => label)).toEqual([
      "t0!",
      "renamed!",
      "t2!",
    ]);
    expect(compiledPiecesOf(reader)).toEqual([]);
  });
});
