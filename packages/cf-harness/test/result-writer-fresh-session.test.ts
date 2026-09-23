/**
 * The result writer on a session that has loaded nothing: the position a
 * runner's writer is in, since it opens its own session after the run.
 *
 * An observed cell whose path redirects into a second document is seeded by
 * one session. A second session on the same memory server, which has read
 * neither, then writes a result observing that cell. A read of the unloaded
 * linked document would record an absence the commit finds untrue.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { renderCellReference } from "@commonfabric/runner/shared";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import {
  createHarnessHandleTable,
  mintAddressHandle,
} from "../src/handle-table.ts";
import { writeAgentResult } from "../src/result-writer.ts";

const signer = await Identity.fromPassphrase("result writer fresh session");

describe("writeAgentResult() on a fresh session", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let managers: EmulatedStorageManager[];
  let runtimes: Runtime[];

  const connect = () => {
    const storageManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    managers.push(storageManager);
    runtimes.push(runtime);
    return runtime;
  };

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    managers = [];
    runtimes = [];
  });

  afterEach(async () => {
    for (const runtime of runtimes) {
      await runtime.idle();
      await runtime.dispose();
    }
    for (const manager of managers) await manager.close();
    await server.close();
  });

  it("writes a result observing a cell that links into a document it has not loaded", async () => {
    const spaceName = `fresh-session-${crypto.randomUUID()}`;
    const seeding = connect();
    const seedSession = await createSession({ identity: signer, spaceName });
    const space = seedSession.space;
    const shelf = seeding.getCell(space, "shelf");
    await seeding.editWithRetry((tx) => {
      const book = seeding.getCell(space, "book", undefined, tx);
      book.set({ title: "Dune" });
      // A redirect, the link a pattern's result holds to the cell behind
      // one of its fields: a read at `first` lands in the book's document.
      shelf.withTx(tx).setRaw({ first: book.getAsWriteRedirectLink() });
    });
    await seeding.idle();

    const writing = connect();
    const pieces = new PiecesController(
      await createSession({ identity: signer, spaceName }),
      writing,
    );
    await pieces.synced();
    const minted = await mintAddressHandle(
      createHarnessHandleTable("run-fresh-session"),
      renderCellReference(shelf.key("first").getAsNormalizedFullLink()),
    );

    const written = await writeAgentResult({
      session: { pieces },
      handleTable: minted.table,
      structuredResult: { answer: "Hyperion" },
      resultSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
      observedHandles: [{ kind: "cell", token: minted.token }],
      maxConfidentiality: [],
    });

    const result = writing.getCellFromLink(written.link);
    await result.sync();
    expect(result.get()).toEqual({ answer: "Hyperion" });
  });
});
