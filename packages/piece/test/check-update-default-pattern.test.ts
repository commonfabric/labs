import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getMetaLink,
  getPatternIdentityRef,
  getPatternSetupIdentityRef,
  getPatternSource,
  getPieceSourceRevisions,
  parseLink,
  resolveEntryIdentity,
  resolveSystemPatternSource,
  resultSchemaMetaSpelling,
  Runtime,
  setPatternSource,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON } from "@commonfabric/runner/cfc/migration-reason";
import { createSession, Identity } from "@commonfabric/identity";
import { HttpProgramResolver } from "@commonfabric/js-compiler/program";
import { FabricLink } from "@commonfabric/data-model/fabric-instances";
import {
  DEFAULT_APP_PATTERN_SOURCE,
  HOME_PATTERN_SOURCE,
  PiecesController,
} from "../src/ops/pieces-controller.ts";
import {
  readPieceSourceState,
  reconcilePieceSource,
} from "../src/ops/piece-origin.ts";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { getLogger } from "@commonfabric/utils/logger";

// The routes those refs resolve to. A system pattern is still SERVED at, and
// its modules still NAMED by, the route path; the `system:` ref is what a
// piece stores as provenance.
const DEFAULT_APP_PATTERN_PATH = resolveSystemPatternSource(
  DEFAULT_APP_PATTERN_SOURCE,
)!;
const HOME_PATTERN_PATH = resolveSystemPatternSource(HOME_PATTERN_SOURCE)!;

const signer = await Identity.fromPassphrase("check update default pattern");

const patternSource = (marker: string) =>
  [
    "import { pattern } from 'commonfabric';",
    `export default pattern<{ items?: string[] }>(({ items }) => ({ items, marker: "${marker}" }));`,
    "",
  ].join("\n");

const SOURCE_V1 = patternSource("v1");
const SOURCE_V2 = patternSource("v2");
// A roll target WITH a handler: a handler's stream is an internal cell the
// (reused) root doc has to materialize — the dimension the plain sources
// above never exercise, and the estuary post-swap failure class.
const SOURCE_V3_HANDLER = [
  "import { Writable, handler, pattern } from 'commonfabric';",
  "const bump = handler<void, { count: Writable<number> }>((_, { count }) => {",
  "  count.set((count.get() ?? 0) + 1);",
  "});",
  "export default pattern<{ items?: string[] }>(({ items }) => {",
  "  const count = new Writable<number>(0).for('count');",
  "  return { items, count, bump: bump({ count }) };",
  "});",
  "",
].join("\n");

// Two home-shaped pattern identities for exercising roll-forward orchestration.
// The rejected repair below is injected with the production migration token;
// these output shapes do not themselves cause it. A generated required result
// is compatible because setup materializes it.
const SOURCE_HOME_OLD_REQUIRED = [
  "import { Writable, handler, pattern } from 'commonfabric';",
  "const bump = handler<void, { count: Writable<number> }>((_, { count }) => {",
  "  count.set((count.get() ?? 0) + 1);",
  "});",
  "interface Output { items: Writable<string[]>; favorites: Writable<string[]>; }",
  "export default pattern<{ items?: string[] }, Output>(() => {",
  "  const items = new Writable<string[]>([]).for('items');",
  "  const favorites = new Writable<string[]>([]).for('favorites');",
  "  const count = new Writable<number>(0).for('count');",
  "  return { items, favorites, count, bump: bump({ count }) };",
  "});",
  "",
].join("\n");

// The roll-forward target differs by a schema default, giving the tests a
// distinct compiled identity that materializes the reused document cleanly.
const SOURCE_HOME_OFFICIAL_DEFAULTED = [
  "import { Default, Writable, handler, pattern } from 'commonfabric';",
  "const bump = handler<void, { count: Writable<number> }>((_, { count }) => {",
  "  count.set((count.get() ?? 0) + 1);",
  "});",
  "interface Output { items: Writable<string[]>; favorites: Writable<string[] | Default<[]>>; }",
  "export default pattern<{ items?: string[] }, Output>(() => {",
  "  const items = new Writable<string[]>([]).for('items');",
  "  const favorites = new Writable<string[]>([]).for('favorites');",
  "  const count = new Writable<number>(0).for('count');",
  "  return { items, favorites, count, bump: bump({ count }) };",
  "});",
  "",
].join("\n");

// A single module exporting BOTH a defaulted `default` (official) and an
// obsolete `legacyHome` named export (old required, un-migratable). Because
// entry identity is content-addressed over the whole module source, both
// exports share ONE identity and differ only by symbol — exactly the state a
// root pinned to `{ currentArtifact, obsoleteSymbol }` is in. Compiling
// `legacyHome` gives a loadable-but-unrunnable entry; the heal must roll it
// forward to the `default` entry rather than short-circuit on the shared
// identity.
const SOURCE_HOME_TWO_EXPORT = [
  "import { Default, Writable, handler, pattern } from 'commonfabric';",
  "const bump = handler<void, { count: Writable<number> }>((_, { count }) => {",
  "  count.set((count.get() ?? 0) + 1);",
  "});",
  "interface OldOutput { items: Writable<string[]>; favorites: Writable<string[]>; }",
  "interface NewOutput { items: Writable<string[]>; favorites: Writable<string[] | Default<[]>>; }",
  "export const legacyHome = pattern<{ items?: string[] }, OldOutput>(() => {",
  "  const items = new Writable<string[]>([]).for('items');",
  "  const favorites = new Writable<string[]>([]).for('favorites');",
  "  const count = new Writable<number>(0).for('count');",
  "  return { items, favorites, count, bump: bump({ count }) };",
  "});",
  "export default pattern<{ items?: string[] }, NewOutput>(() => {",
  "  const items = new Writable<string[]>([]).for('items');",
  "  const favorites = new Writable<string[]>([]).for('favorites');",
  "  const count = new Writable<number>(0).for('count');",
  "  return { items, favorites, count, bump: bump({ count }) };",
  "});",
  "",
].join("\n");

const SOURCE_HOME_GUARDED_DEFAULT = [
  "import { Cfc, Default, RepresentsCurrentUser, Writable, WriteAuthorizedBy, handler, pattern } from 'commonfabric';",
  "const bump = handler<void, { count: Writable<number> }>((_, { count }) => {",
  "  count.set((count.get() ?? 0) + 1);",
  "});",
  "type GuardedRow = { label: string };",
  "const addGuardedRow = handler<",
  "  { label?: string },",
  "  { guarded: Writable<GuardedRow[]> }",
  ">((event, { guarded }) => {",
  "  guarded.push({ label: event.label ?? '' });",
  "});",
  "type CurrentPrincipal = { readonly __ctCurrentPrincipal: true };",
  "type GuardedList = RepresentsCurrentUser<Cfc<",
  "  WriteAuthorizedBy<GuardedRow[], typeof addGuardedRow>,",
  "  { ownerPrincipal: CurrentPrincipal }",
  ">>;",
  "export default pattern<{",
  "  items?: string[];",
  "  guarded: Default<GuardedList, []>;",
  "}>(({ items, guarded }) => {",
  "  const count = new Writable<number>(0).for('count');",
  "  return { items, guarded, addGuardedRow: addGuardedRow({ guarded }), count, bump: bump({ count }) };",
  "});",
  "",
].join("\n");

const IMPORTED_MODULE_URL = "/api/patterns/system/update-marker.ts";

// A same-host custom-app path, as home config would supply via
// `defaultAppUrl` (a published custom app, NOT a system pattern).
const CUSTOM_APP_URL = "/api/patterns/custom/my-app.tsx";
// What a root configured with that URL stores: the ref naming the same file.
const CUSTOM_APP_SOURCE = "system:custom/my-app.tsx";

/** Content identity a toolshed would serve for `source`. */
function identityForSource(
  source: string,
  imports: Record<string, string> = {},
  entry = DEFAULT_APP_PATTERN_PATH,
): Promise<string> {
  return resolveEntryIdentity(
    entry,
    (name) => {
      if (name === entry) return Promise.resolve(source);
      if (Object.hasOwn(imports, name)) return Promise.resolve(imports[name]);
      return Promise.reject(new Error(`not found: ${name}`));
    },
  );
}

interface StubControls {
  setSource(source: string): void;
  setCustomSource(source: string | null): void;
  setIdentitySource(source: string): void;
  setIdentityResponse(body: string, status?: number): void;
  setImport(path: string, source: string): void;
  setIdentityImport(path: string, source: string): void;
  failIdentity(fail: boolean): void;
  identityFetches(): number;
  sourceFetches(): number;
  requestedHrefs(): string[];
  requestedFetches(): Array<{ href: string; cache?: RequestCache }>;
  restore(): void;
}

function installFetchStub(): StubControls {
  const original = globalThis.fetch;
  let source = SOURCE_V1;
  // Served at CUSTOM_APP_URL when set; null keeps the path unserved (404).
  let customSource: string | null = null;
  let identitySource: string | undefined;
  const imports: Record<string, string> = {};
  const identityImports: Record<string, string> = {};
  let identityResponse: { body: string; status: number } | undefined;
  let failIdentityFetch = false;
  let identityFetchCount = 0;
  let sourceFetchCount = 0;
  const requestedHrefs: string[] = [];
  const requestedFetches: Array<{ href: string; cache?: RequestCache }> = [];

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const href = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    const url = new URL(href);
    requestedHrefs.push(url.href);
    requestedFetches.push({
      href: url.href,
      cache: init?.cache ??
        (input instanceof Request ? input.cache : undefined),
    });

    if (
      url.pathname === DEFAULT_APP_PATTERN_PATH ||
      url.pathname === HOME_PATTERN_PATH
    ) {
      if (url.searchParams.has("identity")) {
        identityFetchCount++;
        if (failIdentityFetch) throw new Error("identity fetch failed");
        if (identityResponse) {
          return new Response(identityResponse.body, {
            status: identityResponse.status,
            headers: { "content-type": "text/plain" },
          });
        }
        return new Response(
          await identityForSource(
            identitySource ?? source,
            { ...imports, ...identityImports },
            url.pathname,
          ),
          { headers: { "content-type": "text/plain" } },
        );
      }
      sourceFetchCount++;
      return new Response(source, {
        headers: { "content-type": "text/typescript-jsx" },
      });
    }

    if (url.pathname === CUSTOM_APP_URL && customSource !== null) {
      if (url.searchParams.has("identity")) {
        identityFetchCount++;
        if (failIdentityFetch) throw new Error("identity fetch failed");
        return new Response(
          await identityForSource(customSource, imports, CUSTOM_APP_URL),
          { headers: { "content-type": "text/plain" } },
        );
      }
      sourceFetchCount++;
      return new Response(customSource, {
        headers: { "content-type": "text/typescript-jsx" },
      });
    }

    if (Object.hasOwn(imports, url.pathname)) {
      sourceFetchCount++;
      return new Response(imports[url.pathname], {
        headers: { "content-type": "text/typescript" },
      });
    }

    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;

  return {
    setSource: (s) => (source = s),
    setCustomSource: (s) => (customSource = s),
    setIdentitySource: (s) => (identitySource = s),
    setIdentityResponse: (body, status = 200) => {
      identityResponse = { body, status };
    },
    setImport: (path, s) => (imports[path] = s),
    setIdentityImport: (path, s) => (identityImports[path] = s),
    failIdentity: (f) => (failIdentityFetch = f),
    identityFetches: () => identityFetchCount,
    sourceFetches: () => sourceFetchCount,
    requestedHrefs: () => [...requestedHrefs],
    requestedFetches: () => [...requestedFetches],
    restore: () => (globalThis.fetch = original),
  };
}

describe("opening a space root", () => {
  let stub: StubControls;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let controller: PiecesController;

  async function setup(experimental: Record<string, boolean> = {}) {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      experimental,
    });
    const session = await createSession({
      identity: signer,
      spaceName: "update-space-" + crypto.randomUUID(),
    });
    controller = new PiecesController(session, runtime);
    await controller.synced();
  }

  async function setupHome(
    extraRuntimeOptions: { cfcEnforcementMode?: "disabled" } = {},
  ) {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      ...extraRuntimeOptions,
    });
    const session = await createSession({
      identity: signer,
      spaceDid: signer.did(),
    });
    expect(session.space).toBe(runtime.userIdentityDID);
    controller = new PiecesController(session, runtime);
    await controller.synced();
  }

  beforeEach(() => {
    stub = installFetchStub();
    stub.setSource(SOURCE_V1);
  });

  afterEach(async () => {
    try {
      await controller?.dispose();
    } catch { /* already disposed */ }
    await storageManager?.close();
    stub.restore();
  });

  it("does not duplicate the update check for a newly created root", async () => {
    await setup();

    await controller.ensureDefaultPattern();
    await runtime.sourceReconciler.idle();

    expect(stub.identityFetches()).toBe(0);
  });

  it("returns current when the identity is unchanged (no write)", async () => {
    await setup();
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell())?.identity;

    expect(
      await reconcilePieceSource(
        runtime,
        (await controller.getDefaultPattern(false))!,
      ),
    ).toBe("current");

    const after = getPatternIdentityRef(piece.getCell())?.identity;
    expect(after).toBe(before);
    expect(after).toBe(await identityForSource(SOURCE_V1));
  });

  it("stops an update when disposal follows the current-pattern probe", async () => {
    await setup();
    const piece = await controller.ensureDefaultPattern();
    const originalLoad = runtime.patternManager.loadPatternByIdentity;
    let dispose: Promise<void> | undefined;
    let probeRuns = 0;
    runtime.patternManager.loadPatternByIdentity = (() => {
      probeRuns++;
      dispose = runtime.sourceReconciler.dispose();
      return Promise.resolve(undefined);
    }) as typeof runtime.patternManager.loadPatternByIdentity;

    try {
      expect(await reconcilePieceSource(runtime, piece.getCell()))
        .toBe("unavailable");
      expect(probeRuns).toBe(1);
      expect(dispose).toBeDefined();
      await dispose!;
      expect(stub.sourceFetches()).toBe(1);
    } finally {
      runtime.patternManager.loadPatternByIdentity = originalLoad;
    }
  });

  it("reports a root without a pattern identity as detached", async () => {
    await setup();
    const piece = await controller.ensureDefaultPattern();
    const identityFetchesBefore = stub.identityFetches();
    const { error } = await runtime.editWithRetry((tx) => {
      piece.getCell().withTx(tx).setMetaRaw(
        "patternIdentity",
        "missing",
        rawMetaWriteAuthorization,
      );
    });
    expect(error).toBeUndefined();
    const root = (await controller.getDefaultPattern(false))!;

    expect(
      await reconcilePieceSource(
        runtime,
        (await controller.getDefaultPattern(false))!,
      ),
    ).toBe("detached");
    expect(getPatternIdentityRef(root)).toBeUndefined();
    expect(stub.identityFetches()).toBe(identityFetchesBefore);
  });

  it("rolls the root forward in place on a changed identity", async () => {
    await setup();
    const piece = await controller.ensureDefaultPattern();
    const rootLinkBefore = JSON.stringify(piece.getCell().getAsLink());
    const idV1 = getPatternIdentityRef(piece.getCell())?.identity;

    stub.setSource(SOURCE_V2);
    expect(
      await reconcilePieceSource(
        runtime,
        (await controller.getDefaultPattern(false))!,
      ),
    ).toBe("updated");
    await runtime.idle();

    const root = (await controller.getDefaultPattern(false))!;
    // Same piece entity — no new piece minted; the update wrote a new
    // patternIdentity onto the existing result cell (the watcher re-instantiates
    // the new pattern in place — its own machinery, exercised elsewhere).
    expect(JSON.stringify(root.getAsLink())).toBe(rootLinkBefore);
    const idV2 = getPatternIdentityRef(root)?.identity;
    expect(idV2).toBe(await identityForSource(SOURCE_V2));
    expect(idV2).not.toBe(idV1);
    expect(
      getPieceSourceRevisions(root).map((revision) => ({
        operation: revision.operation,
        origin: revision.origin,
      })),
    ).toEqual([
      {
        operation: "baseline",
        origin: DEFAULT_APP_PATTERN_SOURCE,
      },
      {
        operation: "origin-update",
        origin: DEFAULT_APP_PATTERN_SOURCE,
      },
    ]);
  });

  it("does not reconstruct an origin after an explicit detach", async () => {
    await setup();
    const piece = await controller.ensureDefaultPattern();
    const detachedRef = getPatternIdentityRef(piece.getCell());

    expect(await piece.changeSource({ kind: "detach" })).toEqual({
      status: "applied",
    });
    stub.setSource(SOURCE_V2);

    expect(
      await reconcilePieceSource(
        runtime,
        (await controller.getDefaultPattern(false))!,
      ),
    ).toBe("detached");
    const root = (await controller.getDefaultPattern(false))!;
    expect(getPatternSource(root)).toBeUndefined();
    expect(getPatternIdentityRef(root)).toEqual(detachedRef);
    expect(getPieceSourceRevisions(root).at(-1)?.operation).toBe("detach");
  });

  it("repairs a metadata-only update when the result schema is unchanged", async () => {
    await setup();
    const piece = await controller.ensureDefaultPattern();
    const root = piece.getCell();
    const originalRef = getPatternIdentityRef(root)!;
    expect(getPatternSetupIdentityRef(root)).toEqual(originalRef);
    expect(root.key("marker").get()).toBe("v1");
    await controller.stopPiece(root);

    stub.setSource(SOURCE_V2);
    const currentPattern = await runtime.patternManager.compilePattern(
      {
        main: DEFAULT_APP_PATTERN_PATH,
        files: [{ name: DEFAULT_APP_PATTERN_PATH, contents: SOURCE_V2 }],
      },
      { space: controller.getSpace() },
    );
    const currentRef = runtime.patternManager.getArtifactEntryRef(
      currentPattern,
    )!;
    expect(currentRef.identity).toBe(await identityForSource(SOURCE_V2));
    expect(root.getMetaRaw("schema")).toEqual(
      resultSchemaMetaSpelling(currentPattern.resultSchema!),
    );

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
    expect(getPatternSetupIdentityRef(metadataOnlyRoot)).toEqual(originalRef);

    await controller.startPiece(metadataOnlyRoot);
    expect(metadataOnlyRoot.key("marker").get()).toBe("v1");

    await controller.ensureDefaultPattern();
    await runtime.idle();
    const repairedRoot = (await controller.getDefaultPattern(false))!;
    await repairedRoot.pull();

    expect(repairedRoot.key("marker").get()).toBe("v2");
    expect(getPatternSetupIdentityRef(repairedRoot)).toEqual(currentRef);
  });

  it("repairs argument setup from source after a metadata-only update", async () => {
    const argumentSourceV1 = [
      "import { pattern } from 'commonfabric';",
      "interface Input { label?: string; }",
      "export default pattern<Input>(() => ({ marker: 'v1' }));",
      "",
    ].join("\n");
    const argumentSourceV2 = [
      "import { Default, pattern } from 'commonfabric';",
      "interface Input { label?: string; count: number | Default<2>; }",
      "export default pattern<Input>(({ count }) => ({ marker: 'v2:' + count }));",
      "",
    ].join("\n");
    stub.setSource(argumentSourceV1);
    await setup();
    const piece = await controller.ensureDefaultPattern();
    const root = piece.getCell();
    const originalRef = getPatternIdentityRef(root)!;
    expect(controller.getArgument(root).get()).toEqual({});
    await controller.stopPiece(root);

    stub.setSource(argumentSourceV2);
    const currentPattern = await runtime.patternManager.compilePattern(
      {
        main: DEFAULT_APP_PATTERN_PATH,
        files: [{
          name: DEFAULT_APP_PATTERN_PATH,
          contents: argumentSourceV2,
        }],
      },
      { space: controller.getSpace() },
    );
    const currentRef = runtime.patternManager.getArtifactEntryRef(
      currentPattern,
    )!;
    const metadataUpdate = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw(
        "patternIdentity",
        currentRef,
        rawMetaWriteAuthorization,
      );
    });
    expect(metadataUpdate.error).toBeUndefined();
    const metadataOnlyRoot = (await controller.getDefaultPattern(false))!;
    expect(getPatternSetupIdentityRef(metadataOnlyRoot)).toEqual(originalRef);
    expect(controller.getArgument(metadataOnlyRoot).get()).toEqual({});

    const originalLoad = runtime.patternManager.loadPatternByIdentity;
    let blockedCurrentLoad = false;
    runtime.patternManager.loadPatternByIdentity =
      ((identity, symbol, space) => {
        if (
          !blockedCurrentLoad && identity === currentRef.identity &&
          symbol === currentRef.symbol
        ) {
          blockedCurrentLoad = true;
          return Promise.resolve(undefined);
        }
        return originalLoad.call(
          runtime.patternManager,
          identity,
          symbol,
          space,
        );
      }) as typeof runtime.patternManager.loadPatternByIdentity;

    try {
      await controller.ensureDefaultPattern();
    } finally {
      runtime.patternManager.loadPatternByIdentity = originalLoad;
    }
    await runtime.idle();
    const repairedRoot = (await controller.getDefaultPattern(false))!;
    const repairedArgument = controller.getArgument(repairedRoot);
    await repairedArgument.pull();

    expect(blockedCurrentLoad).toBe(true);
    expect(repairedArgument.get()).toEqual({ count: 2 });
    expect(getPatternSetupIdentityRef(repairedRoot)).toEqual(currentRef);
  });

  it("abandons setup when the argument changes after synchronization", async () => {
    const argumentSourceV1 = [
      "import { pattern } from 'commonfabric';",
      "interface Input { label?: string; }",
      "export default pattern<Input>(() => ({ marker: 'v1' }));",
      "",
    ].join("\n");
    const argumentSourceV2 = [
      "import { Default, pattern } from 'commonfabric';",
      "interface Input { label?: string; count: number | Default<2>; }",
      "export default pattern<Input>(({ count }) => ({ marker: 'v2:' + count }));",
      "",
    ].join("\n");
    stub.setSource(argumentSourceV1);
    await setup();
    const piece = await controller.ensureDefaultPattern();
    const root = piece.getCell();
    const originalRef = getPatternIdentityRef(root)!;
    await piece.setInput({ label: "before" });

    stub.setSource(argumentSourceV2);
    const originalSync = runtime.syncStoredSetupArgument.bind(runtime);
    let changedArgument = false;
    runtime.syncStoredSetupArgument = async (cell) => {
      const guard = await originalSync(cell);
      if (!changedArgument) {
        changedArgument = true;
        const changed = await runtime.editWithRetry((tx) => {
          controller.getArgument(cell).withTx(tx).set({ label: "after" });
        });
        expect(changed.error).toBeUndefined();
      }
      return guard;
    };

    try {
      expect(await reconcilePieceSource(runtime, root)).toBe("unavailable");
    } finally {
      runtime.syncStoredSetupArgument = originalSync;
    }

    const unchangedRoot = (await controller.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(unchangedRoot)).toEqual(originalRef);
    expect(controller.getArgument(unchangedRoot).get()).toEqual({
      label: "after",
    });

    expect(
      await reconcilePieceSource(runtime, unchangedRoot),
    ).toBe("updated");
    const updatedRoot = (await controller.getDefaultPattern(false))!;
    const updatedArgument = controller.getArgument(updatedRoot);
    await updatedArgument.pull();
    expect(updatedArgument.get()).toEqual({ label: "after", count: 2 });
  });

  it("abandons setup when a modern argument link changes after synchronization", async () => {
    const argumentSourceV1 = [
      "import { pattern } from 'commonfabric';",
      "interface Profile { name: string; }",
      "interface Input { profile?: Profile; }",
      "export default pattern<Input>(() => ({ marker: 'v1' }));",
      "",
    ].join("\n");
    const argumentSourceV2 = argumentSourceV1.replace(
      "marker: 'v1'",
      "marker: 'v2'",
    );
    stub.setSource(argumentSourceV1);
    await setup({ modernCellRep: true });
    const piece = await controller.ensureDefaultPattern();
    const root = piece.getCell();
    const originalRef = getPatternIdentityRef(root)!;
    const profilePattern = await runtime.patternManager.compilePattern(
      {
        main: "/setup-argument-profile.ts",
        files: [{
          name: "/setup-argument-profile.ts",
          contents: [
            "import { pattern } from 'commonfabric';",
            "interface Input { name: string; }",
            "export default pattern<Input>(({ name }) => ({ name }));",
            "",
          ].join("\n"),
        }],
      },
      { space: controller.getSpace() },
    );
    const profileBefore = await controller.runPersistent<{ name: string }>(
      profilePattern,
      { name: "before" },
      "setup argument profile before",
    );
    const profileAfter = await controller.runPersistent<{ name: string }>(
      profilePattern,
      { name: "after" },
      "setup argument profile after",
    );
    await piece.setInput({ profile: profileBefore });
    const initialRawArgument = controller.getArgument(root).getRawUntyped() as {
      profile?: unknown;
    };
    expect(initialRawArgument.profile).toBeInstanceOf(FabricLink);
    expect(
      parseLink(initialRawArgument.profile, controller.getArgument(root))?.id,
    ).toBe(profileBefore.getAsNormalizedFullLink().id);

    stub.setSource(argumentSourceV2);
    const originalSync = runtime.syncStoredSetupArgument.bind(runtime);
    let changedArgument = false;
    runtime.syncStoredSetupArgument = async (cell) => {
      const guard = await originalSync(cell);
      if (!changedArgument) {
        changedArgument = true;
        const changed = await runtime.editWithRetry((tx) => {
          controller.getArgument(cell).withTx(tx).set({
            profile: profileAfter,
          });
        });
        expect(changed.error).toBeUndefined();
      }
      return guard;
    };

    try {
      expect(await reconcilePieceSource(runtime, root)).toBe("unavailable");
    } finally {
      runtime.syncStoredSetupArgument = originalSync;
    }

    const unchangedRoot = (await controller.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(unchangedRoot)).toEqual(originalRef);
    const unchangedArgument = controller.getArgument(unchangedRoot);
    const unchangedRawArgument = unchangedArgument.getRawUntyped() as {
      profile?: unknown;
    };
    expect(unchangedRawArgument.profile).toBeInstanceOf(FabricLink);
    expect(parseLink(unchangedRawArgument.profile, unchangedArgument)?.id)
      .toBe(profileAfter.getAsNormalizedFullLink().id);
    const currentArgumentGuard = await runtime.syncStoredSetupArgument(
      unchangedRoot,
    );
    const guardTx = runtime.edit();
    expect(currentArgumentGuard(unchangedRoot.withTx(guardTx))).toBe(true);
    guardTx.abort();
  });

  it("reconciles an unloadable stale root before ensure starts it", async () => {
    await setup();
    const piece = await controller.ensureDefaultPattern();
    const root = piece.getCell();
    const rootLinkBefore = JSON.stringify(root.getAsLink());

    // Simulate a root left behind by an older runtime whose stored pattern can
    // no longer be loaded by this one. The identity is well-formed but its
    // source closure was never persisted, so any attempt to start it fails.
    const staleIdentity = await identityForSource(
      patternSource("unloadable-stale-root"),
    );
    await controller.stopPiece(root);
    const { error } = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw(
        "patternIdentity",
        {
          identity: staleIdentity,
          // The obsolete runtime selected an export the current system source no
          // longer has. Dead-root recovery must select the official entry's
          // default export, rather than trying to preserve this broken symbol.
          symbol: "removed-export",
        },
        rawMetaWriteAuthorization,
      );
    });
    expect(error).toBeUndefined();
    const staleRoot = (await controller.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(staleRoot)?.identity).toBe(staleIdentity);

    // The toolshed advertises a newer system-root identity. The ensure path
    // must install it before start() sees the stale one.
    stub.setSource(SOURCE_V2);

    const updated = await controller.ensureDefaultPattern();
    await runtime.idle();

    expect(JSON.stringify(updated.getCell().getAsLink())).toBe(rootLinkBefore);
    expect(getPatternIdentityRef(updated.getCell())?.identity).toBe(
      await identityForSource(SOURCE_V2),
    );
    expect(getPatternIdentityRef(updated.getCell())?.symbol).toBe("default");
  });

  it("heals a legacy keyless default root without recording the keyless identity as displaced", async () => {
    await setup();
    const piece = await controller.ensureDefaultPattern();
    const root = piece.getCell();

    // A root left behind by a PRE-GUARD runtime: its durable pointer is a
    // legacy `keyless:` orphan — session-synthetic, so unloadable in EVERY
    // session by construction (never minted here; the in-memory index cannot
    // serve it either). No recorded origin, so the origin-follow reconcile
    // and the update check cannot repair it: only the ROLL-FORWARD rescue
    // (the displaced-pattern swap) remains.
    const orphan = "keyless:fid1:legacy-orphan-from-a-pre-guard-session";
    await controller.stopPiece(root);
    const { error } = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw("patternIdentity", {
        identity: orphan,
        symbol: "default",
      }, rawMetaWriteAuthorization);
      root.withTx(tx).setMetaRaw(
        "patternSource",
        undefined,
        rawMetaWriteAuthorization,
      );
    });
    expect(error).toBeUndefined();

    // The rescue triggers on a THROWN start. A keyless pointer alone no
    // longer throws (the start walk tolerates it: not started, not
    // rejected), so the reachable shape is any start failure COINCIDING
    // with the orphan pointer — made deterministic here by failing the
    // first start attempt. The catch then reads ref = the durable keyless
    // orphan, its load short-circuits to undefined, and the origin-less
    // root rolls forward through healDefaultRootByRollForward's swap tx —
    // the path whose direct `displacedPattern` stamp this pin guards.
    const realStart = runtime.start.bind(runtime);
    let failedOnce = false;
    runtime.start = (resultCell) => {
      if (!failedOnce) {
        failedOnce = true;
        return Promise.reject(
          new Error("forced start failure over the legacy orphan"),
        );
      }
      return realStart(resultCell);
    };

    stub.setSource(SOURCE_V2);
    const registry = await controller.getPieceRegistry();
    await runtime.idle();
    expect(registry).toBeDefined();
    expect(failedOnce).toBe(true);

    // Rolled forward to the official entry...
    const healed = (await controller.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(healed)?.identity).toBe(
      await identityForSource(SOURCE_V2),
    );
    // ...and the displaced KEYLESS identity did NOT land durably. The
    // `displacedPattern` record exists for recovery, and recovery to a
    // session identity is impossible by construction — the absent record is
    // the honest one (L3(a): no `keyless:` byte anywhere in durable state,
    // the same gate `applyPieceSourceTransition`'s unavailable arm applies).
    expect(
      (await readPieceSourceState(runtime, healed)).displacedPattern,
    ).toBeUndefined();
  });

  it("heals an unloadable stale root on the REGISTRY path (not just boot)", async () => {
    // The boot path (ensureDefaultPattern) reconciles an unloadable root before
    // start — but registry listings, `cf piece ls`, FUSE, and the shell's list
    // cells all resolve the root through PiecesController.getDefaultPattern
    // instead, which used to inherit NO heal: the load failure propagated and
    // every listing died with the root (2026-07-29 vendor gate, the
    // cf-cell-context type retirement). The controller choke point must run the
    // same awaited updater check and retry once.

    await setup();
    const piece = await controller.ensureDefaultPattern();
    const root = piece.getCell();

    // A root left behind by an older runtime: well-formed identity, but its
    // source closure was never persisted, so any start of it fails.
    const staleIdentity = await identityForSource(
      patternSource("unloadable-registry-path-root"),
    );
    await controller.stopPiece(root);
    const { error } = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw("patternIdentity", {
        identity: staleIdentity,
        symbol: "default",
      }, rawMetaWriteAuthorization);
    });
    expect(error).toBeUndefined();

    stub.setSource(SOURCE_V2);

    // Straight to the registry — never through ensureDefaultPattern.
    const registry = await controller.getPieceRegistry();
    await runtime.idle();

    expect(registry).toBeDefined();
    const healed = (await controller.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(healed)?.identity).toBe(
      await identityForSource(SOURCE_V2),
    );
    expect(getPatternIdentityRef(healed)?.symbol).toBe("default");
  });

  it("preserves both failures when passive and running registry opens fail", async () => {
    await setup();
    const passiveFailure = new Error("passive registry open failed");
    const runningFailure = new Error("running registry open failed");
    const original = controller.getDefaultPattern.bind(controller);
    controller.getDefaultPattern = ((open = true) =>
      Promise.reject(
        typeof open === "object" ? passiveFailure : runningFailure,
      )) as typeof controller.getDefaultPattern;

    let failure: unknown;
    try {
      await controller.getPieceRegistry();
    } catch (error) {
      failure = error;
    } finally {
      controller.getDefaultPattern = original;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      passiveFailure,
      runningFailure,
    ]);
  });

  it("records a passive failure when the running registry fallback succeeds", async () => {
    await setup();
    await controller.ensureDefaultPattern();
    const passiveFailure = new Error("passive registry open failed");
    const original = controller.getDefaultPattern.bind(controller);
    controller.getDefaultPattern =
      ((open = true) =>
        typeof open === "object"
          ? Promise.reject(passiveFailure)
          : original(open)) as typeof controller.getDefaultPattern;
    const logger = getLogger("piece.update");
    const warningsBefore =
      logger.countsByKey["passive-registry-open-failed"]?.warn ?? 0;

    try {
      expect(await controller.getPieceRegistry()).toBeDefined();
    } finally {
      controller.getDefaultPattern = original;
    }

    expect(
      logger.countsByKey["passive-registry-open-failed"]?.warn ?? 0,
    ).toBe(warningsBefore + 1);
  });

  it("preserves a passive failure when the running fallback finds no root", async () => {
    await setup();
    const passiveFailure = new Error("passive registry open failed");
    const original = controller.getDefaultPattern.bind(controller);
    controller.getDefaultPattern =
      ((open = true) =>
        typeof open === "object"
          ? Promise.reject(passiveFailure)
          : Promise.resolve(undefined)) as typeof controller.getDefaultPattern;

    let failure: unknown;
    try {
      await controller.getPieceRegistry();
    } catch (error) {
      failure = error;
    } finally {
      controller.getDefaultPattern = original;
    }

    expect(failure).toBe(passiveFailure);
  });

  it("heals a stale root whose registry export is already persisted", async () => {
    await setup();
    const piece = await controller.ensureDefaultPattern();
    const root = piece.getCell();

    // The registry path serves a persisted export without running the root.
    // A root that has ALREADY exported one therefore takes that path — so
    // the healing has to happen there too, not only on the arm that runs.
    // `pieceListSchema` defaults an absent export to `[]`, so an export
    // persisted as empty is exactly the case that reads as present.
    const { error: seeded } = await runtime.editWithRetry((tx) => {
      root.withTx(tx).asSchema({
        type: "object",
        properties: { pieceRegistry: { type: "array" } },
      }).key("pieceRegistry").set([]);
    });
    expect(seeded).toBeUndefined();

    const staleIdentity = await identityForSource(
      patternSource("unloadable-root-with-persisted-registry"),
    );
    await controller.stopPiece(root);
    const { error } = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw("patternIdentity", {
        identity: staleIdentity,
        symbol: "default",
      }, rawMetaWriteAuthorization);
    });
    expect(error).toBeUndefined();

    stub.setSource(SOURCE_V2);

    const registry = await controller.getPieceRegistry();
    await runtime.idle();

    expect(registry).toBeDefined();
    const healed = (await controller.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(healed)?.identity).toBe(
      await identityForSource(SOURCE_V2),
    );
  });

  it("returns the started replacement when the rescue's retry succeeds", async () => {
    await setup();
    // The rescue's whole point is that the caller gets a root it can use. A
    // root that follows nothing and whose stored pattern this runtime cannot
    // load is rolled forward to the space's official system root, and the
    // start is retried against that.
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-root.tsx",
        files: [{ name: "/custom-root.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await controller.getDefaultPattern(false))!;
    const staleIdentity = await identityForSource(
      patternSource("unloadable-root-whose-rescue-succeeds"),
    );
    await controller.stopPiece(root);
    const { error } = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw("patternIdentity", {
        identity: staleIdentity,
        symbol: "default",
      }, rawMetaWriteAuthorization);
    });
    expect(error).toBeUndefined();
    stub.setSource(SOURCE_V2);

    const started = (await controller.getDefaultPattern(true))!;
    await runtime.idle();

    expect(getPatternIdentityRef(started)?.identity).toBe(
      await identityForSource(SOURCE_V2),
    );
    expect(getPatternIdentityRef(started)?.symbol).toBe("default");
  });

  it("rethrows a start failure for a root that follows an origin", async () => {
    await setup();
    // Opening a root already reconciled it against its origin, so a start that
    // still failed is not a root left behind — rolling it forward would
    // replace source the space deliberately follows.
    const piece = await controller.ensureDefaultPattern();
    const root = piece.getCell();
    await controller.stopPiece(root);
    const { error } = await runtime.editWithRetry((tx) => {
      setPatternSource(root, tx, "https://elsewhere.example/root.tsx");
    });
    expect(error).toBeUndefined();
    const staleRef = getPatternIdentityRef(root)!;

    const restore = shadowLoadProbe(staleRef.identity, "undefined");
    try {
      await expect(controller.getDefaultPattern(true)).rejects.toThrow(
        "Could not load pattern",
      );
    } finally {
      restore();
    }
    expect(getPatternIdentityRef(root)).toEqual(staleRef);
  });

  it("rethrows a start failure whose pinned pattern still loads", async () => {
    await setup();
    // The rescue is for a root whose stored pattern is gone. One that loads
    // fine failed to start for some other reason, and replacing its source
    // would destroy state over a fault the replacement does not address.
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-root.tsx",
        files: [{ name: "/custom-root.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await controller.getDefaultPattern(false))!;
    const pinnedRef = getPatternIdentityRef(root)!;
    await controller.stopPiece(root);

    const originalStart = runtime.start.bind(runtime);
    runtime.start = ((cell: Parameters<typeof originalStart>[0]) => {
      throw new Error("start refused for a reason of its own");
      // deno-lint-ignore no-unreachable
      return originalStart(cell);
    }) as typeof runtime.start;
    try {
      await expect(controller.getDefaultPattern(true)).rejects.toThrow(
        "start refused for a reason of its own",
      );
    } finally {
      runtime.start = originalStart;
    }
    expect(getPatternIdentityRef(root)).toEqual(pinnedRef);
  });

  it("surfaces the ORIGINAL start failure when the post-heal retry fails", async () => {
    await setup();
    // A root that follows nothing, so opening it cannot repair it and the
    // roll-forward is the only rescue left.
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-root.tsx",
        files: [{ name: "/custom-root.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await controller.getDefaultPattern(false))!;
    const staleIdentity = await identityForSource(
      patternSource("unloadable-registry-path-root-retry-fails"),
    );
    await controller.stopPiece(root);
    const { error } = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw("patternIdentity", {
        identity: staleIdentity,
        symbol: "default",
      }, rawMetaWriteAuthorization);
    });
    expect(error).toBeUndefined();
    stub.setSource(SOURCE_V2);

    // Inject a failure into the post-heal sequence: runtime.idle() is only
    // awaited there on this path. The caller must still see the ORIGINAL
    // "Could not load pattern" failure, not the injected secondary one.
    const originalIdle = runtime.idle.bind(runtime);
    let injected = false;
    runtime.idle = () => {
      if (!injected) {
        injected = true;
        return Promise.reject(new Error("secondary retry failure"));
      }
      return originalIdle();
    };
    try {
      await expect(controller.getPieceRegistry()).rejects.toThrow(
        "Could not load pattern",
      );
      expect(injected).toBe(true);
    } finally {
      runtime.idle = originalIdle;
    }
  });

  it("repairs persisted artifacts when the served identity is unchanged", async () => {
    await setup();
    const piece = await controller.ensureDefaultPattern();
    const currentRef = getPatternIdentityRef(piece.getCell())!;
    const sourceFetchesBefore = stub.sourceFetches();
    const originalLoad = runtime.patternManager.loadPatternByIdentity;
    let loadAttempts = 0;
    runtime.patternManager.loadPatternByIdentity =
      ((identity, symbol, space) => {
        loadAttempts++;
        if (loadAttempts === 1 && identity === currentRef.identity) {
          return Promise.resolve(undefined);
        }
        return originalLoad.call(
          runtime.patternManager,
          identity,
          symbol,
          space,
        );
      }) as typeof runtime.patternManager.loadPatternByIdentity;

    try {
      expect(
        await reconcilePieceSource(
          runtime,
          (await controller.getDefaultPattern(false))!,
        ),
      ).toBe("current");
      expect(loadAttempts).toBe(1);
      expect(stub.sourceFetches()).toBe(sourceFetchesBefore + 1);
      await expect(
        originalLoad.call(
          runtime.patternManager,
          currentRef.identity,
          currentRef.symbol,
          controller.getSpace(),
        ),
      ).resolves.toBeDefined();
    } finally {
      runtime.patternManager.loadPatternByIdentity = originalLoad;
    }
  });

  it("reconciles a persisted root discovered after a creation race", async () => {
    await setup();
    const existing = await controller.ensureDefaultPattern();
    const rootLinkBefore = JSON.stringify(existing.getCell().getAsLink());
    const originalGetDefaultPattern = controller.getDefaultPattern;
    const originalGetSpaceCellContents = controller.getSpaceCellContents;
    let firstLookup = true;

    // Model the retry after another writer wins: the first pre-transaction
    // lookup saw no root, while the transaction's double-check now sees one.
    controller.getDefaultPattern = ((runIt?: boolean) => {
      if (firstLookup) {
        firstLookup = false;
        return Promise.resolve(undefined);
      }
      return originalGetDefaultPattern.call(controller, runIt);
    }) as typeof controller.getDefaultPattern;
    controller.getSpaceCellContents = (() => ({
      withTx: () => ({
        key: (key: string) => {
          expect(key).toBe("defaultPattern");
          return { get: () => ({ get: () => ({}) }) };
        },
      }),
    })) as unknown as typeof controller.getSpaceCellContents;

    try {
      const raced = await controller.ensureDefaultPattern();
      expect(JSON.stringify(raced.getCell().getAsLink())).toBe(rootLinkBefore);
      // The winner's root is a persisted root like any other, so opening it
      // follows its origin: the identity route was asked once.
      expect(stub.identityFetches()).toBe(1);
    } finally {
      controller.getDefaultPattern = originalGetDefaultPattern;
      controller.getSpaceCellContents = originalGetSpaceCellContents;
    }
  });

  it("updates without build metadata when compiled source matches ?identity", async () => {
    await setup();
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell())?.identity;

    stub.setSource(SOURCE_V2);

    expect(
      await reconcilePieceSource(
        runtime,
        (await controller.getDefaultPattern(false))!,
      ),
    ).toBe("updated");
    await runtime.idle();
    const root = (await controller.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(root)?.identity).toBe(
      await identityForSource(SOURCE_V2),
    );
    expect(getPatternIdentityRef(root)?.identity).not.toBe(before);
    expect(
      stub.requestedHrefs().some((href) =>
        new URL(href).pathname === "/api/meta"
      ),
    ).toBe(false);
  });

  it("revalidates HTTP caches for identity and the downloaded closure", async () => {
    await setup();
    await controller.ensureDefaultPattern();
    const requestsBefore = stub.requestedFetches().length;
    const importingSource = [
      "import { pattern } from 'commonfabric';",
      "import { marker } from './update-marker.ts';",
      "export default pattern<{ items?: string[] }>(({ items }) => ({ items, marker }));",
      "",
    ].join("\n");
    stub.setSource(importingSource);
    stub.setImport(IMPORTED_MODULE_URL, 'export const marker = "fresh";\n');

    expect(
      await reconcilePieceSource(
        runtime,
        (await controller.getDefaultPattern(false))!,
      ),
    ).toBe("updated");

    expect(
      stub.requestedFetches().slice(requestsBefore).map(({ href, cache }) => {
        const url = new URL(href);
        return {
          path: url.pathname,
          identity: url.searchParams.has("identity"),
          cache,
        };
      }),
    ).toEqual([
      {
        path: DEFAULT_APP_PATTERN_PATH,
        identity: true,
        cache: "no-cache",
      },
      {
        path: DEFAULT_APP_PATTERN_PATH,
        identity: false,
        cache: "no-cache",
      },
      { path: IMPORTED_MODULE_URL, identity: false, cache: "no-cache" },
    ]);
  });

  it("keeps the original when downloaded source differs from ?identity", async () => {
    await setup();
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell());
    const sourceFetchesBefore = stub.sourceFetches();

    stub.setIdentitySource(SOURCE_V2);
    stub.setSource(patternSource("different-source-response"));

    expect(
      await reconcilePieceSource(
        runtime,
        (await controller.getDefaultPattern(false))!,
      ),
    ).toBe("unavailable");
    expect(getPatternIdentityRef(piece.getCell())).toEqual(before);
    expect(stub.identityFetches()).toBe(1);
    expect(stub.sourceFetches()).toBe(sourceFetchesBefore + 1);
  });

  it("keeps the original when a downloaded import differs from ?identity", async () => {
    await setup();
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell());
    const sourceFetchesBefore = stub.sourceFetches();
    const importingSource = [
      "import { pattern } from 'commonfabric';",
      "import { marker } from './update-marker.ts';",
      "export default pattern<{ items: string[] }>(({ items }) => ({ items, marker }));",
      "",
    ].join("\n");
    stub.setSource(importingSource);
    stub.setImport(
      IMPORTED_MODULE_URL,
      'export const marker = "downloaded-import";\n',
    );
    stub.setIdentityImport(
      IMPORTED_MODULE_URL,
      'export const marker = "advertised-import";\n',
    );

    expect(
      await reconcilePieceSource(
        runtime,
        (await controller.getDefaultPattern(false))!,
      ),
    ).toBe("unavailable");
    expect(getPatternIdentityRef(piece.getCell())).toEqual(before);
    expect(stub.identityFetches()).toBe(1);
    expect(stub.sourceFetches()).toBe(sourceFetchesBefore + 2);
  });

  it("fetches ?identity for every update attempt", async () => {
    await setup();
    await controller.ensureDefaultPattern();

    await reconcilePieceSource(
      runtime,
      (await controller.getDefaultPattern(false))!,
    );
    await reconcilePieceSource(
      runtime,
      (await controller.getDefaultPattern(false))!,
    );
    expect(stub.identityFetches()).toBe(2);
  });

  it("never throws when identity lookup fails", async () => {
    await setup();
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell())?.identity;

    stub.failIdentity(true);
    expect(
      await reconcilePieceSource(
        runtime,
        (await controller.getDefaultPattern(false))!,
      ),
    ).toBe("unavailable");
    expect(getPatternIdentityRef(piece.getCell())?.identity).toBe(before);
  });

  it("keeps the original when identity lookup returns a non-success response", async () => {
    await setup();
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell());
    const sourceFetchesBefore = stub.sourceFetches();
    stub.setIdentityResponse("unavailable", 503);

    expect(
      await reconcilePieceSource(
        runtime,
        (await controller.getDefaultPattern(false))!,
      ),
    ).toBe("unavailable");
    expect(getPatternIdentityRef(piece.getCell())).toEqual(before);
    expect(stub.sourceFetches()).toBe(sourceFetchesBefore);
  });

  it("keeps the original when identity lookup returns an empty identity", async () => {
    await setup();
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell());
    const sourceFetchesBefore = stub.sourceFetches();
    stub.setIdentityResponse("  \n");

    expect(
      await reconcilePieceSource(
        runtime,
        (await controller.getDefaultPattern(false))!,
      ),
    ).toBe("unavailable");
    expect(getPatternIdentityRef(piece.getCell())).toEqual(before);
    expect(stub.sourceFetches()).toBe(sourceFetchesBefore);
  });

  it("leaves a repository-pinned sourceless root untouched", async () => {
    await setup();
    const piece = await controller.recreateDefaultPattern({
      customProgram: {
        main: "/repository-root.tsx",
        files: [{ name: "/repository-root.tsx", contents: SOURCE_V1 }],
      },
      repository: "https://github.com/example/patterns",
    });
    const before = getPatternIdentityRef(piece.getCell());
    const identityFetchesBefore = stub.identityFetches();
    expect(getPatternSource(piece.getCell())).toBeUndefined();

    stub.setSource(SOURCE_V2);
    expect(
      await reconcilePieceSource(
        runtime,
        (await controller.getDefaultPattern(false))!,
      ),
    ).toBe("detached");
    expect(getPatternIdentityRef(piece.getCell())).toEqual(before);
    expect(stub.identityFetches()).toBe(identityFetchesBefore);
  });

  it("does not follow this deployment's route for a root whose origin is elsewhere", async () => {
    await setup();
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell());
    const identityFetchesBefore = stub.identityFetches();
    const externalSource = "https://patterns.example/root.tsx";
    const { error } = await runtime.editWithRetry((tx) => {
      piece.getCell().withTx(tx).setMetaRaw(
        "patternSource",
        externalSource,
        rawMetaWriteAuthorization,
      );
    });
    expect(error).toBeUndefined();
    const root = (await controller.getDefaultPattern(false))!;
    expect(getPatternSource(root)).toBe(externalSource);

    // The local route moves. The root does not follow it: its origin names
    // another host, and an external endpoint is no origin at all, so nothing
    // is fetched on the root's behalf.
    stub.setSource(SOURCE_V2);
    expect(await reconcilePieceSource(runtime, root)).toBe("unusable");
    expect(getPatternIdentityRef(root)).toEqual(before);
    expect(getPatternSource(root)).toBe(externalSource);
    expect(stub.identityFetches()).toBe(identityFetchesBefore);
    expect(
      stub.requestedHrefs().some((href) => href.startsWith(externalSource)),
    ).toBe(false);
  });

  it("does not infer provenance from an official-looking filename", async () => {
    await setup();
    const piece = await controller.recreateDefaultPattern({
      customProgram: {
        main: DEFAULT_APP_PATTERN_PATH,
        files: [{ name: DEFAULT_APP_PATTERN_PATH, contents: SOURCE_V1 }],
      },
    });
    const oldRef = getPatternIdentityRef(piece.getCell())!;
    expect(getPatternSource(piece.getCell())).toBeUndefined();
    stub.setSource(SOURCE_V2);

    expect(
      await reconcilePieceSource(
        runtime,
        (await controller.getDefaultPattern(false))!,
      ),
    ).toBe("detached");
    const pinned = (await controller.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(pinned)).toEqual(oldRef);
    expect(getPatternSource(pinned)).toBeUndefined();
    expect(stub.identityFetches()).toBe(0);
    expect(stub.sourceFetches()).toBe(0);
  });

  it("leaves a stale root untouched when replacement compilation fails", async () => {
    await setup();
    const piece = await controller.ensureDefaultPattern();
    const root = piece.getCell();
    const oldRef = getPatternIdentityRef(root)!;
    const originalCompile = runtime.patternManager.compilePattern;
    runtime.patternManager.compilePattern = (() =>
      Promise.reject(
        new Error("replacement compilation failed"),
      )) as typeof runtime.patternManager.compilePattern;
    stub.setSource(SOURCE_V2);

    try {
      expect(
        await reconcilePieceSource(
          runtime,
          (await controller.getDefaultPattern(false))!,
        ),
      ).toBe("unavailable");

      const unchanged = (await controller.getDefaultPattern(false))!;
      expect(getPatternIdentityRef(unchanged)).toEqual(oldRef);
      expect(getPatternSource(unchanged)).toBe(DEFAULT_APP_PATTERN_SOURCE);
      expect(stub.identityFetches()).toBe(1);
    } finally {
      runtime.patternManager.compilePattern = originalCompile;
    }
  });

  it("keeps the original when advertised source needs unavailable runtime semantics", async () => {
    await setup();
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell());
    stub.setSource([
      "import { pattern, futureRuntimeApi } from 'commonfabric';",
      "futureRuntimeApi();",
      "export default pattern<{ items: string[] }>(({ items }) => ({ items }));",
      "",
    ].join("\n"));

    expect(
      await reconcilePieceSource(
        runtime,
        (await controller.getDefaultPattern(false))!,
      ),
    ).toBe("unavailable");
    expect(getPatternIdentityRef(piece.getCell())).toEqual(before);
  });

  it("leaves the current root untouched when the identity swap cannot commit", async () => {
    await setup();
    await controller.ensureDefaultPattern();
    const root = (await controller.getDefaultPattern(false))!;
    const before = getPatternIdentityRef(root);
    const originalWithTx = root.withTx;
    root.withTx = (() => {
      throw new Error("pattern identity swap rejected");
    }) as typeof root.withTx;
    stub.setSource(SOURCE_V2);

    try {
      expect(await reconcilePieceSource(runtime, root)).toBe("unavailable");
      expect(getPatternIdentityRef(root)).toEqual(before);
    } finally {
      root.withTx = originalWithTx;
    }
  });

  it("reports a custom root with no patternSource as detached", async () => {
    await setup();
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-root.tsx",
        files: [{ name: "/custom-root.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await controller.getDefaultPattern(false))!;
    expect(getPatternSource(root)).toBeUndefined();
    const before = getPatternIdentityRef(root)?.identity;

    // Even though the toolshed serves a (different) default-app identity, we
    // must NOT roll this space to default-app: being a root is not provenance,
    // and nothing supplies code to a piece that follows nothing.
    stub.setSource(SOURCE_V2);
    expect(
      await reconcilePieceSource(
        runtime,
        (await controller.getDefaultPattern(false))!,
      ),
    ).toBe("detached");
    expect(getPatternIdentityRef(root)?.identity).toBe(before);
    expect(stub.identityFetches()).toBe(0);
  });

  it("reports a custom home root with no origin as detached", async () => {
    await setupHome();
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await controller.getDefaultPattern(false))!;
    const before = getPatternIdentityRef(root);
    expect(getPatternSource(root)).toBeUndefined();

    stub.setSource(SOURCE_V2);
    expect(
      await reconcilePieceSource(
        runtime,
        (await controller.getDefaultPattern(false))!,
      ),
    ).toBe("detached");
    expect(getPatternIdentityRef(root)).toEqual(before);
    expect(getPatternSource(root)).toBeUndefined();
    expect(stub.identityFetches()).toBe(0);
  });

  it("rolls the home root forward when its source moves", async () => {
    // A home space (session space == the identity DID) follows its origin like
    // any other piece. Same in-place semantics: no new piece minted.

    await setupHome();
    const piece = await controller.ensureDefaultPattern();
    const rootLinkBefore = JSON.stringify(piece.getCell().getAsLink());
    const idV1 = getPatternIdentityRef(piece.getCell())?.identity;

    stub.setSource(SOURCE_V2);
    expect(
      await reconcilePieceSource(
        runtime,
        (await controller.getDefaultPattern(false))!,
      ),
    ).toBe("updated");
    await runtime.idle();

    const root = (await controller.getDefaultPattern(false))!;
    expect(JSON.stringify(root.getAsLink())).toBe(rootLinkBefore);
    const idV2 = getPatternIdentityRef(root)?.identity;
    // The home root compiles at HOME_PATTERN_PATH — identity includes the entry.
    expect(idV2).toBe(
      await identityForSource(SOURCE_V2, {}, HOME_PATTERN_PATH),
    );
    expect(idV2).not.toBe(idV1);
  });

  // The unloadability tiebreak. A stale sourceless root is ambiguous between
  // an obsolete system root and a deliberate custom program (custom recreation
  // stamps no provenance), so a LOADABLE one stays pinned — the test above.
  // One that cannot cold-load is a dead page under either reading: replace it
  // with the official system root and record the displaced ref for recovery.
  // (The 2026-07-21 estuary migration bricked every pre-provenance home root;
  // the pin alone kept them bricked after the update flag opened.)
  function shadowLoadProbe(
    staleIdentity: string,
    outcome: "undefined" | "reject",
  ): () => void {
    const pm = runtime.patternManager as unknown as {
      loadPatternByIdentity: (
        identity: string,
        symbol: string,
        space: unknown,
      ) => Promise<unknown>;
      artifactFromIdentitySync: (identity: string, symbol: string) => unknown;
    };
    const original = pm.loadPatternByIdentity.bind(runtime.patternManager);
    const originalSync = pm.artifactFromIdentitySync.bind(
      runtime.patternManager,
    );
    // The harness compiled the stale program for real, so the unloadable
    // outcome (on estuary: a runtime migration invalidated the stored source)
    // is injected at both seams a start resolves a pattern through — the
    // in-memory artifact index first, then the by-identity load.
    pm.artifactFromIdentitySync = (identity, symbol) =>
      identity === staleIdentity ? undefined : originalSync(identity, symbol);
    pm.loadPatternByIdentity = (identity, symbol, space) =>
      identity !== staleIdentity
        ? original(identity, symbol, space)
        : outcome === "undefined"
        ? Promise.resolve(undefined)
        : Promise.reject(new Error("probe backend unavailable"));
    return () => {
      pm.loadPatternByIdentity = original;
      pm.artifactFromIdentitySync = originalSync;
    };
  }

  it("replaces an unloadable stale sourceless home root", async () => {
    await setupHome();
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await controller.getDefaultPattern(false))!;
    const staleRef = getPatternIdentityRef(root)!;
    expect(getPatternSource(root)).toBeUndefined();

    stub.setSource(SOURCE_V2);
    await controller.stopPiece(root);
    const restore = shadowLoadProbe(staleRef.identity, "undefined");
    try {
      await controller.ensureDefaultPattern();
    } finally {
      restore();
    }
    await runtime.idle();

    const after = (await controller.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)?.identity).toBe(
      await identityForSource(SOURCE_V2, {}, HOME_PATTERN_PATH),
    );
    // Provenance back-filled: the root now tracks the official URL.
    expect(getPatternSource(after)).toBe(HOME_PATTERN_SOURCE);
    // The displaced ref is the only record of the replaced sourceless root.
    const displaced = (after as unknown as {
      getMetaRaw: (key: string) => unknown;
    }).getMetaRaw("displacedPattern") as {
      identity?: string;
      symbol?: string;
      displacedAt?: number;
    };
    expect(displaced?.identity).toBe(staleRef.identity);
    expect(displaced?.symbol).toBe(staleRef.symbol);
    expect(typeof displaced?.displacedAt).toBe("number");
  });

  it("swapped-in pattern with handlers starts over the reused root doc", async () => {
    // The estuary post-#4883 failure class: the swap engages, writes the new
    // patternIdentity onto the EXISTING result cell, and the replacement
    // pattern must then start over that reused doc — including materializing
    // the internal cells of handler nodes the old program never had. A
    // handler-less roll target (every other test here) cannot see this;
    // home.tsx is handler-rich.

    await setupHome();
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await controller.getDefaultPattern(false))!;
    const staleRef = getPatternIdentityRef(root)!;

    stub.setSource(SOURCE_V3_HANDLER);
    await controller.stopPiece(root);
    const restore = shadowLoadProbe(staleRef.identity, "undefined");
    try {
      await controller.ensureDefaultPattern();
    } finally {
      restore();
    }
    await runtime.idle();

    // The swap alone is not the contract — the replacement must RUN. Start
    // it the way bootstrap would and let the scheduler settle; the functional
    // read below is the pin: `count` only reads 0 if the swapped-in program
    // actually ran its setup (internal cells materialized) and instantiated.
    const after = (await controller.getDefaultPattern(true))!;
    await runtime.idle();
    expect(getPatternIdentityRef(after)?.identity).toBe(
      await identityForSource(SOURCE_V3_HANDLER, {}, HOME_PATTERN_PATH),
    );
    expect(after.key("count").get()).toBe(0);
  });

  it("keeps a stopped root's source when the candidate refuses its data", async () => {
    // The candidate declares a required input the root's stored argument does
    // not carry. Following an origin does not compare the two contracts, so
    // what refuses this is staging the candidate over the document: setup
    // rejects it, the transition fails, and the root keeps what it has.
    //
    // TODO(hixie): migrate the root's data onto the candidate instead. As it
    // stands the root silently stops following its own origin, and nobody is
    // told.

    const SOURCE_INCOMPATIBLE = [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ mustHave: string }>(({ mustHave }) => ({",
      "  mustHave,",
      "}));",
      "",
    ].join("\n");
    await setupHome();
    await controller.ensureDefaultPattern();
    const root = (await controller.getDefaultPattern(false))!;
    const runningRef = getPatternIdentityRef(root)!;
    await controller.stopPiece(root);

    stub.setSource(SOURCE_INCOMPATIBLE);
    expect(await reconcilePieceSource(runtime, root)).toBe("unavailable");
    await runtime.idle();
    const after = (await controller.getDefaultPattern(true))!;
    await runtime.idle();
    expect(getPatternIdentityRef(after)).toEqual(runningRef);
    expect(after.key("marker").get()).toBe("v1");
  });

  it("cold-boot swap: handler-bearing replacement heals a root that was NOT running", async () => {
    // The real estuary bricked-space shape, which the running-piece test
    // above cannot see: a bricked root never STARTED (its stored source
    // fails to load), so there is no patternIdentity watcher when the swap
    // lands. ensureDefaultPattern reconciles BEFORE start
    // (startEnsuredDefaultPattern -> checkAndUpdateDefaultPattern), then
    // cold-starts the piece — and `Runner.#startCore()`'s initial
    // instantiation does not run the setup phase, so the incoming pattern's
    // internal cells were never materialized on the reused doc.

    await setupHome();
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await controller.getDefaultPattern(false))!;
    const staleRef = getPatternIdentityRef(root)!;

    // The piece is NOT running when the swap lands — the defining difference
    // from the watcher-path test above.
    await controller.stopPiece(root);

    stub.setSource(SOURCE_V3_HANDLER);
    const restore = shadowLoadProbe(staleRef.identity, "undefined");
    try {
      // The real boot entry: reconcile-before-start, then cold start.
      await controller.ensureDefaultPattern();
    } finally {
      restore();
    }
    await runtime.idle();

    // Re-resolve: the controller's cell is a pre-heal transaction view.
    const after = (await controller.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)?.identity).toBe(
      await identityForSource(SOURCE_V3_HANDLER, {}, HOME_PATTERN_PATH),
    );
    // Functional pin: the pattern body ran its setup (count materialized)…
    expect(after.key("count").get()).toBe(0);
    // …and the handler's stream marker actually works end-to-end.
    (after.key("bump") as unknown as { send: (e: unknown) => void }).send({});
    await runtime.idle();
    await (after as unknown as { pull: () => Promise<unknown> }).pull();
    const afterEvent = (await controller.getDefaultPattern(false))!;
    expect(afterEvent.key("count").get()).toBe(1);
  });

  it("cold start heals a doc whose identity already moved without setup", async () => {
    // The CURRENT durable state of an estuary space bricked by the deployed
    // build: the 2026-07-22 flow already CAS-wrote patternIdentity to the
    // official pattern (checkAndUpdateDefaultPattern "Never calls run()"),
    // but no setup ever committed, so the doc has no internal-cell manifest
    // entries or stream markers for that pattern. On the next boot the
    // identity compares current, so no further swap fires — the doc must be
    // healed at cold start itself.

    await setupHome();
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await controller.getDefaultPattern(false))!;
    await controller.stopPiece(root);

    stub.setSource(SOURCE_V3_HANDLER);
    const targetId = await identityForSource(
      SOURCE_V3_HANDLER,
      {},
      HOME_PATTERN_PATH,
    );
    // Model the already-committed swap: identity points at the CURRENT
    // official pattern, doc still set up for SOURCE_V1 (marker-less for V3).
    const { error } = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw("patternIdentity", {
        identity: targetId,
        symbol: "default",
      }, rawMetaWriteAuthorization);
    });
    expect(error).toBeUndefined();

    await controller.ensureDefaultPattern();
    await runtime.idle();

    // Re-resolve: the controller's cell is a pre-heal transaction view.
    const after = (await controller.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)?.identity).toBe(targetId);
    expect(after.key("count").get()).toBe(0);
    (after.key("bump") as unknown as { send: (e: unknown) => void }).send({});
    await runtime.idle();
    await (after as unknown as { pull: () => Promise<unknown> }).pull();
    const afterEvent = (await controller.getDefaultPattern(false))!;
    expect(afterEvent.key("count").get()).toBe(1);
  });

  it("swaps in a pattern whose argument adds an owner-protected defaulted field", async () => {
    await setupHome();
    expect(runtime.cfcEnforcementMode).not.toBe("disabled");
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await controller.getDefaultPattern(false))!;
    const staleRef = getPatternIdentityRef(root)!;
    const edit = runtime.edit();
    root.withTx(edit).key("items").set(["saved"]);
    runtime.prepareTxForCommit(edit);
    expect((await edit.commit()).error).toBeUndefined();
    await controller.stopPiece(root);

    stub.setSource(SOURCE_HOME_GUARDED_DEFAULT);
    const restore = shadowLoadProbe(staleRef.identity, "undefined");
    try {
      await controller.ensureDefaultPattern();
    } finally {
      restore();
    }
    await runtime.idle();

    const after = (await controller.getDefaultPattern(true))!;
    await runtime.idle();
    expect(getPatternIdentityRef(after)?.identity).toBe(
      await identityForSource(
        SOURCE_HOME_GUARDED_DEFAULT,
        {},
        HOME_PATTERN_PATH,
      ),
    );
    expect(after.key("count").get()).toBe(0);
    expect(after.key("items").get()).toEqual(["saved"]);
    expect(after.key("guarded").get()).toEqual([]);
    const append = runtime.edit();
    after.withTx(append).key("addGuardedRow").send({ label: "owner edit" });
    runtime.prepareTxForCommit(append);
    expect((await append.commit()).error).toBeUndefined();
    await after.pull();
    await runtime.idle();
    const updated = (await controller.getDefaultPattern(false))!;
    expect(updated.key("guarded").get()).toEqual([{ label: "owner edit" }]);

    const attack = runtime.edit();
    const argument = getMetaLink(after.withTx(attack), "argument")!;
    runtime.getCellFromLink(
      { ...argument, schema: undefined },
      undefined,
      attack,
    )
      .key("guarded").set([]);
    runtime.prepareTxForCommit(attack);
    expect((await attack.commit()).error?.message).toContain(
      "writeAuthorizedBy",
    );
  });

  it("heals a root whose pinned pattern fails CFC migration by rolling forward to official", async () => {
    // A pinned pattern is loadable, but its setup repair reports the
    // machine-tagged CFC schema-migration rejection injected below. Enforce-on
    // is the default here because the rejecting layer is the point of the
    // orchestration test. The runnability backstop must roll the root forward
    // to the current official identity and materialize it, including a live
    // handler stream.

    await setupHome();
    expect(runtime.cfcEnforcementMode).not.toBe("disabled");

    // 1. Age the doc: materialize a favorites-less vintage.
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await controller.getDefaultPattern(false))!;
    await controller.stopPiece(root);

    // 2. Compile the migration-rejected fixture so its identity is loadable
    //    in-session, then pin the root to it without source state.
    stub.setSource(SOURCE_HOME_OLD_REQUIRED);
    const oldResolved = await runtime.harness.resolve(
      new HttpProgramResolver(new URL(HOME_PATTERN_PATH, runtime.apiUrl).href),
    );
    const oldPattern = await runtime.patternManager.compilePattern(
      { ...oldResolved, mainExport: "default" },
      { space: controller.getSpace() },
    );
    const oldRef = runtime.patternManager.getArtifactEntryRef(oldPattern)!;
    const { error: pinError } = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw("patternIdentity", {
        identity: oldRef.identity,
        symbol: "default",
      }, rawMetaWriteAuthorization);
    });
    expect(pinError).toBeUndefined();
    // The pinned OLD pattern really is loadable — "loadable but unrunnable" is
    // the precise state this heal is reached from: the cold-start repair's load
    // check hands a pattern that loads on to the setup repair, and only that
    // repair's CFC-migration rejection or stored-argument refusal escalates
    // here.
    await expect(
      runtime.patternManager.loadPatternByIdentity(
        oldRef.identity,
        "default",
        controller.getSpace(),
      ),
    ).resolves.toBeDefined();

    // 3. Toolshed now serves the roll-forward target. Take its expected
    //    identity the SAME way the heal does — the compiled artifact ref, not a
    //    source hash — so the assertion also proves the roll-forward compiled
    //    THIS source, not a stale-cached one.
    stub.setSource(SOURCE_HOME_OFFICIAL_DEFAULTED);
    const officialResolved = await runtime.harness.resolve(
      new HttpProgramResolver(new URL(HOME_PATTERN_PATH, runtime.apiUrl).href),
    );
    const officialPattern = await runtime.patternManager.compilePattern(
      { ...officialResolved, mainExport: "default" },
      { space: controller.getSpace() },
    );
    const officialId =
      runtime.patternManager.getArtifactEntryRef(officialPattern)!.identity;
    // A genuine roll-forward: the target identity differs from the pinned one.
    expect(officialId).not.toBe(oldRef.identity);

    // 4. Inject the CFC MIGRATION rejection on the pinned pattern's OWN setup
    //    repair — the exact signal the runnability gate keys on. Keyed by
    //    expectedPatternIdentity so ONLY the same-identity repair (OLD) is
    //    rejected; the roll-forward's materialize (OFFICIAL) runs for real and
    //    must heal the reused doc. The rejection message mirrors the live
    //    "CFC enforcement rejected commit" wrapper (see the runner + #4936's
    //    schema-merge tests) so the gate's predicate is exercised as shipped.
    //    A genuine required-field rejection for unclassified CFC document data
    //    is covered directly by cfc-additive-default-preserves-old-doc.test.ts;
    //    here we pin the ORCHESTRATION the piece controller adds on top.
    const rt = runtime as unknown as {
      runSynced: (...args: unknown[]) => Promise<unknown>;
    };
    const realRunSynced = rt.runSynced.bind(runtime);
    rt.runSynced = (...args: unknown[]) => {
      const opts = args[3] as
        | { expectedPatternIdentity?: { identity?: string } }
        | undefined;
      if (opts?.expectedPatternIdentity?.identity === oldRef.identity) {
        // The EXACT string the runner surfaces for this class: the commit
        // wrapper, the `not prepared` middle, then the machine token the CFC
        // prepare tags on (see migration-reason.ts / runner.ts). Built from the
        // shared token constant so the gate's predicate is exercised as shipped.
        return Promise.reject(
          new Error(
            "CFC enforcement rejected commit: relevant transaction was not " +
              `prepared: ${CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON}: ` +
              "required field favorites needs a default to preserve old documents",
          ),
        );
      }
      return realRunSynced(...args);
    };

    // 5. Boot: heal by roll-forward — no throw.
    try {
      await controller.ensureDefaultPattern();
    } finally {
      rt.runSynced = realRunSynced;
    }
    await runtime.idle();

    // Re-resolve: the controller's cell is a pre-heal transaction view.
    const after = (await controller.getDefaultPattern(false))!;
    // Rolled forward to the official identity, official provenance stamped…
    expect(getPatternIdentityRef(after)?.identity).toBe(officialId);
    expect(getPatternSource(after)).toBe(HOME_PATTERN_SOURCE);
    // …recording the displaced pinned pattern for recovery.
    const displaced = (after as unknown as {
      getMetaRaw: (k: string) => unknown;
    }).getMetaRaw("displacedPattern") as { identity?: string } | undefined;
    expect(displaced?.identity).toBe(oldRef.identity);

    // FUNCTIONAL read (not just a swap-shaped assertion): the once-fatal
    // required field materialized to its default, and the handler stream works
    // end to end over the reused doc.
    expect(after.key("favorites").get()).toEqual([]);
    expect(after.key("count").get()).toBe(0);
    (after.key("bump") as unknown as { send: (e: unknown) => void }).send({});
    await runtime.idle();
    await (after as unknown as { pull: () => Promise<unknown> }).pull();
    const afterEvent = (await controller.getDefaultPattern(false))!;
    expect(afterEvent.key("count").get()).toBe(1);

    // The roll-forward compiled the FRESHEST official source (ETag-revalidated,
    // `cache: "no-cache"`), never a stale HTTP-cached one — escaping a stale
    // pin is the whole point, so a cache-stale compile would defeat it.
    const homeSourceFetches = stub.requestedFetches().filter((f) => {
      const u = new URL(f.href);
      return u.pathname === HOME_PATTERN_PATH &&
        !u.searchParams.has("identity");
    });
    expect(homeSourceFetches.some((f) => f.cache === "no-cache")).toBe(true);
  });

  // Shared scaffolding for the roll-forward edge cases below: age a home doc,
  // then pin the stopped root sourceless to the identity whose repair each case
  // will reject explicitly. Returns that ref and the distinct official identity
  // a successful roll-forward should reach.
  const pinOldRequiredHome = async () => {
    await setupHome();
    expect(runtime.cfcEnforcementMode).not.toBe("disabled");
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await controller.getDefaultPattern(false))!;
    await controller.stopPiece(root);

    stub.setSource(SOURCE_HOME_OLD_REQUIRED);
    const oldResolved = await runtime.harness.resolve(
      new HttpProgramResolver(new URL(HOME_PATTERN_PATH, runtime.apiUrl).href),
    );
    const oldPattern = await runtime.patternManager.compilePattern(
      { ...oldResolved, mainExport: "default" },
      { space: controller.getSpace() },
    );
    const oldRef = runtime.patternManager.getArtifactEntryRef(oldPattern)!;
    const { error: pinError } = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw("patternIdentity", {
        identity: oldRef.identity,
        symbol: "default",
      }, rawMetaWriteAuthorization);
    });
    expect(pinError).toBeUndefined();

    // Toolshed now serves OFFICIAL; derive its compiled identity the same way
    // the heal does, so `officialId` is exactly the roll-forward's target.
    stub.setSource(SOURCE_HOME_OFFICIAL_DEFAULTED);
    const officialResolved = await runtime.harness.resolve(
      new HttpProgramResolver(new URL(HOME_PATTERN_PATH, runtime.apiUrl).href),
    );
    const officialPattern = await runtime.patternManager.compilePattern(
      { ...officialResolved, mainExport: "default" },
      { space: controller.getSpace() },
    );
    const officialId =
      runtime.patternManager.getArtifactEntryRef(officialPattern)!.identity;
    expect(officialId).not.toBe(oldRef.identity);
    return { root, oldRef, officialId };
  };

  // The full production rejection string for the recoverable class, built from
  // the shared token so the gate is exercised exactly as shipped.
  const MIGRATION_REJECTION =
    "CFC enforcement rejected commit: relevant transaction was not prepared: " +
    `${CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON}: required field favorites ` +
    "needs a default to preserve old documents";

  const patchRunSynced = (
    impl: (
      opts: { expectedPatternIdentity?: { identity?: string } } | undefined,
    ) => Promise<unknown> | "real",
  ) => {
    const rt = runtime as unknown as {
      runSynced: (...args: unknown[]) => Promise<unknown>;
    };
    const real = rt.runSynced.bind(runtime);
    rt.runSynced = (...args: unknown[]) => {
      const opts = args[3] as
        | { expectedPatternIdentity?: { identity?: string } }
        | undefined;
      const out = impl(opts);
      return out === "real" ? real(...args) : out;
    };
    return () => {
      rt.runSynced = real;
    };
  };

  it("fails clearly when a root loses its source state during repair", async () => {
    const { oldRef } = await pinOldRequiredHome();
    const root = (await controller.getDefaultPattern(false))!;
    const restoreRun = patchRunSynced((opts) =>
      opts?.expectedPatternIdentity?.identity === oldRef.identity
        ? Promise.reject(new Error(MIGRATION_REJECTION))
        : "real"
    );
    const originalCompile = runtime.patternManager.compilePattern;
    const originalGetMetaRaw = root.getMetaRaw;
    const originalGetDefaultPattern = controller.getDefaultPattern;
    let clearedSourceState = false;
    controller.getDefaultPattern =
      (() => Promise.resolve(root)) as typeof controller.getDefaultPattern;
    root.getMetaRaw = ((field, options) => {
      if (clearedSourceState && field === "patternIdentity") return undefined;
      return originalGetMetaRaw.call(root, field, options);
    }) as typeof root.getMetaRaw;
    runtime.patternManager.compilePattern = (async (input, cacheCtx) => {
      const pattern = await originalCompile.call(
        runtime.patternManager,
        input,
        cacheCtx,
      );
      if (!clearedSourceState) {
        clearedSourceState = true;
      }
      return pattern;
    }) as typeof runtime.patternManager.compilePattern;

    try {
      await expect(controller.ensureDefaultPattern()).rejects.toThrow(
        "has no source state to update",
      );
      expect(clearedSourceState).toBe(true);
    } finally {
      restoreRun();
      root.getMetaRaw = originalGetMetaRaw;
      controller.getDefaultPattern = originalGetDefaultPattern;
      runtime.patternManager.compilePattern = originalCompile;
    }
  });

  it("stays fail-closed when the repair fails with a CFC rejection that is NOT a schema migration", async () => {
    // The negative twin of the roll-forward test: a repair rejection that
    // carries the `CFC enforcement rejected commit` PREFIX but is NOT the
    // schema-migration class (here: a prepared-digest race). Those
    // reflect ordering/policy/provenance faults, not "the pinned pattern is
    // wrong", so the backstop must NOT repoint the root. The bare-prefix
    // predicate this replaces would have wrongly rolled forward here.

    const { root, oldRef, officialId } = await pinOldRequiredHome();
    const restore = patchRunSynced((opts) =>
      opts?.expectedPatternIdentity?.identity === oldRef.identity
        ? Promise.reject(
          new Error("CFC enforcement rejected commit: prepared digest changed"),
        )
        : "real"
    );
    let thrown: unknown;
    try {
      await controller.ensureDefaultPattern();
    } catch (error) {
      thrown = error;
    } finally {
      restore();
    }
    // Fail-closed: the ORIGINAL cold-start failure surfaces, not a heal error…
    expect(String(thrown)).toContain("stored setup was staged by");
    expect(String(thrown)).not.toContain("default-root heal failed");
    // …and the root's identity is untouched — no roll-forward, no displacement.
    const after = (await controller.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)?.identity).toBe(oldRef.identity);
    expect(getPatternIdentityRef(after)?.identity).not.toBe(officialId);
    expect(
      (after as unknown as { getMetaRaw: (k: string) => unknown })
        .getMetaRaw("displacedPattern"),
    ).toBeUndefined();
    void root;
  });

  it("stays fail-closed when the token appears incidentally in an unrelated CFC error (no false roll-forward)", async () => {
    // Collision guard: the token must be matched in its FRAMED reason position
    // (`: <token>: `), not anywhere in the message. Here an ordinary
    // incompatible-type rejection mentions a property PATH that happens to be
    // named `/cfc-schema-migration-incompatible` — a bare `includes(token)`
    // would misclassify it as recoverable and repoint the root. It must stay
    // fail-closed.

    const { root, oldRef, officialId } = await pinOldRequiredHome();
    const restore = patchRunSynced((opts) =>
      opts?.expectedPatternIdentity?.identity === oldRef.identity
        ? Promise.reject(
          new Error(
            "CFC enforcement rejected commit: relevant transaction was not " +
              `prepared: incompatible types at /${CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON}`,
          ),
        )
        : "real"
    );
    let thrown: unknown;
    try {
      await controller.ensureDefaultPattern();
    } catch (error) {
      thrown = error;
    } finally {
      restore();
    }
    // The ORIGINAL cold-start failure surfaces (fail-closed), not a heal error.
    expect(String(thrown)).toContain("stored setup was staged by");
    expect(String(thrown)).not.toContain("default-root heal failed");
    const after = (await controller.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)?.identity).toBe(oldRef.identity);
    expect(getPatternIdentityRef(after)?.identity).not.toBe(officialId);
    expect(
      (after as unknown as { getMetaRaw: (k: string) => unknown })
        .getMetaRaw("displacedPattern"),
    ).toBeUndefined();
    void root;
  });

  it("aborts the roll-forward swap fail-closed if the root identity changed underneath it", async () => {
    // Blocking-2 guard: `editWithRetry` reruns the swap callback against fresh
    // state, so a concurrent heal that repoints the root between the failed
    // repair and our swap must NOT be clobbered by our stale `officialRef`. We
    // simulate the concurrent heal inside the repair rejection, repointing the
    // root to a THIRD (loadable) identity, then reject with the migration
    // signal so the roll-forward proceeds to the swap — where the precondition
    // must see the changed identity and abort.

    const { root, oldRef, officialId } = await pinOldRequiredHome();

    // A distinct, loadable identity for the "concurrent heal" to install.
    stub.setSource(SOURCE_V3_HANDLER);
    const otherResolved = await runtime.harness.resolve(
      new HttpProgramResolver(new URL(HOME_PATTERN_PATH, runtime.apiUrl).href),
    );
    const otherPattern = await runtime.patternManager.compilePattern(
      { ...otherResolved, mainExport: "default" },
      { space: controller.getSpace() },
    );
    const concurrentId =
      runtime.patternManager.getArtifactEntryRef(otherPattern)!.identity;
    expect(concurrentId).not.toBe(oldRef.identity);
    expect(concurrentId).not.toBe(officialId);
    stub.setSource(SOURCE_HOME_OFFICIAL_DEFAULTED);

    const restore = patchRunSynced((opts) => {
      if (opts?.expectedPatternIdentity?.identity === oldRef.identity) {
        return (async () => {
          await runtime.editWithRetry((tx) => {
            root.withTx(tx).setMetaRaw("patternIdentity", {
              identity: concurrentId,
              symbol: "default",
            }, rawMetaWriteAuthorization);
          });
          throw new Error(MIGRATION_REJECTION);
        })();
      }
      return "real";
    });
    let thrown: unknown;
    try {
      await controller.ensureDefaultPattern();
    } catch (error) {
      thrown = error;
    } finally {
      restore();
    }
    // Fail-closed: a superseded swap is surfaced as a CLEAR error, never
    // reported as success. This is the cold-start path, so the caller does not
    // start what we return — claiming success would hand back an unstarted,
    // un-setup root (the concurrent heal's repoint commits before its own
    // materialize).
    expect(String(thrown)).toContain("default-root heal failed");
    expect(String(thrown)).toContain("superseded by a concurrent heal");
    // Our stale roll-forward did NOT clobber the concurrent identity (no
    // displacement recorded, official identity never installed).
    const after = (await controller.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)?.identity).toBe(concurrentId);
    expect(getPatternIdentityRef(after)?.identity).not.toBe(officialId);
    expect(
      (after as unknown as { getMetaRaw: (k: string) => unknown })
        .getMetaRaw("displacedPattern"),
    ).toBeUndefined();

    // No silent success: the NEXT boot (runSynced restored) starts the
    // concurrent root through the ordinary repair and it works end to end —
    // the once-missing handler markers materialize and the handler fires.
    await controller.ensureDefaultPattern();
    await runtime.idle();
    const healed = (await controller.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(healed)?.identity).toBe(concurrentId);
    expect(healed.key("count").get()).toBe(0);
    (healed.key("bump") as unknown as { send: (e: unknown) => void }).send({});
    await runtime.idle();
    await (healed as unknown as { pull: () => Promise<unknown> }).pull();
    const afterEvent = (await controller.getDefaultPattern(false))!;
    expect(afterEvent.key("count").get()).toBe(1);
  });

  it("surfaces one clear error when the official pattern ALSO fails to migrate", async () => {
    // The atomic-failure contract: if even the current official pattern cannot
    // migrate the reused doc, the operator gets ONE error that names WHY —
    // the pinned pattern's migration failure and the official's — instead of
    // reverse-engineering scattered logs.

    const { oldRef, officialId } = await pinOldRequiredHome();
    const restore = patchRunSynced((opts) =>
      // Reject BOTH the same-identity repair AND the official materialize.
      opts?.expectedPatternIdentity
        ? Promise.reject(new Error(MIGRATION_REJECTION))
        : "real"
    );
    let thrown: unknown;
    try {
      await controller.ensureDefaultPattern();
    } catch (error) {
      thrown = error;
    } finally {
      restore();
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("default-root heal failed");
    expect(message).toContain(oldRef.identity);
    expect(message).toContain("also failed CFC migration");
    // The underlying migration failure is chained as the cause, not discarded.
    expect((thrown as Error)?.cause).toBeDefined();
    // After a failed official materialize the root is pinned to official (the
    // current best pattern), with the displaced OLD ref recorded for recovery —
    // the next boot re-attempts official and, if it still cannot migrate,
    // short-circuits to the same clear error rather than looping.
    const after = (await controller.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)?.identity).toBe(officialId);
  });

  it("surfaces a clear error without looping when the root is already pinned to official", async () => {
    // If the pinned pattern already IS the official ENTRY (same identity AND
    // symbol) but still fails migration (some other cause), rolling forward
    // would target the same entry — the swap is skipped and we surface the
    // clear "already the pinned entry" error instead of looping. The
    // symbol-differs sibling below proves the gate does NOT short-circuit when
    // only the identity matches.

    await setupHome();
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await controller.getDefaultPattern(false))!;
    await controller.stopPiece(root);
    stub.setSource(SOURCE_HOME_OFFICIAL_DEFAULTED);
    const officialResolved = await runtime.harness.resolve(
      new HttpProgramResolver(new URL(HOME_PATTERN_PATH, runtime.apiUrl).href),
    );
    const officialPattern = await runtime.patternManager.compilePattern(
      { ...officialResolved, mainExport: "default" },
      { space: controller.getSpace() },
    );
    const officialRef = runtime.patternManager.getArtifactEntryRef(
      officialPattern,
    )!;
    await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw("patternIdentity", {
        identity: officialRef.identity,
        symbol: "default",
      }, rawMetaWriteAuthorization);
    });
    const restore = patchRunSynced((opts) =>
      opts?.expectedPatternIdentity?.identity === officialRef.identity
        ? Promise.reject(new Error(MIGRATION_REJECTION))
        : "real"
    );
    let thrown: unknown;
    try {
      await controller.ensureDefaultPattern();
    } catch (error) {
      thrown = error;
    } finally {
      restore();
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("default-root heal failed");
    expect(message).toContain("is already the pinned entry");
    expect(message).toContain("#default");
  });

  it("rolls forward a root pinned to the current artifact under an obsolete symbol", async () => {
    // The symbol-differs case (P2): the root is pinned to the CURRENT official
    // artifact identity but under an obsolete export symbol. That entry loads
    // for real (it is a genuine export of the served module) yet fails
    // migration; the heal MUST NOT short-circuit on the shared identity — it
    // must roll forward to the official `default` entry. A gate that compared
    // identity alone treated this as already-official and left it unhealable.

    await setupHome();
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await controller.getDefaultPattern(false))!;
    await controller.stopPiece(root);

    // The toolshed serves the two-export module. Compile BOTH exports from it:
    // they share one identity and differ only by symbol.
    stub.setSource(SOURCE_HOME_TWO_EXPORT);
    const resolved = await runtime.harness.resolve(
      new HttpProgramResolver(new URL(HOME_PATTERN_PATH, runtime.apiUrl).href),
    );
    const legacyPattern = await runtime.patternManager.compilePattern(
      { ...resolved, mainExport: "legacyHome" },
      { space: controller.getSpace() },
    );
    const legacyRef = runtime.patternManager.getArtifactEntryRef(
      legacyPattern,
    )!;
    const officialPattern = await runtime.patternManager.compilePattern(
      { ...resolved, mainExport: "default" },
      { space: controller.getSpace() },
    );
    const officialRef = runtime.patternManager.getArtifactEntryRef(
      officialPattern,
    )!;
    // Same module ⇒ same identity; only the symbol differs.
    expect(legacyRef.identity).toBe(officialRef.identity);
    expect(legacyRef.symbol).toBe("legacyHome");
    expect(officialRef.symbol).toBe("default");

    // Pin the (stopped) root to the obsolete-symbol entry.
    const { error: pinError } = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw("patternIdentity", {
        identity: legacyRef.identity,
        symbol: "legacyHome",
      }, rawMetaWriteAuthorization);
    });
    expect(pinError).toBeUndefined();

    // Reject ONLY the obsolete-symbol repair (its migration fails); the
    // roll-forward materialize of the `default` entry runs for real and heals.
    const restore = patchRunSynced((opts) => {
      const symbol = (opts?.expectedPatternIdentity as { symbol?: string })
        ?.symbol;
      return symbol === "legacyHome"
        ? Promise.reject(new Error(MIGRATION_REJECTION))
        : "real";
    });
    try {
      await controller.ensureDefaultPattern();
    } finally {
      restore();
    }
    await runtime.idle();

    // Healed by roll-forward to the `default` entry (not short-circuited),
    // displacing the obsolete-symbol pin for recovery.
    const after = (await controller.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)?.identity).toBe(officialRef.identity);
    expect(getPatternIdentityRef(after)?.symbol).toBe("default");
    const displaced = (after as unknown as {
      getMetaRaw: (k: string) => unknown;
    }).getMetaRaw("displacedPattern") as { symbol?: string } | undefined;
    expect(displaced?.symbol).toBe("legacyHome");
  });

  it("surfaces a clear error when the official pattern cannot be compiled", async () => {
    // The roll-forward's compile of the official source is a failure surface
    // too: if the toolshed serves un-compilable source, the operator gets one
    // clear "could not be compiled" error, not a raw compiler stack.

    const { oldRef } = await pinOldRequiredHome();
    stub.setSource("this is not valid typescript @@@ export default");
    const restore = patchRunSynced((opts) =>
      opts?.expectedPatternIdentity?.identity === oldRef.identity
        ? Promise.reject(new Error(MIGRATION_REJECTION))
        : "real"
    );
    let thrown: unknown;
    try {
      await controller.ensureDefaultPattern();
    } catch (error) {
      thrown = error;
    } finally {
      restore();
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("default-root heal failed");
    expect(message).toContain("could not be compiled");
  });

  it("surfaces a clear error when the official pattern yields no entry identity", async () => {
    // Defensive branch: compile succeeds but the artifact has no entry ref.
    // The heal must not proceed with an undefined identity — clear error.

    const { oldRef } = await pinOldRequiredHome();
    const pm = runtime.patternManager as unknown as {
      getArtifactEntryRef: (p: unknown) => unknown;
    };
    const realGetRef = pm.getArtifactEntryRef.bind(runtime.patternManager);
    pm.getArtifactEntryRef = () => undefined;
    const restore = patchRunSynced((opts) =>
      opts?.expectedPatternIdentity?.identity === oldRef.identity
        ? Promise.reject(new Error(MIGRATION_REJECTION))
        : "real"
    );
    let thrown: unknown;
    try {
      await controller.ensureDefaultPattern();
    } catch (error) {
      thrown = error;
    } finally {
      restore();
      pm.getArtifactEntryRef = realGetRef;
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("default-root heal failed");
    expect(message).toContain("did not yield an entry identity");
  });

  it("surfaces a clear error when the identity swap cannot commit", async () => {
    // Defensive branch: the swap transaction itself fails to commit (a storage
    // fault, not the precondition abort). The underlying error is chained and
    // the pinned identity is left untouched.

    const { oldRef } = await pinOldRequiredHome();
    const realEdit = runtime.editWithRetry.bind(runtime);
    (runtime as unknown as {
      editWithRetry: (fn: (tx: unknown) => unknown) => Promise<unknown>;
    }).editWithRetry = (fn) =>
      // Only the roll-forward swap records `displacedPattern`, so its callback
      // source uniquely identifies it — force THAT commit to fail, leaving
      // every other edit (pins, setup) real.
      typeof fn === "function" && fn.toString().includes("displacedPattern")
        ? Promise.resolve({ error: new Error("swap backend down") })
        : realEdit(fn as never);
    const restore = patchRunSynced((opts) =>
      opts?.expectedPatternIdentity?.identity === oldRef.identity
        ? Promise.reject(new Error(MIGRATION_REJECTION))
        : "real"
    );
    let thrown: unknown;
    try {
      await controller.ensureDefaultPattern();
    } catch (error) {
      thrown = error;
    } finally {
      restore();
      (runtime as unknown as { editWithRetry: unknown }).editWithRetry =
        realEdit;
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("default-root heal failed");
    expect(message).toContain("identity swap could not commit");
    expect(message).toContain("swap backend down");
    const after = (await controller.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)?.identity).toBe(oldRef.identity);
  });

  it("failed cold-start repair stays fail-closed and leaves the doc healable", async () => {
    // The repair's own failure contract: when the one-shot setup repair
    // cannot commit, the ORIGINAL start error must surface (not the repair's),
    // and the doc must be left exactly as it was — the next boot's repair
    // attempt still heals it. Driven at the runSynced boundary with a
    // commit-layer stub: this root's pointer names V3 while its setup marker
    // still names V1, so the in-process argument re-stage DOES run here — it
    // just passes, since the stored argument satisfies both schemas. A
    // commit-layer failure is what reliably exercises the fail-closed path
    // without also asserting the argument contract.

    await setupHome();
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await controller.getDefaultPattern(false))!;
    await controller.stopPiece(root);

    stub.setSource(SOURCE_V3_HANDLER);
    const currentPattern = await runtime.patternManager.compilePattern(
      {
        main: HOME_PATTERN_PATH,
        files: [{ name: HOME_PATTERN_PATH, contents: SOURCE_V3_HANDLER }],
      },
      { space: controller.getSpace() },
    );
    const currentRef = runtime.patternManager.getArtifactEntryRef(
      currentPattern,
    )!;
    const metadataUpdate = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw(
        "patternIdentity",
        currentRef,
        rawMetaWriteAuthorization,
      );
    });
    expect(metadataUpdate.error).toBeUndefined();

    const rt = runtime as unknown as {
      runSynced: (...args: unknown[]) => Promise<unknown>;
    };
    const originalRunSynced = rt.runSynced.bind(runtime);
    rt.runSynced = () =>
      Promise.reject(new Error("repair backend unavailable"));
    let thrown: unknown;
    try {
      await controller.ensureDefaultPattern();
    } catch (error) {
      thrown = error;
    } finally {
      rt.runSynced = originalRunSynced;
    }
    // The original start failure surfaces, not the repair's own error.
    expect(String(thrown)).toContain("stored setup was staged by");
    expect(String(thrown)).not.toContain("repair backend unavailable");

    // Nothing was torn down or corrupted: with the repair path restored, the
    // very next boot heals the same doc end-to-end.
    await controller.ensureDefaultPattern();
    await runtime.idle();
    const after = (await controller.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)?.identity).toBe(
      await identityForSource(SOURCE_V3_HANDLER, {}, HOME_PATTERN_PATH),
    );
    expect(after.key("count").get()).toBe(0);
    (after.key("bump") as unknown as { send: (e: unknown) => void }).send({});
    await runtime.idle();
    await (after as unknown as { pull: () => Promise<unknown> }).pull();
    const afterEvent = (await controller.getDefaultPattern(false))!;
    expect(afterEvent.key("count").get()).toBe(1);
  });

  it("repair guards rethrow the original start error when the pattern cannot be resolved", async () => {
    // The repair's admission guards, driven through the real boot entry.
    // Cold start of a doc in the already-swapped state whose (current)
    // identity cannot be loaded: the repair's own load sees the same
    // outcome, and each guard must surface the ORIGINAL start error.

    await setupHome();
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await controller.getDefaultPattern(false))!;
    await controller.stopPiece(root);
    stub.setSource(SOURCE_V3_HANDLER);
    const targetId = await identityForSource(
      SOURCE_V3_HANDLER,
      {},
      HOME_PATTERN_PATH,
    );
    const { error } = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw("patternIdentity", {
        identity: targetId,
        symbol: "default",
      }, rawMetaWriteAuthorization);
    });
    expect(error).toBeUndefined();

    // Guard: the repair's loadPatternByIdentity resolves undefined.
    let restore = shadowLoadProbe(targetId, "undefined");
    let thrown: unknown;
    try {
      await controller.ensureDefaultPattern();
    } catch (e) {
      thrown = e;
    } finally {
      restore();
    }
    expect(thrown).toBeDefined();

    // Guard: the repair's loadPatternByIdentity rejects outright.
    restore = shadowLoadProbe(targetId, "reject");
    thrown = undefined;
    try {
      await controller.ensureDefaultPattern();
    } catch (e) {
      thrown = e;
    } finally {
      restore();
    }
    expect(thrown).toBeDefined();

    // With the probes gone the same doc still heals — the guards left it
    // untouched.
    await controller.ensureDefaultPattern();
    await runtime.idle();
    const after = (await controller.getDefaultPattern(false))!;
    expect(after.key("count").get()).toBe(0);
  });

  it("repair guard rethrows the original start error for a malformed identity ref", async () => {
    // A root whose patternIdentity meta is present but malformed: start
    // fails, and the repair cannot even name a pattern to load — the
    // ref-undefined guard must surface the original start failure.

    await setupHome();
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await controller.getDefaultPattern(false))!;
    await controller.stopPiece(root);
    const { error } = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw(
        "patternIdentity",
        { malformed: true },
        rawMetaWriteAuthorization,
      );
    });
    expect(error).toBeUndefined();

    let thrown: unknown;
    try {
      await controller.ensureDefaultPattern();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
  });

  it("replaces an unloadable stale sourceless space root", async () => {
    // The fallback covers every space's DEFAULT pattern, not just home
    // (widened by the flag owner after a non-home field report): a root
    // that cannot load is a dead space regardless of kind. The displaced
    // ref is recorded for non-home too — it is the recovery pointer if
    // the replaced root was a custom program.

    await setup();
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-app.tsx",
        files: [{ name: "/custom-app.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await controller.getDefaultPattern(false))!;
    const staleRef = getPatternIdentityRef(root)!;
    expect(getPatternSource(root)).toBeUndefined();

    stub.setSource(SOURCE_V2);
    await controller.stopPiece(root);
    const restore = shadowLoadProbe(staleRef.identity, "undefined");
    try {
      await controller.ensureDefaultPattern();
    } finally {
      restore();
    }
    await runtime.idle();

    const after = (await controller.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)?.identity).toBe(
      await identityForSource(SOURCE_V2),
    );
    expect(getPatternSource(after)).toBe(
      DEFAULT_APP_PATTERN_SOURCE,
    );
    const displaced = (after as unknown as {
      getMetaRaw: (key: string) => unknown;
    }).getMetaRaw("displacedPattern") as {
      identity?: string;
      symbol?: string;
      displacedAt?: number;
    };
    expect(displaced?.identity).toBe(staleRef.identity);
    expect(displaced?.symbol).toBe(staleRef.symbol);
    expect(typeof displaced?.displacedAt).toBe("number");
  });

  it("keeps the home root pinned when the load probe fails", async () => {
    // A thrown probe is a failed CHECK, not evidence of a dead root — a
    // transient storage/backend failure must not authorize replacing an
    // ambiguous sourceless root. Fail closed, mutate nothing.

    await setupHome();
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await controller.getDefaultPattern(false))!;
    const staleRef = getPatternIdentityRef(root)!;

    stub.setSource(SOURCE_V2);
    await controller.stopPiece(root);
    const restore = shadowLoadProbe(staleRef.identity, "reject");
    try {
      // The open surfaces the start failure rather than replacing the root.
      await expect(controller.ensureDefaultPattern()).rejects.toThrow(
        "probe backend unavailable",
      );
    } finally {
      restore();
    }
    expect(getPatternIdentityRef(root)).toEqual(staleRef);
    expect(getPatternSource(root)).toBeUndefined();
    const displaced = (root as unknown as {
      getMetaRaw: (key: string) => unknown;
    }).getMetaRaw("displacedPattern");
    expect(displaced).toBeUndefined();
  });

  it("keeps the home root pinned when by-identity recovery is disabled", async () => {
    // Under cfcEnforcementMode "disabled" a by-identity load returns
    // undefined for anything outside the in-memory index, so it says "probe
    // unsupported" rather than "artifact dead" and authorizes nothing. The
    // root that cannot start therefore surfaces its failure rather than being
    // replaced.

    await setupHome({ cfcEnforcementMode: "disabled" });
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await controller.getDefaultPattern(false))!;
    const staleRef = getPatternIdentityRef(root)!;

    stub.setSource(SOURCE_V2);
    await controller.stopPiece(root);
    const restore = shadowLoadProbe(staleRef.identity, "undefined");
    try {
      await expect(controller.ensureDefaultPattern()).rejects.toThrow(
        "Could not load pattern",
      );
    } finally {
      restore();
    }
    expect(getPatternIdentityRef(root)).toEqual(staleRef);
    expect(getPatternSource(root)).toBeUndefined();
    expect(
      (root as unknown as { getMetaRaw: (key: string) => unknown })
        .getMetaRaw("displacedPattern"),
    ).toBeUndefined();
  });

  /** Point the home space's root config at `defaultAppUrl`. */
  async function configureDefaultAppUrl(defaultAppUrl: unknown): Promise<void> {
    const homeSpaceCell = runtime.getHomeSpaceCell();
    await homeSpaceCell.sync();
    const homeRoot = runtime.getCell(
      runtime.userIdentityDID,
      "home-root-config",
    );
    const { error } = await runtime.editWithRetry((tx) => {
      homeRoot.withTx(tx).set({ defaultAppUrl });
      // deno-lint-ignore no-explicit-any
      (homeSpaceCell.withTx(tx) as any).key("defaultPattern").set(homeRoot);
    });
    expect(error).toBeUndefined();
    await runtime.idle();
  }

  it("refuses a configured defaultAppUrl that names no pattern route", async () => {
    await setup();
    // A rooted path outside the patterns route resolves against the host to
    // whatever the site serves for an unrouted address, so a root born with
    // it would record an origin nothing can follow. The system default-app
    // source stands in.
    await configureDefaultAppUrl("/participant-card.tsx");

    await controller.recreateDefaultPattern();
    const root = (await controller.getDefaultPattern(false))!;
    expect(getPatternSource(root)).toBe(DEFAULT_APP_PATTERN_SOURCE);
    expect(getPatternIdentityRef(root)?.identity).toBe(
      await identityForSource(SOURCE_V1),
    );
    expect(
      stub.requestedHrefs().some((href) =>
        href.endsWith("/participant-card.tsx")
      ),
    ).toBe(false);
  });

  it("falls back to the system source when the home space cannot be read", async () => {
    await setup();
    // Reading the configured source is a convenience, not a precondition. A
    // home space this session cannot reach yields no configured value, and
    // the root is created from the source this deployment serves.
    const original = runtime.getHomeSpaceCell.bind(runtime);
    runtime.getHomeSpaceCell = () => {
      throw new Error("the home space is not reachable");
    };
    try {
      await controller.recreateDefaultPattern();
    } finally {
      runtime.getHomeSpaceCell = original;
    }

    const root = (await controller.getDefaultPattern(false))!;
    expect(getPatternSource(root)).toBe(DEFAULT_APP_PATTERN_SOURCE);
    expect(getPatternIdentityRef(root)?.identity).toBe(
      await identityForSource(SOURCE_V1),
    );
  });

  it("ignores a configured defaultAppUrl that is not a string", async () => {
    await setup();
    await configureDefaultAppUrl(42);

    await controller.recreateDefaultPattern();
    const root = (await controller.getDefaultPattern(false))!;
    expect(getPatternSource(root)).toBe(DEFAULT_APP_PATTERN_SOURCE);
    expect(getPatternIdentityRef(root)?.identity).toBe(
      await identityForSource(SOURCE_V1),
    );
  });

  describe("recreateDefaultPattern provenance (CT-1890)", () => {
    it("stamps a recreated non-home root so it can auto-update", async () => {
      await setup();
      await controller.recreateDefaultPattern();
      const root = (await controller.getDefaultPattern(false))!;
      expect(getPatternSource(root)).toBe(DEFAULT_APP_PATTERN_SOURCE);

      // The stamp is the point: it makes the recreated root eligible for
      // auto-update. A newer toolshed identity must roll it forward instead
      // of being skipped forever at the sourceless-root gate.
      stub.setSource(SOURCE_V2);
      expect(
        await reconcilePieceSource(
          runtime,
          (await controller.getDefaultPattern(false))!,
        ),
      ).toBe("updated");
      await runtime.idle();
      const updated = (await controller.getDefaultPattern(false))!;
      expect(getPatternIdentityRef(updated)?.identity).toBe(
        await identityForSource(SOURCE_V2),
      );
    });

    it("stamps the configured custom defaultAppUrl and updates through it", async () => {
      await setup();

      // Home config supplies a custom-app URL for new space roots: the home
      // root's `defaultAppUrl`, read via getDefaultAppUrlFromHome().
      const homeSpaceCell = runtime.getHomeSpaceCell();
      await homeSpaceCell.sync();
      const homeRoot = runtime.getCell(
        runtime.userIdentityDID,
        "home-root-config",
      );
      const { error } = await runtime.editWithRetry((tx) => {
        homeRoot.withTx(tx).set({ defaultAppUrl: CUSTOM_APP_URL });
        // deno-lint-ignore no-explicit-any
        (homeSpaceCell.withTx(tx) as any).key("defaultPattern").set(homeRoot);
      });
      expect(error).toBeUndefined();
      await runtime.idle();

      const customV1 = patternSource("custom-v1");
      stub.setCustomSource(customV1);
      await controller.recreateDefaultPattern();
      const root = (await controller.getDefaultPattern(false))!;
      // patternSource freezes the source selected at birth — the configured
      // custom app, not the default-app fallback. The authored URL is
      // canonicalized to the ref naming the same file, so the root is born
      // with the provenance it keeps rather than waiting on a migration.
      expect(getPatternSource(root)).toBe(CUSTOM_APP_SOURCE);
      expect(getPatternIdentityRef(root)?.identity).toBe(
        await identityForSource(customV1, {}, CUSTOM_APP_URL),
      );

      // ...and update lookup continues THROUGH that custom path: a newer
      // custom-app source rolls the root forward to the custom identity,
      // untouched by whatever the default-app path serves.
      const customV2 = patternSource("custom-v2");
      stub.setCustomSource(customV2);
      stub.setSource(SOURCE_V2);
      expect(
        await reconcilePieceSource(
          runtime,
          (await controller.getDefaultPattern(false))!,
        ),
      ).toBe("updated");
      await runtime.idle();
      const updated = (await controller.getDefaultPattern(false))!;
      expect(getPatternSource(updated)).toBe(CUSTOM_APP_SOURCE);
      expect(getPatternIdentityRef(updated)?.identity).toBe(
        await identityForSource(customV2, {}, CUSTOM_APP_URL),
      );
    });

    it("stamps a recreated home root with home.tsx", async () => {
      await setupHome();

      await controller.recreateDefaultPattern();
      const root = (await controller.getDefaultPattern(false))!;
      expect(getPatternSource(root)).toBe(HOME_PATTERN_SOURCE);
    });
  });
});
