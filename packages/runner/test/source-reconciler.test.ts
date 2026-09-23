import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { defer, type Deferred } from "@commonfabric/utils/defer";
import { Identity } from "@commonfabric/identity";
import {
  EmulatedStorageManager,
  newLoopbackServer,
  StorageManager,
} from "../src/storage/cache.deno.ts";
import {
  openSidecarSurface,
  type SidecarSurfaceState,
} from "../src/builtins/wish.ts";
import {
  type Cell,
  getPatternIdentityRef,
  getPatternSetupIdentityRef,
  getPatternSource,
  getPieceReconciliation,
  getPieceSourceRevisions,
  resolveEntryIdentity,
  Runtime,
  type RuntimeFetch,
  type RuntimeProgram,
  setPatternSource,
  systemPatternSource,
} from "../src/index.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";

const signer = await Identity.fromPassphrase("piece source reconciliation");
const PARENT_PATH = "/api/patterns/system/reconcile-parent.tsx";
// The `system:` ref that route path denotes — what a reconciled piece is
// stamped with, whichever legacy spelling it started from.
const PARENT_SOURCE = systemPatternSource("system/reconcile-parent.tsx");
const SOURCE_PATH = "/api/patterns/system/reconcile-target.tsx";
const SYMBOL = "TrackedPattern";

const parentSource = [
  `import { ${SYMBOL} } from "./reconcile-target.tsx";`,
  `export { ${SYMBOL} };`,
  `export default ${SYMBOL};`,
  "",
].join("\n");

function source(marker: string): string {
  return [
    "import { computed, pattern } from 'commonfabric';",
    `export const ${SYMBOL} = pattern<Record<string, never>, { marker: string }>(() => ({ marker: computed(() => "${marker}") }));`,
    "",
  ].join("\n");
}

function sourceWithRequiredInput(marker: string): string {
  return [
    "import { computed, pattern } from 'commonfabric';",
    `export const ${SYMBOL} = pattern<{ required: string }, { marker: string }>(() => ({ marker: computed(() => "${marker}") }));`,
    "",
  ].join("\n");
}

/** The same argument contract with a result the previous one does not carry. */
function sourceWithExtraResult(marker: string): string {
  return [
    "import { computed, pattern } from 'commonfabric';",
    `export const ${SYMBOL} = pattern<Record<string, never>, { marker: string; extra: string }>(() => ({ marker: computed(() => "${marker}"), extra: computed(() => "extra") }));`,
    "",
  ].join("\n");
}

/** A different contract the piece's empty stored argument still satisfies. */
function sourceWithChangedContract(marker: string): string {
  return [
    "import { computed, pattern } from 'commonfabric';",
    `export const ${SYMBOL} = pattern<{ optional?: string }, { marker: string; extra: string }>(() => ({ marker: computed(() => "${marker}"), extra: computed(() => "extra") }));`,
    "",
  ].join("\n");
}

function parentProgram(contents: string): RuntimeProgram {
  return {
    main: PARENT_PATH,
    mainExport: SYMBOL,
    files: [
      { name: PARENT_PATH, contents: parentSource },
      { name: SOURCE_PATH, contents },
    ],
  };
}

function identityFor(contents: string): Promise<string> {
  const files = new Map(
    parentProgram(contents).files.map(({ name, contents }) => [name, contents]),
  );
  return resolveEntryIdentity(
    PARENT_PATH,
    (name) =>
      files.has(name)
        ? Promise.resolve(files.get(name)!)
        : Promise.reject(new Error(`not found: ${name}`)),
  );
}

describe("piece source reconciliation", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let identityGate: Deferred<void> | undefined;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });

  afterEach(async () => {
    identityGate?.resolve();
    await runtime?.sourceReconciler.idle();
    // A compile the test started writes its cache entries behind itself, so
    // teardown waits for them rather than closing storage underneath one.
    await runtime?.patternManager.flushCompileCacheWrites();
    await runtime?.dispose();
  });

  function createRuntime(fetch: RuntimeFetch): Runtime {
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      fetch,
    });
    return runtime;
  }

  /** A piece running v1 of the tracked pattern, with no origin yet. */
  async function preparePiece(fetch: RuntimeFetch) {
    createRuntime(fetch);
    const space = signer.did();
    const initialIdentity = await identityFor(source("v1"));
    const initial = await runtime.patternManager.compilePattern(
      parentProgram(source("v1")),
      { space },
    );
    const piece = runtime.getCell<{ marker?: string }>(
      space,
      `reconcile-${crypto.randomUUID()}`,
    );
    await runtime.setup(undefined, initial, {}, piece);
    expect(getPatternIdentityRef(piece)).toEqual({
      identity: initialIdentity,
      symbol: SYMBOL,
    });
    return piece;
  }

  async function compileMarkerPattern(marker: string) {
    return await runtime.patternManager.compilePattern(
      parentProgram(source(marker)),
      { space: signer.did() },
    );
  }

  async function stampSource(piece: Cell<unknown>, origin: string) {
    const result = await runtime.editWithRetry((tx) => {
      setPatternSource(piece, tx, origin);
    });
    expect(result.error).toBeUndefined();
  }

  function reconcile(piece: Cell<unknown>) {
    return runtime.sourceReconciler.reconcile(piece);
  }

  /** Serves the tracked pattern's route, advertising `identity` for it. */
  function servingFetch(
    identity: () => string,
    contents: () => string,
    record?: (url: URL, init?: RequestInit) => void,
  ): RuntimeFetch {
    return (input, init) => {
      const url = new URL(
        input instanceof Request
          ? input.url
          : input instanceof URL
          ? input.href
          : input,
      );
      record?.(url, init);
      if (url.pathname === PARENT_PATH) {
        return Promise.resolve(
          url.searchParams.has("identity")
            ? new Response(identity())
            : new Response(parentSource),
        );
      }
      if (url.pathname === SOURCE_PATH) {
        return Promise.resolve(new Response(contents()));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    };
  }

  const refuseEveryFetch: RuntimeFetch = () =>
    Promise.reject(new Error("this origin must not be fetched"));

  describe("origins nothing follows", () => {
    it("reports a piece with no recorded origin as detached", async () => {
      const piece = await preparePiece(refuseEveryFetch);
      expect(await reconcile(piece)).toBe("detached");
      expect(getPatternSource(piece)).toBeUndefined();
    });

    it("does not fetch a rooted path that names no pattern route", async () => {
      // Resolving such a path against the host reaches whatever the site
      // serves for an unrouted path — the shell answers 200 with its own HTML
      // for any of them — so it names no source at all.
      const piece = await preparePiece(refuseEveryFetch);
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, "/participant-identity-card.tsx");

      expect(await reconcile(piece)).toBe("unusable");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
      expect(getPatternSource(piece)).toBe("/participant-identity-card.tsx");
    });

    it("does not follow a string that is no URL at all", async () => {
      const piece = await preparePiece(refuseEveryFetch);
      await stampSource(piece, "custom");
      expect(await reconcile(piece)).toBe("unusable");
      expect(getPatternSource(piece)).toBe("custom");
    });

    it("does not follow a URL whose scheme serves no program", async () => {
      const piece = await preparePiece(refuseEveryFetch);
      await stampSource(piece, "file:///etc/passwd");
      expect(await reconcile(piece)).toBe("unusable");
    });
  });

  describe("a legacy rooted path", () => {
    it("becomes the system ref naming the same file, and then follows it", async () => {
      const v1Identity = await identityFor(source("v1"));
      const piece = await preparePiece(
        servingFetch(() => v1Identity, () => source("v1")),
      );
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, PARENT_PATH);

      expect(await reconcile(piece)).toBe("migrated");
      expect(getPatternSource(piece)).toBe(PARENT_SOURCE);
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
      // Re-spelling the origin is an origin change to the history, which is
      // the accepted cost of migrating in place: this pair is what a reader of
      // the source panel sees once, per piece, and never again.
      expect(getPieceSourceRevisions(piece).map((entry) => entry.operation))
        .toEqual(["baseline", "origin-update"]);
      // The baseline keeps the path the piece actually carried, alongside the
      // absolute URL it resolved to, so the panel can show a reader what the
      // piece stored before the migration rewrote it.
      expect(getPieceSourceRevisions(piece).map((entry) => entry.origin))
        .toEqual([
          new URL(PARENT_PATH, runtime.apiUrl).href,
          PARENT_SOURCE,
        ]);
      expect(getPieceSourceRevisions(piece)[0].recordedOrigin).toBe(
        PARENT_PATH,
      );
    });

    it("becomes the system ref from the absolute spelling on its own host", async () => {
      const v1Identity = await identityFor(source("v1"));
      const piece = await preparePiece(
        servingFetch(() => v1Identity, () => source("v1")),
      );
      // The spelling a piece carries once a source transition recorded its
      // route path against the space's host.
      const legacyOrigin = new URL(PARENT_PATH, runtime.apiUrl).href;
      await stampSource(piece, legacyOrigin);

      expect(await reconcile(piece)).toBe("migrated");
      expect(getPatternSource(piece)).toBe(PARENT_SOURCE);
    });

    it("leaves the same path on another host unusable", async () => {
      // Re-pointing it at this toolshed would change which host the piece
      // follows, which is a change of source rather than of spelling. It names
      // an endpoint outside this deployment, which is no origin at all, so the
      // piece keeps what it runs and carries a string a person can repair.
      const foreign = `https://elsewhere.test${PARENT_PATH}`;
      const piece = await preparePiece(refuseEveryFetch);
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, foreign);

      expect(await reconcile(piece)).toBe("unusable");
      expect(getPatternSource(piece)).toBe(foreign);
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    });
  });

  describe("a system pattern this deployment serves", () => {
    it("asks the identity route first, and stops there when nothing moved", async () => {
      const v1Identity = await identityFor(source("v1"));
      const requested: Array<{ href: string; cache?: RequestCache }> = [];
      const piece = await preparePiece(
        servingFetch(
          () => v1Identity,
          () => source("v1"),
          (url, init) => requested.push({ href: url.href, cache: init?.cache }),
        ),
      );
      await stampSource(piece, PARENT_SOURCE);

      expect(await reconcile(piece)).toBe("current");
      // One conditional request, and no source downloaded behind it.
      expect(requested).toEqual([{
        href: `http://toolshed.test${PARENT_PATH}?identity=`,
        cache: "no-cache",
      }]);
    });

    it("adopts newer source and stages it over the document", async () => {
      const v2Identity = await identityFor(source("v2"));
      const piece = await preparePiece(
        servingFetch(() => v2Identity, () => source("v2")),
      );
      await stampSource(piece, PARENT_SOURCE);

      expect(await reconcile(piece)).toBe("updated");
      expect(getPatternIdentityRef(piece)).toEqual({
        identity: v2Identity,
        symbol: SYMBOL,
      });
      expect(getPieceSourceRevisions(piece).at(-1)?.operation).toBe(
        "origin-update",
      );
      // The piece was not running, so nothing else would have staged the new
      // pattern over its document: reading it must now produce v2.
      expect(await runtime.start(piece)).toBe(true);
      await runtime.idle();
      expect((await piece.pull())?.marker).toBe("v2");
    });

    it("moves a running piece's pointer and lets its watcher re-instantiate", async () => {
      const v2Identity = await identityFor(source("v2"));
      const piece = await preparePiece(
        servingFetch(() => v2Identity, () => source("v2")),
      );
      await stampSource(piece, PARENT_SOURCE);
      expect(await runtime.start(piece)).toBe(true);
      await runtime.idle();
      expect((await piece.pull())?.marker).toBe("v1");

      expect(await reconcile(piece)).toBe("updated");
      await runtime.idle();
      // A `system:` update grants the candidate the running pattern's writer
      // authority, and the watcher reads that grant before it follows the
      // pointer; `idle()` does not cover that read, the pointer maintenance
      // settle does.
      await runtime.runner.idlePointerMaintenance();
      // Staging belongs to the transaction that moves the pointer whether or
      // not the piece is running, so the completion marker names the candidate
      // and the watcher re-instantiates over a document already set up for it.
      expect(getPatternSetupIdentityRef(piece)).toEqual({
        identity: v2Identity,
        symbol: SYMBOL,
      });
      expect((await piece.pull())?.marker).toBe("v2");
    });

    it("stages a markerless running piece's anonymous state with its accepted source", async () => {
      const anonymousSource = (value: string) => `
        import { pattern, Writable } from "commonfabric";
        export const ${SYMBOL} = pattern<Record<string, never>, { slots: Writable<string>[] }>(() => ({
          slots: [0].map(() => new Writable("${value}")),
        }));
      `;
      const nextSource = anonymousSource("new-default");
      const nextRef = {
        identity: await identityFor(nextSource),
        symbol: SYMBOL,
      };
      createRuntime(servingFetch(() => nextRef.identity, () => nextSource));
      const initial = await runtime.patternManager.compilePattern(
        parentProgram(anonymousSource("old-default")),
        { space: signer.did() },
      );
      const initialRef = runtime.patternManager.getArtifactEntryRef(initial)!;
      const piece = runtime.getCell(signer.did(), "reconcile-legacy-anonymous");
      const seed = runtime.edit();
      piece.withTx(seed).setMetaRaw(
        "patternIdentity",
        initialRef,
        rawMetaWriteAuthorization,
      );
      await runtime.setup(seed, initial, {}, piece);
      expect((await seed.commit()).error).toBeUndefined();
      expect(await runtime.start(piece)).toBe(true);
      const view = piece.asSchema<{ slots: string[] }>({
        type: "object",
        properties: { slots: { type: "array", items: { type: "string" } } },
      });
      expect(await view.pull()).toEqual({ slots: ["old-default"] });
      const legacy = view.key("slots").key(0).resolveAsCell();
      expect(
        (await runtime.editWithRetry((tx) => {
          legacy.withTx(tx).set("legacy-user-value");
          piece.withTx(tx).setMetaRaw(
            "generatedCellIdentity",
            undefined,
            rawMetaWriteAuthorization,
          );
          piece.withTx(tx).setMetaRaw(
            "patternSetupIdentity",
            undefined,
            rawMetaWriteAuthorization,
          );
          setPatternSource(piece, tx, PARENT_SOURCE);
        })).error,
      ).toBeUndefined();

      expect(await reconcile(piece)).toBe("updated");
      // Reconciliation commits the defaults and projection with both markers;
      // the watcher does not have to finish before this state is readable.
      expect(getPatternIdentityRef(piece)).toEqual(nextRef);
      expect(getPatternSetupIdentityRef(piece)).toEqual(nextRef);
      expect(piece.getMetaRaw("generatedCellIdentity")).toEqual({
        version: 1,
        ...nextRef,
      });
      expect(view.get()).toEqual({ slots: ["new-default"] });
      expect(legacy.get()).toBe("legacy-user-value");
      await runtime.runner.idlePointerMaintenance();
    });

    it("treats a pattern index that errors as an artifact that will not load", async () => {
      // Asking whether the running pattern still loads is a question that can
      // fail rather than answer. A failure is read as "it will not load",
      // which sends the pass on to compile the source again.
      const v1Identity = await identityFor(source("v1"));
      const fetched: string[] = [];
      const piece = await preparePiece(
        servingFetch(
          () => v1Identity,
          () => source("v1"),
          // The identity route and the source download share a pathname, so
          // only a request WITHOUT the identity query proves a download.
          (url) => {
            if (!url.searchParams.has("identity")) fetched.push(url.pathname);
          },
        ),
      );
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, PARENT_SOURCE);

      const manager = runtime.patternManager;
      const load = manager.loadPatternByIdentity.bind(manager);
      manager.loadPatternByIdentity = (...args: Parameters<typeof load>) =>
        args[0] === originalRef!.identity
          ? Promise.reject(new Error("the pattern index is unreadable"))
          : load(...args);
      try {
        expect(await reconcile(piece)).toBe("current");
      } finally {
        manager.loadPatternByIdentity = load;
      }
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
      expect(fetched).toEqual([PARENT_PATH, SOURCE_PATH]);
    });

    it("keeps the running source when the candidate compiles to no identity", async () => {
      // Nothing can point a piece at source that has no identity to point at,
      // so a candidate the compiler produces without one is refused rather
      // than adopted under whatever the piece already records.
      const v2Identity = await identityFor(source("v2"));
      const piece = await preparePiece(
        servingFetch(() => v2Identity, () => source("v2")),
      );
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, PARENT_SOURCE);

      const manager = runtime.patternManager;
      const entryRef = manager.getArtifactEntryRef.bind(manager);
      manager.getArtifactEntryRef = () => undefined;
      try {
        expect(await reconcile(piece)).toBe("unavailable");
      } finally {
        manager.getArtifactEntryRef = entryRef;
      }
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    });

    it("records the pattern it displaced when its source is gone", async () => {
      // A piece whose own source this space no longer holds has nothing left
      // to protect: it cannot be set up again at all, so the origin's source
      // is a rescue. What the rescue replaced is recorded, because after the
      // pointer moves nothing else names it.
      const v2Identity = await identityFor(source("v2"));
      const piece = await preparePiece(
        servingFetch(() => v2Identity, () => source("v2")),
      );
      const originalRef = getPatternIdentityRef(piece)!;
      await stampSource(piece, PARENT_SOURCE);

      const manager = runtime.patternManager;
      const program = manager.getPatternSourceProgramByIdentity.bind(manager);
      manager.getPatternSourceProgramByIdentity = (
        ...args: Parameters<typeof program>
      ) =>
        args[0] === originalRef.identity
          ? Promise.resolve(undefined)
          : program(...args);
      try {
        expect(await reconcile(piece)).toBe("updated");
      } finally {
        manager.getPatternSourceProgramByIdentity = program;
      }

      expect(getPatternIdentityRef(piece)?.identity).toBe(v2Identity);
      expect(piece.getMetaRaw("displacedPattern")).toMatchObject({
        identity: originalRef.identity,
        symbol: originalRef.symbol,
      });
    });

    it("keeps the running source when the route cannot be reached", async () => {
      const piece = await preparePiece(() =>
        Promise.resolve(new Response("nope", { status: 503 }))
      );
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, PARENT_SOURCE);

      expect(await reconcile(piece)).toBe("unavailable");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    });

    it("keeps the running source when the served source does not compile to the identity it advertises", async () => {
      const v2Identity = await identityFor(source("v2"));
      // Advertises v2 while serving v3: the source is not what the origin says
      // it is, so nothing about it can be trusted.
      const piece = await preparePiece(
        servingFetch(() => v2Identity, () => source("v3")),
      );
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, PARENT_SOURCE);

      expect(await reconcile(piece)).toBe("unavailable");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    });

    it("keeps the running source when the identity route names no identity", async () => {
      const piece = await preparePiece(
        servingFetch(() => "", () => source("v2")),
      );
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, PARENT_SOURCE);

      expect(await reconcile(piece)).toBe("unavailable");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    });

    it("compiles the advertised source again when the artifact is gone", async () => {
      // The identity route settles only whether the SOURCE moved. A space that
      // no longer holds the compiled artifact for an unchanged identity cannot
      // start the piece, so reconciliation downloads and compiles that source
      // rather than stopping at the identity comparison — which puts the
      // artifact back under the identity the piece already points at.
      const v1Identity = await identityFor(source("v1"));
      const fetched: string[] = [];
      const piece = await preparePiece(
        servingFetch(
          () => v1Identity,
          () => source("v1"),
          // The identity route and the source download share a pathname, so
          // only a request WITHOUT the identity query proves a download.
          (url) => {
            if (!url.searchParams.has("identity")) fetched.push(url.pathname);
          },
        ),
      );
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, PARENT_SOURCE);

      const manager = runtime.patternManager;
      const load = manager.loadPatternByIdentity.bind(manager);
      manager.loadPatternByIdentity = (...args: Parameters<typeof load>) =>
        args[0] === originalRef!.identity
          ? Promise.resolve(undefined)
          : load(...args);
      try {
        expect(await reconcile(piece)).toBe("current");
      } finally {
        manager.loadPatternByIdentity = load;
      }
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
      expect(fetched).toEqual([PARENT_PATH, SOURCE_PATH]);
    });

    it("adopts a candidate that changes the piece contract", async () => {
      // This deployment gates its own patterns where they are released, so a
      // candidate from its own route is taken as it stands.
      const changed = sourceWithChangedContract("v2");
      const changedIdentity = await identityFor(changed);
      const piece = await preparePiece(
        servingFetch(() => changedIdentity, () => changed),
      );
      await stampSource(piece, PARENT_SOURCE);

      expect(await reconcile(piece)).toBe("updated");
      expect(getPatternIdentityRef(piece)?.identity).toBe(changedIdentity);
    });

    it("keeps a RUNNING piece's pointer when the candidate refuses its data", async () => {
      // Staging the candidate is part of the transition for a running piece
      // too. Were it left to the pattern watcher, the pointer would commit,
      // the watcher's setup would fail, and the next open would find the
      // pointer matching what the origin offers and call the piece current —
      // with the old graph still running and nothing able to undo it.
      const demanding = sourceWithRequiredInput("v2");
      const demandingIdentity = await identityFor(demanding);
      const piece = await preparePiece(
        servingFetch(() => demandingIdentity, () => demanding),
      );
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, PARENT_SOURCE);
      expect(await runtime.start(piece)).toBe(true);
      await runtime.idle();

      expect(await reconcile(piece)).toBe("unavailable");
      await runtime.idle();
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
      expect((await piece.pull())?.marker).toBe("v1");
      expect(getPieceSourceRevisions(piece)).toEqual([]);
    });

    it("keeps the running source when the candidate refuses this piece's data", async () => {
      // Nothing compares the contracts for this origin, so what discovers the
      // problem is staging the candidate over the document: its setup rejects
      // a stored argument the new schema cannot read, the transition fails,
      // and the piece stays on what it has.
      const demanding = sourceWithRequiredInput("v2");
      const demandingIdentity = await identityFor(demanding);
      const piece = await preparePiece(
        servingFetch(() => demandingIdentity, () => demanding),
      );
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, PARENT_SOURCE);

      expect(await reconcile(piece)).toBe("unavailable");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
      expect(getPieceSourceRevisions(piece)).toEqual([]);
    });
  });

  describe("what a reconciliation leaves behind", () => {
    it("records reaching an origin that offers what the piece runs", async () => {
      const v1Identity = await identityFor(source("v1"));
      const piece = await preparePiece(
        servingFetch(() => v1Identity, () => source("v1")),
      );
      await stampSource(piece, PARENT_SOURCE);

      expect(await reconcile(piece)).toBe("current");

      expect(getPieceReconciliation(piece)).toMatchObject({
        outcome: "followed",
        origin: PARENT_SOURCE,
        offered: { identity: v1Identity, symbol: SYMBOL },
      });
    });

    it("reaching the same conclusion again rewrites nothing", async () => {
      const v1Identity = await identityFor(source("v1"));
      const piece = await preparePiece(
        servingFetch(() => v1Identity, () => source("v1")),
      );
      await stampSource(piece, PARENT_SOURCE);
      expect(await reconcile(piece)).toBe("current");
      const first = getPieceReconciliation(piece);

      expect(await reconcile(piece)).toBe("current");

      // Opening a piece that is up to date stays a read.
      expect(getPieceReconciliation(piece)).toEqual(first);
    });

    it("records an origin it could not reach, and what it answered", async () => {
      const piece = await preparePiece(() =>
        Promise.resolve(new Response("nope", { status: 503 }))
      );
      await stampSource(piece, PARENT_SOURCE);

      expect(await reconcile(piece)).toBe("unavailable");

      expect(getPieceReconciliation(piece)).toMatchObject({
        outcome: "unreachable",
        origin: PARENT_SOURCE,
        detail: "the origin answered 503",
      });
    });

    it("records a refusal, its reason, and what was offered", async () => {
      const piece = await preparePiece(refuseEveryFetch);
      const changed = await runtime.patternManager.compilePattern(
        parentProgram(sourceWithChangedContract("v2")),
        { space: piece.space },
      );
      const changedRef = runtime.patternManager.getArtifactEntryRef(changed)!;
      const origin = `cf:pattern:${changedRef.identity}`;
      await stampSource(piece, origin);

      expect(await reconcile(piece)).toBe("incompatible");

      // A refusal leaves no revision, so without this record it would look
      // exactly like a piece running what its origin offers.
      expect(getPieceReconciliation(piece)).toMatchObject({
        outcome: "refused",
        reason: "incompatible-schema",
        origin,
        offered: changedRef,
      });
      expect(getPieceReconciliation(piece)?.detail).toContain("schema differs");
    });

    it("records an origin whose route refused the connection", async () => {
      // The commonest way an origin is out of reach is a request that throws
      // rather than answering. Its caller turns that into `unavailable`, so
      // recording has to happen before it gets there.
      const piece = await preparePiece(() =>
        Promise.reject(new Error("connection refused"))
      );
      await stampSource(piece, PARENT_SOURCE);

      // The caller reports it as unavailable, which is what a reader of the
      // outcome sees; the record is what survives past this call.
      expect(await reconcile(piece)).toBe("unavailable");

      expect(getPieceReconciliation(piece)).toMatchObject({
        outcome: "unreachable",
        origin: PARENT_SOURCE,
        detail: "connection refused",
      });
    });

    it("settles on a failure that arrives without a message", async () => {
      // An empty reason is dropped when the record is read, so recording one
      // would leave every later attempt rewriting the same conclusion.
      const piece = await preparePiece(() => Promise.reject(new Error()));
      await stampSource(piece, PARENT_SOURCE);

      expect(await reconcile(piece)).toBe("unavailable");
      const first = getPieceReconciliation(piece);
      expect(first).toMatchObject({ outcome: "unreachable" });
      expect(first?.detail).toBe("Error");

      expect(await reconcile(piece)).toBe("unavailable");
      expect(getPieceReconciliation(piece)).toEqual(first);
    });

    it("names a failure that is not an Error at all", async () => {
      const piece = await preparePiece(() => Promise.reject("nope"));
      await stampSource(piece, PARENT_SOURCE);

      expect(await reconcile(piece)).toBe("unavailable");

      expect(getPieceReconciliation(piece)?.detail).toBe("nope");
    });

    it("falls back to a phrase when a failure says nothing at all", async () => {
      // An error with neither message nor name, and nothing else to read.
      const silent = new Error();
      silent.name = "";
      const piece = await preparePiece(() => Promise.reject(silent));
      await stampSource(piece, PARENT_SOURCE);

      expect(await reconcile(piece)).toBe("unavailable");

      // Non-empty, so it survives being read back and the record settles.
      expect(getPieceReconciliation(piece)?.detail).toBe(
        "the origin could not be reached",
      );
    });

    it("names what a fabric origin holds even when nothing moved", async () => {
      const piece = await preparePiece(refuseEveryFetch);
      const runningRef = getPatternIdentityRef(piece)!;
      await stampSource(piece, `cf:pattern:${runningRef.identity}`);

      expect(await reconcile(piece)).toBe("current");

      // Nothing moved, and the record still says which source was weighed.
      expect(getPieceReconciliation(piece)).toMatchObject({
        outcome: "followed",
        offered: runningRef,
      });
    });

    it("says nothing about a piece that records no origin", async () => {
      const piece = await preparePiece(refuseEveryFetch);

      expect(await reconcile(piece)).toBe("detached");

      // The absent origin already says it; a record would only restate it.
      expect(getPieceReconciliation(piece)).toBeUndefined();
    });

    it("says nothing about an origin nothing can follow", async () => {
      const piece = await preparePiece(refuseEveryFetch);
      await stampSource(piece, "not a url");

      expect(await reconcile(piece)).toBe("unusable");

      expect(getPieceReconciliation(piece)).toBeUndefined();
    });
  });

  describe("an external endpoint", () => {
    it("is no origin at all, so the piece keeps what it runs", async () => {
      // A piece follows what this deployment serves and what the fabric
      // holds. An endpoint outside both names no origin, so nothing is
      // fetched on the piece's behalf and it carries the string unresolved.
      const piece = await preparePiece(refuseEveryFetch);
      const originalRef = getPatternIdentityRef(piece);
      const origin = `https://programs.test${PARENT_PATH}`;
      await stampSource(piece, origin);

      expect(await reconcile(piece)).toBe("unusable");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
      expect(getPatternSource(piece)).toBe(origin);

      // An unusable origin is read off the recorded string itself, so a
      // record would only restate what the piece already says.
      expect(getPieceReconciliation(piece)).toBeUndefined();
    });
  });

  describe("source inside the fabric", () => {
    it("adopts the pattern another piece currently runs", async () => {
      const piece = await preparePiece(refuseEveryFetch);
      const upstream = await compileMarkerPattern("v2");
      const upstreamRef = runtime.patternManager.getArtifactEntryRef(upstream)!;
      const upstreamPiece = runtime.getCell(
        piece.space,
        `reconcile-upstream-${crypto.randomUUID()}`,
      );
      await runtime.setup(undefined, upstream, {}, upstreamPiece);
      await stampSource(
        piece,
        `cf:/${piece.space}/${upstreamPiece.getAsNormalizedFullLink().id}`,
      );

      expect(await reconcile(piece)).toBe("updated");
      expect(getPatternIdentityRef(piece)).toEqual(upstreamRef);
    });

    it("follows a later change made by the piece it is following", async () => {
      const piece = await preparePiece(refuseEveryFetch);
      const upstreamPiece = runtime.getCell(
        piece.space,
        `reconcile-upstream-${crypto.randomUUID()}`,
      );
      await runtime.setup(
        undefined,
        await compileMarkerPattern("v1"),
        {},
        upstreamPiece,
      );
      await stampSource(
        piece,
        `cf:/${piece.space}/${upstreamPiece.getAsNormalizedFullLink().id}`,
      );
      expect(await reconcile(piece)).toBe("current");

      // The subscription the reconciliation installed is what carries this.
      const moved = await compileMarkerPattern("v2");
      const movedRef = runtime.patternManager.getArtifactEntryRef(moved)!;
      const reached = defer<void>();
      const cancel = piece.sinkMeta("patternIdentity", (value) => {
        const ref = value as { identity?: string } | undefined;
        if (ref?.identity === movedRef.identity) reached.resolve();
      });
      try {
        await runtime.setup(undefined, moved, {}, upstreamPiece);
        await reached.promise;
      } finally {
        cancel();
      }
      await runtime.sourceReconciler.idle();
      expect(getPatternIdentityRef(piece)).toEqual(movedRef);
    });

    it("follows the new target when the piece's own origin is repointed", async () => {
      // Changing where a piece looks is a change the piece's own watcher
      // carries, so the update lands without anyone opening the piece again.
      const piece = await preparePiece(refuseEveryFetch);
      const first = runtime.getCell(
        piece.space,
        `reconcile-upstream-${crypto.randomUUID()}`,
      );
      await runtime.setup(
        undefined,
        await compileMarkerPattern("v1"),
        {},
        first,
      );
      await stampSource(
        piece,
        `cf:/${piece.space}/${first.getAsNormalizedFullLink().id}`,
      );
      expect(await reconcile(piece)).toBe("current");

      const second = runtime.getCell(
        piece.space,
        `reconcile-upstream-${crypto.randomUUID()}`,
      );
      const moved = await compileMarkerPattern("v2");
      const movedRef = runtime.patternManager.getArtifactEntryRef(moved)!;
      await runtime.setup(undefined, moved, {}, second);

      const reached = defer<void>();
      const cancel = piece.sinkMeta("patternIdentity", (value) => {
        const ref = value as { identity?: string } | undefined;
        if (ref?.identity === movedRef.identity) reached.resolve();
      });
      try {
        await stampSource(
          piece,
          `cf:/${piece.space}/${second.getAsNormalizedFullLink().id}`,
        );
        await reached.promise;
      } finally {
        cancel();
      }
      await runtime.sourceReconciler.idle();
      expect(getPatternIdentityRef(piece)).toEqual(movedRef);
    });

    it("picks up a source that moves while a pass is running", async () => {
      // A pass reads its target once. A move that lands after that read could
      // not have been seen by it, so another pass has to follow the one in
      // flight rather than the move being lost.
      const piece = await preparePiece(refuseEveryFetch);
      const upstream = runtime.getCell(
        piece.space,
        `reconcile-upstream-${crypto.randomUUID()}`,
      );
      await runtime.setup(
        undefined,
        await compileMarkerPattern("v1"),
        {},
        upstream,
      );
      await stampSource(
        piece,
        `cf:/${piece.space}/${upstream.getAsNormalizedFullLink().id}`,
      );
      expect(await reconcile(piece)).toBe("current");

      const entered = defer<void>();
      const held = defer<void>();
      const manager = runtime.patternManager;
      const program = manager.getPatternSourceProgramByIdentity.bind(manager);
      manager.getPatternSourceProgramByIdentity = async (
        ...args: Parameters<typeof program>
      ) => {
        entered.resolve();
        await held.promise;
        return await program(...args);
      };

      const third = await compileMarkerPattern("v3");
      const thirdRef = runtime.patternManager.getArtifactEntryRef(third)!;
      const reached = defer<void>();
      const cancel = piece.sinkMeta("patternIdentity", (value) => {
        const ref = value as { identity?: string } | undefined;
        if (ref?.identity === thirdRef.identity) reached.resolve();
      });
      try {
        // The watcher starts a pass, which blocks in its source lookup.
        await runtime.setup(
          undefined,
          await compileMarkerPattern("v2"),
          {},
          upstream,
        );
        await entered.promise;
        // The source moves again while that pass is held.
        await runtime.setup(undefined, third, {}, upstream);
        held.resolve();
        await reached.promise;
      } finally {
        cancel();
        manager.getPatternSourceProgramByIdentity = program;
      }
      await runtime.sourceReconciler.idle();
      expect(getPatternIdentityRef(piece)).toEqual(thirdRef);
    });

    it("installs no follower when the piece stops while its source is read", async () => {
      // Reading a fabric source is where the follower is installed. A stop
      // landing during that read has to leave the piece following nothing, or
      // it would keep taking updates after it stopped.
      const piece = await preparePiece(refuseEveryFetch);
      const upstream = runtime.getCell(
        piece.space,
        `reconcile-upstream-${crypto.randomUUID()}`,
      );
      await runtime.setup(
        undefined,
        await compileMarkerPattern("v1"),
        {},
        upstream,
      );
      await stampSource(
        piece,
        `cf:/${piece.space}/${upstream.getAsNormalizedFullLink().id}`,
      );
      const originalRef = getPatternIdentityRef(piece);

      const pass = reconcile(piece);
      runtime.sourceReconciler.unwatch(piece);
      expect(await pass).toBe("unavailable");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);

      // Nothing is following, so moving the upstream leaves the piece alone.
      await runtime.setup(
        undefined,
        await compileMarkerPattern("v2"),
        {},
        upstream,
      );
      await runtime.idle();
      await runtime.sourceReconciler.idle();
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    });

    it("stops following once the piece stops", async () => {
      const piece = await preparePiece(refuseEveryFetch);
      const upstreamPiece = runtime.getCell(
        piece.space,
        `reconcile-upstream-${crypto.randomUUID()}`,
      );
      await runtime.setup(
        undefined,
        await compileMarkerPattern("v1"),
        {},
        upstreamPiece,
      );
      await stampSource(
        piece,
        `cf:/${piece.space}/${upstreamPiece.getAsNormalizedFullLink().id}`,
      );
      expect(await reconcile(piece)).toBe("current");
      const followingRef = getPatternIdentityRef(piece);

      runtime.sourceReconciler.unwatch(piece);
      await runtime.setup(
        undefined,
        await compileMarkerPattern("v2"),
        {},
        upstreamPiece,
      );
      await runtime.sourceReconciler.idle();
      await runtime.idle();

      expect(getPatternIdentityRef(piece)).toEqual(followingRef);
    });

    it("adopts exact pinned source once, and never reports a move again", async () => {
      const piece = await preparePiece(refuseEveryFetch);
      const target = await compileMarkerPattern("v2");
      const targetRef = runtime.patternManager.getArtifactEntryRef(target)!;
      await stampSource(piece, `cf:pattern:${targetRef.identity}`);

      expect(await reconcile(piece)).toBe("updated");
      expect(getPatternIdentityRef(piece)).toEqual(targetRef);
      // The URL names one content identity, so resolving it again can only
      // find the same one.
      expect(await reconcile(piece)).toBe("current");
    });

    it("refuses a candidate that moves the piece's contract", async () => {
      // Nobody gated the release behind this origin, so an unattended update
      // requires the contract not to move.
      const piece = await preparePiece(refuseEveryFetch);
      const originalRef = getPatternIdentityRef(piece);
      const changed = await runtime.patternManager.compilePattern(
        parentProgram(sourceWithChangedContract("v2")),
        { space: piece.space },
      );
      const changedRef = runtime.patternManager.getArtifactEntryRef(changed)!;
      await stampSource(piece, `cf:pattern:${changedRef.identity}`);

      expect(await reconcile(piece)).toBe("incompatible");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
      expect(getPieceSourceRevisions(piece)).toEqual([]);
    });

    it("refuses a candidate whose result grows past the accepted one", async () => {
      // The argument the piece already stores still fits, so only the reads
      // its result promises have moved — which is a contract change like any
      // other where nobody gated the release.
      const piece = await preparePiece(refuseEveryFetch);
      const originalRef = getPatternIdentityRef(piece);
      const grown = await runtime.patternManager.compilePattern(
        parentProgram(sourceWithExtraResult("v2")),
        { space: piece.space },
      );
      const grownRef = runtime.patternManager.getArtifactEntryRef(grown)!;
      await stampSource(piece, `cf:pattern:${grownRef.identity}`);

      expect(await reconcile(piece)).toBe("incompatible");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    });

    it("adopts a contract-moving candidate when the running pattern is gone", async () => {
      // The comparison an ungated origin has to satisfy is made against the
      // pattern the piece runs. A piece whose own pattern can no longer be
      // loaded has nothing left to protect — it cannot run at all — so the
      // origin's source is a rescue and is taken without a comparison there
      // is no way to make.
      const piece = await preparePiece(refuseEveryFetch);
      const originalRef = getPatternIdentityRef(piece)!;
      const changed = await runtime.patternManager.compilePattern(
        parentProgram(sourceWithChangedContract("v2")),
        { space: piece.space },
      );
      const changedRef = runtime.patternManager.getArtifactEntryRef(changed)!;
      await stampSource(piece, `cf:pattern:${changedRef.identity}`);

      const manager = runtime.patternManager;
      const load = manager.loadPatternByIdentity.bind(manager);
      manager.loadPatternByIdentity = (...args: Parameters<typeof load>) =>
        args[0] === originalRef.identity
          ? Promise.reject(new Error("the running pattern is gone"))
          : load(...args);
      try {
        expect(await reconcile(piece)).toBe("updated");
      } finally {
        manager.loadPatternByIdentity = load;
      }
      expect(getPatternIdentityRef(piece)).toEqual(changedRef);
    });

    it("adopts a contract-moving candidate when the running pattern is absent", async () => {
      // The same waiver as above, for a pattern index that answers rather than
      // fails: no pattern to compare against is no comparison either way.
      const piece = await preparePiece(refuseEveryFetch);
      const originalRef = getPatternIdentityRef(piece)!;
      const changed = await runtime.patternManager.compilePattern(
        parentProgram(sourceWithChangedContract("v2")),
        { space: piece.space },
      );
      const changedRef = runtime.patternManager.getArtifactEntryRef(changed)!;
      await stampSource(piece, `cf:pattern:${changedRef.identity}`);

      const manager = runtime.patternManager;
      const load = manager.loadPatternByIdentity.bind(manager);
      manager.loadPatternByIdentity = (...args: Parameters<typeof load>) =>
        args[0] === originalRef.identity
          ? Promise.resolve(undefined)
          : load(...args);
      try {
        expect(await reconcile(piece)).toBe("updated");
      } finally {
        manager.loadPatternByIdentity = load;
      }
      expect(getPatternIdentityRef(piece)).toEqual(changedRef);
    });

    it("keeps the running source when the target runs no pattern", async () => {
      // An entity is only a source while it names a pattern. One that holds
      // ordinary data names nothing to adopt, so the piece keeps what it has
      // and the entity is not followed.
      const piece = await preparePiece(refuseEveryFetch);
      const originalRef = getPatternIdentityRef(piece);
      const plain = runtime.getCell<{ note: string }>(
        piece.space,
        `reconcile-plain-${crypto.randomUUID()}`,
      );
      const { error } = await runtime.editWithRetry((tx) => {
        plain.withTx(tx).set({ note: "not a pattern" });
      });
      expect(error).toBeUndefined();
      await stampSource(
        piece,
        `cf:/${piece.space}/${plain.getAsNormalizedFullLink().id}`,
      );

      expect(await reconcile(piece)).toBe("unavailable");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    });

    it("keeps the running source when a pinned target is unavailable", async () => {
      const piece = await preparePiece(refuseEveryFetch);
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(
        piece,
        "cf:pattern:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      );

      expect(await reconcile(piece)).toBe("unavailable");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    });

    it("refuses a reference that names no update authority", async () => {
      const piece = await preparePiece(refuseEveryFetch);
      const originalRef = getPatternIdentityRef(piece);
      const target = await compileMarkerPattern("v2");
      const targetRef = runtime.patternManager.getArtifactEntryRef(target)!;
      const upstreamPiece = runtime.getCell(
        piece.space,
        `reconcile-unauthorized-${crypto.randomUUID()}`,
      );
      await runtime.setup(undefined, target, {}, upstreamPiece);
      const upstreamId = upstreamPiece.getAsNormalizedFullLink().id;
      expect(targetRef).not.toEqual(originalRef);

      for (
        const [origin, outcome] of [
          // A subpath names a file inside a program, not a program.
          [`cf:pattern:${targetRef.identity}/nested.ts`, "unusable"],
          // A name is not a stable identifier.
          [`cf:/friendly-space/${upstreamId}`, "unusable"],
          // A host that does not serve the space it claims to route to.
          [`cf://other.test/${piece.space}/${upstreamId}`, "unavailable"],
        ] as const
      ) {
        await stampSource(piece, origin);
        expect(await reconcile(piece)).toBe(outcome);
        expect(getPatternIdentityRef(piece)).toEqual(originalRef);
        expect(getPatternSource(piece)).toBe(origin);
      }
    });
  });

  describe("a piece the runtime supplies", () => {
    /** A cell for a piece that does not exist yet. */
    function emptyPiece(fetch: RuntimeFetch) {
      createRuntime(fetch);
      return runtime.getCell<{ marker?: string }>(
        signer.did(),
        `supplied-${crypto.randomUUID()}`,
      );
    }

    function open(piece: Cell<unknown>, origin = PARENT_SOURCE) {
      return runtime.sourceReconciler.open(piece, origin);
    }

    it("shares supplied source across slots while compiling into each destination", async () => {
      const identity = await identityFor(source("v1"));
      let identityRequests = 0;
      let sourceRequests = 0;
      createRuntime(servingFetch(() => identity, () => source("v1"), (url) => {
        if (url.searchParams.has("identity")) identityRequests++;
        else sourceRequests++;
      }));
      const compile = runtime.patternManager.compilePattern.bind(
        runtime.patternManager,
      );
      const compiledSpaces: string[] = [];
      runtime.patternManager.compilePattern = (...args) => {
        compiledSpaces.push(args[1]!.space!);
        return compile(...args);
      };
      const spaces = [
        signer.did(),
        signer.did(),
        signer.did(),
        (await Identity.fromPassphrase("supplied source destination")).did(),
      ];
      try {
        for (const [index, space] of spaces.entries()) {
          const pattern = await open(
            runtime.getCell(space, `source-slot-${index}`),
          );
          expect(pattern).toBeDefined();
          expect(runtime.patternManager.getArtifactEntryRef(pattern!)?.identity)
            .toBe(identity);
          await runtime.patternManager.flushCompileCacheWrites();
          const retained = await runtime.patternManager
            .getPatternSourceProgramByIdentity(identity, space);
          expect(retained).toBeDefined();
          expect(retained!.files.some((file) => file.contents === source("v1")))
            .toBe(true);
        }
        expect(identityRequests).toBe(4);
        expect(compiledSpaces).toEqual(spaces);
        // The supplied closure has two files; each destination resolves it once.
        expect(sourceRequests).toBe(4);
      } finally {
        runtime.patternManager.compilePattern = compile;
      }
    });

    it("shares an in-flight supplied closure between concurrent slots", async () => {
      const identity = await identityFor(source("v1"));
      const bothIdentities = defer<void>();
      const sourceEntered = defer<void>();
      const releaseSource = defer<void>();
      let identities = 0;
      let resolutions = 0;
      const fetch = servingFetch(() => identity, () => source("v1"), (url) => {
        if (url.searchParams.has("identity") && ++identities === 2) {
          bothIdentities.resolve();
        }
      });
      createRuntime(async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.pathname === PARENT_PATH && !url.searchParams.has("identity")) {
          resolutions++;
          sourceEntered.resolve();
          await releaseSource.promise;
        }
        return await fetch(input, init);
      });
      const first = open(runtime.getCell(signer.did(), "concurrent-first"));
      await sourceEntered.promise;
      const second = open(runtime.getCell(signer.did(), "concurrent-second"));
      try {
        await bothIdentities.promise;
        releaseSource.resolve();
        const patterns = await Promise.all([first, second]);
        expect(patterns.every((pattern) => pattern !== undefined)).toBe(true);
        expect(identities).toBe(2);
        expect(resolutions).toBe(1);
      } finally {
        releaseSource.resolve();
        await Promise.all([first, second]);
      }
    });

    it("revalidates deployment identity before reusing supplied source", async () => {
      const v1 = await identityFor(source("v1"));
      const v2 = await identityFor(source("v2"));
      let advertised = v1;
      let contents = source("v1");
      let identities = 0;
      let downloads = 0;
      createRuntime(servingFetch(() => advertised, () => contents, (url) => {
        if (url.searchParams.has("identity")) identities++;
        else downloads++;
      }));
      const first = await open(
        runtime.getCell(signer.did(), "deployment-first"),
      );
      expect(first).toBeDefined();
      expect(runtime.patternManager.getArtifactEntryRef(first!)?.identity).toBe(
        v1,
      );
      advertised = v2;
      contents = source("v2");
      for (const slot of ["deployment-next", "deployment-warm"]) {
        const pattern = await open(runtime.getCell(signer.did(), slot));
        expect(pattern).toBeDefined();
        expect(runtime.patternManager.getArtifactEntryRef(pattern!)?.identity)
          .toBe(v2);
      }
      expect(identities).toBe(3);
      expect(downloads).toBe(4);
    });

    it("retries a failed source download without retaining its rejection", async () => {
      const identity = await identityFor(source("v1"));
      let unavailable = true;
      let downloads = 0;
      const fetch = servingFetch(() => identity, () => source("v1"));
      createRuntime((input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.pathname === PARENT_PATH && !url.searchParams.has("identity")) {
          downloads++;
          if (unavailable) {
            return Promise.reject(new Error("source unavailable"));
          }
        }
        return fetch(input, init);
      });
      expect(await open(runtime.getCell(signer.did(), "failed-download")))
        .toBeUndefined();
      unavailable = false;
      expect(await open(runtime.getCell(signer.did(), "retry-download")))
        .toBeDefined();
      expect(await open(runtime.getCell(signer.did(), "warm-download")))
        .toBeDefined();
      expect(downloads).toBe(2);
    });

    it("retries corrected source after an advertised-identity mismatch", async () => {
      const identity = await identityFor(source("v2"));
      let contents = source("v1");
      let downloads = 0;
      createRuntime(servingFetch(() => identity, () => contents, (url) => {
        if (!url.searchParams.has("identity")) downloads++;
      }));
      expect(await open(runtime.getCell(signer.did(), "mismatched-source")))
        .toBeUndefined();
      contents = source("v2");
      for (const slot of ["corrected-source", "warm-corrected-source"]) {
        const pattern = await open(runtime.getCell(signer.did(), slot));
        expect(pattern).toBeDefined();
        expect(runtime.patternManager.getArtifactEntryRef(pattern!)?.identity)
          .toBe(identity);
      }
      expect(downloads).toBe(4);
    });

    it("retries compilation failure without evicting a newer successful source", async () => {
      const identity = await identityFor(source("v1"));
      let downloads = 0;
      createRuntime(servingFetch(() => identity, () => source("v1"), (url) => {
        if (!url.searchParams.has("identity")) downloads++;
      }));
      const compile = runtime.patternManager.compilePattern.bind(
        runtime.patternManager,
      );
      const entered = [defer<void>(), defer<void>()];
      const release = [defer<void>(), defer<void>()];
      let calls = 0;
      runtime.patternManager.compilePattern = async (...args) => {
        const index = calls++;
        if (index < 2) {
          entered[index].resolve();
          await release[index].promise;
          throw new Error("controlled compile failure");
        }
        return await compile(...args);
      };
      const first = open(runtime.getCell(signer.did(), "failure-first"));
      await entered[0].promise;
      const second = open(runtime.getCell(signer.did(), "failure-second"));
      try {
        await entered[1].promise;
        release[0].resolve();
        expect(await first).toBeUndefined();
        expect(await open(runtime.getCell(signer.did(), "failure-retry")))
          .toBeDefined();
        expect(downloads).toBe(4);
        release[1].resolve();
        expect(await second).toBeUndefined();
        expect(await open(runtime.getCell(signer.did(), "after-late-failure")))
          .toBeDefined();
        expect(downloads).toBe(4);
        expect(calls).toBe(4);
      } finally {
        for (const gate of release) gate.resolve();
        await Promise.all([first, second]);
        runtime.patternManager.compilePattern = compile;
      }
    });

    it("isolates retained source containers from compiler-owned inputs", async () => {
      const dataFiles = ["/attached.txt"];
      const sourceRoots = ["/retained.ts"];
      const attached = [
        { name: dataFiles[0], contents: "attached source data" },
        { name: sourceRoots[0], contents: "export const retained = true;" },
      ];
      const files = new Map(
        [...parentProgram(source("v1")).files, ...attached].map((
          file,
        ) => [file.name, file.contents]),
      );
      const identity = await resolveEntryIdentity(
        PARENT_PATH,
        (name) => Promise.resolve(files.get(name)!),
        { dataFiles, sourceRoots },
      );
      let downloads = 0;
      createRuntime(servingFetch(() => identity, () => source("v1"), (url) => {
        if (!url.searchParams.has("identity")) downloads++;
      }));
      const resolve = runtime.harness.resolve.bind(runtime.harness);
      runtime.harness.resolve = async (...args) => {
        const program = await resolve(...args);
        return {
          ...program,
          files: [...program.files, ...attached],
          dataFiles: [...dataFiles],
          sourceRoots: [...sourceRoots],
        };
      };
      const compile = runtime.patternManager.compilePattern.bind(
        runtime.patternManager,
      );
      let calls = 0;
      runtime.patternManager.compilePattern = async (...args) => {
        calls++;
        if (typeof args[0] === "string") {
          throw new Error("supplied source must carry its resolved program");
        }
        expect(args[0].files.map((file) => file.contents)).toContain(
          source("v1"),
        );
        expect(args[0].dataFiles).toEqual(dataFiles);
        expect(args[0].sourceRoots).toEqual(sourceRoots);
        const pattern = await compile(...args);
        args[0].files[0].contents = "changed by compiler owner";
        args[0].files.pop();
        args[0].dataFiles!.push("owner-data.txt");
        args[0].sourceRoots!.push("owner-root.tsx");
        return pattern;
      };
      try {
        expect(await open(runtime.getCell(signer.did(), "containers-first")))
          .toBeDefined();
        expect(await open(runtime.getCell(signer.did(), "containers-next")))
          .toBeDefined();
        expect(calls).toBe(2);
        expect(downloads).toBe(2);
        const stored = await runtime.patternManager
          .getPatternSourceProgramByIdentity(identity, signer.did());
        expect(stored?.dataFiles).toEqual(dataFiles);
        expect(stored?.sourceRoots).toEqual(sourceRoots);
        expect(stored?.files).toEqual(expect.arrayContaining(attached));
      } finally {
        runtime.harness.resolve = resolve;
        runtime.patternManager.compilePattern = compile;
      }
    });

    it("separates full source targets and retires the least recently used entry", async () => {
      const identity = await identityFor(source("v1"));
      const downloads: string[] = [];
      createRuntime(servingFetch(() => identity, () => source("v1"), (url) => {
        if (url.pathname === PARENT_PATH && !url.searchParams.has("identity")) {
          downloads.push(url.host);
        }
      }));
      const hostForSpace = runtime.hostForSpace.bind(runtime);
      let host = "source-0.test";
      runtime.hostForSpace = () => new URL(`http://${host}`);
      const atHost = async (index: number) => {
        host = `source-${index}.test`;
        expect(
          await open(
            runtime.getCell(signer.did(), `target-${crypto.randomUUID()}`),
          ),
        )
          .toBeDefined();
      };
      try {
        for (let index = 0; index < 32; index++) await atHost(index);
        expect(downloads.length).toBe(32);
        await atHost(0);
        expect(downloads.length).toBe(32);
        await atHost(32);
        await atHost(0);
        expect(downloads.length).toBe(33);
        await atHost(1);
        expect(downloads.at(-1)).toBe("source-1.test");
        expect(downloads.length).toBe(34);
      } finally {
        runtime.hostForSpace = hostForSpace;
      }
    });

    for (const sourceLength of [2_200_000, 4_200_000]) {
      it(`bounds retention of ${sourceLength} source code units`, async () => {
        const contents = source("v1") + "\n/*" + " ".repeat(sourceLength) +
          "*/";
        const identity = await identityFor(contents);
        let downloads = 0;
        createRuntime(servingFetch(() => identity, () => contents, (url) => {
          if (
            url.pathname === PARENT_PATH && !url.searchParams.has("identity")
          ) downloads++;
        }));
        const hostForSpace = runtime.hostForSpace.bind(runtime);
        let host = "weighted-first.test";
        runtime.hostForSpace = () => new URL(`http://${host}`);
        try {
          for (
            const target of [
              "weighted-first.test",
              "weighted-second.test",
              "weighted-first.test",
            ]
          ) {
            host = target;
            expect(
              await open(
                runtime.getCell(
                  signer.did(),
                  `weighted-${crypto.randomUUID()}`,
                ),
              ),
            )
              .toBeDefined();
          }
          expect(downloads).toBe(3);
          expect(
            await open(runtime.getCell(signer.did(), "weighted-same-target")),
          ).toBeDefined();
          // A source larger than the budget is never retained, even alone.
          expect(downloads).toBe(sourceLength > 4 * 1024 * 1024 ? 4 : 3);
        } finally {
          runtime.hostForSpace = hostForSpace;
        }
      });
    }

    it("retries failed destination persistence before reusing supplied source", async () => {
      const identity = await identityFor(source("v1"));
      let downloads = 0;
      createRuntime(servingFetch(() => identity, () => source("v1"), (url) => {
        if (!url.searchParams.has("identity")) downloads++;
      }));
      const manager = runtime.patternManager.accessForTestingOnly;
      let failedWrites = 0;
      manager.compileCacheWriter = () => {
        failedWrites++;
        return Promise.reject(new Error("controlled closure write failure"));
      };
      try {
        expect(await open(runtime.getCell(signer.did(), "closure-failure")))
          .toBeUndefined();
        await runtime.patternManager.flushCompileCacheWrites();
        expect(failedWrites).toBeGreaterThan(0);
        expect(
          await runtime.patternManager.getPatternSourceProgramByIdentity(
            identity,
            signer.did(),
          ),
        )
          .toBeUndefined();
        manager.compileCacheWriter = undefined;
        expect(await open(runtime.getCell(signer.did(), "closure-repair")))
          .toBeDefined();
        await runtime.patternManager.flushCompileCacheWrites();
        const retained = await runtime.patternManager
          .getPatternSourceProgramByIdentity(identity, signer.did());
        expect(retained).toBeDefined();
        expect(retained!.files.some((file) => file.contents === source("v1")))
          .toBe(true);
        expect(downloads).toBe(4);
        expect(await open(runtime.getCell(signer.did(), "closure-warm")))
          .toBeDefined();
        expect(downloads).toBe(4);
      } finally {
        manager.compileCacheWriter = undefined;
      }
    });

    it("recompiles shared source when the registry epoch ends during a sidecar open", async () => {
      await storageManager.close();
      const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
      storageManager = EmulatedStorageManager.connectTo(server, { as: signer });
      const identity = await identityFor(source("v1"));
      let identities = 0;
      let downloads = 0;
      createRuntime(servingFetch(() => identity, () => source("v1"), (url) => {
        if (url.searchParams.has("identity")) identities++;
        else downloads++;
      }));
      const entered = defer<void>();
      const release = defer<void>();
      const compile = runtime.patternManager.compilePattern.bind(
        runtime.patternManager,
      );
      let calls = 0;
      runtime.patternManager.compilePattern = async (...args) => {
        const first = ++calls === 1;
        const pattern = await compile(...args);
        if (first) {
          entered.resolve();
          await release.promise;
        }
        return pattern;
      };
      const slot: SidecarSurfaceState = {};
      const piece = runtime.getCell(signer.did(), "epoch-sidecar");
      const opening = openSidecarSurface(runtime, slot, piece, {
        name: "reconcile-parent.tsx",
        origin: PARENT_SOURCE,
      });
      try {
        await entered.promise;
        await runtime.patternManager.flushCompileCacheWrites();
        await storageManager.synced();
        await storageManager.close();
        release.resolve();
        const pattern = await opening;
        expect(pattern).toBeDefined();
        expect(runtime.patternManager.getArtifactEntryRef(pattern!)?.identity)
          .toBe(identity);
        expect(calls).toBe(2);
        expect(identities).toBe(2);
        expect(downloads).toBe(2);
        const result = runtime.getCell<{ marker: string }>(
          signer.did(),
          "epoch-sidecar-result",
        );
        await runtime.setup(undefined, pattern!, {}, result);
        expect(await runtime.start(result)).toBe(true);
        const cancel = result.sink(() => {});
        try {
          await runtime.idle();
          expect(result.get().marker).toBe("v1");
        } finally {
          cancel();
        }
        await runtime.patternManager.flushCompileCacheWrites();
        expect(
          await runtime.patternManager.getPatternSourceProgramByIdentity(
            identity,
            signer.did(),
          ),
        )
          .toBeDefined();
      } finally {
        release.resolve();
        await opening;
        runtime.patternManager.compilePattern = compile;
        await runtime.dispose();
        await server.close();
      }
    });

    it("abandons a shared download on disposal before any caller compiles", async () => {
      const identity = await identityFor(source("v1"));
      const entered = defer<void>();
      const bothIdentities = defer<void>();
      const release = defer<void>();
      let identities = 0;
      let compilations = 0;
      const fetch = servingFetch(() => identity, () => source("v1"), (url) => {
        if (url.searchParams.has("identity") && ++identities === 2) {
          bothIdentities.resolve();
        }
      });
      createRuntime(async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.pathname === PARENT_PATH && !url.searchParams.has("identity")) {
          entered.resolve();
          await release.promise;
        }
        return await fetch(input, init);
      });
      const compile = runtime.patternManager.compilePattern.bind(
        runtime.patternManager,
      );
      runtime.patternManager.compilePattern = (...args) => {
        compilations++;
        return compile(...args);
      };
      const first = open(
        runtime.getCell(signer.did(), "disposed-download-first"),
      );
      await entered.promise;
      const second = open(
        runtime.getCell(signer.did(), "disposed-download-second"),
      );
      try {
        await bothIdentities.promise;
        await runtime.sourceReconciler.dispose();
        expect(await Promise.all([first, second])).toEqual([
          undefined,
          undefined,
        ]);
        release.resolve();
        expect(
          await open(runtime.getCell(signer.did(), "disposed-download-later")),
        )
          .toBeUndefined();
        expect(identities).toBe(2);
        expect(compilations).toBe(0);
      } finally {
        release.resolve();
        await Promise.all([first, second]);
        runtime.patternManager.compilePattern = compile;
      }
    });

    it("starts no rescue after disposal during source-closure loading", async () => {
      const identity = await identityFor(source("v1"));
      let requests = 0;
      createRuntime(servingFetch(() => identity, () => source("v1"), () => {
        requests++;
      }));
      const elsewhere = (await Identity.fromPassphrase("rescue source space"))
        .did();
      const pattern = await runtime.patternManager.compilePattern(
        parentProgram(source("v1")),
        { space: elsewhere },
      );
      const piece = runtime.getCell(signer.did(), "disposed-rescue");
      await runtime.setup(undefined, pattern, {}, piece);
      await runtime.patternManager.flushCompileCacheWrites();
      const originalRef = getPatternIdentityRef(piece);
      const load = runtime.patternManager.getPatternSourceProgramByIdentity
        .bind(
          runtime.patternManager,
        );
      expect(await load(identity, piece.space)).toBeUndefined();
      const entered = defer<void>();
      const release = defer<void>();
      let hold = true;
      runtime.patternManager.getPatternSourceProgramByIdentity = async (
        ...args
      ) => {
        const program = await load(...args);
        if (hold) {
          hold = false;
          expect(program).toBeUndefined();
          entered.resolve();
          await release.promise;
        }
        return program;
      };
      const opening = open(piece);
      try {
        await Promise.race([
          entered.promise,
          opening.then(() => {
            throw new Error("open did not reach source-closure loading");
          }),
        ]);
        await runtime.sourceReconciler.dispose();
        release.resolve();
        await opening;
        expect(requests).toBe(0);
        expect(getPatternIdentityRef(piece)).toEqual(originalRef);
        expect(getPatternSource(piece)).toBeUndefined();
        expect(getPieceSourceRevisions(piece)).toEqual([]);
        expect(await load(identity, piece.space)).toBeUndefined();
      } finally {
        release.resolve();
        await opening;
        runtime.patternManager.getPatternSourceProgramByIdentity = load;
      }
    });

    it("tracks a pass before its fetch can initiate disposal", async () => {
      const identity = await identityFor(source("v1"));
      let disposing: Promise<void> | undefined;
      let requests = 0;
      const fetch = servingFetch(() => identity, () => source("v1"));
      createRuntime((input, init) => {
        requests++;
        disposing ??= runtime.sourceReconciler.dispose();
        return fetch(input, init);
      });
      const result = await open(
        runtime.getCell(signer.did(), "fetch-disposal"),
      );
      expect(disposing).toBeDefined();
      await disposing;
      expect(result).toBeUndefined();
      expect(requests).toBe(1);
    });

    for (const phase of ["initial sync", "compilation"] as const) {
      it(`supplies nothing after disposal during ${phase}`, async () => {
        const identity = await identityFor(source("v1"));
        let identityRequests = 0;
        const piece = emptyPiece(
          servingFetch(() => identity, () => source("v1"), (url) => {
            if (url.searchParams.has("identity")) identityRequests++;
          }),
        );
        const entered = defer<void>();
        const release = defer<void>();
        const withTx = piece.withTx.bind(piece);
        const compile = runtime.patternManager.compilePattern.bind(
          runtime.patternManager,
        );
        if (phase === "initial sync") {
          const detached = piece.withTx();
          const sync = detached.sync.bind(detached);
          detached.sync = async () => {
            entered.resolve();
            await release.promise;
            return await sync();
          };
          piece.withTx = () => detached;
        } else {
          runtime.patternManager.compilePattern = async (...args) => {
            const pattern = await compile(...args);
            entered.resolve();
            await release.promise;
            return pattern;
          };
        }
        const opening = open(piece);
        try {
          await Promise.race([
            entered.promise,
            opening.then(() => {
              throw new Error("open did not enter the controlled phase");
            }),
          ]);
          const disposing = runtime.sourceReconciler.dispose();
          if (phase === "initial sync") await disposing;
          release.resolve();
          await disposing;
          expect(await opening).toBeUndefined();
          expect(identityRequests).toBe(phase === "initial sync" ? 0 : 1);
        } finally {
          release.resolve();
          await opening;
          piece.withTx = withTx;
          runtime.patternManager.compilePattern = compile;
        }
      });
    }

    it("answers with the source its origin names, for a piece not yet there", async () => {
      const v1Identity = await identityFor(source("v1"));
      const piece = emptyPiece(
        servingFetch(() => v1Identity, () => source("v1")),
      );

      const pattern = await open(piece);
      expect(pattern).toBeDefined();
      // The identity is what the origin advertises. The export is whichever
      // one compiling the file selects, which this fixture reaches under two
      // names for one pattern object.
      expect(runtime.patternManager.getArtifactEntryRef(pattern!)?.identity)
        .toBe(v1Identity);
    });

    it("records the supplied origin with the piece's creation revision", async () => {
      const v1Identity = await identityFor(source("v1"));
      const piece = emptyPiece(
        servingFetch(() => v1Identity, () => source("v1")),
      );
      const pattern = await open(piece);

      const result = await runtime.editWithRetry((tx) => {
        runtime.runner.run(tx, pattern!, {}, piece.withTx(tx), {
          sourceOrigin: PARENT_SOURCE,
        });
      });
      expect(result.error).toBeUndefined();

      expect(getPatternSource(piece)).toBe(PARENT_SOURCE);
      expect(getPieceSourceRevisions(piece).map((entry) => entry.operation))
        .toEqual(["create"]);
      expect(getPieceSourceRevisions(piece).at(-1)?.origin).toBe(PARENT_SOURCE);
    });

    it("gives an origin to a piece the runtime made before it claimed one", async () => {
      const v1Identity = await identityFor(source("v1"));
      const piece = await preparePiece(
        servingFetch(() => v1Identity, () => source("v1")),
      );
      const originalRef = getPatternIdentityRef(piece);

      const pattern = await open(piece);

      expect(getPatternSource(piece)).toBe(PARENT_SOURCE);
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
      expect(getPieceSourceRevisions(piece).map((entry) => entry.operation))
        .toEqual(["baseline", "follow"]);
      expect(runtime.patternManager.getArtifactEntryRef(pattern!))
        .toEqual(originalRef);
    });

    it("gives the origin and its source to a piece whose space holds no source for what it runs", async () => {
      // A piece the runtime made before it claimed an origin, running a
      // pattern its own space retains no source for: what the origin names
      // now is the only code that space can give it, so it takes that in the
      // same revision that records the origin, and keeps the identity it
      // displaced. The pattern stays live in this runtime's index, compiled
      // into another space, because the index answers by identity alone and
      // an answer from there is not this space holding the source.
      const v1Identity = await identityFor(source("v1"));
      const v2Identity = await identityFor(source("v2"));
      createRuntime(servingFetch(() => v2Identity, () => source("v2")));
      const elsewhere = (await Identity.fromPassphrase("another space")).did();
      const v1 = await runtime.patternManager.compilePattern(
        parentProgram(source("v1")),
        { space: elsewhere },
      );
      const piece = runtime.getCell<{ marker?: string }>(
        signer.did(),
        `supplied-${crypto.randomUUID()}`,
      );
      await runtime.setup(undefined, v1, {}, piece);
      await runtime.patternManager.flushCompileCacheWrites();
      const originalRef = getPatternIdentityRef(piece)!;
      expect(originalRef.identity).toBe(v1Identity);
      expect(
        await runtime.patternManager.getPatternSourceProgramByIdentity(
          v1Identity,
          piece.space,
        ),
        "the piece's space must hold no source for what it runs",
      ).toBeUndefined();
      expect(
        await runtime.patternManager.loadPatternByIdentity(
          v1Identity,
          SYMBOL,
          piece.space,
        ),
        "the pattern must stay live in the runtime's index",
      ).toBeDefined();

      const pattern = await open(piece);

      expect(runtime.patternManager.getArtifactEntryRef(pattern!)).toEqual({
        identity: v2Identity,
        symbol: SYMBOL,
      });
      expect(getPatternSource(piece)).toBe(PARENT_SOURCE);
      expect(getPatternIdentityRef(piece)).toEqual({
        identity: v2Identity,
        symbol: SYMBOL,
      });
      expect(piece.getMetaRaw("displacedPattern")).toMatchObject(originalRef);
      expect(getPieceSourceRevisions(piece).map((entry) => entry.operation))
        .toEqual(["follow"]);
      expect(getPieceSourceRevisions(piece).at(-1)?.origin).toBe(PARENT_SOURCE);
    });

    it("adopts what the origin now names, and answers with that", async () => {
      const v2Identity = await identityFor(source("v2"));
      const piece = await preparePiece(
        servingFetch(() => v2Identity, () => source("v2")),
      );
      await stampSource(piece, PARENT_SOURCE);

      const pattern = await open(piece);

      expect(getPatternIdentityRef(piece)).toEqual({
        identity: v2Identity,
        symbol: SYMBOL,
      });
      expect(runtime.patternManager.getArtifactEntryRef(pattern!)).toEqual({
        identity: v2Identity,
        symbol: SYMBOL,
      });
      expect(getPieceSourceRevisions(piece).at(-1)?.operation).toBe(
        "origin-update",
      );
    });

    it("follows an owner-selected origin while supplied source is cached", async () => {
      const suppliedIdentity = await identityFor(source("v2"));
      const piece = await preparePiece(
        servingFetch(() => suppliedIdentity, () => source("v2")),
      );
      expect(await open(runtime.getCell(signer.did(), "cached-supplied-slot")))
        .toBeDefined();
      const selected = await compileMarkerPattern("v3");
      const selectedRef = runtime.patternManager.getArtifactEntryRef(selected)!;
      expect(selectedRef.identity).not.toBe(suppliedIdentity);
      const chosen = `cf:pattern:${selectedRef.identity}`;
      await stampSource(piece, chosen);

      const pattern = await open(piece);

      expect(pattern).toBeDefined();
      expect(runtime.patternManager.getArtifactEntryRef(pattern!)).toEqual(
        selectedRef,
      );
      expect(getPatternIdentityRef(piece)).toEqual(selectedRef);
      expect(getPatternSource(piece)).toBe(chosen);
    });

    it("leaves an origin its owner chose alone", async () => {
      // A surface the runtime supplies is still the space owner's piece. Once
      // they have pointed it somewhere else, the runtime supplying it is no
      // longer what decides where its code comes from.
      const piece = await preparePiece(refuseEveryFetch);
      const chosen = `https://programs.test${PARENT_PATH}`;
      await stampSource(piece, chosen);

      await open(piece);

      expect(getPatternSource(piece)).toBe(chosen);
      expect(getPieceSourceRevisions(piece).map((entry) => entry.operation))
        .toEqual([]);
    });

    it("supplies nothing for an origin that is not a system pattern", async () => {
      const piece = emptyPiece(refuseEveryFetch);
      expect(await open(piece, "https://programs.test/main.tsx"))
        .toBeUndefined();
    });

    it("records nothing for a supplied origin it cannot supply", async () => {
      // The origin the runtime may supply is settled before either path uses
      // it, so a piece that already exists is not stamped with one that a
      // piece not yet there would have been refused.
      const piece = await preparePiece(refuseEveryFetch);

      expect(await open(piece, "https://programs.test/main.tsx"))
        .toBeUndefined();

      expect(getPatternSource(piece)).toBeUndefined();
      expect(getPieceSourceRevisions(piece).map((entry) => entry.operation))
        .toEqual([]);
    });

    it("leaves the space holding the source behind what it answers with", async () => {
      // What a supplied open owes its caller is not a pattern object: it is
      // this space holding the source closure behind it, which the creation
      // revision retains and a later cross-space child replicates out of. An
      // identity this runtime already holds in memory is held under that
      // identity alone, with no space attached, so answering from there would
      // hand back a pattern whose closure this space never received.
      const v1Identity = await identityFor(source("v1"));
      const piece = emptyPiece(
        servingFetch(() => v1Identity, () => source("v1")),
      );
      // Live in this runtime's index, and compiled into another space, so the
      // only way this space ends up with the closure is by getting it here.
      const elsewhere = await Identity.fromPassphrase("another space");
      await runtime.patternManager.compilePattern(
        parentProgram(source("v1")),
        { space: elsewhere.did() },
      );

      const pattern = await open(piece);

      expect(runtime.patternManager.getArtifactEntryRef(pattern!)?.identity)
        .toBe(v1Identity);
      await runtime.patternManager.flushCompileCacheWrites();
      expect(
        await runtime.patternManager.getPatternSourceProgramByIdentity(
          v1Identity,
          signer.did(),
        ),
        "the space the surface is being created in must hold its source",
      ).toBeDefined();
    });

    it("leaves every space it opens a surface in holding that source", async () => {
      // One runtime serving many spaces is the case a process-global cache
      // could not answer: it compiles once, and every space after the first is
      // served a pattern whose closure was never persisted there. Opening per
      // surface piece has no first space — each one compiles into the space
      // its own piece lives in.
      const v1Identity = await identityFor(source("v1"));
      createRuntime(servingFetch(() => v1Identity, () => source("v1")));
      const spaces = [
        signer.did(),
        (await Identity.fromPassphrase("second served space")).did(),
      ];

      for (const space of spaces) {
        const piece = runtime.getCell<{ marker?: string }>(
          space,
          `supplied-${crypto.randomUUID()}`,
        );
        expect(await runtime.sourceReconciler.open(piece, PARENT_SOURCE))
          .toBeDefined();
      }

      await runtime.patternManager.flushCompileCacheWrites();
      for (const space of spaces) {
        expect(
          await runtime.patternManager.getPatternSourceProgramByIdentity(
            v1Identity,
            space,
          ),
          `${space} was served the surface without being given its source`,
        ).toBeDefined();
      }
    });

    it("supplies nothing when the origin's source cannot be resolved", async () => {
      // The host advertises an identity and then fails to serve the source
      // behind it. Nothing is left to run, and the failure is the pass's.
      const v1Identity = await identityFor(source("v1"));
      const piece = emptyPiece((input) => {
        const url = new URL(
          input instanceof Request
            ? input.url
            : input instanceof URL
            ? input.href
            : input,
        );
        return Promise.resolve(
          url.searchParams.has("identity")
            ? new Response(v1Identity)
            : new Response("gone", { status: 500 }),
        );
      });

      expect(await open(piece)).toBeUndefined();
    });

    it("abandons an in-flight supplied resolve on disposal", async () => {
      identityGate = defer();
      const requested = defer();
      const v1Identity = await identityFor(source("v1"));
      const piece = emptyPiece(async (input) => {
        const url = new URL(
          input instanceof Request
            ? input.url
            : input instanceof URL
            ? input.href
            : input,
        );
        if (url.searchParams.has("identity")) {
          requested.resolve();
          await identityGate!.promise;
          return new Response(v1Identity);
        }
        return new Response(parentSource);
      });

      const opening = open(piece);
      // The request is the witness that the pass is registered: disposal has
      // to have something in flight to abandon.
      await requested.promise;
      const disposing = runtime.sourceReconciler.dispose();
      identityGate.resolve();

      await disposing;
      expect(await opening).toBeUndefined();
    });

    it("answers rather than rejecting when nothing about the open works", async () => {
      // Opening a surface runs from a launch nothing awaits for its value, so
      // a rejection escaping it would surface as an unhandled one rather than
      // as a surface that did not come up. A runtime that cannot even say
      // which host serves the space is the shortest way to a throw before any
      // of the paths that answer for themselves.
      const piece = await preparePiece(refuseEveryFetch);
      const hostForSpace = runtime.hostForSpace;
      (runtime as unknown as { hostForSpace: () => URL }).hostForSpace = () => {
        throw new Error("no route for this space");
      };
      try {
        expect(await open(piece)).toBeUndefined();
      } finally {
        (runtime as unknown as { hostForSpace: typeof hostForSpace })
          .hostForSpace = hostForSpace;
      }
      expect(getPatternSource(piece)).toBeUndefined();
    });

    it("answers nothing for a piece it cannot even read", async () => {
      // Opening starts by reading the piece, which is what says whether it
      // exists at all. A read that fails outright — storage closing under a
      // launch is the ordinary way — leaves nothing to answer with, and the
      // caller is told so rather than handed a rejection.
      const piece = emptyPiece(refuseEveryFetch);
      await storageManager.close();

      expect(await open(piece)).toBeUndefined();
    });

    it("refuses source that does not compile to the advertised identity", async () => {
      // The host says one thing and serves another, so what it serves is not
      // the source that origin names.
      const v2Identity = await identityFor(source("v2"));
      const piece = emptyPiece(
        servingFetch(() => v2Identity, () => source("v1")),
      );
      expect(await open(piece)).toBeUndefined();
    });
  });

  describe("guarding the write", () => {
    it("shares one reconciliation between concurrent openings", async () => {
      const v1Identity = await identityFor(source("v1"));
      let identityRequests = 0;
      identityGate = defer();
      const piece = await preparePiece(
        servingFetch(() => v1Identity, () => source("v1"), (url) => {
          if (url.searchParams.has("identity")) identityRequests++;
        }),
      );
      await stampSource(piece, PARENT_SOURCE);

      const both = Promise.all([reconcile(piece), reconcile(piece)]);
      identityGate.resolve();
      expect(await both).toEqual(["current", "current"]);
      expect(identityRequests).toBe(1);
    });

    it("starts a fresh pass for a piece reopened as its abandoned one unwinds", async () => {
      // Stopping a piece abandons the pass in flight for it. Opening it again
      // before that pass has finished unwinding must not be answered by the
      // abandoned one: the piece would start on source its origin had already
      // replaced, which is the whole thing reconciling before a start prevents.
      const v2Identity = await identityFor(source("v2"));
      const identityRequested = defer<void>();
      identityGate = defer();
      let identityRequests = 0;
      const piece = await preparePiece(async (input) => {
        const url = new URL(
          input instanceof Request
            ? input.url
            : input instanceof URL
            ? input.href
            : input,
        );
        if (url.searchParams.has("identity")) {
          identityRequests++;
          identityRequested.resolve();
          await identityGate!.promise;
          return new Response(v2Identity);
        }
        return new Response(
          url.pathname === SOURCE_PATH ? source("v2") : parentSource,
        );
      });
      await stampSource(piece, PARENT_SOURCE);

      const abandoned = reconcile(piece);
      await identityRequested.promise;
      runtime.sourceReconciler.unwatch(piece);
      const reopened = reconcile(piece);
      identityGate.resolve();
      await abandoned;
      await reopened;
      await runtime.sourceReconciler.idle();

      expect(identityRequests).toBe(2);
      expect(getPatternIdentityRef(piece)?.identity).toBe(v2Identity);
    });

    it("does not apply an update once the recorded origin has changed", async () => {
      const v2Identity = await identityFor(source("v2"));
      const identityRequested = defer();
      identityGate = defer();
      const piece = await preparePiece(async (input) => {
        const url = new URL(
          input instanceof Request
            ? input.url
            : input instanceof URL
            ? input.href
            : input,
        );
        if (url.searchParams.has("identity")) {
          identityRequested.resolve();
          await identityGate!.promise;
          return new Response(v2Identity);
        }
        return new Response(
          url.pathname === SOURCE_PATH ? source("v2") : parentSource,
        );
      });
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, PARENT_SOURCE);

      const running = reconcile(piece);
      await identityRequested.promise;
      // A detach lands while the update is resolving. The transition it was
      // going to write names an origin the piece no longer follows.
      await runtime.editWithRetry((tx) => {
        piece.withTx(tx).setMetaRaw(
          "patternSource",
          undefined,
          rawMetaWriteAuthorization,
        );
      });
      identityGate.resolve();

      expect(await running).toBe("unavailable");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
      expect(getPieceSourceRevisions(piece)).toEqual([]);
    });

    it("does not apply an update once the piece's pattern has moved", async () => {
      // The candidate was compared against the pattern the piece was running
      // when the pass began. A piece that has moved to a different pattern
      // since is not the piece that comparison was about, so the transition
      // is dropped rather than applied over it.
      const v2Identity = await identityFor(source("v2"));
      const identityRequested = defer<void>();
      identityGate = defer();
      const piece = await preparePiece(async (input) => {
        const url = new URL(
          input instanceof Request
            ? input.url
            : input instanceof URL
            ? input.href
            : input,
        );
        if (url.searchParams.has("identity")) {
          identityRequested.resolve();
          await identityGate!.promise;
          return new Response(v2Identity);
        }
        return new Response(
          url.pathname === SOURCE_PATH ? source("v2") : parentSource,
        );
      });
      await stampSource(piece, PARENT_SOURCE);

      const pass = reconcile(piece);
      await identityRequested.promise;
      const moved = await compileMarkerPattern("v3");
      const movedRef = runtime.patternManager.getArtifactEntryRef(moved)!;
      const { error } = await runtime.editWithRetry((tx) => {
        piece.withTx(tx).setMetaRaw(
          "patternIdentity",
          movedRef,
          rawMetaWriteAuthorization,
        );
      });
      expect(error).toBeUndefined();
      identityGate.resolve();

      expect(await pass).toBe("unavailable");
      expect(getPatternIdentityRef(piece)).toEqual(movedRef);
    });

    it("does not apply an update once the piece has moved under the write", async () => {
      // The candidate was compared against the pattern the piece ran when the
      // pass read it, and the write is proved against that same pattern. A
      // move landing after the comparison but before the write drops the
      // transition rather than applying it over a piece it was never about.
      const v2Identity = await identityFor(source("v2"));
      const piece = await preparePiece(
        servingFetch(() => v2Identity, () => source("v2")),
      );
      await stampSource(piece, PARENT_SOURCE);
      const moved = await compileMarkerPattern("v3");
      const movedRef = runtime.patternManager.getArtifactEntryRef(moved)!;

      // The last await the pass takes before opening its write transaction.
      const sync = runtime.syncStoredSetupArgument.bind(runtime);
      runtime.syncStoredSetupArgument = async (
        ...args: Parameters<typeof sync>
      ) => {
        const unchanged = await sync(...args);
        const { error } = await runtime.editWithRetry((tx) => {
          piece.withTx(tx).setMetaRaw(
            "patternIdentity",
            movedRef,
            rawMetaWriteAuthorization,
          );
        });
        expect(error).toBeUndefined();
        return unchanged;
      };
      try {
        expect(await reconcile(piece)).toBe("unavailable");
      } finally {
        runtime.syncStoredSetupArgument = sync;
      }
      expect(getPatternIdentityRef(piece)).toEqual(movedRef);
      expect(getPatternSource(piece)).toBe(PARENT_SOURCE);
    });

    it("reports no update when the piece stops while the write is in flight", async () => {
      // The write transaction re-checks the abort signal on entry, so a stop
      // landing after that check still commits. What it must not do is report
      // an update: the piece is no longer running, and a caller told the
      // source moved would resync and start a piece that was just stopped.
      const v2Identity = await identityFor(source("v2"));
      const piece = await preparePiece(
        servingFetch(() => v2Identity, () => source("v2")),
      );
      await stampSource(piece, PARENT_SOURCE);

      // Setup runs inside the write callback, after the entry check.
      const setup = runtime.setup.bind(runtime);
      runtime.setup = ((...args: Parameters<typeof setup>) => {
        runtime.sourceReconciler.unwatch(piece);
        return setup(...args);
      }) as typeof runtime.setup;
      try {
        expect(await reconcile(piece)).toBe("unavailable");
      } finally {
        runtime.setup = setup;
      }
    });

    it("abandons an in-flight reconciliation on disposal", async () => {
      const identityRequested = defer();
      identityGate = defer();
      const piece = await preparePiece(async () => {
        identityRequested.resolve();
        await identityGate!.promise;
        return new Response(await identityFor(source("v2")));
      });
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, PARENT_SOURCE);

      const running = reconcile(piece);
      await identityRequested.promise;
      const disposed = runtime.sourceReconciler.dispose();
      identityGate.resolve();
      await disposed;

      expect(await running).toBe("unavailable");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    });

    it("reports a reconciliation requested after disposal as detached", async () => {
      const piece = await preparePiece(refuseEveryFetch);
      await stampSource(piece, PARENT_SOURCE);
      await runtime.sourceReconciler.dispose();
      expect(await reconcile(piece)).toBe("detached");
    });
  });
});
