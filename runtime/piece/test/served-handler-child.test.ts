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

  /** Makes a parent, has it add a child, and returns a client's cell for it. */
  const addChildOnServer = async (
    pieces: PiecesController,
    title: string,
  ): Promise<Cell<any>> => {
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
    const children = parent.key("children" as never) as Cell<unknown>;
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
    const pieces = await clientPieces();
    const child = await addChildOnServer(pieces, "first");

    expect(await runningOnServer(child.getAsNormalizedFullLink())).toBe(false);
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

  it("indexes no pattern per event once the transaction commits", async () => {
    const pieces = await clientPieces();
    const child = await addChildOnServer(pieces, "first");
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
