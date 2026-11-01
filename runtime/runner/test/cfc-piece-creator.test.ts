/**
 * The record of a piece's creator: the `creator` meta field a setup writes on
 * a new piece's result document, naming the principal the piece was created
 * for, and the admission that refuses every other write to it
 * (`docs/plans/piece-creator-owns-update-added-fields.md`). The record is
 * behind the `pieceCreatorRecord` experimental flag.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";

import type { Cell } from "../src/cell.ts";
import { runtimeWritePolicyAuthorization } from "../src/cfc/types.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import type { RunnerRunOptions } from "../src/runner.ts";
import { getMetaLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { setCfcTrustSnapshot } from "../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";

const alice = await Identity.fromPassphrase("piece creator alice");
const bob = await Identity.fromPassphrase("piece creator bob");
const service = await Identity.fromPassphrase("piece creator service");

/** A pattern with one argument field and nothing about any principal. */
const PIECE_SOURCE = [
  "import { pattern, Writable } from 'commonfabric';",
  "export default pattern<{ count: Writable<number> }, { count: number }>(",
  "  ({ count }) => ({ count }),",
  ");",
].join("\n");

type Piece = { count: number };

describe("cfc-piece-creator", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let managers: EmulatedStorageManager[];
  let runtimes: Runtime[];
  let openTxs: IExtendedStorageTransaction[];
  let client: Runtime;
  let serving: Runtime;
  let pieces = 0;

  /** A runtime on the shared server, closed when the test ends. */
  const connect = (
    as: Identity,
    options: { servingPosture?: boolean; pieceCreatorRecord?: boolean } = {},
  ): Runtime => {
    const storageManager = EmulatedStorageManager.connectTo(server, { as });
    managers.push(storageManager);
    const runtime = new Runtime({
      apiUrl: new URL("https://fabric.example/"),
      storageManager,
      ...(options.servingPosture ? { servingPosture: true } : {}),
      experimental: {
        pieceCreatorRecord: options.pieceCreatorRecord ?? true,
      },
    });
    runtimes.push(runtime);
    return runtime;
  };

  /** Opens a transaction on `runtime` that the test aborts if it is left open. */
  const edit = (runtime: Runtime): IExtendedStorageTransaction => {
    const tx = runtime.edit();
    openTxs.push(tx);
    return tx;
  };

  /**
   * Creates a piece of `PIECE_SOURCE` on `runtime` in `space`, in `tx` when
   * given, and returns its result cell. The transaction a caller does not own
   * is committed here and must land.
   */
  const createPiece = async (
    runtime: Runtime,
    space: MemorySpace,
    options: { tx?: IExtendedStorageTransaction; run?: RunnerRunOptions } = {},
  ): Promise<Cell<Piece>> =>
    (await createPieceOf(runtime, space, options))
      .result;

  /** {@link createPiece}, returning the compiled pattern as well. */
  const createPieceOf = async (
    runtime: Runtime,
    space: MemorySpace,
    options: { tx?: IExtendedStorageTransaction; run?: RunnerRunOptions } = {},
  ) => {
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: PIECE_SOURCE }],
    }, { space });
    const name = `piece-${pieces++}`;
    const argument = runtime.getCell<{ count: number }>(
      space,
      `${name}-argument`,
      undefined,
    );
    const result = runtime.getCell<Piece>(
      space,
      `${name}-result`,
      compiled.resultSchema,
    );
    const tx = options.tx ?? runtime.edit();
    argument.withTx(tx).set({ count: 0 });
    runtime.run(tx, compiled, argument, result, options.run);
    if (options.tx === undefined) {
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    return { result, compiled };
  };

  /** The creator the stored result document of `result` names, read afresh. */
  const storedCreator = async (
    result: Cell<Piece>,
  ): Promise<unknown> => {
    const reader = connect(alice, { pieceCreatorRecord: false });
    const fresh = reader.getCellFromLink<Piece>(
      result.getAsNormalizedFullLink(),
    );
    await fresh.sync();
    return fresh.getMetaRaw("creator");
  };

  /** A serving transaction stamped as a handler run `actor` invoked. */
  const servedHandlerTx = (actor?: Identity): IExtendedStorageTransaction => {
    const tx = edit(serving);
    stampWaveRunContext(tx, {
      actionId: "handler/piece-creator",
      kind: "event-handler",
      eventId: "event-1",
      ...(actor !== undefined
        ? { acting: { user: actor.did(), session: `${actor.did()}-session` } }
        : {}),
    });
    if (actor !== undefined) {
      setCfcTrustSnapshot(tx, serving.trustSnapshotForPrincipal(actor.did()));
    }
    return tx;
  };

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    managers = [];
    runtimes = [];
    openTxs = [];
    client = connect(alice);
    serving = connect(service, { servingPosture: true });
  });

  afterEach(async () => {
    for (const tx of openTxs) {
      if (tx.status().status === "ready") tx.abort(new Error("test-only"));
    }
    for (const runtime of runtimes) {
      await runtime.idle();
      await runtime.dispose();
    }
    for (const manager of managers) await manager.close();
    await server.close();
  });

  //
  // What a creation records
  //

  it("records the acting principal on the result document of a piece a client creates", async () => {
    const result = await createPiece(client, alice.did());

    expect(result.getMetaRaw("creator")).toBe(alice.did());
    expect(await storedCreator(result)).toBe(alice.did());
  });

  it("records nothing while the flag is off", async () => {
    const legacy = connect(alice, { pieceCreatorRecord: false });
    const result = await createPiece(legacy, alice.did());

    expect(result.getMetaRaw("creator")).toBeUndefined();
    expect(await storedCreator(result)).toBeUndefined();
  });

  it("records the run's actor on a piece a served handler run creates", async () => {
    const tx = servedHandlerTx(bob);
    const result = await createPiece(serving, service.did(), { tx });
    expect((await tx.commit().settled).error).toBeUndefined();

    expect(await storedCreator(result)).toBe(bob.did());
  });

  it("records the parent's creator, not the run's actor, on a child a served run instantiates", async () => {
    // Alice created the parent. Bob's handler run instantiates a child of it,
    // as a collection builtin does for a new entry: the child is what the
    // parent's code made, so it is Alice's.

    const parent = await createPiece(client, alice.did());
    await serving.getCellFromLink(parent.getAsNormalizedFullLink()).sync();
    const tx = servedHandlerTx(bob);
    const child = await createPiece(serving, alice.did(), {
      tx,
      run: { parentPieceRootId: parent.getAsNormalizedFullLink().id },
    });
    expect((await tx.commit().settled).error).toBeUndefined();

    expect(await storedCreator(child)).toBe(alice.did());
  });

  it("records nothing for a served run that acts for no one", async () => {
    const tx = servedHandlerTx();
    const result = await createPiece(serving, service.did(), { tx });
    expect((await tx.commit().settled).error).toBeUndefined();

    expect(await storedCreator(result)).toBeUndefined();
  });

  //
  // What the admission refuses
  //

  it("refuses a creator written to a piece that already exists", async () => {
    const result = await createPiece(client, alice.did());
    const link = result.getAsNormalizedFullLink();

    const attack = edit(client);
    result.withTx(attack).setMetaRaw(
      "creator",
      bob.did(),
      rawMetaWriteAuthorization,
    );
    attack.markCfcPieceCreator(
      runtimeWritePolicyAuthorization,
      { space: link.space, id: link.id },
      bob.did(),
    );
    expect((await attack.commit().settled).error?.message).toContain(
      "creator record",
    );
    expect(await storedCreator(result)).toBe(alice.did());
  });

  it("keeps the recorded creator when a setup installs the pointer again", async () => {
    const { result, compiled } = await createPieceOf(client, alice.did());
    const link = result.getAsNormalizedFullLink();
    const argument = client.getCellFromLink(getMetaLink(result, "argument")!);

    const clear = edit(client);
    result.withTx(clear).setMetaRaw(
      "patternIdentity",
      undefined,
      rawMetaWriteAuthorization,
    );
    expect((await clear.commit().settled).error).toBeUndefined();

    // Bob's runtime sets the piece up again over the retained record.
    const member = connect(bob);
    const reloaded = member.getCellFromLink<Piece>(link);
    await reloaded.sync();
    const again = member.edit();
    member.run(
      again,
      compiled,
      member.getCellFromLink(argument.getAsNormalizedFullLink()),
      reloaded,
    );
    expect((await again.commit().settled).error).toBeUndefined();

    expect(await storedCreator(result)).toBe(alice.did());
  });

  it("refuses a creator written over one already stored by a transaction that installs the pointer again", async () => {
    const result = await createPiece(client, alice.did());
    const link = result.getAsNormalizedFullLink();
    const identity = result.getMetaRaw("patternIdentity");

    const clear = edit(client);
    result.withTx(clear).setMetaRaw(
      "patternIdentity",
      undefined,
      rawMetaWriteAuthorization,
    );
    expect((await clear.commit().settled).error).toBeUndefined();

    // A runtime that loads the document afresh finds the pointer absent, as
    // the store holds it, so its write installs the pointer.
    const attacker = connect(alice);
    const reloaded = attacker.getCellFromLink<Piece>(link);
    await reloaded.sync();
    const attack = edit(attacker);
    reloaded.withTx(attack).setMetaRaw(
      "patternIdentity",
      identity,
      rawMetaWriteAuthorization,
    );
    reloaded.withTx(attack).setMetaRaw(
      "creator",
      bob.did(),
      rawMetaWriteAuthorization,
    );
    attack.markCfcPieceCreator(
      runtimeWritePolicyAuthorization,
      { space: link.space, id: link.id },
      bob.did(),
    );
    expect((await attack.commit().settled).error?.message).toContain(
      "creator record",
    );
    expect(await storedCreator(result)).toBe(alice.did());
  });

  it("refuses a creator record the runtime did not mark", async () => {
    const tx = edit(client);
    const cell = client.getCell(alice.did(), "unmarked-creator", undefined, tx);
    cell.set({ count: 0 });
    cell.setMetaRaw("creator", alice.did(), rawMetaWriteAuthorization);
    expect((await tx.commit().settled).error?.message).toContain(
      "creator record",
    );
  });

  it("refuses a creator record naming the serving runtime's identity", async () => {
    const tx = edit(serving);
    const cell = serving.getCell(
      service.did(),
      "service-creator",
      undefined,
      tx,
    );
    cell.set({ count: 0 });
    cell.setMetaRaw("creator", service.did(), rawMetaWriteAuthorization);
    const link = cell.getAsNormalizedFullLink();
    tx.markCfcPieceCreator(
      runtimeWritePolicyAuthorization,
      { space: link.space, id: link.id },
      service.did(),
    );
    expect((await tx.commit().settled).error?.message).toContain(
      "creator record",
    );
  });

  it("refuses a creator record that is not a DID", async () => {
    const tx = edit(client);
    const cell = client.getCell(alice.did(), "string-creator", undefined, tx);
    cell.set({ count: 0 });
    cell.setMetaRaw("creator", "alice", rawMetaWriteAuthorization);
    const link = cell.getAsNormalizedFullLink();
    tx.markCfcPieceCreator(
      runtimeWritePolicyAuthorization,
      { space: link.space, id: link.id },
      "alice",
    );
    expect((await tx.commit().settled).error?.message).toContain(
      "creator record",
    );
  });

  it("refuses a write to the field that does not carry the runtime's authorization", () => {
    const tx = edit(client);
    const cell = client.getCell(alice.did(), "seam-creator", undefined, tx);
    cell.set({ count: 0 });
    const link = cell.getAsNormalizedFullLink();
    expect(() =>
      tx.writeOrThrow(
        { space: link.space, id: link.id, path: ["creator"] },
        alice.did(),
      )
    ).toThrow("meta seam");
  });
});
