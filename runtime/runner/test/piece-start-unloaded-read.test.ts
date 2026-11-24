import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { Result, Unit, URI } from "@commonfabric/memory/interface";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../src/index.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { getMetaLink, isCellLink, parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("piece-start-unloaded-read");
const space = signer.did();
const PIECE_CAUSE = "piece-start-unloaded-read";

const programOf = (contents: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents }],
});

/**
 * A parent whose child takes a `Writable` the parent owns, as `extra`, beside
 * a plain `label`. The child reports `marker`, which names the version.
 */
const childTakesExtra = (marker: string): RuntimeProgram =>
  programOf([
    "import { pattern, Writable } from 'commonfabric';",
    "interface Notes { notes: string[] }",
    "interface ChildArgs { label: string; extra?: Writable<Notes> }",
    "const Child = pattern<ChildArgs, { marker: string }>(() => {",
    `  return { marker: ${JSON.stringify(marker)} };`,
    "});",
    "export default pattern<{ label: string }, { child: { marker: string } }>(",
    "  ({ label }) => {",
    "    const extra = new Writable<Notes>({ notes: ['kept'] });",
    "    const child = Child({ label, extra });",
    "    return { child };",
    "  },",
    ");",
    "",
  ].join("\n"));

/**
 * The same parent and child, except that the child no longer takes `extra`
 * and the parent no longer owns the cell it was handed.
 */
const childTakesLabel = (marker: string): RuntimeProgram =>
  programOf([
    "import { pattern } from 'commonfabric';",
    "interface ChildArgs { label: string }",
    "const Child = pattern<ChildArgs, { marker: string }>(() => {",
    `  return { marker: ${JSON.stringify(marker)} };`,
    "});",
    "export default pattern<{ label: string }, { child: { marker: string } }>(",
    "  ({ label }) => {",
    "    const child = Child({ label });",
    "    return { child };",
    "  },",
    ");",
    "",
  ].join("\n"));

describe("a piece-start commit refused over a document its runtime had not loaded", () => {
  // Starting a stored piece at a new version sets its child up again over the
  // child's stored argument, and that setup judges each stored slot through
  // the link it holds. The child here stopped taking `extra` a version ago,
  // and a setup carries the stored slots its caller leaves out, so the cell
  // that slot links to is reachable from nothing either version reads. Its
  // load is held back from the starting runtime until a commit's catch-up
  // asks for it, which is what a start whose loads missed a document looks
  // like: its commit claims the document absent, and the server holds it.

  let server: MemoryV2Server.Server;
  const runtimes: { runtime: Runtime; storage: EmulatedStorageManager }[] = [];

  beforeEach(() => {
    server = newSharedServer();
  });
  afterEach(async () => {
    for (const { runtime, storage } of runtimes.splice(0)) {
      await runtime.dispose();
      await storage.close();
    }
    await server.close();
  });

  // Each runtime has a replica of its own, so a document one has loaded is
  // not thereby local to the other.
  const newRuntime = (): Runtime => {
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    runtimes.push({ runtime, storage });
    return runtime;
  };

  // `runSynced()` resolves before the piece-start commit settles, so a refused
  // commit reaches a test only through the observer seam.
  const observeStartFailures = (runtime: Runtime): unknown[] => {
    const failures: unknown[] = [];
    runtime.pieceStartCommitFailureObserver = ({ error }) => {
      failures.push(error);
    };
    return failures;
  };

  const update = async (
    runtime: Runtime,
    cell: Cell<Record<string, unknown>>,
    program: RuntimeProgram,
  ): Promise<void> => {
    const pattern = await runtime.patternManager.compilePattern(program, {
      space,
    });
    await runtime.runSynced(cell, pattern);
    await runtime.runner.idlePieceInstantiationSettlements();
    await runtime.idle();
    await runtime.storageManager.synced();
  };

  // Stores the piece at version 1, its child's argument still carrying the
  // `extra` slot version 0 wrote, and returns the id of the document that
  // slot links to.
  const storeCarriedSlotPiece = async (): Promise<URI> => {
    const author = newRuntime();
    const tx = author.edit();
    const first = await author.patternManager.compilePattern(
      childTakesExtra("v0"),
      { space, tx },
    );
    const authored = author.getCell<Record<string, unknown>>(
      space,
      PIECE_CAUSE,
      undefined,
      tx,
    );
    author.run(tx, first, { label: "loops" }, authored);
    author.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await authored.pull();
    await author.idle();
    author.runner.stop(authored);
    await update(author, authored, childTakesLabel("v1"));
    author.runner.stop(authored);

    const childLink = authored.key("child").getRaw();
    if (!isCellLink(childLink)) throw new Error("the piece holds no child");
    const child = author.getCellFromLink(childLink).resolveAsCell();
    const argumentLink = getMetaLink(child, "argument");
    if (argumentLink === undefined) {
      throw new Error("the child has no argument document");
    }
    const argument = author.getCellFromLink({
      ...argumentLink,
      schema: undefined,
    }).getRaw() as Record<string, unknown>;
    const extra = parseLink(argument.extra, child);
    if (extra === undefined) throw new Error("the child carries no `extra`");
    return extra.id;
  };

  // Answers `runtime`'s loads of `id` with nothing until the catch-up of a
  // refusal naming `id` asks for it. The catch-up's load is answered by
  // `catchUp`, or by the server. `refusals` holds each refusal whose catch-up
  // released the document.
  const loadedOnlyByCatchUp = (
    runtime: Runtime,
    id: URI,
    catchUp?: () => Promise<Result<Unit, Error>>,
  ) => {
    const provider = runtime.storageManager.open(space);
    const sync = provider.sync.bind(provider);
    const refusals: unknown[] = [];
    const syncs = stub(provider, "sync", (uri, selector, scope, instance) => {
      if (uri !== id) return sync(uri, selector, scope, instance);
      if (refusals.length === 0) return Promise.resolve({ ok: {} });
      return catchUp?.() ?? sync(uri, selector, scope, instance);
    });
    const awaitReadiness = runtime.awaitCommitRetryReadiness.bind(runtime);
    const readiness = stub(
      runtime,
      "awaitCommitRetryReadiness",
      (error, signal) => {
        const { conflicts } = error as { conflicts?: { of?: unknown }[] };
        if (conflicts?.some((conflict) => conflict.of === id)) {
          refusals.push(error);
        }
        return awaitReadiness(error, signal);
      },
    );
    return {
      refusals,
      [Symbol.dispose]() {
        readiness.restore();
        syncs.restore();
      },
    };
  };

  it("starts the piece once the catch-up has loaded the document", async () => {
    const carried = await storeCarriedSlotPiece();
    const cold = newRuntime();
    const failures = observeStartFailures(cold);
    using unloaded = loadedOnlyByCatchUp(cold, carried);
    const piece = cold.getCell<Record<string, unknown>>(space, PIECE_CAUSE);
    await piece.sync();

    await update(cold, piece, childTakesLabel("v2"));

    expect(failures).toEqual([]);
    expect(unloaded.refusals).toHaveLength(1);
    expect(unloaded.refusals[0]).toMatchObject({
      name: "ConflictError",
      conflicts: [{ of: carried, seq: 0 }],
    });
    expect(await piece.key("child").key("marker").pull()).toBe("v2");
  });

  it("reports a catch-up that could not load the document, with its reason", async () => {
    const carried = await storeCarriedSlotPiece();
    const cold = newRuntime();
    const failures = observeStartFailures(cold);
    const unreachable = new Error("the memory server is unreachable");
    using _unloaded = loadedOnlyByCatchUp(
      cold,
      carried,
      () => Promise.resolve({ error: unreachable }),
    );
    const piece = cold.getCell<Record<string, unknown>>(space, PIECE_CAUSE);
    await piece.sync();

    await update(cold, piece, childTakesLabel("v2"));

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      message: expect.stringContaining(carried),
      cause: unreachable,
    });
  });
});
