import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getPatternIdentityRef,
  getPatternSetupIdentityRef,
  isLink,
  resolveEntryIdentity,
  resolveSystemPatternSource,
  Runtime,
} from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { createSession, Identity } from "@commonfabric/identity";
import {
  DEFAULT_APP_PATTERN_SOURCE,
  PiecesController,
} from "../src/ops/pieces-controller.ts";
import { reconcilePieceSource } from "../src/ops/piece-origin.ts";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";

// The route that ref expands to — what the toolshed serves, and what the
// worker names the module by when it compiles the pattern over HTTP.
const DEFAULT_APP_PATTERN_PATH = resolveSystemPatternSource(
  DEFAULT_APP_PATTERN_SOURCE,
)!;

// Golden replay for non-home root state across an in-place update.
//
// The other swap tests prove that patternIdentity changes while the piece
// entity stays the same. This test seeds representative durable state under
// version N and updates the running root to version N+1. It verifies that the
// state remains intact and that the new code runs over it.

const signer = await Identity.fromPassphrase("default-app golden replay");

const newSharedServer = (): MemoryV2Server.Server => newLoopbackServer();

// Two versions of a default-app-shaped root with the same registry cause.
const ROOT_V1 = [
  "import { pattern, computed, Writable } from 'commonfabric';",
  "interface Profile { name: string; }",
  "interface Input { label?: string; profile?: Profile; }",
  "export default pattern<Input>(() => {",
  "  const pieceRegistry = new Writable<string[]>([]);",
  "  return {",
  "    pieceRegistry,",
  "    summary: computed(() => `v1:` + pieceRegistry.get().length),",
  "  };",
  "});",
  "",
].join("\n");

const ROOT_V2 = [
  "import { Default, pattern, computed, Writable } from 'commonfabric';",
  "interface Profile { name: string; }",
  "interface Input { label?: string; profile: Profile; count: number | Default<2>; }",
  "export default pattern<Input>(({ profile }) => {",
  "  const pieceRegistry = new Writable<string[]>([]);",
  "  return {",
  "    pieceRegistry,",
  "    summary: computed(() => `v2:` + pieceRegistry.get().length),",
  "    profileName: computed(() => profile.name),",
  "  };",
  "});",
  "",
].join("\n");

const SEEDED_PIECES = ["note:groceries", "note:standup", "notebook:trip"];

/** Content identity a toolshed would serve for `source`. */
function identityForSource(source: string): Promise<string> {
  return resolveEntryIdentity(
    DEFAULT_APP_PATTERN_PATH,
    (name) =>
      name === DEFAULT_APP_PATTERN_PATH
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

    if (url.pathname === DEFAULT_APP_PATTERN_PATH) {
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

describe("default-app golden replay (state survives an in-place roll-forward)", () => {
  let stub: StubControls;
  let server: MemoryV2Server.Server;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;
  let controller: PiecesController;

  beforeEach(async () => {
    stub = installFetchStub();
    stub.setSource(ROOT_V1);
    server = newSharedServer();
    storageManager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const session = createSession({
      identity: signer,
      spaceDid: await runtime.createSpace(),
    });
    controller = new PiecesController(session, runtime);
    await controller.synced();
  });

  afterEach(async () => {
    try {
      await controller?.dispose();
    } catch { /* already disposed */ }
    await storageManager?.close();
    await server?.close();
    stub.restore();
  });

  it("preserves registry state without restoring removed pieces", async () => {
    // N: instantiate the default-app-shaped root.
    const piece = await controller.ensureDefaultPattern();
    const root = piece.getCell();
    const rootLinkBefore = JSON.stringify(root.getAsLink());
    const idV1 = getPatternIdentityRef(root)?.identity;
    expect(idV1).toBe(await identityForSource(ROOT_V1));

    // Keep a live subscription on the root's reactive `summary`, the way a
    // mounted shell would. The graph is pull-based; without a standing consumer
    // the re-instantiated pattern would be built but never execute, and we would
    // only be testing the meta swap (which the sibling tests already cover), not
    // that the new code actually runs and re-reads the seeded state. The sink
    // also delivers the RESOLVED computed value (a bare `.get()` on a computed
    // result key yields the unresolved alias), which we latch here.
    let summary: unknown;
    const cancelSink = root.key("summary").sink((value) => {
      summary = value;
    });

    // Seed representative state: add pieces to the running root, the way a
    // user filling a fresh space would, and confirm they landed durably.
    await runtime.editWithRetry((tx) => {
      root.withTx(tx).key("pieceRegistry").set([...SEEDED_PIECES]);
    });
    await piece.setInput({ profile: { name: "warm" } });
    await runtime.idle();
    expect(root.key("pieceRegistry").get()).toEqual(SEEDED_PIECES);
    // V1's reactive summary sees the seeded state.
    expect(summary).toBe("v1:" + SEEDED_PIECES.length);

    // N+1: the toolshed now serves a newer default-app (its `summary` logic
    // changed). Roll forward in place.
    stub.setSource(ROOT_V2);
    expect(
      await reconcilePieceSource(
        runtime,
        (await controller
          .getDefaultPattern(false))!,
      ),
    ).toBe("updated");
    // Let the pattern watcher observe the meta change and re-instantiate, then
    // pull the root so the new instance actually executes (pull-based graph).
    await runtime.idle();
    const rolled = (await controller.getDefaultPattern(false))!;
    await rolled.pull();

    const registryRoot = rolled.asSchema(
      {
        type: "object",
        properties: {
          pieceRegistry: { type: "array", items: { type: "string" } },
        },
      } as const,
    );
    let pieceRegistry: unknown;
    const cancelPieceRegistrySink = registryRoot.key("pieceRegistry").sink(
      (value) => {
        pieceRegistry = value;
      },
    );
    await runtime.idle();

    // Same piece entity — the root was rewritten in place, not re-minted.
    expect(JSON.stringify(rolled.getAsLink())).toBe(rootLinkBefore);

    // The identity advanced to V2.
    const idV2 = getPatternIdentityRef(rolled)?.identity;
    expect(idV2).toBe(await identityForSource(ROOT_V2));
    expect(idV2).not.toBe(idV1);

    // The new computation proves that V2 is running before we inspect the
    // registry state.
    expect(summary).toBe("v2:" + SEEDED_PIECES.length);

    // The crux: the state seeded under V1 survived the swap, intact and in
    // order. No crash, no loss.
    expect(pieceRegistry).toEqual(SEEDED_PIECES);

    // Emptying the registry later is intentional user state.
    await runtime.editWithRetry((tx) => {
      rolled.withTx(tx).key("pieceRegistry").set([]);
    });
    await runtime.idle();
    expect(pieceRegistry).toEqual([]);
    expect(summary).toBe("v2:0");

    cancelPieceRegistrySink();
    cancelSink();
  });

  it("preserves the registry before a cold root starts", async () => {
    const piece = await controller.ensureDefaultPattern();
    const root = piece.getCell();
    const profilePattern = await runtime.patternManager.compilePattern(
      {
        main: "/cold-update-profile.tsx",
        files: [{
          name: "/cold-update-profile.tsx",
          contents: [
            "import { pattern } from 'commonfabric';",
            "export default pattern<void>(() => ({ name: 'Ada' }));",
            "",
          ].join("\n"),
        }],
      },
      { space: controller.getSpace() },
    );
    const profile = await controller.runPersistent<{ name: string }>(
      profilePattern,
      {},
      "cold update profile",
    );
    await runtime.editWithRetry((tx) => {
      root.withTx(tx).key("pieceRegistry").set([...SEEDED_PIECES]);
    });
    await piece.setInput({ label: "durable", profile });
    const storedProfile = (controller.getArgument(root).getRawUntyped() as {
      profile?: unknown;
    }).profile;
    expect(isLink(storedProfile)).toBe(true);
    await runtime.idle();
    await controller.synced();
    await controller.stopPiece(root);

    stub.setSource(ROOT_V2);
    const session = createSession({
      identity: signer,
      spaceDid: controller.getSpace(),
    });
    const readerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const freshRuntime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: readerStorage,
    });
    const freshController = new PiecesController(session, freshRuntime);
    let cancelPieceRegistrySink: (() => void) | undefined;

    try {
      await freshController.synced();
      const profileLink = profile.getAsNormalizedFullLink();
      const readerReplica = readerStorage.open(
        controller.getSpace(),
      ) as unknown as {
        get?: (uri: string, scope?: unknown) => unknown;
      };
      expect(
        readerReplica.get?.(profileLink.id, profileLink.scope),
      ).toBeUndefined();
      const coldRoot = await freshController.getDefaultPattern(false);
      expect(coldRoot).toBeDefined();
      expect(await reconcilePieceSource(freshRuntime, coldRoot!))
        .toBe("updated");
      expect(
        readerReplica.get?.(profileLink.id, profileLink.scope),
      ).toBeDefined();
      const updated = await freshController.ensureDefaultPattern();
      const updatedRoot = updated.getCell().asSchema(
        {
          type: "object",
          properties: {
            pieceRegistry: { type: "array", items: { type: "string" } },
          },
        } as const,
      );

      let pieceRegistry: unknown;
      cancelPieceRegistrySink = updatedRoot.key("pieceRegistry").sink(
        (value) => {
          pieceRegistry = value;
        },
      );
      await freshRuntime.idle();

      expect(getPatternIdentityRef(updatedRoot)?.identity).toBe(
        await identityForSource(ROOT_V2),
      );
      expect(pieceRegistry).toEqual(SEEDED_PIECES);
      const updatedArgument = freshController.getArgument(updatedRoot);
      await updatedArgument.pull();
      expect(updatedArgument.get()).toEqual({
        label: "durable",
        profile: { name: "Ada" },
        count: 2,
      });
    } finally {
      cancelPieceRegistrySink?.();
      await freshController.dispose();
      await readerStorage.close();
    }
  });

  /**
   * A root pinned to V2 whose stored setup was staged by V1, started as it is.
   * Returns the V2 entry ref the root now points at.
   */
  async function stageMetadataOnlyRollForward() {
    const piece = await controller.ensureDefaultPattern();
    const root = piece.getCell();
    await piece.setInput({ profile: { name: "warm" } });
    await runtime.idle();
    await controller.stopPiece(root);

    stub.setSource(ROOT_V2);
    const currentPattern = await runtime.patternManager.compilePattern(
      {
        main: DEFAULT_APP_PATTERN_PATH,
        files: [{ name: DEFAULT_APP_PATTERN_PATH, contents: ROOT_V2 }],
      },
      { space: controller.getSpace() },
    );
    const currentRef = runtime.patternManager.getArtifactEntryRef(
      currentPattern,
    )!;
    const { error } = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw(
        "patternIdentity",
        currentRef,
        rawMetaWriteAuthorization,
      );
    });
    expect(error).toBeUndefined();
    const metadataOnlyRoot = (await controller.getDefaultPattern(false))!;
    await controller.startPiece(metadataOnlyRoot);
    return currentRef;
  }

  /**
   * Run `body` with pattern loads for `identity` answered by `answer` instead
   * of by the pattern manager.
   */
  async function withLoadFor(
    identity: string,
    answer: () => Promise<undefined>,
    body: () => Promise<void>,
  ) {
    const manager = runtime.patternManager;
    const load = manager.loadPatternByIdentity.bind(manager);
    manager.loadPatternByIdentity = (...args: Parameters<typeof load>) =>
      args[0] === identity ? answer() : load(...args);
    try {
      await body();
    } finally {
      manager.loadPatternByIdentity = load;
    }
  }

  it("leaves the root alone when its pinned pattern will not load", async () => {
    // The re-stage repairs a document whose stored setup an older version
    // staged. With no pattern to stage from there is nothing to repair with,
    // so the root is left exactly as it is rather than half-written.
    const currentRef = await stageMetadataOnlyRollForward();

    await withLoadFor(
      currentRef.identity,
      () => Promise.resolve(undefined),
      async () => {
        await controller.ensureDefaultPattern();
      },
    );
    await runtime.idle();

    const after = (await controller.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)).toEqual(currentRef);
    expect(getPatternSetupIdentityRef(after)).not.toEqual(currentRef);
  });

  it("leaves the root alone when loading its pinned pattern throws", async () => {
    const currentRef = await stageMetadataOnlyRollForward();

    await withLoadFor(
      currentRef.identity,
      () => Promise.reject(new Error("the pattern index is unreadable")),
      async () => {
        await controller.ensureDefaultPattern();
      },
    );
    await runtime.idle();

    const after = (await controller.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)).toEqual(currentRef);
    expect(getPatternSetupIdentityRef(after)).not.toEqual(currentRef);
  });

  it("repairs a metadata-only roll-forward to the current pattern", async () => {
    const piece = await controller.ensureDefaultPattern();
    const root = piece.getCell();
    await piece.setInput({ profile: { name: "warm" } });
    await runtime.editWithRetry((tx) => {
      root.withTx(tx).key("pieceRegistry").set([...SEEDED_PIECES]);
    });
    await runtime.idle();
    await controller.stopPiece(root);

    stub.setSource(ROOT_V2);
    const currentPattern = await runtime.patternManager.compilePattern(
      {
        main: DEFAULT_APP_PATTERN_PATH,
        files: [{ name: DEFAULT_APP_PATTERN_PATH, contents: ROOT_V2 }],
      },
      { space: controller.getSpace() },
    );
    const currentRef = runtime.patternManager.getArtifactEntryRef(
      currentPattern,
    )!;
    expect(currentRef.identity).toBe(await identityForSource(ROOT_V2));
    expect(
      (currentPattern.resultSchema as { required?: string[] }).required,
    ).toContain("profileName");

    // Reproduce the updater that advanced only patternIdentity. The persisted
    // root still carries V1's stored schema and projection.
    const metadataUpdate = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw(
        "patternIdentity",
        currentRef,
        rawMetaWriteAuthorization,
      );
    });
    expect(metadataUpdate.error).toBeUndefined();
    const metadataOnlyRoot = (await controller.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(metadataOnlyRoot)).toEqual(currentRef);
    expect(metadataOnlyRoot.getMetaRaw("schema")).not.toEqual(
      currentPattern.resultSchema,
    );
    await controller.startPiece(metadataOnlyRoot);
    expect(metadataOnlyRoot.key("profileName").getRaw()).toBeUndefined();

    // Opening the root re-stages a document its pinned pattern did not set
    // up, which is what repairs the projection. The repair writes through a
    // transaction of its own, so read the root it hands back rather than the
    // one captured before it: the older cell still describes the metadata the
    // re-stage replaced.
    const repaired = await controller.ensureDefaultPattern();
    await runtime.idle();
    expect(getPatternSetupIdentityRef(repaired.getCell())).toEqual(currentRef);

    const repairedRoot = repaired.getCell().asSchema(
      {
        type: "object",
        properties: {
          pieceRegistry: { type: "array", items: { type: "string" } },
          profileName: { type: "string" },
        },
      } as const,
    );
    let pieceRegistry: unknown;
    const cancelPieceRegistrySink = repairedRoot.key("pieceRegistry").sink(
      (value) => {
        pieceRegistry = value;
      },
    );
    await repairedRoot.pull();
    await runtime.idle();

    // `profileName` is V2's alone, and the projection carrying it is what the
    // re-stage writes. `pieceRegistry` was seeded under V1 and survives a root
    // that was never repaired, so it says nothing on its own.
    expect(repairedRoot.key("profileName").get()).toBe("warm");
    expect(pieceRegistry).toEqual(SEEDED_PIECES);
    cancelPieceRegistrySink();
  });
});
