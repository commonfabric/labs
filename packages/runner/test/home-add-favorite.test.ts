import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { favoriteKey } from "@commonfabric/home-schemas";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { Cell } from "../src/cell.ts";

const signer = await Identity.fromPassphrase("home add-favorite tests");
const space = signer.did();

type FavoriteEntry = {
  tags?: string[];
  tag?: string;
  userTags?: string[];
  id?: string;
};

describe("home favorites handlers", () => {
  // Compiles and runs the real home pattern, then drives its addFavorite /
  // removeFavorite handlers the way the runtime client does: it derives the
  // piece's stable key and the discovery tags as data, and the handlers key the
  // favorite entity by that id.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  // deno-lint-ignore no-explicit-any
  let home: any;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const patternsRoot = join(import.meta.dirname!, "..", "..", "patterns");
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      { main: join(patternsRoot, "system", "home.tsx"), root: patternsRoot },
    );
    const homePattern = await runtime.patternManager.compilePattern(program, {
      space,
    });
    const resultCell = runtime.getCell(space, "home-instance");
    home = await runtime.runSynced(resultCell, homePattern, {});
    await home.pull();
    await runtime.idle();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  // Create a piece cell and return the (link, id) a client would send for it.
  function makePiece(cause: string): { piece: unknown; id: string } {
    const target = runtime.getCell(space, cause, undefined, tx) as Cell<
      unknown
    >;
    target.set({ content: cause });
    const id = favoriteKey(target.getAsNormalizedFullLink());
    return { piece: target.getAsLink(), id };
  }

  // Each handler send below runs through the scheduler, so the rewritten list
  // arrives on a committed change the sink reports. The pattern starts
  // `favorites` at an empty list, which the emptiness predicate matches, so each
  // caller of readFavoritesUntilEmpty first establishes that the list holds an
  // entry.
  function readFavorites(): Promise<FavoriteEntry[]> {
    return waitForCellValue<FavoriteEntry[]>(
      runtime,
      home.key("favorites"),
      (favorites) => (favorites?.length ?? 0) > 0,
    );
  }

  function readFavoritesUntilEmpty(): Promise<FavoriteEntry[]> {
    return waitForCellValue<FavoriteEntry[]>(
      runtime,
      home.key("favorites"),
      (favorites) => favorites?.length === 0,
    );
  }

  it("stores the discovery tags it is given", async () => {
    const { piece, id } = makePiece("favorited-piece");
    await tx.commit().settled;
    tx = runtime.edit();

    home.key("addFavorite").send({
      piece,
      tags: ["alpha", "beta"],
      spaceName: "test-space",
      id,
    });

    const favorites = await readFavorites();
    expect(favorites.length).toBe(1);
    expect(favorites[0].tags).toEqual(["alpha", "beta"]);
    expect(favorites[0].userTags).toEqual([]);
    expect(favorites[0].id).toBe(id);
  });

  it("dedups a re-favorite and removes by piece identity", async () => {
    const { piece, id } = makePiece("favorited-piece");
    await tx.commit().settled;
    tx = runtime.edit();

    home.key("addFavorite").send({ piece, tags: ["one"], id });
    expect((await readFavorites()).length).toBe(1);

    // Re-favoriting the same piece resolves to the same key — no duplicate.
    home.key("addFavorite").send({ piece, tags: ["one"], id });
    for (let i = 0; i < 10; i++) await runtime.idle();
    expect(
      (home.key("favorites").get() as FavoriteEntry[] | undefined)?.length,
    ).toBe(1);

    // Unfavoriting removes the membership entry by identity.
    home.key("removeFavorite").send({ piece, id });
    expect(await readFavoritesUntilEmpty()).toEqual([]);
  });

  it("removes a legacy favorite (no keyed entity) via the piece-cell fallback", async () => {
    const { piece, id } = makePiece("legacy-piece");
    await tx.commit().settled;
    tx = runtime.edit();

    // Simulate a favorite added before keyed addressing: push a wrapper with no
    // id straight onto the list, so it lives at a per-event entity id the key
    // cannot reach.
    home.key("favorites").withTx(tx).push({
      cell: piece,
      tags: [],
      userTags: [],
    });
    // A manual test tx prepares the way the runtime's own commit paths do:
    // an enforcing rung refuses a relevant transaction that arrives
    // unprepared.
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    tx = runtime.edit();
    await runtime.idle();
    const seeded =
      (home.key("favorites").get() as FavoriteEntry[] | undefined) ?? [];
    expect(seeded.length).toBe(1);
    expect(seeded[0].id).toBeUndefined();

    // The keyed removal cannot reach it, so removeFavorite falls back to
    // matching the piece cell and still deletes it.
    home.key("removeFavorite").send({ piece, id });
    expect(await readFavoritesUntilEmpty()).toEqual([]);
  });
});
