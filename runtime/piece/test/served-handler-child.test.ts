/**
 * A piece a handler starts on a serving runtime stays stored and stops running
 * once the handler's transaction commits, as if the server had restarted. A read
 * of a value it derives and an event sent to it bring it back.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
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
import { PiecesController } from "../src/ops/pieces-controller.ts";
import {
  confirmServedInstantiate,
  servedInstantiatePiece,
} from "../src/ops/served-lifecycle.ts";
import { sendVerbEvent } from "../src/verb-call.ts";

const serviceSigner = await Identity.fromPassphrase("served child service");
const aliceSigner = await Identity.fromPassphrase("served child alice");
const space = aliceSigner.did() as MemorySpace;

/** A list a verb adds a child to, each child with a verb and a derived value. */
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `/// <cts-enable />
import { computed, handler, NAME, pattern, Writable } from "commonfabric";

const rename = handler<{ name: string }, { title: Writable<string> }>(
  (event, state) => {
    state.title.set(event.name);
  },
);

const Child = pattern<{ title: Writable<string> }>(({ title }) => {
  const upper = computed(() => title.get().toUpperCase());
  return { [NAME]: "Child", title, upper, rename: rename({ title }) };
});

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
  const children = new Writable<unknown[]>([]).for("children");
  return { [NAME]: "Parent", children, addChild: addChild({ children }) };
});
`,
  }],
};

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

  beforeEach(async () => {
    serving = await startServingMemoryServer({
      apiUrl: new URL(import.meta.url),
      serviceIdentity: serviceSigner,
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      worker: false,
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
   * Makes a parent and has it add a child, and returns a client's cell for the
   * parent's list of children, which the client has not read.
   */
  const addChildUnread = async (
    pieces: PiecesController,
    title: string,
  ): Promise<Cell<unknown>> => {
    const { pieceId } = await host.runLifecycleVerb(space, {
      name: "instantiate",
      run: (runtime) =>
        servedInstantiatePiece(
          new PiecesController(session, runtime, { deferSpaceCellSync: true }),
          { source: { program: PROGRAM }, actingUser: aliceSigner.did() },
        ),
      confirm: (runtime, receipt) =>
        confirmServedInstantiate(runtime, space, receipt, aliceSigner.did()),
    });
    const parent = pieces.getResult(
      await pieces.getPieceCell(pieceId, { reconcile: false, start: false }),
    );
    addChildVerb = parent.key("addChild" as never)
      .asSchemaFromLinks() as Cell<unknown>;
    await send(addChildVerb, { title });
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
    // derives, and the title, which the handler wrote.

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
