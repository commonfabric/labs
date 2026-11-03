import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import * as Engine from "@commonfabric/memory/v2/engine";
import type { SupersededOutput } from "../../src/executor/wave.ts";
import { createSigilLinkFromParsedLink } from "../../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../../src/meta-seam.ts";
import { Runtime } from "../../src/runtime.ts";
import { supersededOutputsOwed } from "../../src/scheduler/superseded-output.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("superseded output");
const space = signer.did() as MemorySpace;

describe("supersededOutputsOwed()", () => {
  let server: ReturnType<typeof newSharedServer>;
  let runtime: Runtime;
  let peer: Runtime;

  beforeEach(() => {
    // Fan-out only on a flush, so a case decides when a frame reaches the
    // replica under test.
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    });
    peer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, {
        as: signer,
        id: "peer",
      }),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await peer.dispose();
    await server.close();
  });

  /**
   * Commits `write` to the document `name` as `writer` and leaves its frame
   * held. An accept waits for the frame, so `settled` resolves after a flush.
   */
  const commitHeld = async (
    writer: Runtime,
    name: string,
    write: (cell: ReturnType<Runtime["getCell"]>) => void,
  ): Promise<{ output: SupersededOutput; settled: Promise<unknown> }> => {
    const tx = writer.edit();
    const cell = writer.getCell(space, name, undefined, tx);
    write(cell);
    const settled = tx.commit().settled;
    await writer.storageManager.open(space).pullToServerHead?.();
    const { id, scope } = cell.getAsNormalizedFullLink();
    return {
      output: {
        space,
        id,
        ...(scope === undefined ? {} : { scope }),
        seq: Engine.serverSeq(await server.engineForSpace(space)),
      },
      settled,
    };
  };

  /** Commits as `commitHeld()` does, and delivers the commit's frame. */
  const authored = async (
    writer: Runtime,
    name: string,
    write: (cell: ReturnType<Runtime["getCell"]>) => void,
  ): Promise<SupersededOutput> => {
    const { output, settled } = await commitHeld(writer, name, write);
    await server.flushSessions();
    await settled;
    return output;
  };

  /** What a client's piece start writes to a computed document. */
  const structureOnly = (cell: ReturnType<Runtime["getCell"]>) =>
    cell.setMetaRaw(
      "result",
      createSigilLinkFromParsedLink(cell.getAsNormalizedFullLink()),
      rawMetaWriteAuthorization,
    );

  /**
   * Has the runtime under test watch a document holding no value, then has the
   * peer write a value to it, whose frame stays held.
   */
  const valueOnItsWay = async (name: string) => {
    await authored(peer, name, structureOnly);
    await runtime.getCell(space, name, undefined).sync();
    return await commitHeld(peer, name, (cell) => cell.set(99));
  };

  it("returns true for a document holding structure and no value", async () => {
    const output = await authored(runtime, "structure", structureOnly);

    expect(await supersededOutputsOwed(runtime, [output])).toBe(true);
  });

  it("returns false for a document holding an authored value", async () => {
    const output = await authored(runtime, "value", (cell) => cell.set(99));

    expect(await supersededOutputsOwed(runtime, [output])).toBe(false);
  });

  it("returns true when any one of several documents holds no value", async () => {
    const value = await authored(runtime, "mixed-v", (cell) => cell.set(99));
    const structure = await authored(runtime, "mixed-s", structureOnly);

    expect(await supersededOutputsOwed(runtime, [value, structure])).toBe(true);
  });

  it("returns false for a document that does not exist", async () => {
    const value = await authored(runtime, "gone", (cell) => cell.set(99));
    const output = { ...value, id: `${value.id}-absent`, seq: 0 };

    expect(await supersededOutputsOwed(runtime, [output])).toBe(false);
  });

  it("loads a document this replica holds nothing of", async () => {
    const output = await authored(peer, "peer-value", (cell) => cell.set(99));
    const { replica } = runtime.storageManager.open(space);
    const before = replica.confirmedDocumentSeq(
      output.id as never,
      output.scope,
    );

    expect(before).toBeLessThan(output.seq);
    expect(await supersededOutputsOwed(runtime, [output])).toBe(false);
  });

  it("decides on what the commit wrote once its frame arrives", async () => {
    // The replica's own view holds no value until the frame lands, so an answer
    // given sooner is true, and a run started on it would overwrite the value
    // the commit wrote.

    const { output, settled } = await valueOnItsWay("on-its-way");
    let answered = false;
    const owed = supersededOutputsOwed(runtime, [output]).then((result) => {
      answered = true;
      return result;
    });
    const provider = runtime.storageManager.open(space);
    await provider.pullToServerHead?.();
    expect(answered).toBe(false);

    await server.flushSessions();
    await settled;

    expect(await owed).toBe(false);
  });

  it("waits for the frame when loading the document fails", async () => {
    const { output, settled } = await valueOnItsWay("load-fails");
    using _sync = stub(
      runtime.storageManager,
      "syncCell",
      () => Promise.reject(new Error("no connection")),
    );
    const owed = supersededOutputsOwed(runtime, [output]);

    await server.flushSessions();
    await settled;

    expect(await owed).toBe(false);
  });
});
