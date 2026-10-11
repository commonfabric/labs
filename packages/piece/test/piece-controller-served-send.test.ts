// A stream send through `PieceController.set()` under server execution: the
// call returns with the event committed and the serving runtime's run of the
// handler still ahead, and a read through `PieceController.get()` waits for
// that run's consequence, so the sender and a client opened afterwards both
// read what the served run wrote.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity, type Session } from "@commonfabric/identity";
import type { DID, MemorySpace } from "@commonfabric/memory/interface";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { Runtime, type RuntimeProgram } from "@commonfabric/runner";
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

const spaceSigner = await Identity.fromPassphrase("served send space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("served send service");
const aliceSigner = await Identity.fromPassphrase("served send alice");

/** A handler whose write is the only way `name` changes. */
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `/// <cts-enable />
import { handler, NAME, pattern, Writable } from "commonfabric";

const setName = handler<{ name: string }, { name: Writable<string> }>(
  (event, state) => {
    state.name.set("served:" + event.name);
  },
);

export default pattern<{ seed?: string }>(() => {
  const name = new Writable<string>("initial").for("name");
  return { [NAME]: "Served send", name, setName: setName({ name }) };
});
`,
  }],
};

describe("piece-controller", () => {
  let serving: ServingMemoryServer;
  let server: MemoryV2Server.Server;
  let host: ExecutorHost;
  let session: Session;
  let cleanups: Array<() => Promise<void>>;

  beforeEach(async () => {
    serving = await startServingMemoryServer({
      apiUrl: new URL(import.meta.url),
      serviceIdentity: serviceSigner,
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });
    ({ server, host } = serving);
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

  /** A client's view of the space, opened as alice. */
  const clientPieces = async (): Promise<PiecesController> => {
    const manager = EmulatedStorageManager.connectTo(server, {
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

  const instantiate = () =>
    host.runLifecycleVerb(space, {
      name: "instantiate",
      run: (runtime) =>
        servedInstantiatePiece(
          new PiecesController(session, runtime, { deferSpaceCellSync: true }),
          { source: { program: PROGRAM }, actingUser: aliceSigner.did() },
        ),
      confirm: (runtime, receipt) =>
        confirmServedInstantiate(runtime, space, receipt, aliceSigner.did()),
    });

  it("returns from a stream send ahead of the served run, which a read then waits for", async () => {
    const receipt = await instantiate();
    const sender = await clientPieces();
    const piece = await sender.get(receipt.pieceId);
    await piece.result.set({ name: "alice" }, ["setName"]);
    expect(await piece.result.get(["name"])).toBe("served:alice");
    // The read returned once the event's consequence had arrived here.
    expect(sender.runtime.speculationOverlay?.pendingIntentCount).toBe(0);
    // A client opened afterwards reads the served run's write.
    const reader = await clientPieces();
    const later = await reader.get<{ name: string }>(receipt.pieceId);
    const name = reader.getResult(later.getCell()).key("name");
    await name.sync();
    expect(name.get()).toBe("served:alice");
  });
});
