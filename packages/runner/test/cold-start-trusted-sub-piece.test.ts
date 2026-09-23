import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { join } from "@std/path";

import { StorageManager } from "../src/storage/cache.deno.ts";
import { markRendererTrustedEvent } from "../src/cfc/ui-contract.ts";
import { resolveLocalProgram } from "../src/harness/local-program.deno.ts";
import { Runtime } from "../src/runtime.ts";

// Starting a stored piece replays the setup of the sub-pieces its pattern
// instantiates, and a replay re-stages each sub-piece's argument document —
// the same redirects that document already holds. Where a sub-pattern's
// argument field carries a trusted UI write contract, that re-stage runs at a
// CFC gate that admits a field the runtime is projecting and refuses one an
// untrusted writer is editing. A refusal there is not local to the field: it
// takes down the piece-start commit, so the starting runtime tears the whole
// graph down and nothing in it recomputes.
//
// `cfc-staged-publish` is the pattern that exercises it — three trusted
// surfaces, each taking contract-carrying fields from the parent — and it is
// used here rather than a fixture so that what the gate sees is the shape
// patterns really take.

const signer = await Identity.fromPassphrase("cold-start-trusted-sub-piece");
const space = signer.did();
const patternsRoot = join(import.meta.dirname!, "..", "..", "patterns");

const saveDraftClick = () => ({
  type: "click",
  provenance: {
    origin: "dom",
    trusted: true,
    ui: {
      pattern: "TrustedSaveDraftSurface",
      eventIntegrity: ["TrustedSaveDraftSurface"],
      uiContractDataset: { uiAction: "TrustedSaveDraft" },
    },
  },
});

describe("cold start of a piece with trusted sub-pieces", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await storageManager?.close();
  });

  const newRuntime = () =>
    new Runtime({ apiUrl: new URL(import.meta.url), storageManager });

  // `start()` resolves before its piece-start commit settles, so a refused
  // commit reaches a test only through the observer seam. What comes back is
  // the list the observer fills, empty while the started graph stays up.
  const observeStartFailures = (runtime: Runtime): string[] => {
    const failures: string[] = [];
    runtime.pieceStartCommitFailureObserver = ({ error }) => {
      failures.push(String((error as Error)?.message ?? error));
    };
    return failures;
  };

  // Create the piece the way a shell does, then leave it stored and stopped.
  // The creating runtime is not disposed: the emulated storage is shared, and
  // disposing it takes the stored piece with it.
  const storeStagedPublishPiece = async (runtime: Runtime) => {
    const tx = runtime.edit();
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: join(patternsRoot, "cfc-staged-publish", "main.tsx"),
        root: patternsRoot,
      },
    );
    const pattern = await runtime.patternManager.compilePattern(program, {
      space,
      tx,
    });
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "cold-start-staged-publish",
      undefined,
      tx,
    );
    const running = runtime.run(tx, pattern, {
      draftTitle: "Launch",
      draftBody: "Body",
    }, cell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await running.pull();
    await runtime.idle();
    await runtime.storageManager.synced();
    runtime.runner.stop(cell);
  };

  it("starts it, and its trusted surfaces drive the piece", async () => {
    const creator = newRuntime();
    const cold = newRuntime();
    const failures = observeStartFailures(cold);
    try {
      await storeStagedPublishPiece(creator);

      const cell = cold.getCell<Record<string, unknown>>(
        space,
        "cold-start-staged-publish",
      );
      await cell.sync();
      expect(await cold.start(cell)).toBe(true);
      await cell.pull();
      await cold.idle();
      // The setup writes have to land for the graph to stay up: a refused
      // piece-start commit leaves the piece stored but running nowhere.
      expect(
        failures,
        "the piece-start commit was refused, so the started graph was torn " +
          "down",
      ).toEqual([]);
      expect(await cell.key("stage").pull()).toBe("drafting");

      // A trusted click has to reach the sub-piece's handler AND be recomputed
      // by the parent, which only the cold runtime's own graph can do.
      const click = saveDraftClick();
      markRendererTrustedEvent(click);
      (cell.key("saveDraft") as unknown as { send: (e: unknown) => void })
        .send(click);
      await cold.idle();
      await cell.pull();
      await cold.idle();

      expect(await cell.key("savedTitle").pull()).toBe("Launch");
      expect(
        await cell.key("stage").pull(),
        "the stage computed did not re-run in the runtime that started the " +
          "piece",
      ).toBe("saved");
    } finally {
      await cold.dispose();
      await creator.dispose();
    }
  });

  it("still refuses an untrusted write to a contract-carrying field", async () => {
    const creator = newRuntime();
    const cold = newRuntime();
    const failures = observeStartFailures(cold);
    try {
      await storeStagedPublishPiece(creator);

      const cell = cold.getCell<Record<string, unknown>>(
        space,
        "cold-start-staged-publish",
      );
      await cell.sync();
      expect(await cold.start(cell)).toBe(true);
      await cell.pull();
      await cold.idle();
      // A refusal below is only evidence if the graph is up to refuse it: a
      // piece that never started leaves the same values in place.
      expect(
        failures,
        "the piece-start commit was refused, so the started graph was torn " +
          "down",
      ).toEqual([]);
      expect(await cell.key("stage").pull()).toBe("drafting");

      // The same payload the renderer would carry, without the mark the
      // renderer puts on it. Admitting the setup replay must not admit this.
      (cell.key("saveDraft") as unknown as { send: (e: unknown) => void })
        .send(saveDraftClick());
      await cold.idle();
      await cell.pull();
      await cold.idle();

      expect(await cell.key("savedTitle").pull()).toBe("");
      expect(await cell.key("stage").pull()).toBe("drafting");
    } finally {
      await cold.dispose();
      await creator.dispose();
    }
  });
});
