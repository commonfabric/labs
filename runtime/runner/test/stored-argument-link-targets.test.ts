import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../src/index.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { getMetaLink, isCellLink } from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("stored-argument-link-targets");
const space = signer.did();

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

/** A pattern with no nodes, over an open argument. */
const emptyPattern = programOf([
  "import { pattern } from 'commonfabric';",
  "interface Args { [key: string]: any }",
  "export default pattern<Args, Record<string, never>>(() => ({}));",
  "",
].join("\n"));

describe("stored argument link targets", () => {
  describe("a nested instance stored under another pattern", () => {
    const PIECE_CAUSE = "nested instance stored under another pattern";
    let server: MemoryV2Server.Server;
    const runtimes: { runtime: Runtime; storage: EmulatedStorageManager }[] =
      [];

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

    // `runSynced()` resolves before the piece-start commit settles, so a
    // refused commit reaches a test only through the observer seam.
    const observeStartFailures = (runtime: Runtime): string[] => {
      const failures: string[] = [];
      runtime.pieceStartCommitFailureObserver = ({ error }) => {
        failures.push(String((error as Error)?.message ?? error));
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

    const childOf = (
      runtime: Runtime,
      cell: Cell<Record<string, unknown>>,
    ): Cell<unknown> => {
      const link = cell.key("child").getRaw();
      if (!isCellLink(link)) throw new Error("the piece holds no child link");
      return runtime.getCellFromLink(link).resolveAsCell();
    };

    const storedChildArgument = (
      runtime: Runtime,
      cell: Cell<Record<string, unknown>>,
    ): Record<string, unknown> => {
      const argumentLink = getMetaLink(childOf(runtime, cell), "argument");
      if (argumentLink === undefined) {
        throw new Error("the child has no argument document");
      }
      return runtime.getCellFromLink({ ...argumentLink, schema: undefined })
        .getRaw() as Record<string, unknown>;
    };

    it("starts the child at the new version in a runtime that never loaded what a carried slot links to", async () => {
      // The child's stored argument keeps `extra` once the child stops taking
      // it, since a restage carries the stored slots its caller leaves out.
      // The cell `extra` links to is then reachable from nothing a version-1
      // or version-2 graph reads, so a runtime that first sees the piece at
      // version 1 has never loaded it, and the child's restage to version 2
      // judges `extra` through that link.

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
      expect(isCellLink(storedChildArgument(author, authored).extra)).toBe(
        true,
      );

      const cold = newRuntime();
      const failures = observeStartFailures(cold);
      const piece = cold.getCell<Record<string, unknown>>(space, PIECE_CAUSE);
      await piece.sync();
      await update(cold, piece, childTakesLabel("v2"));

      expect(failures).toEqual([]);
      expect(await piece.key("child").key("marker").pull()).toBe("v2");
      // The carried slot is still stored: the start landed by reading it, not
      // by leaving it out.
      expect(isCellLink(storedChildArgument(cold, piece).extra)).toBe(true);
    });
  });

  describe("a pre-sync captured for another principal", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
    });
    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    it("requests none of the link targets the runtime's own instance of a user-scoped argument holds", async () => {
      // With server execution off, a runtime holds only its own principal's
      // instances of user-scoped documents: a commit's scopes resolve against
      // the connection's principal, and a read naming another principal's
      // instance is refused. So the other principal's instance of the
      // argument is absent here, and a pre-sync captured for that principal
      // has no link to name. What it must not do is read the runtime's own
      // instance in its place and name the target linked from there.

      const other = (await Identity.fromPassphrase(
        "stored-argument-link-targets other principal",
      )).did();
      const tx = runtime.edit();
      const ownTarget = runtime.getCell(space, "own target", undefined, tx);
      ownTarget.set({ n: 1 });
      const argument = runtime.getCell<Record<string, unknown>>(
        space,
        "user-scoped argument",
        undefined,
        tx,
        "user",
      );
      argument.set({ slot: ownTarget });
      const piece = runtime.getCell<Record<string, unknown>>(
        space,
        "piece over a user-scoped argument",
        undefined,
        tx,
      );
      piece.set({});
      piece.setMetaRaw(
        "argument",
        argument.getAsWriteRedirectLink({ base: piece }),
        rawMetaWriteAuthorization,
      );
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.storageManager.synced();

      const pattern = await runtime.patternManager.compilePattern(
        emptyPattern,
        { space },
      );
      const provider = storageManager.open(space);
      const sync = provider.sync;
      const requested: string[] = [];
      provider.sync = (id, selector, scope, instance) => {
        requested.push(id);
        return sync.call(provider, id, selector, scope, instance);
      };
      try {
        const readTx = runtime.readTx();
        readTx.tx.scopeKeyIdentity = { principal: other };
        await runtime.runner.syncStoredPieceCells(
          piece.withTx(readTx),
          pattern,
        );
      } finally {
        provider.sync = sync;
      }

      expect(requested).toContain(argument.getAsNormalizedFullLink().id);
      expect(requested).not.toContain(ownTarget.getAsNormalizedFullLink().id);
    });
  });
});
