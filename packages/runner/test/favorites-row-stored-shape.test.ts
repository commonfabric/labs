import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path/from-file-url";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { toStructuredDebugValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";

// A pattern that maps over durable data must accept the rows its PRODUCER
// actually writes. Nothing checks that agreement: the row's element schema
// comes from the consumer's own type, the rows come from a handler in another
// pattern, and the two only meet when a stored row is re-staged.
//
// `favorites-manager.tsx` declared `tag: string` — required, no default — while
// home's `addFavorite` has only ever written `{ cell, tags, userTags,
// spaceName, id }` (`tags`, plural). Every stored favorite therefore failed the
// row's argument validation on resume:
//
//   updated arguments do not match the candidate schema:
//   element: missing required property tag
//
// The row never instantiated, the scheduler re-threw on every pass, and that
// loop starved the runtime — `cell:resolveAsCell` for the row's cells stopped
// being answered, so the links fell through to placeholder text and the tab
// read as empty. Nothing reached the page console: the throw is inside the
// worker runtime. One property with no producer, invisible for weeks.
//
// This drives the REAL shipped pattern over a row of exactly the shape
// `addFavorite` writes, THROUGH A PATTERN SWAP. Both halves matter. Adding a
// favorite to an already-running piece never re-stages the argument, so a
// fresh-data test stays green against the bug — which is precisely how the
// mismatch survived every existing test. The swap is what production does when
// the auto-update moves a piece to new source, and it is the moment the stored
// row is checked against the schema.

const signer = await Identity.fromPassphrase("favorites-row-stored-shape");
const space = signer.did();

/**
 * Whether any string anywhere in the debug form of `value` contains `text`.
 * The structured form is walked rather than a rendered string searched, so
 * that a match deep in a view tree is found rather than elided.
 */
function debugFormContains(value: unknown, text: string): boolean {
  const walk = (node: unknown): boolean => {
    if (typeof node === "string") {
      return node.includes(text);
    } else if (isObjectOrArray(node)) {
      return Object.values(node).some(walk);
    }
    return false;
  };
  return walk(
    toStructuredDebugValue(value, {
      maxDepth: 100,
      maxArrayLength: Infinity,
      maxProperties: Infinity,
      maxStringLines: Infinity,
    }),
  );
}

const FAVORITES_MANAGER_PATH = fromFileUrl(
  import.meta.resolve("../../patterns/system/favorites-manager.tsx"),
);

// Stands in for home.tsx as the space's default pattern: the wish target
// `#favorites` resolves to `<home space>.defaultPattern.favorites`, so what
// this exposes IS what favorites-manager reads.
const FAVORITES_HOST = [
  "import { Default, NAME, pattern, UI, Writable } from 'commonfabric';",
  "",
  "type Favorite = {",
  "  cell: Writable<{ [NAME]?: string }>;",
  // Exactly the keys home's addFavorite stores — `tags` plural, no `tag`.
  "  tags: string[];",
  "  userTags: Writable<string[]>;",
  "  spaceName?: string;",
  "  id?: string;",
  "};",
  "",
  "export default pattern<",
  "  Record<string, never>,",
  "  { favorites: Favorite[] | Default<[]> }",
  ">(() => {",
  "  const favorites = new Writable<Favorite[] | Default<[]>>([])",
  "    .for('favorites');",
  "  return {",
  "    [NAME]: 'Favorites Host',",
  "    [UI]: <div>host</div>,",
  "    favorites,",
  "  };",
  "});",
  "",
].join("\n");

// A piece for the favorite to point at, so the row holds a real cell link
// rather than a bare object.
const FAVORITED_PIECE = [
  "import { NAME, pattern, UI } from 'commonfabric';",
  "",
  "export default pattern<Record<string, never>>(() => ({",
  "  [NAME]: 'Favorited Thing',",
  "  [UI]: <div>thing</div>,",
  "}));",
  "",
].join("\n");

const programOf = (contents: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents }],
});

describe("a stored favorite row instantiates in favorites-manager", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let rt: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      // `#favorites` resolves against the identity's HOME space. `Runtime`
      // derives that DID from the storage manager's signer, which is this
      // space's signer, so there is nothing to pass here.
      experimental: {},
    });
  });
  afterEach(async () => {
    await rt?.dispose();
    await storageManager?.close();
  });

  it("survives a swap carrying exactly the keys addFavorite writes", async () => {
    const managerSource = await Deno.readTextFile(FAVORITES_MANAGER_PATH);
    // The row's failure is a THROWN scheduler action, not a rendering
    // difference: the map keeps the markup it produced before the swap, so the
    // UI alone cannot tell a re-instantiated row from a stale one. The error is
    // the assertion.
    const actionErrors: string[] = [];
    rt.scheduler.onError((error: unknown) =>
      actionErrors.push(
        String((error as { message?: string })?.message ?? error),
      )
    );

    const tx = rt.edit();

    // The space's default pattern supplies `#favorites`.
    const host = await rt.patternManager.compilePattern(
      programOf(FAVORITES_HOST),
      { space, tx },
    );
    const hostCell = rt.getCell<Record<string, unknown>>(
      space,
      "favorites-host",
      undefined,
      tx,
    );
    const hostRunning = rt.run(tx, host, {}, hostCell);

    // Something for the favorite to reference.
    const thing = await rt.patternManager.compilePattern(
      programOf(FAVORITED_PIECE),
      { space, tx },
    );
    const thingCell = rt.getCell<Record<string, unknown>>(
      space,
      "favorited-thing",
      undefined,
      tx,
    );
    rt.run(tx, thing, {}, thingCell);

    rt.getSpaceCell(space).withTx(tx).key("defaultPattern").set(
      hostCell as never,
    );
    await tx.commit();
    await hostRunning.pull();
    await rt.idle();

    // Write the row the way home's addFavorite does, then let it settle so the
    // manager below re-stages it from durable state rather than seeing it
    // appear while already running.
    const seedTx = rt.edit();
    hostCell.withTx(seedTx).key("favorites").set([
      // Post-#4197: discovery tags are plural, and the row is keyed by id.
      {
        cell: thingCell,
        tags: [],
        userTags: [],
        // `spaceName` is absent rather than explicitly undefined: an optional
        // property carrying `undefined` is a value of the wrong type, not an
        // omission, and the row is rejected for that instead.
        id: "favorite-1",
      },
      // Pre-#4197: a single `tag`, no `tags`, and no keyed `id`. Both vintages
      // are in real storage, so a projection that requires EITHER tag field
      // breaks one of them — this row is what keeps a future "fix" to a
      // required `tags: string[]` from passing.
      {
        cell: thingCell,
        tag: "#thing",
        userTags: [],
      },
    ] as never);
    await seedTx.commit();
    await rt.idle();

    // The REAL shipped pattern, over that stored row.
    const managerTx = rt.edit();
    const manager = await rt.patternManager.compilePattern(
      programOf(managerSource),
      { space, tx: managerTx },
    );
    const managerCell = rt.getCell<Record<string, unknown>>(
      space,
      "favorites-manager",
      undefined,
      managerTx,
    );
    const managerRunning = rt.run(managerTx, manager, {}, managerCell);
    await managerTx.commit();
    await managerRunning.pull();
    await rt.idle();

    // Sanity: the row is live before the swap, so a failure below is the swap's
    // re-stage and not a mis-seeded fixture.
    expect(
      debugFormContains(managerCell.getAsQueryResult(), "No favorites yet."),
    )
      .toBe(false);

    // The swap. Identity is content-addressed, so v2 has to differ in SOURCE —
    // a fresh transaction over identical bytes would compile to the same
    // identity and move nothing. The difference is the pattern's name, which
    // makes the swap positively observable below: without that, a run where
    // the pointer move silently did nothing would pass on "no errors" alone.
    const v2Tx = rt.edit();
    const v2 = await rt.patternManager.compilePattern(
      programOf(
        managerSource.replace(
          `[NAME]: "Favorites Manager"`,
          `[NAME]: "Favorites Manager v2"`,
        ),
      ),
      { space, tx: v2Tx },
    );
    const v2Ref = rt.patternManager.getArtifactEntryRef(v2)!;
    managerCell.withTx(v2Tx).setMetaRaw("patternIdentity", {
      identity: v2Ref.identity,
      symbol: v2Ref.symbol,
    }, rawMetaWriteAuthorization);
    await v2Tx.commit();
    await rt.idle();
    await rt.runner.idlePointerMaintenance();
    await rt.idle();

    // Before the fix the swap threw out of `applySetupState` with
    // "element: missing required property tag": the row never re-instantiated,
    // the scheduler re-threw on every pass, and that loop starved the cell
    // reads the links depend on.
    expect(actionErrors).toEqual([]);
    // The swap really landed: a no-op pointer move would leave the old name and
    // make the no-errors assertion above vacuous.
    expect(
      (managerCell.getAsQueryResult() as Record<string, unknown>)["$NAME"],
    ).toBe("Favorites Manager v2");
    expect(
      debugFormContains(managerCell.getAsQueryResult(), "No favorites yet."),
    )
      .toBe(false);
  });
});
