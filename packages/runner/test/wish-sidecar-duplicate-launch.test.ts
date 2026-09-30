import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { resolveEntryIdentity } from "../src/index.ts";
import { Runtime } from "../src/runtime.ts";
import {
  sidecarRunFailureDisposition,
  sidecarValueIsWinner,
  wishSidecarDiagnostics,
} from "../src/builtins/wish.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { NAME, UI } from "../src/builder/types.ts";
import {
  getPatternEnvironment,
  setPatternEnvironment,
} from "../src/builder/env.ts";

// The profile-resolution starvation family's reproduced member (2026-08-25,
// OW45 residue): when the `#profile` wish node's create-surface sidecar is
// launched MORE THAN ONCE before opening its surface answers, every launch
// chains its own instantiation continuation on that open, and the answer runs
// the sidecar repeatedly into the SAME
// cause-derived result cell. One run wins; a duplicate's commit fails on the
// conflict class (StorageTransactionInconsistent / ConflictError — its
// snapshot predates the winner), and its error arm then REPLACED the winner's
// materialized surface with an error UI (`commitPatternErrorUI`), removing
// `$NAME`/`createProfile` and leaving the only route to a first profile a
// dead error box. On a serving runtime the wave folds winner-then-clobber
// into one commit, so the durable state is the error box from birth; live
// evidence: the #6248 ensure-ON board's profile shards and 6/11 local reds at
// main 35ab29c38 — every red store carries the `remove /value/$NAME` +
// error-span patch on the create surface's cell.
//
// The duplicate here is driven the way the live one is: two runs of the same
// content-addressed pattern (two runtimes over one store — the serving loop's
// re-runs of one wish node are the same shape) open one cause-derived sidecar
// piece, so both continuations instantiate into one address. The contract
// pinned: the materialized create surface survives the losing duplicate.
const signer = await Identity.fromPassphrase("wish-sidecar-duplicate-launch");
const homeSpace = signer.did();

const read = (name: string) =>
  Deno.readTextFileSync(
    fromFileUrl(new URL("../../patterns/system/", import.meta.url)) + name,
  );

// The patterns route serves each file under this prefix, and the worker names
// every module it fetched by its pathname, so a served pattern's identity is
// resolved over the same names the route answers for.
const PATTERNS_ROUTE = "/api/patterns/system/";

const identityOfPattern = (name: string) =>
  resolveEntryIdentity(
    PATTERNS_ROUTE + name,
    (module) => Promise.resolve(read(module.slice(PATTERNS_ROUTE.length))),
  );

// The create surface's program as the route serves it, named by the pathnames
// the worker gives modules it fetched over HTTP — the same names the identity
// is resolved over, so compiling this produces the identity the route
// advertises.
const SURFACE_PROGRAM: RuntimeProgram = {
  main: PATTERNS_ROUTE + "profile-create.tsx",
  files: [
    {
      name: PATTERNS_ROUTE + "profile-create.tsx",
      contents: read("profile-create.tsx"),
    },
    {
      name: PATTERNS_ROUTE + "profile-home.tsx",
      contents: read("profile-home.tsx"),
    },
  ],
};

const WISH_SRC = [
  "import { pattern, wish } from 'commonfabric';",
  "export default pattern(() => ({",
  "  profile: wish({ query: '#profile' }),",
  "}));",
].join("\n");

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents: WISH_SRC }],
};

const RESULT_CAUSE = "wish-sidecar-duplicate-launch-result";

describe("wish profile-create sidecar duplicate launch", () => {
  let server: MemoryV2Server.Server;
  let managerA: EmulatedStorageManager;
  let managerB: EmulatedStorageManager;
  let originalFetch: typeof globalThis.fetch;
  let originalEnvironment: ReturnType<typeof getPatternEnvironment>;

  beforeEach(() => {
    server = newSharedServer();
    managerA = EmulatedStorageManager.connectTo(server, { as: signer });
    managerB = EmulatedStorageManager.connectTo(server, { as: signer });
    originalFetch = globalThis.fetch;
    originalEnvironment = getPatternEnvironment();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    setPatternEnvironment(originalEnvironment);
    await managerA?.close();
    await managerB?.close();
    await server?.close();
  });

  it("a duplicate pre-fetch launch does not clobber the materialized create surface", async () => {
    // Serve the REAL profile-create.tsx (+ its profile-home.tsx import). The
    // IDENTITY response is gated: it signals when the first launch's open is
    // in flight and releases only once BOTH runtimes' launches have registered
    // their continuations on their opens — the duplicate-launch window, held
    // open deterministically.
    const createIdentity = await identityOfPattern("profile-create.tsx");
    const entryRequested = Promise.withResolvers<void>();
    const entryGate = Promise.withResolvers<void>();
    globalThis.fetch = ((input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("profile-create.tsx")) {
        if (new URL(url).searchParams.has("identity")) {
          entryRequested.resolve();
          return entryGate.promise.then(() =>
            new Response(createIdentity, { status: 200 })
          );
        }
        return Promise.resolve(
          new Response(read("profile-create.tsx"), { status: 200 }),
        );
      }
      if (url.includes("profile-home.tsx")) {
        return Promise.resolve(
          new Response(read("profile-home.tsx"), { status: 200 }),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as typeof fetch;

    const rt1 = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: managerA,
      cfcFlowLabels: "persist",
    });
    const rt2 = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: managerB,
      cfcFlowLabels: "persist",
    });
    try {
      // Home space with a profile-less default pattern: `#profile` resolves
      // to the missing-profile state, whose UI is the create surface.
      const setupTx = rt1.edit();
      const homeSpaceCell = rt1.getSpaceCell(homeSpace);
      const homeDefault = rt1.getCell(
        homeSpace,
        "duplicate-launch-home-default",
        undefined,
        setupTx,
      );
      homeDefault.key("marker").set("home");
      // deno-lint-ignore no-explicit-any
      (homeSpaceCell.withTx(setupTx) as any).key("defaultPattern").set(
        homeDefault,
      );
      rt1.prepareTxForCommit(setupTx);
      const setupCommit = await setupTx.commit();
      expect(setupCommit.error).toBeUndefined();
      await rt1.storageManager.synced();

      // Both runtimes hold the create surface's artifact before either
      // launches. Each surface is opened on its own, so what makes the two
      // instantiations collide is that neither has any work left to do once
      // the gate releases: the identity route names an artifact the space
      // already holds, so both go straight from that one response to
      // instantiating, inside one round-trip of each other. Without this each
      // open would fetch and compile the closure at its own pace and the
      // duplicate this test exists to witness would be a coin toss.
      for (const rt of [rt1, rt2]) {
        const surface = await rt.patternManager.compilePattern(
          SURFACE_PROGRAM,
          { space: homeSpace },
        );
        expect(
          rt.patternManager.getArtifactEntryRef(surface)?.identity,
          "the pre-warmed surface must be the one the identity route names, " +
            "or the open falls back to fetching and the race is a coin toss",
        ).toBe(createIdentity);
      }
      await rt1.patternManager.flushCompileCacheWrites();
      await rt2.patternManager.flushCompileCacheWrites();

      // Both runtimes compile the same source — content-addressed, so the
      // wish node (and with it the sidecar slot cells) shares one cause.
      const tx1 = rt1.edit();
      const pattern1 = await rt1.patternManager.compilePattern(PROGRAM, {
        space: homeSpace,
        tx: tx1,
      });
      const result1 = rt1.getCell<Record<string, unknown>>(
        homeSpace,
        RESULT_CAUSE,
        undefined,
        tx1,
      );
      // deno-lint-ignore no-explicit-any
      const run1 = rt1.run(tx1, pattern1 as any, {}, result1);
      rt1.prepareTxForCommit(tx1);
      const commit1 = await tx1.commit();
      expect(commit1.error).toBeUndefined();

      // Demand drives the compiled piece's wish action (which fires the
      // launch); the pull itself may then park behind the gated fetch, so it
      // is raced against the entry witness rather than awaited.
      const demand1 = run1.pull().catch(() => {});
      await Promise.race([demand1, entryRequested.promise]);
      // The first launch's open is in flight (the identity request is the
      // witness); the gate keeps the window open while the SAME piece —
      // hence the same wish node, the same cause-derived sidecar cells —
      // starts in the second runtime. Its launch opens the same piece and
      // registers the duplicate continuation.
      await entryRequested.promise;
      const opensBefore = wishSidecarDiagnostics.profileCreateSurfaceOpens;
      const runsBefore = wishSidecarDiagnostics.sidecarRunsStarted;
      const racedBefore = wishSidecarDiagnostics.sidecarRunsRaced;

      await rt1.patternManager.flushCompileCacheWrites();
      await rt1.storageManager.synced();
      const piece2 = rt2.getCellFromLink(run1.getAsNormalizedFullLink());
      await piece2.sync();
      const started = await rt2.start(piece2);
      expect(started).toBe(true);
      // Demand drives rt2's wish action too; its pull may also park behind
      // the gate, so it is left racing.
      const demand2 = piece2.pull().catch(() => {});
      void demand2;
      // STRUCTURAL WITNESS: wait until rt2's launch has chained the
      // duplicate continuation on its own in-flight open (counted at
      // registration in wish.ts's diagnostics seam). The gate is held, so
      // this wait cannot lose a race; the bound only converts a hung
      // scheduler into a loud failure instead of a hang.
      for (let attempt = 0; attempt < 500; attempt++) {
        if (
          wishSidecarDiagnostics.profileCreateSurfaceOpens > opensBefore
        ) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(wishSidecarDiagnostics.profileCreateSurfaceOpens)
        .toBeGreaterThan(opensBefore);

      // Release the gate: every registered continuation instantiates into
      // the same cause-derived cell; idle() covers the tracked launches.
      entryGate.resolve();
      await Promise.all([rt1.idle(), rt2.idle()]);
      await run1.pull();
      await rt1.idle();
      await rt2.idle();

      // The wish UI names the create-surface cell the launches filled.
      await run1.pull();
      const createCell = run1.key("profile").key(UI).key("props").key("$cell")
        .resolveAsCell();
      await createCell.sync();
      await createCell.pull();

      // The contract: the materialized create surface survives the duplicate.
      // Pre-fix, the losing duplicate's conflict-class commit error wrote an
      // error UI over the winner (remove $NAME/createProfile, $UI -> an error
      // span carrying "Transaction consistency violated").
      // Vacuity killer: the duplicate instantiation actually RAN (rt1's
      // and rt2's continuations both invoked runSidecarInOwnTx) — without
      // this, a timing miss would green the contract assertions on a
      // single launch that raced nothing.
      expect(wishSidecarDiagnostics.sidecarRunsStarted - runsBefore)
        .toBeGreaterThanOrEqual(2);
      // And the losing duplicate took the WINNER-CHECKED YIELD path (the
      // fix's central arm), not a clean serialize or a silent drop: the
      // raced counter increments exactly when a conflict-class loser
      // yields to a materialized winner.
      expect(wishSidecarDiagnostics.sidecarRunsRaced - racedBefore)
        .toBeGreaterThanOrEqual(1);

      const surface = createCell.get() as Record<string | symbol, unknown>;
      const raw = JSON.stringify(createCell.getRaw());
      // Both conflict-class spellings the loser's error arm can carry.
      expect(raw).not.toContain("Transaction consistency violated");
      expect(raw).not.toContain("stale confirmed read");
      expect(surface?.[NAME]).toBe("Create Profile");
      expect(Object.keys(surface ?? {})).toContain("createProfile");
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});

//
// The failure disposition, exhaustively
//
// The discrimination itself — this is the shared decision both
// the commit-error arm AND the thrown-error arm of runSidecarInOwnTx consume
// (a thrown conflict carries the same object shape as a commit-refused one).
// The thrown arm is not deterministically drivable through the public flow
// (it needs a third-party write to land between a transaction's snapshot and
// its own reads), so the semantics are pinned here and each arm reduces to a
// mechanical consume of this function; the flow-level pin above covers the
// commit arm end to end.
//

describe("sidecarRunFailureDisposition", () => {
  const conflict = { name: "ConflictError" };
  const inconsistent = { name: "StorageTransactionInconsistent" };
  const aborted = { name: "StorageTransactionAborted" };

  it("yields to a materialized winner on either conflict spelling", async () => {
    expect(await sidecarRunFailureDisposition(conflict, () => true, false))
      .toBe("yield");
    expect(await sidecarRunFailureDisposition(inconsistent, () => true, false))
      .toBe("yield");
    // A winner outranks the attempt budget: yield even on the last attempt.
    expect(await sidecarRunFailureDisposition(conflict, () => true, true))
      .toBe("yield");
    // The probe may be async (the real winnerInCell is).
    expect(
      await sidecarRunFailureDisposition(
        inconsistent,
        () => Promise.resolve(true),
        true,
      ),
    ).toBe("yield");
  });

  it("re-runs an input-doc conflict (no winner) while attempts remain", async () => {
    expect(await sidecarRunFailureDisposition(conflict, () => false, false))
      .toBe("retry");
    expect(await sidecarRunFailureDisposition(inconsistent, () => false, false))
      .toBe("retry");
  });

  it("ends a winnerless conflict on the last attempt with the error UI", async () => {
    expect(await sidecarRunFailureDisposition(conflict, () => false, true))
      .toBe("error-ui");
    expect(await sidecarRunFailureDisposition(inconsistent, () => false, true))
      .toBe("error-ui");
  });

  it("routes real failures to the error UI without consulting the winner probe", async () => {
    const probeNotConsulted = () => {
      throw new Error("winner probe must not run for non-conflict failures");
    };
    expect(
      await sidecarRunFailureDisposition(aborted, probeNotConsulted, false),
    )
      .toBe("error-ui");
    expect(
      await sidecarRunFailureDisposition(
        { name: "WishError" },
        probeNotConsulted,
        true,
      ),
    ).toBe("error-ui");
    expect(
      await sidecarRunFailureDisposition(undefined, probeNotConsulted, false),
    ).toBe("error-ui");
    expect(
      await sidecarRunFailureDisposition(null, probeNotConsulted, false),
    ).toBe("error-ui");
  });
});

//
// Which value wins
//

describe("sidecarValueIsWinner", () => {
  // The winner predicate itself (Cubic P2, review round): an error ACCOUNT left
  // by commitPatternErrorUI must NOT count as a racing winner — yielding to it
  // would leave the surface permanently red and defeat the heal path.

  it("an empty cell is no winner", () => {
    expect(sidecarValueIsWinner(undefined)).toBe(false);
  });
  it("a materialized surface is a winner", () => {
    expect(sidecarValueIsWinner({ [NAME]: "Create Profile", [UI]: {} }))
      .toBe(true);
    // Marker-less values stay winners — only the explicit error account is
    // excluded (a legit UI-only surface must never be mistaken for one, or
    // the loser retries against the real winner and clobbers it terminally).
    expect(sidecarValueIsWinner({ [UI]: {} })).toBe(true);
  });
  it("an error account is NOT a winner", () => {
    expect(sidecarValueIsWinner({ [UI]: {}, sidecarError: "fetch failed" }))
      .toBe(false);
  });
});
