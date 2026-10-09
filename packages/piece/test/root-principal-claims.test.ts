/**
 * Pins what `PiecesController`'s roll-forward heal rests on when it declines a
 * root whose stored label says it represents a principal: a profile's label
 * says so, and the system roots it does roll forward, Home and the default
 * app, say no such thing. The roots are the real system patterns, compiled
 * from this checkout and run the way a space's first open runs them.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import { Identity } from "@commonfabric/identity";
import {
  attestedPrincipalsAt,
  type Cell,
  type MemorySpace,
  Runtime,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { markRendererTrustedEvent } from "../../runner/src/cfc/ui-contract.ts";

const signer = await Identity.fromPassphrase("root principal claims");
const patternsRoot = join(import.meta.dirname!, "..", "..", "patterns");

describe("represents-principal claims on space roots", () => {
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
    await runtime.dispose();
    await storageManager.close();
  });

  /**
   * Runs `system/<file>` as a root in `space`, then `before` over it, and
   * returns the principals the root's stored label says it represents.
   */
  const claimsOfRoot = async (
    file: string,
    space: MemorySpace,
    before?: (root: Cell<Record<string, unknown>>) => Promise<void>,
  ) => {
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      { main: join(patternsRoot, "system", file), root: patternsRoot },
    );
    const pattern = await runtime.patternManager.compilePattern(program, {
      space,
    });
    const root = await runtime.runSynced(
      runtime.getCell(space, `${file} root`),
      pattern,
      {},
    );
    await root.pull();
    await runtime.idle();
    await before?.(root as Cell<Record<string, unknown>>);
    await runtime.storageManager.synced();
    const tx = runtime.edit();
    try {
      return attestedPrincipalsAt(
        tx,
        root.getAsNormalizedFullLink(),
        "represents-principal",
      );
    } finally {
      tx.abort();
    }
  };

  it("returns the owner for a profile root", async () => {
    expect(
      await claimsOfRoot("profile-home.tsx", await runtime.createSpace()),
    ).toEqual([signer.did()]);
  });

  it("returns no principal for a Home root", async () => {
    expect(await claimsOfRoot("home.tsx", signer.did())).toEqual([]);
  });

  it("returns no principal for a Home root that lists a profile", async () => {
    let listed = 0;
    expect(
      await claimsOfRoot("home.tsx", signer.did(), async (home) => {
        const event = {
          name: "Ada",
          provenance: {
            origin: "dom",
            trusted: true,
            ui: {
              pattern: "ProfileCreateSurface",
              eventIntegrity: ["ProfileCreateSurface"],
              uiContractDataset: { uiAction: "CreateProfile" },
            },
          },
        };
        markRendererTrustedEvent(event);
        const tx = runtime.edit();
        home.withTx(tx).key("createProfile").send(event);
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        await runtime.idle();
        await home.pull();
        listed = (home.key("profiles").asSchema({
          type: "array",
          items: { type: "unknown", asCell: ["cell"] },
        }).get() as unknown[]).length;
      }),
    ).toEqual([]);
    expect(listed).toBe(1);
  });

  it("returns no principal for a default-app root", async () => {
    expect(
      await claimsOfRoot("default-app.tsx", await runtime.createSpace()),
    ).toEqual([]);
  });
});
