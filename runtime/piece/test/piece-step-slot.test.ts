import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { createSession, Identity } from "@commonfabric/identity";
import { getPatternIdentityRef, Pattern, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("piece step slot");

function doublePattern(): Pattern {
  return {
    argumentSchema: {
      type: "object",
      properties: { input: { type: "number" } },
    },
    resultSchema: {
      type: "object",
      properties: { output: { type: "number" } },
    },
    derivedInternalCells: [{ partialCause: "output" }],
    result: { output: { $alias: { partialCause: "output", path: [] } } },
    nodes: [
      {
        module: {
          type: "javascript",
          implementation: (input: number) => input * 2,
        },
        inputs: { $alias: { cell: "argument", path: ["input"] } },
        outputs: { $alias: { partialCause: "output", path: [] } },
      },
    ],
  };
}

describe("piece run/step through a value-link slot", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager,
    });
    const session = createSession({
      identity: signer,
      spaceDid: await runtime.createSpace(),
    });
    pieces = new PiecesController(session, runtime);
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("starts a piece addressed through a value-link slot (the cf piece step path)", async () => {
    // Canonical piece K carries patternIdentity; the value-link slot R -> K (the
    // shape a piece pushed into a list/object gets addressed by) carries none.
    const k = await pieces.runPersistent(
      runtime.unsafeTrustPattern(doublePattern(), {
        reason: "piece step slot test fixture",
      }),
      { input: 5 },
      undefined,
      { start: true },
    );
    const r = runtime.getCell(
      pieces.getSpace(),
      "step-slot-" + crypto.randomUUID(),
    );
    await runtime.editWithRetry((tx) => {
      r.withTx(tx).set(k.getAsLink());
    });
    await pieces.synced();
    const slotId = entityRefToString(r.entityId);

    // Before this fix, `get(slotId, runIt=true)` -> `runtime.start(R)` threw
    // "Cannot start: no pattern identity" (R has none). `pieces.get` now
    // canonicalizes R -> K, so start / read / stop operate on the real piece.
    const started = await pieces.get(slotId, true);
    // The canonical piece is hand-built (KEYLESS): it carries no durable
    // pattern pointer (the never-durable contract; L3(a), RULED
    // 2026-08-27). Canonicalization evidence is the runner's session
    // pointer naming it — and the canonical piece computing.
    expect(getPatternIdentityRef(started.getCell())).toBeUndefined();
    expect(runtime.runner.sessionPatternPointerFor(started.getCell()))
      .toBeDefined();
    expect(await started.result.get(["output"])).toBe(10);
  });
});
