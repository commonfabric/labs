/**
 * A piece a handler starts on a serving runtime stays stored and stops running
 * once the handler's transaction commits, as if the server had restarted. A read
 * of a value it derives and an event sent to it bring it back.
 */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { createSession, Identity, type Session } from "@commonfabric/identity";
import type { DID, MemorySpace } from "@commonfabric/memory/interface";
import {
  type Cell,
  type NormalizedFullLink,
  pullFromServer,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import type { ExecutorHost } from "@commonfabric/runner/executor/host";
import {
  type ServingMemoryServer,
  startServingMemoryServer,
} from "@commonfabric/runner/executor/serving-memory-server.deno";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";
import { withStuckNet } from "@commonfabric/test-support/stuck-net";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import {
  confirmServedInstantiate,
  servedInstantiatePiece,
} from "../src/ops/served-lifecycle.ts";
import { sendVerbEvent } from "../src/verb-call.ts";

const serviceSigner = await Identity.fromPassphrase("served child service");
const aliceSigner = await Identity.fromPassphrase("served child alice");
const space = aliceSigner.did() as MemorySpace;

/**
 * A list a verb adds a child to, each child with a verb and the values it
 * derives, which `child` declares: the pattern `Child` given its `title`. The
 * parent has a derivation of its own over each child's `upper`.
 */
const programWith = (child: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `/// <cts-enable />
import {
  computed,
  fetchJson,
  handler,
  NAME,
  pattern,
  Writable,
} from "commonfabric";

const rename = handler<{ name: string }, { title: Writable<string> }>(
  (event, state) => {
    state.title.set(event.name);
  },
);

${child}

const addChild = handler<
  { title: string },
  { children: Writable<unknown[]> },
  { child: { upper: string } }
>((event, state) => {
  const title = new Writable<string>(event.title).for("title");
  const child = Child({ title });
  state.children.push(child);
  return { child };
});

export default pattern<{ seed?: string }>(() => {
  const children = new Writable<{ upper?: string }[]>([]).for("children");
  const uppers = computed(() =>
    children.get().map((child) => child?.upper ?? "")
  );
  return {
    [NAME]: "Parent",
    children,
    uppers,
    addChild: addChild({ children }),
  };
});
`,
  }],
});

/** Each child derives `upper` from its title. */
const PROGRAM = programWith(`
const Child = pattern<{ title: Writable<string> }>(({ title }) => {
  const upper = computed(() => title.get().toUpperCase());
  return { [NAME]: "Child", title, upper, rename: rename({ title }) };
});
`);

/** Each child derives `greeting` from what a fetch answers, as well. */
const FETCHING_PROGRAM = programWith(`
const Child = pattern<{ title: Writable<string> }>(({ title }) => {
  const upper = computed(() => title.get().toUpperCase());
  const fetched = fetchJson<{ greeting: string }>({
    url: "https://example.test/greeting",
  });
  const greeting = computed(() => fetched.result?.greeting);
  return { [NAME]: "Child", title, upper, greeting, rename: rename({ title }) };
});
`);

/** What the stub fetch the serving runtime makes answers. */
const GREETING = { greeting: "hello" };

/** What a client reads of a child. */
const CHILD_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    upper: { type: "string" },
    rename: { asCell: ["stream"] },
  },
} as const;

describe("served-handler-child", () => {
  let serving: ServingMemoryServer;
  let host: ExecutorHost;
  let session: Session;
  let cleanups: Array<() => Promise<void>>;

  /** The verb of the parent the test's {@link addChildOnServer} last made. */
  let addChildVerb: Cell<unknown> | undefined;

  /** What the stub fetch waits for before it answers. */
  let fetchAnswers: Promise<void>;

  /** Resolved once the serving runtime has asked the stub fetch. */
  let fetchAsked: PromiseWithResolvers<void>;

  beforeEach(async () => {
    fetchAnswers = Promise.resolve();
    fetchAsked = Promise.withResolvers<void>();
    serving = await startServingMemoryServer({
      apiUrl: new URL(import.meta.url),
      serviceIdentity: serviceSigner,
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      worker: false,
      fetch: async () => {
        fetchAsked.resolve();
        await fetchAnswers;
        return new Response(JSON.stringify(GREETING), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    host = serving.host.host!;
    session = createSession({
      identity: serviceSigner,
      spaceDid: space as DID,
    });
    cleanups = [];
  });

  afterEach(async () => {
    await host.close();
    for (const cleanup of cleanups.reverse()) await cleanup();
    await serving.close();
  });

  const clientPieces = async (): Promise<PiecesController> => {
    const manager = EmulatedStorageManager.connectTo(serving.server, {
      as: aliceSigner,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    cleanups.push(async () => {
      await runtime.dispose();
      await manager.close();
    });
    const pieces = new PiecesController(session, runtime, {
      deferSpaceCellSync: true,
    });
    await pieces.ready;
    return pieces;
  };

  const send = async (stream: Cell<unknown>, event: unknown): Promise<void> => {
    const sent = await sendVerbEvent(stream, event, {
      invocation: { id: crypto.randomUUID(), session: "test-session" },
      echo: false,
    });
    if (sent.status !== "committed") {
      throw new Error(`The send failed: ${sent.error.message}`);
    }
    expect(await sent.handled()).toEqual({ status: "handled" });
  };

  /**
   * Makes a parent of `program` and returns a client's cell for it, which the
   * client has not read. Its verb is the one {@link addSecondChild} sends to.
   */
  const makeParent = async (
    pieces: PiecesController,
    program: RuntimeProgram = PROGRAM,
  ): Promise<Cell<unknown>> => {
    const { pieceId } = await host.runLifecycleVerb(space, {
      name: "instantiate",
      run: (runtime) =>
        servedInstantiatePiece(
          new PiecesController(session, runtime, { deferSpaceCellSync: true }),
          { source: { program }, actingUser: aliceSigner.did() },
        ),
      confirm: (runtime, receipt) =>
        confirmServedInstantiate(runtime, space, receipt, aliceSigner.did()),
    });
    const parent = pieces.getResult(
      await pieces.getPieceCell(pieceId, { reconcile: false, start: false }),
    );
    addChildVerb = parent.key("addChild" as never)
      .asSchemaFromLinks() as Cell<unknown>;
    return parent as Cell<unknown>;
  };

  /**
   * Makes a parent of `program` and has it add a child, and returns a client's
   * cell for the parent's list of children, which the client has not read.
   */
  const addChildUnread = async (
    pieces: PiecesController,
    title: string,
    program: RuntimeProgram = PROGRAM,
  ): Promise<Cell<unknown>> => {
    const parent = await makeParent(pieces, program);
    await send(addChildVerb!, { title });
    return parent.key("children" as never) as Cell<unknown>;
  };

  /** Makes a parent, has it add a child, and returns a client's cell for it. */
  const addChildOnServer = async (
    pieces: PiecesController,
    title: string,
  ): Promise<Cell<any>> => {
    const children = await addChildUnread(pieces, title);
    expect(await pullFromServer(pieces.runtime, children)).toBe(true);
    return (children as Cell<any>).key(0).resolveAsCell().asSchema(
      CHILD_SCHEMA,
    );
  };

  /** Has the parent {@link addChildOnServer} made add another child. */
  const addSecondChild = (): Promise<void> =>
    send(addChildVerb!, { title: "another" });

  const runningOnServer = (link: NormalizedFullLink): Promise<boolean> =>
    host.runLifecycleVerb(space, {
      name: "inspect",
      run: (runtime) =>
        Promise.resolve(
          runtime.runner.isRunning(runtime.getCellFromLink(link)),
        ),
    });

  it("stops running once the handler's transaction commits", async () => {
    // A client's read of the list can demand the child, so the serving runtime
    // reads the link to it here, before any client reads the list.
    const pieces = await clientPieces();
    const children = await addChildUnread(pieces, "first");

    const onServer = await host.runLifecycleVerb(space, {
      name: "inspect",
      run: async (runtime) => {
        const list = runtime.getCellFromLink(
          children.getAsNormalizedFullLink(),
        ) as Cell<any>;
        await list.sync();
        const child = list.key(0).resolveAsCell();
        return {
          id: child.getAsNormalizedFullLink().id,
          running: runtime.runner.isRunning(child),
        };
      },
    });
    expect(onServer.running).toBe(false);

    // What the serving runtime inspected is the child a client reads.
    expect(await pullFromServer(pieces.runtime, children)).toBe(true);
    const child = (children as Cell<any>).key(0).resolveAsCell();
    expect(onServer.id).toBe(child.getAsNormalizedFullLink().id);
  });

  describe("after a client reads the list that links to it", () => {
    // A link to the child names its result document, which a read of the list
    // is sent whatever its schema. A read of each child's title is sent the
    // child's argument too, which holds an input rather than a value the child
    // derives, and the title, which the handler wrote. A read of the value each
    // child derives is sent the child's `computed:` document, which holds no
    // value until the child runs.

    /** A read of each child's derived value. */
    const UPPER_LIST_SCHEMA = {
      type: "array",
      items: { type: "object", properties: { upper: { type: "string" } } },
    } as const;

    /**
     * Reads `children` under `schema`, and returns what the read found of the
     * child and whether the child then runs.
     */
    const runsAfterReading = async (
      schema: Record<string, unknown> | undefined,
    ): Promise<{ running: boolean; read: unknown }> => {
      const pieces = await clientPieces();
      const children = await addChildUnread(pieces, "first");
      const list =
        (schema === undefined
          ? children
          : children.asSchema(schema as never)) as Cell<any>;
      expect(await pullFromServer(pieces.runtime, list)).toBe(true);
      const read = list.get()?.[0];
      const child = (children as Cell<any>).key(0).resolveAsCell();
      const running = await runningOnServer(child.getAsNormalizedFullLink());
      return { running, read };
    };

    it("leaves the child stopped for a read with no schema of its own", async () => {
      const { running } = await runsAfterReading(undefined);
      expect(running).toBe(false);
    });

    it("leaves the child stopped for a read of each child's title", async () => {
      const { running, read } = await runsAfterReading({
        type: "array",
        items: { type: "object", properties: { title: { type: "string" } } },
      });
      expect(read).toEqual({ title: "first" });
      expect(running).toBe(false);
    });

    it("derives for a view read the value each child derives, and stops the child again", async () => {
      // The child runs until it has written what the read reached, which the
      // store then serves as it serves any value a stopped piece wrote.

      const pieces = await clientPieces();
      const children = await addChildUnread(pieces, "first");
      const list = children.asSchema(UPPER_LIST_SCHEMA) as Cell<any>;
      expect(await pullFromServer(pieces.runtime, list)).toBe(true);

      expect(list.get()?.[0]).toEqual({ upper: "FIRST" });
      await host.whenQuiescent();
      const child = (children as Cell<any>).key(0).resolveAsCell();
      expect(await runningOnServer(child.getAsNormalizedFullLink())).toBe(
        false,
      );
    });

    it("pushes a tracked read of the list the value each child derives, and stops the child again", async () => {
      // A watch rather than a view: the sync answers with the document the
      // child left unwritten, and the value arrives once the child that read
      // starts has derived it. The watch goes on tracking the document, and
      // the child stops all the same. The serving loop's timers keep the
      // process from going quiet, so the wait carries a stuck net.

      const pieces = await clientPieces();
      const children = await addChildUnread(pieces, "first");
      const list = children.asSchema(UPPER_LIST_SCHEMA) as Cell<any>;
      const derived = Promise.withResolvers<void>();
      const cancel = list.sink((value: any) => {
        if (value?.[0]?.upper === "FIRST") derived.resolve();
      });
      await list.sync();
      await withStuckNet(
        derived.promise,
        "the value the child derives for the tracked read",
      );

      expect(list.get()?.[0]).toEqual({ upper: "FIRST" });
      await host.whenQuiescent();
      const child = (children as Cell<any>).key(0).resolveAsCell();
      expect(await runningOnServer(child.getAsNormalizedFullLink())).toBe(
        false,
      );
      cancel();
    });

    it("loads no root for a read of the value a running child has not derived", async () => {
      // A child a client demands at the commit keeps running, with its value
      // not yet derived. A node of the child writes the document, so the read's
      // demand of it has that node derive it, and the demand pass has no piece
      // to start.

      const pieces = await clientPieces();
      const demanded = await host.runLifecycleVerb(space, {
        name: "stub demand",
        run: (runtime) =>
          Promise.resolve(
            stub(runtime.scheduler, "pieceHasDemandedWriter", () => true),
          ),
      });
      let children: Cell<unknown>;
      try {
        children = await addChildUnread(pieces, "first");
      } finally {
        demanded.restore();
      }
      // Read on the serving runtime: a client resolving the child's value
      // would watch its document as a root of its own.
      const { child, upperId } = await host.runLifecycleVerb(space, {
        name: "inspect",
        run: async (runtime) => {
          const list = runtime.getCellFromLink(
            children.getAsNormalizedFullLink(),
          ) as Cell<any>;
          await list.sync();
          const child = list.key(0).resolveAsCell();
          await child.sync();
          return {
            child: child.getAsNormalizedFullLink(),
            upperId: child.key("upper").resolveAsCell()
              .getAsNormalizedFullLink().id,
          };
        },
      });
      expect(await runningOnServer(child)).toBe(true);
      expect((await serving.server.readDocument(space, upperId))?.value)
        .toBeUndefined();

      const list = children.asSchema(UPPER_LIST_SCHEMA) as Cell<any>;
      const derived = Promise.withResolvers<void>();
      const cancel = list.sink((value: any) => {
        if (value?.[0]?.upper === "FIRST") derived.resolve();
      });
      await list.sync();
      await withStuckNet(
        derived.promise,
        "the value the running child derives for the read",
      );

      expect(
        host.spaceServer(space)!.accessForTestingOnly.demandedRootIds.has(
          upperId,
        ),
      ).toBe(false);
      cancel();
    });

    it("keeps the child running for a read until its fetch answers, and stops it then", async () => {
      // The value the read reaches derives from a fetch, which the runtime's
      // idle does not wait for. Stopped before it answers, the child would
      // drop the fetch and leave the read with nothing.

      const answer = Promise.withResolvers<void>();
      fetchAnswers = answer.promise;
      const released = Promise.withResolvers<void>();
      const releases = await host.runLifecycleVerb(space, {
        name: "observe releases",
        run: (runtime) => {
          const release = runtime.runner.releaseReadStart.bind(
            runtime.runner,
          );
          return Promise.resolve(
            stub(runtime.runner, "releaseReadStart", (cell: Cell<unknown>) => {
              const stopped = release(cell);
              if (stopped) released.resolve();
              return stopped;
            }),
          );
        },
      });
      try {
        const pieces = await clientPieces();
        const children = await addChildUnread(
          pieces,
          "first",
          FETCHING_PROGRAM,
        );
        const list = children.asSchema({
          type: "array",
          items: {
            type: "object",
            properties: { greeting: { type: "string" } },
          },
        } as never) as Cell<any>;
        const answered = Promise.withResolvers<void>();
        const cancel = list.sink((value: any) => {
          if (value?.[0]?.greeting === GREETING.greeting) answered.resolve();
        });
        await list.sync();
        await withStuckNet(fetchAsked.promise, "the child's fetch");
        await host.runLifecycleVerb(space, {
          name: "idle",
          run: (runtime) => runtime.idle(),
        });
        const child = (children as Cell<any>).key(0).resolveAsCell()
          .getAsNormalizedFullLink();
        expect(await runningOnServer(child)).toBe(true);

        answer.resolve();
        await withStuckNet(answered.promise, "the greeting the fetch answers");
        await withStuckNet(released.promise, "the child's release");

        expect(list.get()?.[0]).toEqual(GREETING);
        expect(await runningOnServer(child)).toBe(false);
        cancel();
      } finally {
        releases.restore();
      }
    });

    it("leaves the child stopped for a read of the value it derived before it stopped", async () => {
      // The store holds what the child derived, which the read is sent as it
      // stands, as it is for any value a stopped piece wrote. The serving
      // runtime derives it here, so that no client demand on the child is left
      // to start it again.

      const pieces = await clientPieces();
      const children = await addChildUnread(pieces, "first");
      const listLink = children.getAsNormalizedFullLink();
      const { child, stopDeriving } = await host.runLifecycleVerb(space, {
        name: "derive",
        run: async (runtime) => {
          const list = runtime.getCellFromLink(listLink) as Cell<any>;
          await list.sync();
          const child = list.key(0).resolveAsCell();
          await runtime.start(child);
          const cancel = child.key("upper").sink(() => {});
          return {
            child: child.getAsNormalizedFullLink(),
            stopDeriving: () => {
              cancel();
              runtime.runner.stop(child);
            },
          };
        },
      });
      await host.whenQuiescent();
      await host.runLifecycleVerb(space, {
        name: "stop",
        run: () => Promise.resolve(stopDeriving()),
      });
      expect(await runningOnServer(child)).toBe(false);

      const list = children.asSchema(UPPER_LIST_SCHEMA) as Cell<any>;
      expect(await pullFromServer(pieces.runtime, list)).toBe(true);

      expect(list.get()?.[0]).toEqual({ upper: "FIRST" });
      expect(await runningOnServer(child)).toBe(false);
    });
  });

  it("runs again once a client tracks a value it derives", async () => {
    const pieces = await clientPieces();
    const child = await addChildOnServer(pieces, "first");
    const upper = child.key("upper") as Cell<unknown>;
    const cancel = upper.sink(() => {});
    expect(await pullFromServer(pieces.runtime, upper)).toBe(true);
    expect(upper.get()).toBe("FIRST");

    expect(await runningOnServer(child.getAsNormalizedFullLink())).toBe(true);
    cancel();
  });

  it("keeps running when a client demands its document at the commit", async () => {
    const pieces = await clientPieces();
    const demanded = await host.runLifecycleVerb(space, {
      name: "stub demand",
      run: (runtime) =>
        Promise.resolve(
          stub(runtime.scheduler, "isDemandedEntity", () => true),
        ),
    });
    try {
      const child = await addChildOnServer(pieces, "first");

      expect(await runningOnServer(child.getAsNormalizedFullLink())).toBe(true);
    } finally {
      demanded.restore();
    }
  });

  it("keeps running when a client demands what its nodes write at the commit", async () => {
    const pieces = await clientPieces();
    const demanded = await host.runLifecycleVerb(space, {
      name: "stub demand",
      run: (runtime) =>
        Promise.resolve(
          stub(runtime.scheduler, "pieceHasDemandedWriter", () => true),
        ),
    });
    try {
      const child = await addChildOnServer(pieces, "first");

      expect(await runningOnServer(child.getAsNormalizedFullLink())).toBe(true);
    } finally {
      demanded.restore();
    }
  });

  it("names a demanded writer once a client tracks a value it derives", async () => {
    // The two tests above stub the demand, because a client cannot name a child's
    // document before the handler that creates it has committed. This one is the
    // real client demand those stubs stand in for.
    const pieces = await clientPieces();
    const child = await addChildOnServer(pieces, "first");
    const { id } = child.getAsNormalizedFullLink();
    const hasDemandedWriter = () =>
      host.runLifecycleVerb(space, {
        name: "inspect demand",
        run: (runtime) =>
          Promise.resolve(
            runtime.scheduler.pieceHasDemandedWriter(space, id),
          ),
      });
    expect(await hasDemandedWriter()).toBe(false);

    const upper = child.key("upper") as Cell<unknown>;
    const cancel = upper.sink(() => {});
    expect(await pullFromServer(pieces.runtime, upper)).toBe(true);

    expect(await hasDemandedWriter()).toBe(true);
    cancel();
  });

  it("asks for the documents nothing reads to be released once the transaction commits", async () => {
    // The release pass is what lets go of the watches a stopped piece's
    // documents were loaded under; a stop requests one, and so must this.
    const pieces = await clientPieces();
    const releases = await host.runLifecycleVerb(space, {
      name: "stub release",
      run: (runtime) =>
        Promise.resolve(
          stub(runtime, "releaseUnreadDocuments", () => Promise.resolve()),
        ),
    });
    try {
      await addChildOnServer(pieces, "first");

      expect(releases.calls.length).toBeGreaterThan(0);
    } finally {
      releases.restore();
    }
  });

  it("indexes no pattern per event once the transaction commits", async () => {
    const pieces = await clientPieces();
    await addChildOnServer(pieces, "first");
    const indexedModules = () =>
      host.runLifecycleVerb(space, {
        name: "count modules",
        run: (runtime) =>
          Promise.resolve(runtime.getSizes().patterns.indexedModules),
      });
    const before = await indexedModules();

    await addSecondChild();

    expect(await indexedModules()).toBe(before);
  });

  it("holds no more node bindings as children are added", async () => {
    const pieces = await clientPieces();
    await addChildOnServer(pieces, "first");
    const heldNodeBindings = () =>
      host.runLifecycleVerb(space, {
        name: "count bindings",
        run: (runtime) =>
          Promise.resolve(
            runtime.runner.accessForTestingOnly.heldNodeBindings,
          ),
      });
    const before = await heldNodeBindings();

    await addSecondChild();

    expect(await heldNodeBindings()).toBe(before);
  });

  it("keeps what the handler stored", async () => {
    const pieces = await clientPieces();
    const child = await addChildOnServer(pieces, "first");

    const title = child.key("title") as Cell<unknown>;
    await title.sync();
    expect(title.get()).toBe("first");
  });

  it("derives a value for a read", async () => {
    const pieces = await clientPieces();
    const child = await addChildOnServer(pieces, "first");

    const upper = child.key("upper") as Cell<unknown>;
    expect(await pullFromServer(pieces.runtime, upper)).toBe(true);
    expect(upper.get()).toBe("FIRST");
  });

  it("gives a demanded derivation of the parent the value a new child derives", async () => {
    // A Topics board's index reads what each topic derives. The parent's
    // derivation is demanded before the child exists, and reruns once the
    // handler adds one. If the child stops before that rerun reads its value,
    // nothing has written the value and nothing starts the child to write it.
    const pieces = await clientPieces();
    const parent = await makeParent(pieces);
    const uppers = (parent.key("uppers" as never) as Cell<unknown>).asSchema(
      { type: "array", items: { type: "string" } } as const,
    );
    const cancel = uppers.sink(() => {});
    expect(await pullFromServer(pieces.runtime, uppers)).toBe(true);
    expect(uppers.get()).toEqual([]);

    await send(addChildVerb!, { title: "first" });

    expect(await pullFromServer(pieces.runtime, uppers)).toBe(true);
    expect(uppers.get()).toEqual(["FIRST"]);
    cancel();
  });

  it("handles an event, and a read then sees what it changed", async () => {
    const pieces = await clientPieces();
    const child = await addChildOnServer(pieces, "first");

    await send(child.key("rename"), { name: "second" });

    const upper = child.key("upper") as Cell<unknown>;
    expect(await pullFromServer(pieces.runtime, upper)).toBe(true);
    expect(upper.get()).toBe("SECOND");
  });

  it("derives a value again after what it read changes", async () => {
    const pieces = await clientPieces();
    const child = await addChildOnServer(pieces, "first");
    const reader = child.key("upper") as Cell<unknown>;
    expect(await pullFromServer(pieces.runtime, reader)).toBe(true);
    expect(reader.get()).toBe("FIRST");

    await send(child.key("rename"), { name: "second" });

    const fresh = await clientPieces();
    const upper = fresh.runtime.getCellFromLink(
      child.key("upper").getAsNormalizedFullLink(),
    ) as Cell<unknown>;
    expect(await pullFromServer(fresh.runtime, upper)).toBe(true);
    expect(upper.get()).toBe("SECOND");
  });
});
