import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";

// CT-1917 (2026-07-28 estuary): a hot-swap to a new pattern version re-runs
// setup, and setup re-validates the STORED argument against the candidate
// schema by materializing it — dereferencing every link. An argument slot
// whose stored value is a link to a doc that is absent (or simply not loaded
// in this session — the normal client cold state) materializes to nothing,
// the key is dropped, and required-validation kills the swap with
// "missing required property <slot>". The piece then stays pinned to the old
// pattern (or, on a fresh open, never comes up) even though the stored
// argument is exactly what the original instantiation wrote.
//
// Production shape: BacklinksIndex's `pieceRegistry` argument links into its
// host default-app's registry cell; the host was down (its own pattern failed
// to compile), the link read cold, and the official-pattern upgrade of
// BacklinksIndex died on "missing required property pieceRegistry".

const signer = await Identity.fromPassphrase("pattern-swap-link-argument");
const space = signer.did();

// V1/V2 share the argument schema — `registry` is a required array slot —
// and differ only in a result marker so the running version is observable.
// The lift tolerates an unreadable registry the way real index patterns do.
const patternWithMarker = (marker: string): string =>
  [
    "import { lift, pattern } from 'commonfabric';",
    "type Entry = { name?: string };",
    "type Input = { registry: Entry[] };",
    "const count = lift<{ registry: Entry[] | undefined }, number>(",
    "  ({ registry }) => (registry ?? []).length,",
    ");",
    "export default pattern<Input, { marker: string; total: number }>(",
    "  ({ registry }) => {",
    `    return { marker: ${
      JSON.stringify(marker)
    }, total: count({ registry }) };`,
    "  },",
    ");",
    "",
  ].join("\n");

const programOf = (contents: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents }],
});

describe("pattern swap with a link-valued argument slot", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let rt: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });
  afterEach(async () => {
    await rt?.dispose();
    await storageManager?.close();
  });

  // Start V1 with `registry` supplied as a CELL (stored as a link), then move
  // patternIdentity to V2 so the armed watcher performs the hot-swap.
  const startThenSwap = async (
    registryCell: unknown,
  ): Promise<{
    cell: ReturnType<Runtime["getCell"]>;
    v2Identity: string;
  }> => {
    const tx = rt.edit();
    const pm = rt.patternManager;
    const v1 = await pm.compilePattern(programOf(patternWithMarker("v1")), {
      space,
      tx,
    });
    const v2 = await pm.compilePattern(programOf(patternWithMarker("v2")), {
      space,
      tx,
    });
    const v2Ref = pm.getArtifactEntryRef(v2)!;
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      "swap-link-argument-piece",
      undefined,
      tx,
    );
    const running = rt.run(tx, v1, { registry: registryCell }, cell);
    await tx.commit().settled;
    await running.pull();
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v1");

    const tx2 = rt.edit();
    cell.withTx(tx2).setMetaRaw("patternIdentity", {
      identity: v2Ref.identity,
      symbol: v2Ref.symbol,
    }, rawMetaWriteAuthorization);
    await tx2.commit().settled;
    await rt.idle();
    await cell.pull();
    return { cell, v2Identity: v2Ref.identity };
  };

  it("swaps when the linked registry doc has data (warm control)", async () => {
    const tx = rt.edit();
    const registry = rt.getCell<{ name?: string }[]>(
      space,
      "swap-link-argument-registry-warm",
      undefined,
      tx,
    );
    registry.set([{ name: "one" }]);
    await tx.commit().settled;

    const { cell } = await startThenSwap(registry);
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v2");
  });

  it("swaps when the linked registry doc is absent (cold link)", async () => {
    // Never written: models the client whose link target is not loaded — the
    // production state whenever the argument links into a piece that is down.
    const registry = rt.getCell<{ name?: string }[]>(
      space,
      "swap-link-argument-registry-absent",
    );

    const { cell } = await startThenSwap(registry);
    // Bug under test: swap-setup rejects with "registry: value does not match
    // type array" (the link-valued slot dereferenced to nothing), so the piece
    // stays on V1. The stored argument still holds the link and is exactly
    // what V1's own instantiation wrote — the swap must survive it.
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v2");
  });

  it("swaps when a link INSIDE an array slot is cold (item-level link)", async () => {
    // Links live at any depth: an array slot whose ITEM is a link to an
    // absent doc must get the same deferral as a link at the slot itself.
    const entry = rt.getCell<{ name?: string }>(
      space,
      "swap-link-argument-array-item-absent",
    );

    const { cell } = await startThenSwap([entry]);
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v2");
  });

  it("swaps when the argument doc itself reads cold (nested-piece shape)", async () => {
    // A nested piece's argument meta links into its HOST's doc; when the host
    // is down that whole doc reads cold. Production signature: "missing
    // required property pieceRegistry" — validation ran against bare defaults
    // after the argument link dereferenced to nothing.
    const tx = rt.edit();
    const pm = rt.patternManager;
    const v1 = await pm.compilePattern(programOf(patternWithMarker("v1")), {
      space,
      tx,
    });
    const v2 = await pm.compilePattern(programOf(patternWithMarker("v2")), {
      space,
      tx,
    });
    const v2Ref = pm.getArtifactEntryRef(v2)!;
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      "swap-link-argument-piece-cold-doc",
      undefined,
      tx,
    );
    const running = rt.run(tx, v1, { registry: [{ name: "one" }] }, cell);
    await tx.commit().settled;
    await running.pull();
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v1");

    // Retarget the argument meta at a doc that was never written — the swap
    // must not treat "argument unreadable right now" as "argument invalid".
    const coldArgument = rt.getCell<Record<string, unknown>>(
      space,
      "swap-link-argument-cold-argument-doc",
    );
    const tx2 = rt.edit();
    cell.withTx(tx2).setMetaRaw(
      "argument",
      coldArgument.getAsWriteRedirectLink({ base: cell }),
      rawMetaWriteAuthorization,
    );
    cell.withTx(tx2).setMetaRaw("patternIdentity", {
      identity: v2Ref.identity,
      symbol: v2Ref.symbol,
    }, rawMetaWriteAuthorization);
    await tx2.commit().settled;
    await rt.idle();
    // The watcher names the cold argument document before the swap reads
    // it; the swap lands once that name-sync has settled.
    await rt.runner.idlePointerMaintenance();
    await cell.pull();
    expect((cell.getAsQueryResult() as { marker: string }).marker).toBe("v2");
  });
});
