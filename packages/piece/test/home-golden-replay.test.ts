import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getPatternIdentityRef,
  resolveEntryIdentity,
  resolveSystemPatternSource,
  Runtime,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createSession, Identity } from "@commonfabric/identity";
import {
  HOME_PATTERN_SOURCE,
  PiecesController,
} from "../src/ops/pieces-controller.ts";
import { reconcilePieceSource } from "../src/ops/piece-origin.ts";

// The route that ref expands to — what the toolshed serves, and what the
// worker names the module by when it compiles the pattern over HTTP.
const HOME_PATTERN_PATH = resolveSystemPatternSource(
  HOME_PATTERN_SOURCE,
)!;

// Golden replay for the HOME root — the higher-stakes sibling of
// default-app-golden-replay.test.ts.
//
// The home root (home.tsx) carries the user's REAL durable data — favorites,
// journal, spaces — where losing data on an update would be unrecoverable.
// This test is the state-survival evidence that lets home follow its origin
// like every other piece: seed representative
// home data, roll the home root N→N+1 in place, and prove every list survives
// intact and the new code runs over it.
//
// It is deliberately faithful to how real home OWNS its state. home.tsx does:
//   const favorites = new Writable<Favorite[]>([]).for("favorites");
//   const journal   = new Writable<JournalEntry[]>([]).for("journal");
//   const spaces    = new Writable<SpaceEntry[]>([]).for("spaces");
// The `.for(<label>)` gives each owned cell a STABLE cause ("id stability", per
// the comment at home.tsx:166) — which is exactly the discipline that lets an
// in-place re-instantiation keep the data instead of minting fresh empty cells.
// This test uses the same idiom, so a regression in that stable-key addressing
// would surface here as lost home data.

const signer = await Identity.fromPassphrase("home golden replay");

// A home-SHAPED synthetic root: owns three lists the way home.tsx does (stable
// `.for(...)` causes), and derives a reactive `summary` folding all three counts
// plus the version marker. The marker lives INSIDE the computed so it only
// surfaces through the swap if the new code actually runs (re-instantiation
// re-wires reactive nodes, not static result literals). Synthetic (not the real
// home.tsx) because home.tsx imports a half-dozen sibling modules that a
// single-file fetch stub can't resolve — but it reproduces the property that
// actually matters: owned, stable-key-addressed state read by a live derivation.
const rootSource = (version: string) =>
  [
    "import { pattern, computed, Writable } from 'commonfabric';",
    "type Favorite = { id: string; spaceName: string };",
    "type JournalEntry = { timestamp: number; narrative: string };",
    "type SpaceEntry = { name: string; did?: string };",
    "export default pattern<void>(() => {",
    "  const favorites = new Writable<Favorite[]>([]).for('favorites');",
    "  const journal = new Writable<JournalEntry[]>([]).for('journal');",
    "  const spaces = new Writable<SpaceEntry[]>([]).for('spaces');",
    "  return {",
    "    favorites,",
    "    journal,",
    "    spaces,",
    "    summary: computed(() =>",
    `      \`${version}:\` + favorites.get().length + '/' +`,
    "        journal.get().length + '/' + spaces.get().length),",
    "  };",
    "});",
    "",
  ].join("\n");

const ROOT_V1 = rootSource("v1");
const ROOT_V2 = rootSource("v2");

const SEEDED_FAVORITES = [{ id: "fav:notes", spaceName: "Work" }];
const SEEDED_JOURNAL = [{ timestamp: 1, narrative: "seeded entry" }];
const SEEDED_SPACES = [
  { name: "Work" },
  { name: "Personal", did: "did:key:zabc" },
];
// V1's summary over the seeds: "v1:<favs>/<journal>/<spaces>" = "v1:1/1/2".
const SEEDED_COUNTS =
  `${SEEDED_FAVORITES.length}/${SEEDED_JOURNAL.length}/${SEEDED_SPACES.length}`;

/** Content identity a toolshed would serve for `source`. */
function identityForSource(source: string): Promise<string> {
  return resolveEntryIdentity(
    HOME_PATTERN_PATH, // /api/patterns/system/home.tsx
    (name) =>
      name === HOME_PATTERN_PATH
        ? Promise.resolve(source)
        : Promise.reject(new Error(`not found: ${name}`)),
  );
}

interface StubControls {
  setSource(source: string): void;
  restore(): void;
}

function installFetchStub(): StubControls {
  const original = globalThis.fetch;
  let source = ROOT_V1;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const href = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    const url = new URL(href);

    if (url.pathname === HOME_PATTERN_PATH) {
      if (url.searchParams.has("identity")) {
        return new Response(await identityForSource(source), {
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response(source, {
        headers: { "content-type": "text/typescript-jsx" },
      });
    }

    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;

  return {
    setSource: (s) => (source = s),
    restore: () => (globalThis.fetch = original),
  };
}

describe("home golden replay (durable home state survives an in-place roll-forward)", () => {
  let stub: StubControls;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let controller: PiecesController;

  beforeEach(async () => {
    stub = installFetchStub();
    stub.setSource(ROOT_V1);
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      // One flag covers every tracked system root, home included.
    });
    // A HOME session: space === the user's identity DID, which is what flips
    // `isHomeSpace` on inside the controller (ensureDefaultPattern + the update
    // gate) so the home branch — cause "home-pattern", provenance HOME_PATTERN_PATH
    // — is exercised.
    const session = createSession({
      identity: signer,
      spaceDid: signer.did(),
    });
    expect(session.space).toBe(runtime.userIdentityDID);
    controller = new PiecesController(session, runtime);
    await controller.synced();
  });

  afterEach(async () => {
    try {
      await controller?.dispose();
    } catch { /* already disposed */ }
    await storageManager?.close();
    stub.restore();
  });

  it("carries seeded home state (favorites/journal/spaces) across the N→N+1 swap", async () => {
    // N: instantiate the home-shaped root.
    const piece = await controller.ensureDefaultPattern();
    const root = piece.getCell();
    const rootLinkBefore = JSON.stringify(root.getAsLink());
    const idV1 = getPatternIdentityRef(root)?.identity;
    expect(idV1).toBe(await identityForSource(ROOT_V1));

    // Standing subscriber (the graph is pull-based) that latches the RESOLVED
    // computed value — a bare `.get()` on a computed result key yields the
    // unresolved alias.
    let summary: unknown;
    const cancelSink = root.key("summary").sink((value) => {
      summary = value;
    });

    // Seed all three owned lists in one edit, the way a user filling their home
    // would (bare `.set()` throws ReadOnlyTransactionError — use editWithRetry).
    await runtime.editWithRetry((tx) => {
      root.withTx(tx).key("favorites").set([...SEEDED_FAVORITES]);
      root.withTx(tx).key("journal").set([...SEEDED_JOURNAL]);
      root.withTx(tx).key("spaces").set([...SEEDED_SPACES]);
    });
    await runtime.idle();
    expect(root.key("favorites").get()).toEqual(SEEDED_FAVORITES);
    expect(root.key("journal").get()).toEqual(SEEDED_JOURNAL);
    expect(root.key("spaces").get()).toEqual(SEEDED_SPACES);
    // V1's reactive summary sees every seeded list.
    expect(summary).toBe("v1:" + SEEDED_COUNTS);

    // N+1: the toolshed now serves a newer home (its `summary` logic changed).
    // Roll forward in place.
    stub.setSource(ROOT_V2);
    expect(
      await reconcilePieceSource(
        runtime,
        (await controller
          .getDefaultPattern(false))!,
      ),
    ).toBe("updated");
    // Let the watcher observe the meta change and re-instantiate, then pull so
    // the new instance actually executes.
    await runtime.idle();
    const rolled = (await controller.getDefaultPattern(false))!;
    await rolled.pull();
    await runtime.idle();

    // Same piece entity — the home root was rewritten in place, not re-minted.
    expect(JSON.stringify(rolled.getAsLink())).toBe(rootLinkBefore);

    // The identity advanced to V2.
    const idV2 = getPatternIdentityRef(rolled)?.identity;
    expect(idV2).toBe(await identityForSource(ROOT_V2));
    expect(idV2).not.toBe(idV1);

    // The crux: every seeded home list survived the swap, intact and in order.
    // No crash, no loss.
    expect(rolled.key("favorites").get()).toEqual(SEEDED_FAVORITES);
    expect(rolled.key("journal").get()).toEqual(SEEDED_JOURNAL);
    expect(rolled.key("spaces").get()).toEqual(SEEDED_SPACES);

    // And the NEW code is actually running over that survived state: the V2
    // computation (`v2:`, not `v1:`) reports the seeded counts.
    expect(summary).toBe("v2:" + SEEDED_COUNTS);

    cancelSink();
  });
});
