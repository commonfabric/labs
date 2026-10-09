import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const owner = await Identity.fromPassphrase("profile-home edit list owner");
const profileSpace = (await Identity.fromPassphrase(
  "profile-home edit list space",
)).did();

const PROGRAM: RuntimeProgram = {
  main: "/profile-home.tsx",
  files: [{
    name: "/profile-home.tsx",
    contents: Deno.readTextFileSync(
      new URL("../../patterns/system/profile-home.tsx", import.meta.url),
    ),
  }],
};

describe("profile-home edit form", () => {
  let manager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let errors: string[];

  beforeEach(() => {
    errors = [];
    manager = StorageManager.emulate({ as: owner });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      errorHandlers: [(error) => errors.push(String(error?.message ?? error))],
      trustSnapshotProvider: () => ({
        id: owner.did(),
        actingPrincipal: owner.did(),
      }),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await manager.close();
  });

  /**
   * Starts a profile in a space of its own and lists it in the owner's home,
   * which is what makes the profile's `wish("#profile")` find its viewer to
   * be its owner and show the edit form once editing is on.
   */
  async function startOwnedProfile(): Promise<Cell<Record<string, unknown>>> {
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(PROGRAM, {
      space: profileSpace,
      tx,
    });
    const profile = runtime.run(
      tx,
      pattern,
      { initialName: "Ada" },
      runtime.getCell<Record<string, unknown>>(
        profileSpace,
        "profile",
        undefined,
        tx,
      ),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();

    const home = runtime.edit();
    const defaultPattern = runtime.getCell(
      owner.did(),
      "home default pattern",
      undefined,
      home,
    );
    defaultPattern.key("profiles").set([profile]);
    defaultPattern.key("defaultProfile").set(profile);
    runtime.getHomeSpaceCell(home)
      .asSchema<{ defaultPattern: Cell<unknown> }>({ type: "object" })
      .key("defaultPattern").set(defaultPattern);
    runtime.prepareTxForCommit(home);
    expect((await home.commit().settled).error).toBeUndefined();
    return profile;
  }

  /** Sends `event` to the profile's `stream` as the owner, and settles. */
  async function send(
    profile: Cell<Record<string, unknown>>,
    stream: string,
    event: unknown,
  ): Promise<void> {
    const tx = runtime.edit();
    profile.withTx(tx).key(stream).send(event);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await manager.synced();
  }

  /**
   * Renders the profile with editing on, makes one entry through `stream`, and
   * returns the refusals the render met once `field` holds that entry. Each
   * row of the edit form's list for `field` captures the owner-protected
   * `field` for its Remove button.
   */
  async function refusalsRenderingEditRow(
    field: string,
    stream: string,
    event: unknown,
  ): Promise<string[]> {
    const profile = await startOwnedProfile();
    const stopRender = profile.key("$UI").sink(() => {});
    try {
      await runtime.idle();
      await send(profile, "toggleEditing", {});
      expect(profile.key("isEditing").get()).toBe(true);
      expect(errors).toEqual([]);

      await send(profile, stream, event);
      expect(profile.key(field).get()).toHaveLength(1);
      return errors;
    } finally {
      stopRender();
    }
  }

  it("renders the owner's row for a pinned piece without a refusal", async () => {
    expect(
      await refusalsRenderingEditRow("elements", "addPiece", {
        pieceSpace: "did:key:z6MkkKEmheMPDZUr4YEkZrW6niR7Bn5FWAuQic5fUUzcGkfq",
        pieceId: "fid1:cMVC_ZTgWedhTzHW8jWbz70xANFfmLmpL-dNU1842Ps",
        title: "Pinned",
      }),
    ).toEqual([]);
  });

  it("renders the owner's row for an external link without a refusal", async () => {
    expect(
      await refusalsRenderingEditRow("externalLinks", "addExternalLink", {
        label: "GitHub",
        url: "https://github.com/ada",
      }),
    ).toEqual([]);
  });
});
