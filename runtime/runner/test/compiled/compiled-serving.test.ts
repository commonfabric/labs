import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import {
  type Artifact,
  Instance,
} from "../../../../base/pattern-compiler/exec/executor.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import { PatternCompileError } from "../../src/compiled/compile.deno.ts";
import {
  type CompiledServingMemoryServer,
  listenCompiledServingMemoryServer,
} from "../../src/compiled/serving-memory-server.deno.ts";
import type { ResumedPiece } from "../../src/compiled/resume.ts";
import {
  compiledPiecesOf,
  type PatternProgram,
} from "../../src/compiled/serving.ts";
import {
  argumentDocumentOf,
  compiledFailureOf,
  compiledPointerOf,
  setUpCompiledPiece,
} from "../../src/compiled/setup.ts";
import { compartmentEvaluator } from "../../src/compiled/value-code.ts";
import { getMetaLink } from "../../src/link-utils.ts";
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

/** The program of one file of `compare/fixtures/`. */
const programOf = async (name: string): Promise<PatternProgram> => ({
  main: `/${name}.tsx`,
  files: [{
    name: `/${name}.tsx`,
    contents: await Deno.readTextFile(
      new URL(
        `../../../../base/pattern-compiler/compare/fixtures/${name}.tsx`,
        import.meta.url,
      ),
    ),
  }],
});

/** The statement of the handler body of `fixtures/handler.tsx` that sets `last`. */
const SETS_LAST = "last.set(event.text + secret);";

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
  /** The programs the serving runtime had compiled. */
  let compiled: PatternProgram[];
  /** How many module texts of value code the serving runtime evaluated. */
  let evaluated: number;
  /** The pieces a serving runtime resumed from their basis. */
  let resumed: ResumedPiece[];

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
    compiled = [];
    evaluated = 0;
    resumed = [];
    const evaluate = compartmentEvaluator();
    serving = await listenCompiledServingMemoryServer({
      // The crate's binary is not run here. What stands in its place gives
      // the artifact the crate emitted for a fixture, and refuses a source
      // that names the host object of the value code, as the crate does.
      compile: async (program) => {
        compiled.push(program);
        const [{ contents }] = program.files;
        if (contents.includes("$h")) {
          throw new PatternCompileError("`$h` is not a listed name");
        }
        const main = await artifactOf(program.main.slice(1, -".tsx".length));
        // The handler of `fixtures/handler.tsx` stores what the name `Deno`
        // is to it, which nothing the crate emits reads.
        for (const module of main.code.modules) {
          module.source = module.source.replaceAll(
            SETS_LAST,
            "last.set(typeof Deno);",
          );
        }
        return { main, artifacts: () => undefined };
      },
      pieces: {
        piece: {
          evaluate: (module, parameters) => {
            evaluated += 1;
            return evaluate(module, parameters);
          },
        },
        resumed: (_result, piece) => resumed.push(piece),
      },
    });
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
    const program = await programOf("serving-list");
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
      setUpCompiledPiece(runtime, tx, program, { items }, result.withTx(tx));
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

  it("has the serving runtime read the documents of the piece from the store, where no policy says otherwise", async () => {
    const first = client();
    const { artifact, result } = await setUp(first, 3);

    await holds(first, reading(first, result), inMemory(artifact, 3, []));

    expect(serving.host.stats().storeReads).toBeGreaterThan(0);
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

  // `fixtures/relay.tsx`: the handler of `relay` counts its runs in
  // `relayed` and sends an event to the stream `bump`, whose handler adds
  // to `total`.
  describe("an event a handler sends to a stream of the piece", () => {
    type Relayed = { total: number; relayed: number };

    const setUpRelay = async (runtime: Runtime) => {
      const result = runtime.getCell<Relayed>(space, "relay");
      const program = await programOf("relay");
      await commit(runtime, (tx) => {
        setUpCompiledPiece(
          runtime,
          tx,
          program,
          { start: 1 },
          result.withTx(tx),
        );
      });
      const cell = runtime.getCellFromLink<Relayed>(
        result.getAsNormalizedFullLink(),
      );
      cancels.push(cell.sink(() => {}));
      return cell;
    };

    /**
     * The member `name` of the result, once the client holds the marker
     * of the stream it links to, by which a send to it is an event.
     */
    const stream = async (cell: Cell<Relayed>, name: string) => {
      await waitForCellValue<Record<string, unknown>>(
        clients[0],
        cell,
        (value) => value?.[name] !== undefined,
        { stuckLabel: `a client reads the member ${name}` },
      );
      const member = cell.key(name as never) as unknown as Cell<unknown>;
      await member.sync();
      await member.resolveAsCell().sync();
      return member;
    };

    /** Waits until `cell` holds `total` and `relayed`. */
    const counts = (
      runtime: Runtime,
      cell: Cell<Relayed>,
      total: number,
      relayed: number,
    ) =>
      waitForCellValue<Relayed>(
        runtime,
        cell,
        (value) =>
          (value?.total ?? 0) === total && (value?.relayed ?? 0) === relayed,
        { stuckLabel: `a client reads total ${total}, relayed ${relayed}` },
      );

    it("is handled behind the handler that sent it", async () => {
      const sender = client();
      const cell = await setUpRelay(sender);

      (await stream(cell, "relay")).send({ by: 3 });

      await counts(sender, cell, 3, 1);
      expect(serving.pieces()[0].counts.events).toBe(2);
      expect(serving.pieces()[0].refusals).toEqual([]);
    });

    it("is handled by the serving loop that takes the space over, where the loop before stopped between the commit of the handler that sent it and its handling", async () => {
      const sender = client();
      const cell = await setUpRelay(sender);
      const relay = await stream(cell, "relay");
      relay.send({ by: 3 });
      await counts(sender, cell, 3, 1);
      await serving.host.whenQuiescent();
      const [piece] = serving.pieces();
      const [runtime] = serving.runtimes();
      // The serving process handles nothing more for the stream `bump`
      // unless the event comes from a stored entry: the copy of a sent
      // event that the process holds for itself is lost with the process.
      const { queueEvent } = runtime.scheduler;
      const bump = (await stream(cell, "bump")).resolveAsCell()
        .getAsNormalizedFullLink().id;
      runtime.scheduler.queueEvent = (link, ...rest) => {
        const served = rest[4]?.served;
        if (link.id === bump && served?.streamEntry === undefined) return;
        return queueEvent.call(runtime.scheduler, link, ...rest);
      };
      // The commit of the wave that holds the second run of `relay` is the
      // last of this loop to reach the store.
      const stopped = serving.stopCommittingWhen(() =>
        piece.counts.events >= 3
      );

      relay.send({ by: 4 });
      await stopped;
      await serving.restart();
      // A client that connects to the serving process that started again.
      const late = client();
      const read = late.getCellFromLink<Relayed>(
        cell.getAsNormalizedFullLink(),
      );
      cancels.push(read.sink(() => {}));

      // `relay` ran twice and is not run again, and the event it sent in
      // its second run is handled once.
      await counts(late, read, 7, 2);
      await serving.host.whenQuiescent();
      expect((await counts(late, read, 7, 2)).relayed).toBe(2);
      expect(serving.pieces()[0].refusals).toEqual([]);
    });
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

    // The loop that took over started the piece from the storage, for the
    // first event it was handed.
    expect(serving.pieces().length).toBe(1);
    expect(serving.pieces()[0].counts.events).toBe(2);
    expect(serving.pieces()[0].refusals).toEqual([]);
  });

  it("evaluates nothing when another serving loop takes over a space whose piece is current, and starts the executor for the next event", async () => {
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
    await serving.host.whenQuiescent();
    expect(evaluated).toBe(1);

    await serving.restart();
    // The read of a client that holds nothing is the demand that has the
    // loop reach the piece.
    const reader = client();
    await holds(
      reader,
      reading(reader, result),
      inMemory(artifact, 3, EVENTS.slice(0, 2)),
    );
    await serving.host.whenQuiescent();

    expect(resumed.map(({ current }) => current)).toEqual([true]);
    expect(evaluated).toBe(1);
    expect(serving.pieces()).toEqual([]);

    streamOf(cell, EVENTS[2][0]).send(EVENTS[2][1]);
    await holds(sender, cell, inMemory(artifact, 3, EVENTS.slice(0, 3)));

    expect(evaluated).toBe(2);
    expect(serving.pieces().length).toBe(1);
  });

  it("starts the executor of a piece that was resumed current when a client changes an item", async () => {
    const sender = client();
    const { artifact, result } = await setUp(sender, 3);
    const cell = reading(sender, result);
    await holds(sender, cell, inMemory(artifact, 3, []));
    await serving.host.whenQuiescent();
    await serving.restart();
    const reader = client();
    const read = reading(reader, result);
    await holds(reader, read, inMemory(artifact, 3, []));
    await serving.host.whenQuiescent();
    expect(resumed.map(({ current }) => current)).toEqual([true]);
    expect(serving.pieces()).toEqual([]);

    const first = sender.getCell<Item>(space, "item 0");
    await first.sync();
    await commit(sender, (tx) => first.withTx(tx).key("title").set("first"));

    await holds(reader, read, {
      labels: ["first!", "t1!", "t2!"],
      events: 0,
    });
    expect(serving.pieces().length).toBe(1);
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

  /** The reason the serving runtime gave for not starting a piece. */
  const refusal = async (runtime: Runtime, result: Cell<unknown>) => {
    const cell = runtime.getCellFromLink<{ reason: string }>({
      space,
      id: compiledFailureOf(result.getAsNormalizedFullLink().id),
      path: [],
      scope: "space",
    });
    cancels.push(cell.sink(() => {}));
    const { reason } = await waitForCellValue<{ reason: string }>(
      runtime,
      cell,
      (value) => typeof value?.reason === "string",
      { stuckLabel: "a client reads why its piece did not start" },
    );
    return reason;
  };

  describe("the compiled pattern of a piece", () => {
    it("is compiled by the serving runtime from the source a client wrote, and its value code is evaluated in a compartment", async () => {
      const sender = client();
      const program = await programOf("handler");
      type Result = { last?: string; note: string; record?: unknown };
      const result = sender.getCell<Result>(space, "handler");
      await commit(sender, (tx) => {
        setUpCompiledPiece(
          sender,
          tx,
          program,
          { secret: "s", note: "n" },
          result.withTx(tx),
        );
      });
      const cell = sender.getCellFromLink<Result>(
        result.getAsNormalizedFullLink(),
      );
      cancels.push(cell.sink(() => {}));
      // The state cell `last` has no document until the handler writes it.
      await waitForCellValue<Result>(
        sender,
        cell,
        (value) => value?.note === "n" && value.record !== undefined,
        { stuckLabel: "a client reads the result of the load" },
      );

      (cell.key("record") as unknown as Cell<unknown>).send({
        text: "t",
        extra: "e",
      });

      const value = await waitForCellValue<Result>(
        sender,
        cell,
        (value) => typeof value?.last === "string",
        { stuckLabel: "a client reads what the handler stored" },
      );
      expect(value.last).toBe("undefined");
      expect(compiled).toEqual([program]);
      expect(evaluated).toBe(1);
    });

    it("names the argument document in the metadata of the result document, where a client finds it, and derives from what the client writes into it", async () => {
      const sender = client();
      const program = await programOf("handler");
      type Result = { note: string; record?: unknown };
      const result = sender.getCell<Result>(space, "handler");
      await commit(sender, (tx) => {
        setUpCompiledPiece(
          sender,
          tx,
          program,
          { secret: "s", note: "n" },
          result.withTx(tx),
        );
      });
      const cell = sender.getCellFromLink<Result>(
        result.getAsNormalizedFullLink(),
      );
      cancels.push(cell.sink(() => {}));
      await waitForCellValue<Result>(
        sender,
        cell,
        (value) => value?.note === "n",
        { stuckLabel: "a client reads the result of the load" },
      );

      const argument = getMetaLink(cell, "argument");
      expect(argument?.id).toBe(
        argumentDocumentOf(result.getAsNormalizedFullLink().id),
      );
      await commit(sender, (tx) => {
        sender.getCellFromLink<{ note: string }>(argument!, undefined, tx)
          .key("note").set("m");
      });

      const value = await waitForCellValue<Result>(
        sender,
        cell,
        (value) => value?.note === "m",
        { stuckLabel: "a client reads what the piece derived from its write" },
      );
      expect(value.note).toBe("m");
      expect(serving.pieces().length).toBe(1);
    });

    it("is not evaluated where a client wrote an artifact in the place of the source, and the client reads why", async () => {
      const sender = client();
      const artifact = await artifactOf("handler");
      const result = sender.getCell<{ last: string }>(space, "handler");
      const { id } = result.getAsNormalizedFullLink();
      const at = (entity: string) => ({
        space,
        id: entity as `${string}:${string}`,
        path: [],
        scope: "space" as const,
      });
      await commit(sender, (tx) => {
        tx.writeValueOrThrow(at("of:an artifact"), JSON.stringify(artifact));
        tx.writeValueOrThrow(at(compiledPointerOf(id)), {
          artifact: "of:an artifact",
        });
        tx.writeValueOrThrow(at(argumentDocumentOf(id)), {
          secret: "s",
          note: "n",
        });
      });
      cancels.push(
        sender.getCellFromLink(result.getAsNormalizedFullLink()).sink(() => {}),
      );

      const reason = await refusal(sender, result);

      expect(reason).toContain("names no source");
      expect(compiled).toEqual([]);
      expect(evaluated).toBe(0);
      expect(serving.pieces()).toEqual([]);
    });

    it("is not evaluated where the compiler refuses the source, and the client reads the diagnostics", async () => {
      const sender = client();
      const program = await programOf("handler");
      program.files[0].contents = program.files[0].contents.replace(
        SETS_LAST,
        "last.set(String($h));",
      );
      const result = sender.getCell<{ last: string }>(space, "handler");
      await commit(sender, (tx) => {
        setUpCompiledPiece(
          sender,
          tx,
          program,
          { secret: "s", note: "n" },
          result.withTx(tx),
        );
      });
      cancels.push(
        sender.getCellFromLink(result.getAsNormalizedFullLink()).sink(() => {}),
      );

      const reason = await refusal(sender, result);

      expect(reason).toContain("`$h` is not a listed name");
      expect(compiled).toEqual([program]);
      expect(evaluated).toBe(0);
      expect(serving.pieces()).toEqual([]);
    });
  });
});
