import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { WishParams } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { createBuilder } from "../../src/builder/factory.ts";
import { Runtime } from "../../src/runtime.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const userIdentity = await Identity.fromPassphrase("wish home targets user");
const patternSpace = await Identity.fromPassphrase("wish home targets space");

type WishState = { result?: unknown; error?: string; errorCode?: string };

describe("wish-home-targets", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let wish: ReturnType<typeof createBuilder>["commonfabric"]["wish"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];

  beforeEach(() => {
    // The storage manager's identity is the user whose Home a wish reads.
    storageManager = StorageManager.emulate({ as: userIdentity });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    ({ wish, pattern } = createTrustedBuilder(runtime).commonfabric);
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** Links a Home root holding `fields` from the user's home space. */
  async function seedHome(fields: Record<string, unknown>): Promise<void> {
    const tx = runtime.edit();
    const root = runtime.getCell<Record<string, unknown>>(
      userIdentity.did(),
      "wish home targets root",
      undefined,
      tx,
    );
    root.set(fields);
    runtime.getHomeSpaceCell(tx).asSchema(undefined).key("defaultPattern")
      .set(root);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
  }

  /** The state a wish for `query` in `scope` settles to. */
  async function wishFor(
    label: string,
    query: string,
    scope?: WishParams["scope"],
  ): Promise<WishState | undefined> {
    const tx = runtime.edit();
    const wishPattern = pattern(() => ({
      result: wish({ query, ...(scope === undefined ? {} : { scope }) }),
    }));
    const resultCell = runtime.getCell<{ result?: WishState }>(
      patternSpace.did(),
      `wish home targets ${label}`,
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    return result.key("result").get();
  }

  describe("without a requesting identity", () => {
    // A serving runtime whose run carries no demanding principal has no Home
    // to read, and says so rather than reading the service's own. Each case
    // seeds the Home first, while the runtime still names its user.

    for (
      const query of ["#favorites", "#journal", "#learned", "#learnedSummary"]
    ) {
      it(`reports the missing identity for ${query}`, async () => {
        await seedHome({
          favorites: [],
          journal: [],
          learned: { summary: "" },
        });
        runtime.homeSpacePrincipalFor = () => undefined;

        const resolved = await wishFor(query, query);

        expect(resolved?.error).toBe(
          `User identity DID not available for ${query}`,
        );
        expect(resolved?.result).toBeUndefined();
      });
    }

    it("reports the missing identity for a hashtag search of the user's Home", async () => {
      const favorite = runtime.getCell(
        userIdentity.did(),
        "wish home targets favorite",
      );
      const tx = runtime.edit();
      favorite.withTx(tx).set({ name: "Tagged" });
      expect((await tx.commit().settled).error).toBeUndefined();
      await seedHome({
        favorites: [{ cell: favorite, tags: ["tagged"], userTags: [] }],
      });
      runtime.homeSpacePrincipalFor = () => undefined;

      const resolved = await wishFor("hashtag", "#tagged", ["~"]);

      expect(resolved?.error).toBe(
        'User identity DID not available to search favorites for "#tagged"',
      );
      expect(resolved?.errorCode).toBe("failed");
      expect(resolved?.result).toBeUndefined();
    });
  });

  it("finds a favorite by hashtag in the user's Home", async () => {
    // The positive counterpart of the identity-less search above.
    const favorite = runtime.getCell(
      userIdentity.did(),
      "wish home targets favorite",
    );
    const tx = runtime.edit();
    favorite.withTx(tx).set({ name: "Tagged" });
    expect((await tx.commit().settled).error).toBeUndefined();
    await seedHome({
      favorites: [{ cell: favorite, tags: ["tagged"], userTags: [] }],
    });

    const resolved = await wishFor("hashtag found", "#tagged", ["~"]);

    expect(resolved?.error).toBeUndefined();
    expect(resolved?.result).toEqual({ name: "Tagged" });
  });

  describe("the root target", () => {
    it("resolves to the user's home space under the Home scope", async () => {
      // One space per transaction.
      const homeTx = runtime.edit();
      runtime.getHomeSpaceCell(homeTx).asSchema(undefined).key("marker").set(
        "home",
      );
      expect((await homeTx.commit().settled).error).toBeUndefined();
      const ownTx = runtime.edit();
      runtime.getCell<{ marker?: string }>(
        patternSpace.did(),
        patternSpace.did(),
        undefined,
        ownTx,
      ).key("marker").set("pattern space");
      expect((await ownTx.commit().settled).error).toBeUndefined();
      await runtime.idle();

      const home = await wishFor("root home", "/marker", ["~"]);
      const own = await wishFor("root own", "/marker", ["."]);

      expect(home?.error).toBeUndefined();
      expect(home?.result).toBe("home");
      expect(own?.error).toBeUndefined();
      expect(own?.result).toBe("pattern space");
    });
  });
});
